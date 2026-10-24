import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import {
    mkdir,
    mkdtemp,
    readFile,
    writeFile,
    readdir,
    rm,
    symlink,
    truncate,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { RepositoryLock } from "../../../src/git/repositoryLock";
import { ChangelistPersistence } from "../../../src/changes/changelistPersistence";
import type { HydratedChangelistState } from "../../../src/changes/rangeMapping";
import type {
    ChangelistState,
    RangeSnapshot,
} from "../../../src/webviews/protocol/changeSelection";
import { ChangelistStore } from "../../../src/changes/changelistStore";
import { changeFingerprint as hash, parseChangeDiff } from "../../../src/changes/parseDiff";
import { rangeSnapshot } from "../../../src/changes/rangeMapping";
import {
    MAX_PARTIAL_TEXT_BYTES,
    PartialChangesUnsupportedError,
} from "../../../src/git/partialSnapshot";
import { validSnapshot } from "../../../src/changes/rangeMetadata";
import { removeScratchDirectories } from "../../helpers/scratchDirectories";

vi.mock("node:fs/promises", async (importOriginal) => ({
    ...(await importOriginal<typeof import("node:fs/promises")>()),
}));

let root: string;
let gitDir: string;
beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "intelligit-range-storage-"));
    gitDir = path.join(root, ".git");
    await mkdir(gitDir);
});
afterEach(async () => {
    vi.restoreAllMocks();
    await removeScratchDirectories(root);
});

/** Produces validated ordinary-text evidence with one independently owned insertion. */
function snapshot(file: string, lineCount: number, version?: number) {
    const lines = Array.from({ length: lineCount }, (_, line) => `${file} line ${line}\n`);
    const base = lines.join("");
    const insertion = Math.floor(lineCount / 2);
    const added = `${file} inserted version ${version}\n`;
    const working =
        version === undefined
            ? base
            : [...lines.slice(0, insertion), added, ...lines.slice(insertion)].join("");
    const diff =
        version === undefined ? "" : `@@ -${insertion},0 +${insertion + 1},1 @@\n+${added}`;
    const blocks = parseChangeDiff(diff, base, working);
    expect(Buffer.byteLength(base)).toBeLessThan(MAX_PARTIAL_TEXT_BYTES);
    expect(Buffer.byteLength(working)).toBeLessThan(MAX_PARTIAL_TEXT_BYTES);
    const contentId = hash(JSON.stringify([base, working, blocks]));
    return rangeSnapshot({
        root,
        gitDir,
        commonDir: gitDir,
        indexPath: path.join(gitDir, "index"),
        head: "a".repeat(40),
        ref: "refs/heads/main",
        indexHash: hash(base),
        worktreeHash: hash(working),
        attributes: "",
        mode: "100644",
        indexed: base,
        working,
        contentId,
        view: { snapshotId: contentId, path: file, side: "working", base, blocks },
    });
}

