import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
    assertPartialSnapshotCurrent,
    MAX_PARTIAL_TEXT_BYTES,
    type PartialFileSnapshot,
} from "../git/partialSnapshot";
import { changeFingerprint } from "../changes/parseDiff";
import { rangeSnapshot } from "../changes/rangeMapping";
import { validRangeMetadata, validSnapshot } from "../changes/rangeMetadata";
import { selectedContent, validateSelection } from "../changes/selection";
import { validateImportedPatch, validateShelfManifestPath } from "../shelf/importValidation";
import { classifyPatchHeader } from "../shelf/patchClassification";
import { indexPatchBlocks } from "../shelf/patchIO";
import {
    parseShelfPersistenceContract,
    type ShelfFileEntry,
    type ShelfSelectionProvenance,
} from "../shelf/model";
import {
    captureShelfObjects,
    captureWholeSourceIdentity,
    type ShelfCaptureArtifacts,
    type ShelfCaptureDependencies,
} from "./shelfServiceCapture";

const MAX_CAPTURE_BYTES = 32 * 1024 * 1024;

/** Host-owned snapshot and patch; browser requests must be resolved before this boundary. */
interface SelectedShelfEntry {
    readonly snapshot: PartialFileSnapshot;
    readonly lineIds: readonly string[];
    readonly patch: Buffer;
    readonly owners: Readonly<Record<string, string>>;
}

/** Whole-file capture retains every source owner, with range evidence for mixed text. */
export interface WholeShelfEntry {
    readonly path: string;
    readonly sourceListIds: readonly string[];
    readonly ownership?: Omit<SelectedShelfEntry, "patch" | "lineIds">;
}

/** One shared base and provenance describe one complete generation, never per-file shelves. */
export interface SelectedShelfInput {
    readonly name: string;
    readonly baseCommit: string;
    readonly scope: ShelfSelectionProvenance["scope"];
    readonly sourceLists: ShelfSelectionProvenance["sourceLists"];
    readonly scopeDraft?: string;
    readonly selected: readonly SelectedShelfEntry[];
    readonly whole: readonly WholeShelfEntry[];
}

/** Caller holds metadata, repository and shelf locks; this seam never removes local changes. */
export async function captureSelectedShelf(
    input: SelectedShelfInput,
    dependencies: ShelfCaptureDependencies,
): Promise<ShelfCaptureArtifacts & { readonly assertWholeCurrent?: () => Promise<void> }> {
    await dependencies.store.assertMutationReady();
    const { metadata, evidence, capturedBytes } = await prepareSelection(input, dependencies);
    const assertWholeCurrent = input.whole.length
        ? await captureWholeSourceIdentity(
              input.whole.map((entry) => entry.path),
              input.baseCommit,
              dependencies,
          )
        : undefined;
    const shelfId = randomUUID();
    const whole = input.whole.length
        ? await captureShelfObjects(
              { name: input.name, paths: input.whole.map((entry) => entry.path) },
              dependencies,
              shelfId,
              MAX_CAPTURE_BYTES - capturedBytes,
          )
        : undefined;
    if (
        whole &&
        (whole.baseCommit !== input.baseCommit || whole.entries.length !== input.whole.length)
    )
        throw new Error("Whole-file capture changed before publication.");
    const files: ShelfFileEntry[] = [...(whole?.entries ?? [])];
    const objectHashes = new Set(whole?.objectHashes);
    for (const entry of input.selected) {
        const patch = await dependencies.store.putObject(shelfId, entry.patch);
        objectHashes.add(patch.hash);
        const base = dependencies.recordBaseRevisions
            ? await dependencies.store.putObject(shelfId, Buffer.from(entry.snapshot.view.base))
            : undefined;
        if (base) objectHashes.add(base.hash);
        files.push(selectedEntry(entry.snapshot.view.path, patch.hash, base?.hash));
    }
    for (const bytes of evidence.values())
        objectHashes.add((await dependencies.store.putObject(shelfId, bytes)).hash);
    // Recheck identities after object IO and before the single current-pointer publication.
    for (const entry of input.selected)
        await assertSnapshot(entry.snapshot, input.baseCommit, dependencies);
    for (const entry of input.whole)
        if (entry.ownership)
            await assertSnapshot(entry.ownership.snapshot, input.baseCommit, dependencies);
    await assertWholeCurrent?.();
    const manifest = await dependencies.store.writeShelfGeneration(shelfId, {
        schemaVersion: 2,
        metadata,
        files,
        objectHashes: [...objectHashes],
    });
    return {
        shelfId,
        generation: manifest.generation,
        baseCommit: input.baseCommit,
        revertFiles: whole?.revertFiles ?? [],
        assertWholeCurrent,
    };
}