describe("durable range evidence", () => {
    it("rejects fresh evidence over the byte budget as unsupported before publication", async () => {
        const evidence = snapshot("large.txt", 1);
        const lineHash = hash("line");
        evidence.baseLines = Array.from({ length: 100_000 }, () => lineHash);
        evidence.workingLines = [...evidence.baseLines];
        evidence.anchors = Array.from({ length: 100_000 }, (_, index) => ({
            id: `0:${index}`,
            fingerprint: hash(String(index)),
            kind: "remove" as const,
            line: index,
            hash: lineHash,
            context: [lineHash, lineHash, lineHash, lineHash, lineHash],
        }));
        expect(validSnapshot(evidence)).toBe(true);
        expect(Buffer.byteLength(JSON.stringify(evidence))).toBeGreaterThan(64 * 1024 * 1024);
        const persistence = await ChangelistPersistence.open(root, gitDir);

        await expect(persistence.storeSnapshot("large.txt", evidence)).rejects.toBeInstanceOf(
            PartialChangesUnsupportedError,
        );

        await expect(readFile(persistence.filename)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(readdir(persistence.evidenceDirectory)).rejects.toMatchObject({
            code: "ENOENT",
        });
    });

    it("aggregate range evidence does not block drafts or assignments", async () => {
        const fixtures = Array.from({ length: 32 }, (_, file) => ({
            file: `file-${file}.txt`,
            snapshots: [0, 1, 2].map((version) => snapshot(`file-${file}.txt`, 6_000, version)),
        }));
        const inlineEvidenceBytes = fixtures.reduce(
            (total, fixture) =>
                total +
                fixture.snapshots.reduce(
                    (bytes, value) => bytes + Buffer.byteLength(JSON.stringify(value)),
                    0,
                ),
            0,
        );
        expect(
            inlineEvidenceBytes,
            "real current and historical evidence must exceed the old aggregate budget",
        ).toBeGreaterThan(64 * 1024 * 1024);

        const store = new ChangelistStore();
        await store.connect(root, gitDir);
        let state = await store.create(root, store.get(root).revision, "Feature");
        const feature = state.lists[1].id;
        for (const [index, fixture] of fixtures.entries()) {
            for (const [version, current] of fixture.snapshots.entries()) {
                await expect(
                    store.track(root, fixture.file, current).then((next) => {
                        state = next;
                    }),
                    `aggregate evidence must not block tracking ${fixture.file} version ${version}`,
                ).resolves.toBeUndefined();
                if (index === 0 && version === 0) {
                    const fingerprints = current.anchors.map((anchor) => anchor.fingerprint);
                    state = await store.assignChanges(
                        root,
                        state.revision,
                        fixture.file,
                        current.contentId,
                        feature,
                        fingerprints,
                        new Set(fingerprints),
                    );
                    state = await store.recordSelection(
                        root,
                        fixture.file,
                        current.contentId,
                        "all",
                        [],
                        current.anchors.length,
                    );
                }
            }
        }
        await expect(
            store.saveDraft(root, "all", "", "Draft after tracking large files"),
            "aggregate evidence must not block a draft",
        ).resolves.toBeDefined();
        state = await store.moveFiles(root, store.get(root).revision, feature, [
            fixtures.at(-1)!.file,
        ]);
        expect(state.files[fixtures.at(-1)!.file]).toBe(feature);
        const reopened = new ChangelistStore();
        await reopened.connect(root, gitDir);
        const persisted = reopened.get(root);
        expect(reopened.draft(root, "all")).toBe("Draft after tracking large files");
        expect(Object.keys(persisted.files)).toHaveLength(32);
        for (const [index, fixture] of fixtures.entries()) {
            const ownership = persisted.changes[fixture.file];
            expect(ownership.contentId).toBe(fixture.snapshots[2].contentId);
            expect(ownership.stale).toBe(false);
            expect(ownership.history).toHaveLength(2);
            expect(persisted.files[fixture.file]).toBe(
                index === fixtures.length - 1 ? feature : "default",
            );
            expect(ownership.lines).toEqual(
                index === 0 ? { [fixture.snapshots[2].anchors[0].fingerprint]: feature } : {},
            );
        }
        expect(persisted.changes[fixtures[0].file].selections?.all).toEqual({
            contentId: fixtures[0].snapshots[2].contentId,
            lineIds: [],
            total: 1,
        });
    }, 180_000);

    it("restores historical ownership after reconnect and remaps a removed list before redo", async () => {
        const file = "owned.txt";
        const inserted = snapshot(file, 20, 0);
        const clean = snapshot(file, 20);
        const store = new ChangelistStore();
        await store.connect(root, gitDir);
        let state = await store.create(root, store.get(root).revision, "Feature");
        const feature = state.lists[1].id;
        state = await store.track(root, file, inserted);
        const fingerprints = inserted.anchors.map((anchor) => anchor.fingerprint);
        state = await store.assignChanges(
            root,
            state.revision,
            file,
            inserted.contentId,
            feature,
            fingerprints,
            new Set(fingerprints),
        );
        await store.recordSelection(root, file, inserted.contentId, "all", [], 1);
        await store.track(root, file, clean);

        const reopened = new ChangelistStore();
        await reopened.connect(root, gitDir);
        state = await reopened.track(root, file, inserted);
        expect(state.changes[file].lines).toEqual({ [fingerprints[0]]: feature });
        expect(state.changes[file].selections?.all.lineIds).toEqual([]);
        state = await reopened.track(root, file, clean);
        await reopened.remove(root, state.revision, feature);
        const afterRemoval = new ChangelistStore();
        await afterRemoval.connect(root, gitDir);
        state = await afterRemoval.track(root, file, inserted);
        expect(state.changes[file].lines).toEqual({});
        expect(state.files[file]).toBe("default");
        expect(state.changes[file].stale).toBe(false);
        expect(state.changes[file].selections?.all.lineIds).toEqual([]);
    });
});

/** Produces an old-format authoritative record with real full range evidence and mutable user intent. */
function legacyState(): HydratedChangelistState {
    const current = snapshot("legacy.txt", 20, 1);
    const previous = snapshot("legacy.txt", 20, 0);
    const state = new ChangelistStore().get(root);
    return {
        ...state,
        revision: 7,
        allDraft: "Legacy draft",
        files: { "legacy.txt": "default" },
        changes: {
            "legacy.txt": {
                contentId: current.contentId,
                lines: {},
                stale: false,
                totalChanges: 1,
                tracking: current,
                history: [{ snapshot: previous, lines: {} }],
                selections: { all: { contentId: current.contentId, lineIds: [], total: 1 } },
            },
        },
    };
}

/** Writes a legacy envelope as a simulated old client would, only in this test's temporary worktree. */
async function publishLegacy(
    persistence: ChangelistPersistence,
    state: HydratedChangelistState,
): Promise<string> {
    const bytes = JSON.stringify({
        schemaVersion: 3,
        root: persistence.root,
        gitDir: persistence.gitDir,
        state,
    });
    await writeFile(persistence.filename, bytes);
    return bytes;
}

/** Extracts public compact identities to verify the disk lifecycle without opening private store state. */
function liveBlobs(state: ChangelistState): string[] {
    return [
        ...new Set(
            Object.values(state.changes).flatMap((ownership) => [
                ...(ownership.tracking ? [ownership.tracking.blob] : []),
                ...(ownership.history ?? []).map((entry) => entry.snapshot.blob),
            ]),
        ),
    ]
        .map((blob) => `${blob}.json`)
        .sort();
}

describe("range evidence integrity and lifecycle", () => {
    it("binds detached evidence when the same live store first connects", async () => {
        const store = new ChangelistStore();
        const initial = snapshot("one.txt", 20, 0);
        await store.track(root, "one.txt", initial);
        const before = store.get(root);
        await expect(
            store.connect(root, gitDir),
            "detached snapshot identities must be replaced by durable file-bound evidence",
        ).resolves.toBeUndefined();
        expect(store.get(root).revision).toBe(before.revision);
        const reopened = new ChangelistStore();
        await reopened.connect(root, gitDir);
        expect(reopened.get(root).changes["one.txt"].contentId).toBe(initial.contentId);
        await expect(
            reopened.track(root, "one.txt", snapshot("one.txt", 20, 1)),
        ).resolves.toBeDefined();
    });

    it("warm metadata operations do not touch range payloads", async () => {
        const store = new ChangelistStore();
        await store.connect(root, gitDir);
        for (let file = 0; file < 4; file++)
            for (let version = 0; version < 3; version++)
                await store.track(root, `${file}.txt`, snapshot(`${file}.txt`, 40, version));
        const load = vi.spyOn(ChangelistPersistence.prototype, "loadSnapshot");
        const save = vi.spyOn(ChangelistPersistence.prototype, "storeSnapshot");
        const names = vi.spyOn(fs, "readdir");
        const stringify = vi.spyOn(JSON, "stringify");
        const clone = vi.spyOn(globalThis, "structuredClone");
        const revision = store.revision(root);
        clone.mockClear();
        for (let poll = 0; poll < 10; poll++) expect(store.revision(root)).toBe(revision);
        expect(clone, "revision polls must not clone metadata").not.toHaveBeenCalled();
        for (let read = 0; read < 3; read++) {
            store.get(root);
            store.view(root);
        }
        await store.saveDraft(root, "all", "", "Metadata only");
        expect(
            load,
            "warm metadata operations must read zero blob payloads",
        ).not.toHaveBeenCalled();
        expect(save, "a draft must publish zero blob payloads").not.toHaveBeenCalled();
        expect(names, "manifest publication checks names once, not payloads").toHaveBeenCalledTimes(
            1,
        );
        const payloads = [...stringify.mock.calls, ...clone.mock.calls].map(([value]) => value);
        stringify.mockRestore();
        clone.mockRestore();
        expect(
            payloads.every((value) => !JSON.stringify(value).includes('"baseLines"')),
            "global clone/stringify paths must contain only compact metadata",
        ).toBe(true);
        load.mockClear();
        save.mockClear();
        await store.track(root, "0.txt", snapshot("0.txt", 40, 3));
        expect(
            load.mock.calls.map(([file]) => file),
            "reconciling one file must not load unrelated evidence",
        ).toEqual(["0.txt", "0.txt", "0.txt"]);
        expect(
            save.mock.calls.map(([file]) => file),
            "unchanged history must not be republished",
        ).toEqual(["0.txt"]);
        const detached = store.get(root);
        detached.changes["0.txt"].tracking!.blob = "0".repeat(64);
        detached.changes["0.txt"].history![0].lines["f".repeat(64)] = "missing";
        expect(store.get(root).changes["0.txt"]).not.toEqual(detached.changes["0.txt"]);
        await expect(store.track(root, "0.txt", snapshot("0.txt", 40, 4))).resolves.toBeDefined();
    });

    it("upgrades schema 3 losslessly and retains exact recovery bytes", async () => {
        const persistence = await ChangelistPersistence.open(root, gitDir);
        const legacy = legacyState();
        const bytes = await publishLegacy(persistence, legacy);
        const store = new ChangelistStore();
        await store.connect(root, gitDir);
        const state = store.get(root);
        expect(state.revision).toBe(legacy.revision);
        expect(state.files).toEqual(legacy.files);
        expect(state.allDraft).toBe(legacy.allDraft);
        expect(state.changes["legacy.txt"].selections).toEqual(
            legacy.changes["legacy.txt"].selections,
        );
        expect(state.changes["legacy.txt"].history?.map((entry) => entry.lines)).toEqual([{}]);
        expect(
            await readFile(
                path.join(persistence.directory, `state-v3.${hash(bytes)}.backup.json`),
                "utf8",
            ),
        ).toBe(bytes);
        const manifest = await readFile(persistence.filename, "utf8");
        expect(JSON.parse(manifest).schemaVersion).toBe(5);
        expect(manifest).not.toContain('"baseLines"');
        const reopened = new ChangelistStore();
        await reopened.connect(root, gitDir);
        expect(reopened.get(root)).toEqual(state);
    });

    it("interrupted upgrade retains both legacy generations after an old-writer update", async () => {
        const persistence = await ChangelistPersistence.open(root, gitDir);
        const first = legacyState();
        const bytesA = await publishLegacy(persistence, first);
        const write = vi
            .spyOn(ChangelistPersistence.prototype, "write")
            .mockRejectedValueOnce(new Error("interrupt before manifest"));
        await expect(new ChangelistStore().connect(root, gitDir)).rejects.toThrow(
            "interrupt before manifest",
        );
        expect(await readFile(persistence.filename, "utf8")).toBe(bytesA);
        write.mockRestore();
        const second = { ...first, revision: 8, allDraft: "Old writer B" };
        const release = await persistence.acquire();
        let bytesB: string;
        try {
            bytesB = await publishLegacy(persistence, second);
        } finally {
            await release();
        }
        const unrelated = path.join(persistence.directory, "recovery-notes.txt");
        await writeFile(unrelated, "Keep this recovery evidence");
        const store = new ChangelistStore();
        await store.connect(root, gitDir);
        expect(store.get(root)).toMatchObject({
            revision: 8,
            allDraft: "Old writer B",
            files: second.files,
            lists: second.lists,
        });
        expect(store.get(root).changes["legacy.txt"].selections).toEqual(
            second.changes["legacy.txt"].selections,
        );
        await new ChangelistStore().connect(root, gitDir);
        for (const bytes of [bytesA, bytesB!])
            expect(
                await readFile(
                    path.join(persistence.directory, `state-v3.${hash(bytes)}.backup.json`),
                    "utf8",
                ),
            ).toBe(bytes);
        expect(await readFile(unrelated, "utf8")).toBe("Keep this recovery evidence");
    });

    it("refuses a corrupt matching legacy backup without changing either record", async () => {
        const persistence = await ChangelistPersistence.open(root, gitDir);
        const bytes = await publishLegacy(persistence, legacyState());
        const backup = path.join(persistence.directory, `state-v3.${hash(bytes)}.backup.json`);
        await writeFile(backup, "corrupt matching backup");
        await expect(new ChangelistStore().connect(root, gitDir)).rejects.toThrow(
            "requires review",
        );
        expect(await readFile(persistence.filename, "utf8")).toBe(bytes);
        expect(await readFile(backup, "utf8")).toBe("corrupt matching backup");
    });

    it("preserves disconnected workspace evidence and original migration seed proofs", async () => {
        const values = new Map<string, unknown>();
        const storage = {
            get: <T>(key: string) => values.get(key) as T | undefined,
            update: async (key: string, value: unknown) => {
                values.set(key, structuredClone(value));
            },
        };
        const first = new ChangelistStore(storage);
        await first.track(root, "legacy.txt", snapshot("legacy.txt", 20, 0));
        await first.saveDraft(root, "all", "", "Disconnected draft");
        const seed = structuredClone(values.get("intelligit.changelists.v1"));
        expect(JSON.stringify(seed)).toContain('"baseLines"');
        expect(JSON.stringify(first.get(root))).not.toContain('"baseLines"');
        const second = new ChangelistStore(storage);
        expect(second.get(root)).toEqual(first.get(root));
        await second.connect(root, gitDir);
        await second.saveDraft(root, "all", "Disconnected draft", "Durable draft");
        expect(storage.get("intelligit.changelists.v1")).toMatchObject({ schemaVersion: 5 });
        values.set("intelligit.changelists.v1", seed);
        const staleWorkspace = new ChangelistStore(storage);
        await staleWorkspace.connect(root, gitDir);
        expect(staleWorkspace.draft(root, "all")).toBe("Durable draft");
    });

    it.each(["root", "gitDir", "path", "digest", "snapshot", "header"] as const)(
        "refuses %s evidence tampering without replacing the manifest",
        async (field) => {
            const store = new ChangelistStore();
            await store.connect(root, gitDir);
            const state = await store.track(root, "one.txt", snapshot("one.txt", 20, 0));
            const persistence = await ChangelistPersistence.open(root, gitDir);
            const before = await readFile(persistence.filename, "utf8");
            const reference = { ...state.changes["one.txt"].tracking! };
            const originalFile = path.join(persistence.evidenceDirectory, `${reference.blob}.json`);
            const envelope = JSON.parse(await readFile(originalFile, "utf8"));
            if (field === "header") reference.head = "b".repeat(40);
            else if (field === "digest") reference.blob = "../outside";
            else {
                if (field === "snapshot") envelope.snapshot.baseLines = ["invalid"];
                else envelope[field] = `${envelope[field]}-other`;
                const bytes = JSON.stringify(envelope);
                reference.blob = hash(bytes);
                await writeFile(
                    path.join(persistence.evidenceDirectory, `${reference.blob}.json`),
                    bytes,
                );
            }
            await expect(persistence.loadSnapshot("one.txt", reference)).rejects.toThrow(
                "requires review",
            );
            expect(await readFile(persistence.filename, "utf8")).toBe(before);
        },
    );

    it("validates repeated digest headers in historical references on reconnect", async () => {
        const store = new ChangelistStore();
        await store.connect(root, gitDir);
        await store.track(root, "one.txt", snapshot("one.txt", 20, 0));
        const persistence = await ChangelistPersistence.open(root, gitDir);
        const envelope = JSON.parse(await readFile(persistence.filename, "utf8"));
        const ownership = envelope.state.changes["one.txt"];
        ownership.history = [
            { snapshot: { ...ownership.tracking, head: "b".repeat(40) }, lines: {} },
        ];
        const tampered = JSON.stringify(envelope);
        await writeFile(persistence.filename, tampered);
        await expect(new ChangelistStore().connect(root, gitDir)).rejects.toThrow(
            "requires review",
        );
        expect(await readFile(persistence.filename, "utf8")).toBe(tampered);
    });

    it.each(["missing", "truncated", "oversized"] as const)(
        "refuses %s accessed evidence and preserves the prior manifest",
        async (kind) => {
            const store = new ChangelistStore();
            await store.connect(root, gitDir);
            const state = await store.track(root, "one.txt", snapshot("one.txt", 20, 0));
            const persistence = await ChangelistPersistence.open(root, gitDir);
            const before = await readFile(persistence.filename, "utf8");
            const filename = path.join(
                persistence.evidenceDirectory,
                `${state.changes["one.txt"].tracking!.blob}.json`,
            );
            if (kind === "missing") await rm(filename);
            else if (kind === "truncated") await writeFile(filename, "{");
            else await truncate(filename, 64 * 1024 * 1024 + 1);
            await expect(store.track(root, "one.txt", snapshot("one.txt", 20, 1))).rejects.toThrow(
                "requires review",
            );
            expect(await readFile(persistence.filename, "utf8")).toBe(before);
            if (kind === "missing")
                await expect(
                    store.saveDraft(root, "all", "", "Cannot lose evidence"),
                ).rejects.toThrow("requires review");
            if (kind === "truncated") expect(await readFile(filename, "utf8")).toBe("{");
        },
    );

    it("does not overwrite corrupt content at an existing digest", async () => {
        const store = new ChangelistStore();
        await store.connect(root, gitDir);
        const current = snapshot("one.txt", 20, 0);
        const state = await store.track(root, "one.txt", current);
        const persistence = await ChangelistPersistence.open(root, gitDir);
        const filename = path.join(
            persistence.evidenceDirectory,
            `${state.changes["one.txt"].tracking!.blob}.json`,
        );
        await writeFile(filename, "corrupt payload");
        await expect(persistence.storeSnapshot("one.txt", current)).rejects.toThrow(
            "requires review",
        );
        expect(await readFile(filename, "utf8")).toBe("corrupt payload");
    });

    it.skipIf(process.platform === "win32")(
        "refuses symlinked evidence files and directories",
        async () => {
            const store = new ChangelistStore();
            await store.connect(root, gitDir);
            const state = await store.track(root, "one.txt", snapshot("one.txt", 20, 0));
            const persistence = await ChangelistPersistence.open(root, gitDir);
            const filename = path.join(
                persistence.evidenceDirectory,
                `${state.changes["one.txt"].tracking!.blob}.json`,
            );
            const outside = path.join(root, "outside.json");
            await writeFile(outside, await readFile(filename));
            await rm(filename);
            await symlink(outside, filename);
            await expect(new ChangelistStore().connect(root, gitDir)).rejects.toThrow(
                "requires review",
            );
            await removeScratchDirectories(persistence.evidenceDirectory);
            const other = path.join(root, "outside-evidence");
            await mkdir(other);
            await symlink(other, persistence.evidenceDirectory);
            await expect(store.track(root, "new.txt", snapshot("new.txt", 20, 0))).rejects.toThrow(
                "requires review",
            );
            expect(await readFile(outside, "utf8")).toContain('"snapshot"');
        },
    );

    it("keeps only current and two history payloads and removes interrupted orphans on reconnect", async () => {
        const store = new ChangelistStore();
        await store.connect(root, gitDir);
        let state = store.get(root);
        for (let version = 0; version < 7; version++)
            state = await store.track(root, "one.txt", snapshot("one.txt", 20, version));
        const persistence = await ChangelistPersistence.open(root, gitDir);
        expect((await readdir(persistence.evidenceDirectory)).sort()).toEqual(liveBlobs(state));
        expect(liveBlobs(state)).toHaveLength(3);
        const orphan = await persistence.storeSnapshot("orphan.txt", snapshot("orphan.txt", 20, 0));
        const unknown = path.join(persistence.evidenceDirectory, "user-notes.txt");
        await writeFile(unknown, "preserve");
        await new ChangelistStore().connect(root, gitDir);
        expect(await readdir(persistence.evidenceDirectory)).not.toContain(`${orphan.blob}.json`);
        expect(await readFile(unknown, "utf8")).toBe("preserve");
        expect(store.get(root)).toEqual(state);
    });

    it("keeps the old manifest when interrupted after blob durability and before manifest publication", async () => {
        const store = new ChangelistStore();
        await store.connect(root, gitDir);
        const before = await store.track(root, "one.txt", snapshot("one.txt", 20, 0));
        const write = vi
            .spyOn(ChangelistPersistence.prototype, "write")
            .mockRejectedValueOnce(new Error("manifest interruption"));
        await expect(store.track(root, "one.txt", snapshot("one.txt", 20, 1))).rejects.toThrow(
            "manifest interruption",
        );
        write.mockRestore();
        const reopened = new ChangelistStore();
        await reopened.connect(root, gitDir);
        expect(reopened.get(root)).toEqual(before);
        const persistence = await ChangelistPersistence.open(root, gitDir);
        expect((await readdir(persistence.evidenceDirectory)).sort()).toEqual(liveBlobs(before));
    });

    it("does not reject a published transaction when retired evidence cleanup fails", async () => {
        const store = new ChangelistStore();
        await store.connect(root, gitDir);
        for (let version = 0; version < 3; version++)
            await store.track(root, "one.txt", snapshot("one.txt", 20, version));
        const previous = store.get(root);
        const retired = previous.changes["one.txt"].history![1].snapshot.blob;
        const original = fs.rm;
        vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const remove = vi.spyOn(fs, "rm").mockImplementation(async (...args) => {
            if (String(args[0]).endsWith(`${retired}.json`))
                throw new Error("cleanup permission failure");
            return original(...args);
        });
        const next = await store.track(root, "one.txt", snapshot("one.txt", 20, 3));
        expect(next.revision).toBe(previous.revision + 1);
        remove.mockRestore();
        const reopened = new ChangelistStore();
        await reopened.connect(root, gitDir);
        expect(reopened.get(root)).toEqual(next);
    });

    it("holds the metadata lease throughout hydration and rejects a stale descriptor before loading", async () => {
        const first = new ChangelistStore();
        const second = new ChangelistStore();
        await first.connect(root, gitDir);
        await second.connect(root, gitDir);
        for (let version = 0; version < 3; version++)
            await first.track(root, "one.txt", snapshot("one.txt", 20, version));
        const before = first.get(root);
        let started!: () => void;
        const reading = new Promise<void>((resolve) => {
            started = resolve;
        });
        let resume!: () => void;
        const barrier = new Promise<void>((resolve) => {
            resume = resolve;
        });
        const original = ChangelistPersistence.prototype.loadSnapshot;
        let hold = true;
        const load = vi
            .spyOn(ChangelistPersistence.prototype, "loadSnapshot")
            .mockImplementation(async function (file, reference) {
                if (hold) {
                    hold = false;
                    started();
                    await barrier;
                }
                return original.call(this, file, reference);
            });
        const tracking = first.track(root, "one.txt", snapshot("one.txt", 20, 3));
        await reading;
        let attempted!: (outcome: string) => void;
        const waiting = new Promise<string>((resolve) => {
            attempted = resolve;
        });
        const acquire = RepositoryLock.prototype.acquire;
        const lock = vi
            .spyOn(RepositoryLock.prototype, "acquire")
            .mockImplementation(async function (...args) {
                try {
                    const release = await acquire.apply(this, args);
                    attempted("acquired");
                    return release;
                } catch (error) {
                    attempted("busy");
                    throw error;
                }
            });
        const draft = second.saveDraft(root, "all", "", "Waited for hydration");
        let outcome: string;
        try {
            outcome = await waiting;
        } finally {
            resume();
        }
        await tracking;
        await draft;
        lock.mockRestore();
        expect(
            outcome,
            "another writer must encounter the held metadata lease during hydration",
        ).toBe("busy");
        expect(second.draft(root, "all")).toBe("Waited for hydration");
        load.mockClear();
        await expect(
            first.track(root, "one.txt", snapshot("one.txt", 20, 4), before.revision),
        ).rejects.toThrow("changed");
        expect(
            load,
            "a stale observation must reject before opening retired evidence",
        ).not.toHaveBeenCalled();
    });
});

describe("range evidence publication failures", () => {
    it("rejects evidence read permission failures without changing the manifest", async () => {
        const store = new ChangelistStore();
        await store.connect(root, gitDir);
        const state = await store.track(root, "one.txt", snapshot("one.txt", 20, 0));
        const persistence = await ChangelistPersistence.open(root, gitDir);
        const before = await readFile(persistence.filename, "utf8");
        const blob = state.changes["one.txt"].tracking!.blob;
        const original = fs.open;
        vi.spyOn(fs, "open").mockImplementation(async (...args) => {
            if (String(args[0]).endsWith(`${blob}.json`))
                throw Object.assign(new Error("permission denied"), { code: "EACCES" });
            return original(...args);
        });
        await expect(store.track(root, "one.txt", snapshot("one.txt", 20, 1))).rejects.toThrow(
            "requires review",
        );
        expect(await readFile(persistence.filename, "utf8")).toBe(before);
    });

    it("bounds actual payload bytes if a file grows during the read", async () => {
        const store = new ChangelistStore();
        await store.connect(root, gitDir);
        const state = await store.track(root, "one.txt", snapshot("one.txt", 20, 0));
        const persistence = await ChangelistPersistence.open(root, gitDir);
        const before = await readFile(persistence.filename, "utf8");
        const filename = path.join(
            persistence.evidenceDirectory,
            `${state.changes["one.txt"].tracking!.blob}.json`,
        );
        const open = fs.open;
        vi.spyOn(fs, "open").mockImplementation(async (...args) => {
            const handle = await open(...args);
            if (String(args[0]) === filename) {
                const read = handle.read.bind(handle);
                vi.spyOn(handle, "read").mockImplementationOnce(async (...readArgs) => {
                    await truncate(filename, 64 * 1024 * 1024 + 1);
                    return read(...readArgs);
                });
            }
            return handle;
        });
        await expect(store.track(root, "one.txt", snapshot("one.txt", 20, 1))).rejects.toThrow(
            "requires review",
        );
        expect(await readFile(persistence.filename, "utf8")).toBe(before);
    });

    it("keeps the prior manifest if immutable blob publication fails", async () => {
        const store = new ChangelistStore();
        await store.connect(root, gitDir);
        const before = await store.track(root, "one.txt", snapshot("one.txt", 20, 0));
        const original = fs.link;
        const link = vi.spyOn(fs, "link").mockImplementation(async (...args) => {
            if (String(args[1]).includes(`${path.sep}evidence${path.sep}`))
                throw new Error("blob publication interrupted");
            return original(...args);
        });
        await expect(store.track(root, "one.txt", snapshot("one.txt", 20, 1))).rejects.toThrow(
            "requires review",
        );
        link.mockRestore();
        const reopened = new ChangelistStore();
        await reopened.connect(root, gitDir);
        expect(reopened.get(root)).toEqual(before);
    });

    it("publishes a manifest only after its new evidence and containing directory are durable", async () => {
        const store = new ChangelistStore();
        await store.connect(root, gitDir);
        const persistence = await ChangelistPersistence.open(root, gitDir);
        const events: string[] = [];
        const open = fs.open;
        vi.spyOn(fs, "open").mockImplementation(async (...args) => {
            const handle = await open(...args);
            const filename = String(args[0]);
            const sync = handle.sync.bind(handle);
            vi.spyOn(handle, "sync").mockImplementation(async () => {
                await sync();
                if (filename.startsWith(`${persistence.evidenceDirectory}${path.sep}`))
                    events.push("payload durable");
                if (filename === persistence.evidenceDirectory)
                    events.push("evidence directory durable");
            });
            return handle;
        });
        const rename = fs.rename;
        vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
            if (String(args[1]) === persistence.filename) {
                expect(
                    events,
                    "manifest publication must follow the payload durability barrier",
                ).toContain("payload durable");
                if (process.platform !== "win32")
                    expect(
                        events,
                        "manifest publication must follow the evidence-directory durability barrier",
                    ).toContain("evidence directory durable");
            }
            return rename(...args);
        });
        await store.track(root, "one.txt", snapshot("one.txt", 20, 0));
        const reopened = new ChangelistStore();
        await reopened.connect(root, gitDir);
        expect(reopened.get(root)).toEqual(store.get(root));
    });
});

describe.skipIf(process.platform === "win32")("evidence directory publication durability", () => {
    it("reestablishes the parent barrier when an empty evidence directory is recreated", async () => {
        const persistence = await ChangelistPersistence.open(root, gitDir);
        await persistence.write(new ChangelistStore().get(root));
        await removeScratchDirectories(persistence.evidenceDirectory);
        let parentSyncs = 0;
        const open = fs.open;
        vi.spyOn(fs, "open").mockImplementation(async (...args) => {
            const handle = await open(...args);
            if (String(args[0]) === persistence.directory) {
                const sync = handle.sync.bind(handle);
                vi.spyOn(handle, "sync").mockImplementation(async () => {
                    await sync();
                    parentSyncs++;
                });
            }
            return handle;
        });
        await persistence.storeSnapshot("one.txt", snapshot("one.txt", 20, 0));
        expect(parentSyncs, "a recreated directory must not reuse the old durability flag").toBe(1);
    });

    it("syncs the new evidence directory entry in its parent before manifest publication", async () => {
        const persistence = await ChangelistPersistence.open(root, gitDir);
        await publishLegacy(persistence, legacyState());
        const events: string[] = [];
        const mkdir = fs.mkdir;
        vi.spyOn(fs, "mkdir").mockImplementation(async (...args) => {
            const result = await mkdir(...args);
            if (String(args[0]) === persistence.evidenceDirectory) events.push("evidence created");
            return result;
        });
        const open = fs.open;
        vi.spyOn(fs, "open").mockImplementation(async (...args) => {
            const handle = await open(...args);
            if (String(args[0]) === persistence.directory) {
                const sync = handle.sync.bind(handle);
                vi.spyOn(handle, "sync").mockImplementation(async () => {
                    await sync();
                    events.push("parent durable");
                });
            }
            return handle;
        });
        const rename = fs.rename;
        vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
            if (String(args[1]) === persistence.filename) {
                const created = events.indexOf("evidence created");
                expect(
                    created,
                    "migration must create the evidence directory",
                ).toBeGreaterThanOrEqual(0);
                expect(
                    events.slice(created),
                    "the parent must persist the new evidence directory before manifest publication",
                ).toContain("parent durable");
            }
            return rename(...args);
        });
        await new ChangelistStore().connect(root, gitDir);
    });

    it("retains legacy state if syncing the newly created evidence directory entry fails", async () => {
        const persistence = await ChangelistPersistence.open(root, gitDir);
        const before = await publishLegacy(persistence, legacyState());
        let created = false;
        const mkdir = fs.mkdir;
        vi.spyOn(fs, "mkdir").mockImplementation(async (...args) => {
            const result = await mkdir(...args);
            if (String(args[0]) === persistence.evidenceDirectory) created = true;
            return result;
        });
        const open = fs.open;
        vi.spyOn(fs, "open").mockImplementation(async (...args) => {
            const handle = await open(...args);
            if (String(args[0]) === persistence.directory && created)
                vi.spyOn(handle, "sync").mockRejectedValueOnce(
                    new Error("parent durability failure"),
                );
            return handle;
        });
        await expect(new ChangelistStore().connect(root, gitDir)).rejects.toThrow(
            "requires review",
        );
        expect(created).toBe(true);
        expect(await readFile(persistence.filename, "utf8")).toBe(before);
        vi.restoreAllMocks();
        const recovered = new ChangelistStore();
        await recovered.connect(root, gitDir);
        expect(recovered.get(root).revision).toBe(7);
    });
});