/** Validates bounded host selections and provenance before any immutable object is written. */
async function prepareSelection(input: SelectedShelfInput, dependencies: ShelfCaptureDependencies) {
    const paths = [
        ...input.selected.map((entry) => entry.snapshot.view.path),
        ...input.whole.map((entry) => entry.path),
    ];
    if (
        !paths.length ||
        paths.length > 20_000 ||
        new Set(paths).size !== paths.length ||
        !/^[a-f0-9]{40,64}$/.test(input.baseCommit)
    )
        throw new Error("Invalid or duplicate shelf capture paths.");
    paths.forEach(validateShelfManifestPath);
    if (input.selected.length > 64)
        throw new Error("Partial shelf capture supports at most 64 selected text files.");
    const selectedOutputBytes = input.selected.reduce(
        (size, entry) =>
            size +
            Buffer.byteLength(
                selectedContent(
                    entry.snapshot.view.base,
                    entry.snapshot.view.blocks,
                    entry.lineIds,
                ),
            ),
        0,
    );
    if (selectedOutputBytes > 16 * 1024 * 1024)
        throw new Error("Partial shelf capture exceeds 16 MiB of selected output.");
    const selectedBytes = input.selected.reduce(
        (size, entry) =>
            size +
            entry.patch.length +
            Buffer.byteLength(entry.snapshot.view.base) +
            Buffer.byteLength(entry.snapshot.working),
        0,
    );
    if (selectedBytes > MAX_CAPTURE_BYTES)
        throw new Error("Shelf capture exceeds the supported aggregate size.");
    const owners = new Set(input.sourceLists.map((list) => list.id));
    const evidence = new Map<string, Buffer>();
    const sources = new Map(input.whole.map((entry) => [entry.path, entry.sourceListIds]));
    for (const entry of input.selected) {
        await assertSnapshot(entry.snapshot, input.baseCommit, dependencies);
        const selected = validateSelection(entry.snapshot.view.blocks, entry.lineIds);
        if (selected.size === 0) throw new Error("Select changes first.");
        evidence.set(
            entry.snapshot.view.path,
            captureOwnership(entry.snapshot, entry.owners, owners, selected),
        );
        sources.set(entry.snapshot.view.path, [...new Set(Object.values(entry.owners))]);
        await validateSelectedPatch(entry, dependencies);
    }
    for (const entry of input.whole) {
        if (entry.sourceListIds.length > 1 && !entry.ownership)
            throw new Error("Mixed-owner text requires captured ownership.");
        if (entry.ownership) {
            if (entry.ownership.snapshot.view.side !== "working")
                throw new Error("Whole-file ownership requires the complete working snapshot.");
            if (entry.ownership.snapshot.view.path !== entry.path)
                throw new Error("Ownership path changed.");
            await assertSnapshot(entry.ownership.snapshot, input.baseCommit, dependencies);
            const bytes = captureOwnership(
                entry.ownership.snapshot,
                entry.ownership.owners,
                owners,
            );
            if (
                new Set(Object.values(entry.ownership.owners)).size !==
                    entry.sourceListIds.length ||
                Object.values(entry.ownership.owners).some(
                    (id) => !entry.sourceListIds.includes(id),
                )
            )
                throw new Error("Whole-file source owners disagree.");
            evidence.set(entry.path, bytes);
        }
    }
    const provenance: ShelfSelectionProvenance = {
        version: 1,
        scope: input.scope,
        sourceLists: input.sourceLists,
        scopeDraft: input.scopeDraft,
        entries: paths.map((file) => ({
            changeId: changeId(file),
            sourceListIds: sources.get(file)!,
            ownershipObjectHash: evidence.has(file)
                ? changeFingerprint(evidence.get(file)!)
                : undefined,
        })),
    };
    const metadata = {
        name: input.name,
        baseCommit: input.baseCommit,
        lifecycle: "shelved" as const,
        createdAt: Date.now(),
        selection: provenance,
    };
    // Validate source text/owner references before writing any immutable object.
    parseShelfPersistenceContract({
        metadata,
        files: paths.map((file) => selectedEntry(file, "a".repeat(64))),
    });
    const capturedBytes =
        selectedBytes +
        [...evidence.values()].reduce((size, bytes) => size + bytes.length, 0) +
        Buffer.byteLength(JSON.stringify(metadata));
    if (capturedBytes > MAX_CAPTURE_BYTES)
        throw new Error("Shelf capture exceeds the supported aggregate size.");
    return { metadata, evidence, capturedBytes };
}