/** More files than migration workers, so the grouped upgrade overlaps files and still queues some. */
const MIGRATED_FILES = 10;

/** A schema-3 record whose every file holds distinct tracked and historical evidence. */
function legacyFiles(count: number): HydratedChangelistState {
    const files: HydratedChangelistState["files"] = {};
    const changes: HydratedChangelistState["changes"] = {};
    for (let index = 0; index < count; index++) {
        const file = `migrated-${index}.txt`;
        const current = snapshot(file, 20, 1);
        files[file] = "default";
        changes[file] = {
            contentId: current.contentId,
            lines: {},
            stale: false,
            totalChanges: 1,
            tracking: current,
            history: [{ snapshot: snapshot(file, 20, 0), lines: {} }],
            selections: { all: { contentId: current.contentId, lineIds: [], total: 1 } },
        };
    }
    return { ...new ChangelistStore().get(root), revision: 7, files, changes };
}

/** Bounds a migration so a hang fails on a named deadline instead of the runner timeout. */
async function settle<T>(work: Promise<T>, label: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            work,
            new Promise<never>((_, reject) => {
                timer = setTimeout(
                    () => reject(new Error(`${label} did not settle within 15 s`)),
                    15_000,
                );
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

type CrashPoint = "payload" | "barrier" | "validation" | "collection";

/**
 * Logs durability events and models a power loss: an evidence entry linked after the last
 * completed evidence-directory fsync may vanish, so `powerLoss` removes every such entry.
 */
function durabilityLog(persistence: ChangelistPersistence, crash?: CrashPoint) {
    const events: string[] = [];
    const unsynced = new Set<string>();
    let links = 0;
    const { link, mkdir, open, rename } = fs;
    vi.spyOn(fs, "mkdir").mockImplementation(async (...args) => {
        const result = await mkdir(...args);
        if (String(args[0]) === persistence.evidenceDirectory) events.push("evidence created");
        return result;
    });
    vi.spyOn(fs, "link").mockImplementation(async (...args) => {
        const target = String(args[1]);
        const evidence = path.dirname(target) === persistence.evidenceDirectory;
        if (evidence && crash === "payload" && ++links === 3)
            throw new Error("crash after some payloads");
        await link(...args);
        if (!evidence) return;
        unsynced.add(target);
        events.push("payload linked");
    });
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        const handle = await open(...args);
        const filename = String(args[0]);
        const sync = handle.sync.bind(handle);
        vi.spyOn(handle, "sync").mockImplementation(async () => {
            if (filename !== persistence.evidenceDirectory) {
                await sync();
                if (filename === persistence.directory) events.push("parent durable");
                else if (path.dirname(filename) === persistence.evidenceDirectory)
                    events.push("payload durable");
                return;
            }
            if (crash === "barrier") throw new Error("crash before the evidence-directory barrier");
            const covered = [...unsynced];
            await sync();
            for (const name of covered) unsynced.delete(name);
            events.push("evidence directory durable");
        });
        return handle;
    });
    vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
        await rename(...args);
        if (String(args[1]) === persistence.filename) events.push("manifest published");
    });
    if (crash === "validation")
        vi.spyOn(ChangelistPersistence.prototype, "validateEvidence").mockRejectedValueOnce(
            new Error("crash after the evidence-directory barrier"),
        );
    if (crash === "collection")
        vi.spyOn(ChangelistPersistence.prototype, "collect").mockRejectedValueOnce(
            new Error("crash after manifest publication"),
        );
    return {
        events,
        count: (event: string) => events.filter((entry) => entry === event).length,
        /** Restores real I/O, then drops every directory entry no fsync has made durable. */
        async powerLoss() {
            vi.restoreAllMocks();
            for (const filename of unsynced) await rm(filename, { force: true });
            unsynced.clear();
        },
    };
}