/** Path-derived identity is shared with ordinary whole-file capture and cannot collide across paths. */
function changeId(file: string): string {
    return `change-${createHash("sha256").update(file).digest("hex").slice(0, 20)}`;
}

/** Selected content is one base-to-selection layer, independent of the user's staged split. */
function selectedEntry(file: string, patchHash: string, baseHash?: string): ShelfFileEntry {
    return {
        changeId: changeId(file),
        worktreeBlock: {
            path: file,
            status: "M",
            patchObjectHash: patchHash,
            baseObjectHash: baseHash,
        },
        binary: false,
        untracked: false,
        baseAvailability: baseHash ? "full" : "history",
        exactReconstruction: true,
        lifecycle: "shelved",
    };
}

/** Binds evidence to this host repository and shared HEAD; stale Git/worktree identities refuse. */
async function assertSnapshot(
    snapshot: PartialFileSnapshot,
    head: string,
    dependencies: ShelfCaptureDependencies,
): Promise<void> {
    if (snapshot.head !== head || snapshot.root !== (await realpath(dependencies.repositoryRoot)))
        throw new Error("Selected files require one current snapshot and shared base.");
    await assertPartialSnapshotCurrent(dependencies.executor, snapshot);
}

/** Retains bounded immutable source anchors only for captured changes; every owner must be declared. */
function captureOwnership(
    snapshot: PartialFileSnapshot,
    lines: Readonly<Record<string, string>>,
    owners: ReadonlySet<string>,
    selected?: ReadonlySet<string>,
): Buffer {
    const all = rangeSnapshot(
        snapshot.view.side === "index" ? { ...snapshot, working: snapshot.indexed } : snapshot,
    );
    const tracking = {
        ...all,
        anchors: all.anchors.filter((anchor) => !selected || selected.has(anchor.id)),
    };
    if (
        !validSnapshot(tracking) ||
        !validRangeMetadata({ tracking }, owners, true) ||
        tracking.anchors.length !== Object.keys(lines).length ||
        tracking.anchors.some((anchor) => !owners.has(lines[anchor.fingerprint]))
    )
        throw new Error("Invalid captured shelf ownership.");
    return Buffer.from(JSON.stringify({ version: 1, tracking, lines }));
}

/** Standard Git must apply the exact patch to its captured base and yield only the selected bytes. */
async function validateSelectedPatch(
    entry: SelectedShelfEntry,
    dependencies: ShelfCaptureDependencies,
): Promise<void> {
    const file = entry.snapshot.view.path;
    const content = selectedContent(
        entry.snapshot.view.base,
        entry.snapshot.view.blocks,
        entry.lineIds,
    );
    if (
        !entry.patch.length ||
        entry.patch.length > 8 * 1024 * 1024 ||
        Buffer.byteLength(content) > MAX_PARTIAL_TEXT_BYTES
    )
        throw new Error("Unsupported selected shelf content.");
    validateImportedPatch(entry.patch);
    const blocks = indexPatchBlocks(entry.patch);
    const classification = classifyPatchHeader(entry.patch);
    if (
        blocks.length !== 1 ||
        blocks[0].path !== file ||
        classification.status !== "M" ||
        classification.binary ||
        classification.renamedFrom
    )
        throw new Error("Selected shelves require ordinary tracked text modifications.");
    const directory = await mkdtemp(path.join(tmpdir(), "intelligit-selected-check-"));
    try {
        const target = path.join(directory, file);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, entry.snapshot.view.base);
        await dependencies.executor.runBinary(["-C", directory, "apply", "--check", "-"], {
            input: entry.patch,
        });
        await dependencies.executor.runBinary(["-C", directory, "apply", "-"], {
            input: entry.patch,
        });
        if (!(await readFile(target)).equals(Buffer.from(content)))
            throw new Error("Selected patch contains different or non-selected changes.");
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}