/** One complete upgrade yields the expected state; the same legacy record is then restored on a clean disk. */
async function uninterruptedMigration(state: HydratedChangelistState): Promise<ChangelistState> {
    const persistence = await ChangelistPersistence.open(root, gitDir);
    await publishLegacy(persistence, state);
    const store = new ChangelistStore();
    await settle(store.connect(root, gitDir), "uninterrupted migration");
    const expected = store.get(root);
    await removeScratchDirectories(persistence.directory);
    await publishLegacy(await ChangelistPersistence.open(root, gitDir), state);
    return expected;
}

describe.skipIf(process.platform === "win32")("grouped migration durability", () => {
    it("syncs every payload but the evidence directory once per migration", async () => {
        const persistence = await ChangelistPersistence.open(root, gitDir);
        await publishLegacy(persistence, legacyFiles(MIGRATED_FILES));
        const log = durabilityLog(persistence);
        const store = new ChangelistStore();
        await settle(store.connect(root, gitDir), "migration");
        const payloads = liveBlobs(store.get(root)).length;
        expect(payloads, "each file contributes tracked and historical evidence").toBe(
            2 * MIGRATED_FILES,
        );
        expect(log.count("payload durable"), "each evidence payload keeps its own fsync").toBe(
            payloads,
        );
        expect(
            log.count("evidence directory durable"),
            "migration must fsync the evidence directory once, not once per payload",
        ).toBe(1);
        const created = log.events.indexOf("evidence created");
        const barrier = log.events.indexOf("evidence directory durable");
        expect(
            log.events.slice(created, barrier).filter((event) => event === "parent durable"),
            "a newly created evidence directory keeps exactly one parent barrier",
        ).toHaveLength(1);
    });

    it("publishes the schema-5 manifest only after the evidence-directory barrier", async () => {
        const persistence = await ChangelistPersistence.open(root, gitDir);
        await publishLegacy(persistence, legacyFiles(MIGRATED_FILES));
        const log = durabilityLog(persistence);
        await settle(new ChangelistStore().connect(root, gitDir), "migration");
        const lastPayload = log.events.lastIndexOf("payload linked");
        const manifest = log.events.indexOf("manifest published");
        expect(lastPayload, "migration must publish evidence").toBeGreaterThanOrEqual(0);
        expect(manifest, "the manifest must follow every payload").toBeGreaterThan(lastPayload);
        expect(
            log.events.slice(lastPayload, manifest),
            "the evidence-directory barrier must fall between the last payload and the manifest",
        ).toContain("evidence directory durable");
    });

    it("reuses already-published payloads and still covers them with the one barrier", async () => {
        const persistence = await ChangelistPersistence.open(root, gitDir);
        await publishLegacy(persistence, legacyFiles(MIGRATED_FILES));
        vi.spyOn(ChangelistPersistence.prototype, "validateEvidence").mockRejectedValueOnce(
            new Error("interrupted after payloads"),
        );
        await expect(
            settle(new ChangelistStore().connect(root, gitDir), "first migration"),
        ).rejects.toThrow("interrupted after payloads");
        vi.restoreAllMocks();
        const log = durabilityLog(persistence);
        await settle(new ChangelistStore().connect(root, gitDir), "repeated migration");
        expect(log.count("payload durable"), "byte-identical payloads must be reused").toBe(0);
        expect(
            log.count("evidence directory durable"),
            "reused names must still cross one evidence-directory barrier",
        ).toBe(1);
    });

    it("refuses a corrupt already-published payload instead of reusing it", async () => {
        const persistence = await ChangelistPersistence.open(root, gitDir);
        const legacy = await publishLegacy(persistence, legacyFiles(MIGRATED_FILES));
        vi.spyOn(ChangelistPersistence.prototype, "validateEvidence").mockRejectedValueOnce(
            new Error("interrupted after payloads"),
        );
        await expect(
            settle(new ChangelistStore().connect(root, gitDir), "first migration"),
        ).rejects.toThrow("interrupted after payloads");
        vi.restoreAllMocks();
        const [orphan] = await readdir(persistence.evidenceDirectory);
        await writeFile(path.join(persistence.evidenceDirectory, orphan), "corrupt orphan");
        await expect(
            settle(new ChangelistStore().connect(root, gitDir), "repeated migration"),
        ).rejects.toThrow("requires review");
        expect(await readFile(persistence.filename, "utf8")).toBe(legacy);
    });

    it.each(["payload", "barrier", "validation", "collection"] as const)(
        "a crash at %s leaves legacy or complete schema-5 state that restarts finish identically",
        async (crash) => {
            const expected = await uninterruptedMigration(legacyFiles(MIGRATED_FILES));
            const persistence = await ChangelistPersistence.open(root, gitDir);
            const legacy = await readFile(persistence.filename, "utf8");
            const log = durabilityLog(persistence, crash);
            const failure = await settle(
                new ChangelistStore().connect(root, gitDir).then(
                    () => undefined,
                    (error: unknown) => error,
                ),
                "interrupted migration",
            );
            const causes: string[] = [];
            for (let error = failure; error instanceof Error; error = error.cause)
                causes.push(error.message);
            expect(
                causes.some((message) => message.startsWith("crash")),
                `the injected crash must interrupt the migration, got ${JSON.stringify(causes)}`,
            ).toBe(true);
            await log.powerLoss();
            const saved = await readFile(persistence.filename, "utf8");
            const manifest = JSON.parse(saved) as { schemaVersion: number; state: ChangelistState };
            if (manifest.schemaVersion === 5) {
                const names = new Set(await readdir(persistence.evidenceDirectory));
                expect(
                    liveBlobs(manifest.state).filter((name) => !names.has(name)),
                    "a durable manifest must never reference evidence a power loss dropped",
                ).toEqual([]);
            } else
                expect(saved, "an incomplete migration must keep the complete legacy record").toBe(
                    legacy,
                );
            for (const attempt of ["first restart", "second restart"]) {
                const restarted = new ChangelistStore();
                await settle(restarted.connect(root, gitDir), attempt);
                expect(
                    restarted.get(root),
                    `the ${attempt} must load the uninterrupted migration's state`,
                ).toEqual(expected);
            }
        },
    );
});

/** Fails one evidence write mid-batch and records what was still running at release and at rejection. */
async function failMidBatch(
    state: HydratedChangelistState,
    failing: string,
    delayMs: (snapshot: RangeSnapshot) => number,
) {
    const persistence = await ChangelistPersistence.open(root, gitDir);
    const legacy = await publishLegacy(persistence, state);
    const running = new Map<string, number>();
    const writes = () => [...running.values()].reduce((total, count) => total + count, 0);
    let peakFiles = 0;
    const storeSnapshot = ChangelistPersistence.prototype.storeSnapshot;
    vi.spyOn(ChangelistPersistence.prototype, "storeSnapshot").mockImplementation(async function (
        this: ChangelistPersistence,
        file: string,
        value: RangeSnapshot,
    ) {
        running.set(file, (running.get(file) ?? 0) + 1);
        peakFiles = Math.max(peakFiles, running.size);
        try {
            if (value.contentId === failing) throw new Error("evidence write failed mid-batch");
            await new Promise((resolve) => setTimeout(resolve, delayMs(value)));
            return await storeSnapshot.call(this, file, value);
        } finally {
            const left = running.get(file)! - 1;
            if (left) running.set(file, left);
            else running.delete(file);
        }
    });
    const atRelease: number[] = [];
    const acquire = ChangelistPersistence.prototype.acquire;
    vi.spyOn(ChangelistPersistence.prototype, "acquire").mockImplementation(async function (
        this: ChangelistPersistence,
    ) {
        const release = await acquire.call(this);
        return async () => {
            atRelease.push(writes());
            await release();
        };
    });
    const outcome = await settle(
        new ChangelistStore().connect(root, gitDir).then(
            () => ({ error: undefined, atRejection: writes() }),
            (error: unknown) => ({ error, atRejection: writes() }),
        ),
        "failed migration",
    );
    vi.restoreAllMocks();
    expect(outcome.error, "the injected write failure must surface").toMatchObject({
        message: "evidence write failed mid-batch",
    });
    expect(await readFile(persistence.filename, "utf8")).toBe(legacy);
    return { ...outcome, atRelease, peakFiles };
}

describe("grouped migration failure draining", () => {
    it("drains every in-flight file before a failure releases the metadata lease", async () => {
        const state = legacyFiles(12);
        const result = await failMidBatch(
            state,
            state.changes["migrated-0.txt"].tracking!.contentId,
            () => 100,
        );
        expect(
            result.atRelease,
            "the metadata lease must be released only after every worker drained",
        ).toEqual([0]);
        expect(
            result.atRejection,
            "no evidence write may still be running when the failure surfaces",
        ).toBe(0);
        expect(result.peakFiles, "migration must publish files in parallel").toBeGreaterThan(1);
        expect(
            result.peakFiles,
            "migration must never run more than eight files at once",
        ).toBeLessThanOrEqual(8);
    });

    it("drains a failed file's own sibling history writes before releasing the lease", async () => {
        const state = legacyFiles(1);
        const ownership = state.changes["migrated-0.txt"];
        const late = snapshot("migrated-0.txt", 20, 2);
        const failing = ownership.history![0].snapshot.contentId;
        ownership.history = [{ snapshot: late, lines: {} }, ...ownership.history!];
        const result = await failMidBatch(state, failing, (value) =>
            value.contentId === late.contentId ? 300 : 0,
        );
        expect(
            result.atRelease,
            "a sibling history write must finish before the lease is released",
        ).toEqual([0]);
        expect(result.atRejection, "no sibling history write may outlive the failure").toBe(0);
    });
});
