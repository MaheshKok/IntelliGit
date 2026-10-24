import { execFileSync } from "node:child_process";
import {
    chmod,
    lstat,
    mkdir,
    mkdtemp,
    readFile,
    symlink,
    unlink,
    utimes,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ShelfCaptureDependencies } from "../../../src/services/shelfServiceCapture";
import { readPartialSnapshot } from "../../../src/git/partialSnapshot";
import { selectedContent } from "../../../src/changes/selection";
import {
    captureSelectedShelf,
    type WholeShelfEntry,
} from "../../../src/services/shelfSelectedCapture";
import {
    createShelfFixture,
    createSecondService,
    cleanTemporaryRepositories,
    git,
    indexSnapshot,
} from "./shelfTestHarness";
import { removeScratchDirectories } from "../../helpers/scratchDirectories";
import { connectedChangelists } from "../../helpers/connectedChangelists";

const extra: string[] = [];
afterEach(async () => {
    vi.restoreAllMocks();
    await cleanTemporaryRepositories();
    await removeScratchDirectories(...extra.splice(0));
});
const lists = [
    { id: "default", name: "प्रथम", description: "First", draft: "Draft α\n" },
    {
        id: "12345678-1234-1234-1234-123456789abc",
        name: "第二",
        description: "Second",
        draft: "Draft β\r\n",
    },
];

async function selectedFixture(base = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\n") {
    const fixture = await createShelfFixture({ initialFiles: { "α.txt": base, "第二.txt": base } });
    await fixture.store.withLock(() => fixture.store.migrateWithHeldLocks());
    const changelists = await connectedChangelists(fixture.root);
    await changelists.edit(
        fixture.root,
        changelists.get(fixture.root).revision,
        "default",
        lists[0].name,
        lists[0].description,
    );
    await changelists.create(
        fixture.root,
        changelists.get(fixture.root).revision,
        lists[1].name,
        lists[1].description,
    );
    const ids = changelists.get(fixture.root).lists.map((list) => list.id);
    for (const [index, id] of ids.entries())
        await changelists.saveDraft(fixture.root, id, "", lists[index].draft);
    await changelists.saveDraft(fixture.root, "all", "", "All draft");
    const sourceLists = changelists.get(fixture.root).lists.map((list) => ({
        ...list,
        description: list.description ?? "",
        draft: list.draft ?? "",
    }));
    const directory = await mkdtemp(path.join(tmpdir(), "selected-capture-proof-"));
    extra.push(directory);
    const selected = [];
    for (const [index, file] of ["α.txt", "第二.txt"].entries()) {
        await writeFile(
            path.join(fixture.root, file),
            base.replace("two", `selected-${index}`).replace("eight", `unselected-${index}`),
        );
        const snapshot = await readPartialSnapshot(fixture.executor, fixture.root, file, "working");
        const lines = snapshot.view.blocks
            .flatMap((block) => block.lines)
            .filter(
                (line) =>
                    line.kind !== "context" &&
                    (line.text.includes("two") ||
                        (line.text.includes("selected-") && !line.text.includes("unselected-"))),
            );
        const lineIds = lines.map((line) => line.id);
        const content = selectedContent(snapshot.view.base, snapshot.view.blocks, lineIds);
        for (const prefix of ["a", "b"])
            await mkdir(path.join(directory, prefix), { recursive: true });
        await writeFile(path.join(directory, "a", file), base);
        await writeFile(path.join(directory, "b", file), content);
        let patch: Buffer;
        try {
            patch = execFileSync(
                "git",
                ["diff", "--no-index", "--no-prefix", "--", `a/${file}`, `b/${file}`],
                { cwd: directory },
            );
        } catch (error) {
            patch = (error as { status: number; stdout: Buffer }).stdout;
        }
        selected.push({
            snapshot,
            lineIds,
            patch,
            owners: Object.fromEntries(
                lines.map((line) => [line.fingerprint, sourceLists[index].id]),
            ),
        });
    }
    return {
        ...fixture,
        sourceLists,
        changelists,
        directory,
        selected,
        base,
        request: {
            name: "選択",
            baseCommit: selected[0].snapshot.head,
            scope: "selection" as const,
            sourceLists,
            scopeDraft: "All draft",
            selected,
            whole: [],
        },
    };
}

describe("nondestructive list-aware capture", () => {
    it.each([
        "missing evidence",
        "mismatched owners",
        "wrong evidence path",
        "indexed evidence",
    ] as const)("refuses whole mixed-owner %s before object writes", async (kind) => {
        const fixture = await selectedFixture();
        const first = fixture.selected[0];
        if (kind === "indexed evidence") {
            await git(fixture.root, ["add", "--", first.snapshot.view.path]);
            first.snapshot = await readPartialSnapshot(
                fixture.executor,
                fixture.root,
                first.snapshot.view.path,
                "index",
            );
            fixture.selected[1].snapshot = await readPartialSnapshot(
                fixture.executor,
                fixture.root,
                fixture.selected[1].snapshot.view.path,
                "working",
            );
        }
        const lines = first.snapshot.view.blocks
            .flatMap((block) => block.lines)
            .filter((line) => line.kind !== "context");
        const owners = Object.fromEntries(
            lines.map((line, index) => [line.fingerprint, fixture.sourceLists[index % 2].id]),
        );
        const whole: WholeShelfEntry = {
            path: first.snapshot.view.path,
            sourceListIds: fixture.sourceLists.map((list) => list.id),
            ownership:
                kind === "missing evidence"
                    ? undefined
                    : {
                          snapshot:
                              kind === "wrong evidence path"
                                  ? fixture.selected[1].snapshot
                                  : first.snapshot,
                          owners:
                              kind === "mismatched owners"
                                  ? Object.fromEntries(
                                        lines.map((line) => [line.fingerprint, "default"]),
                                    )
                                  : owners,
                      },
        };
        const write = vi.spyOn(fixture.store, "putObject");
        await expect(
            fixture.store.withLock(() =>
                captureSelectedShelf(
                    { ...fixture.request, selected: [fixture.selected[1]], whole: [whole] },
                    {
                        repositoryRoot: fixture.root,
                        executor: fixture.executor,
                        store: fixture.store,
                        recordBaseRevisions: true,
                        materializeEntry: async () => undefined,
                    },
                ),
            ),
        ).rejects.toThrow();
        expect(write).not.toHaveBeenCalled();
    });

    it("refuses a source changed during object persistence before publishing any pointer", async () => {
        const fixture = await selectedFixture();
        const put = fixture.store.putObject.bind(fixture.store);
        vi.spyOn(fixture.store, "putObject").mockImplementationOnce(async (...args) => {
            const result = await put(...args);
            await writeFile(
                path.join(fixture.root, fixture.selected[0].snapshot.view.path),
                "changed during capture\n",
            );
            return result;
        });
        const publish = vi.spyOn(fixture.store, "writeShelfGeneration");
        await expect(
            fixture.store.withLock(() =>
                captureSelectedShelf(fixture.request, {
                    repositoryRoot: fixture.root,
                    executor: fixture.executor,
                    store: fixture.store,
                    recordBaseRevisions: true,
                    materializeEntry: async () => undefined,
                }),
            ),
        ).rejects.toThrow("file, index or branch changed");
        expect(publish).not.toHaveBeenCalled();
        expect((await fixture.store.listShelves()).shelfIds).toEqual([]);
    });

    it("captures indexed text selections against indexed ownership anchors despite later worktree edits", async () => {
        const fixture = await selectedFixture();
        await git(fixture.root, [
            "add",
            "--",
            ...fixture.selected.map((entry) => entry.snapshot.view.path),
        ]);
        await writeFile(
            path.join(fixture.root, fixture.selected[0].snapshot.view.path),
            "later worktree content\n",
        );
        for (const entry of fixture.selected)
            entry.snapshot = await readPartialSnapshot(
                fixture.executor,
                fixture.root,
                entry.snapshot.view.path,
                "index",
            );
        const result = await fixture.store.withLock(() =>
            captureSelectedShelf(fixture.request, {
                repositoryRoot: fixture.root,
                executor: fixture.executor,
                store: fixture.store,
                recordBaseRevisions: true,
                materializeEntry: async () => undefined,
            }),
        );
        const manifest = await fixture.store.readCurrentShelfManifest(result.shelfId);
        const provenance = manifest.metadata.selection!.entries[0];
        const ownership = JSON.parse(
            (
                await fixture.store.readObject(result.shelfId, provenance.ownershipObjectHash!)
            ).toString(),
        );
        expect(ownership.lines).toEqual(fixture.selected[0].owners);
        expect(
            await fixture.store.readObject(
                result.shelfId,
                manifest.files[0].worktreeBlock!.patchObjectHash!,
            ),
        ).toEqual(fixture.selected[0].patch);
        expect(
            await readFile(path.join(fixture.root, fixture.selected[0].snapshot.view.path), "utf8"),
        ).toBe("later worktree content\n");
    });

    it.each([
        "duplicate",
        "stale selection",
        "stale worktree",
        "different base",
        "nonselected patch",
        "dangling owner",
        "missing owner",
        "extra owner",
        "wrong patch path",
        "invalid draft",
        "oversized",
        "mode change",
        "malformed patch",
    ] as const)("refuses %s before any generation publication", async (kind) => {
        const fixture = await selectedFixture();
        const request = {
            ...fixture.request,
            selected: fixture.selected.map((entry) => ({ ...entry, owners: { ...entry.owners } })),
        };
        const entry = request.selected[0];
        if (kind === "duplicate") request.selected.push(entry);
        if (kind === "stale selection") entry.lineIds = ["999:999"];
        if (kind === "stale worktree")
            await writeFile(path.join(fixture.root, entry.snapshot.view.path), "changed again\n");
        if (kind === "different base") request.baseCommit = "a".repeat(40);
        if (kind === "nonselected patch")
            entry.patch = await git(fixture.root, ["diff", "--", entry.snapshot.view.path]);
        if (kind === "dangling owner")
            entry.owners[Object.keys(entry.owners)[0]] = "87654321-4321-4321-4321-cba987654321";
        if (kind === "missing owner") delete entry.owners[Object.keys(entry.owners)[0]];
        if (kind === "extra owner") entry.owners["a".repeat(64)] = "default";
        if (kind === "wrong patch path") entry.patch = request.selected[1].patch;
        if (kind === "invalid draft")
            request.sourceLists = [
                { ...fixture.sourceLists[0], draft: "x".repeat(100_001) },
                fixture.sourceLists[1],
            ];
        if (kind === "oversized") entry.patch = Buffer.alloc(33 * 1024 * 1024);
        if (kind === "mode change")
            entry.patch = Buffer.from(
                entry.patch
                    .toString()
                    .replace("index ", "old mode 100644\nnew mode 100755\nindex "),
            );
        if (kind === "malformed patch")
            entry.patch = Buffer.from(
                entry.patch.toString().replace(/@@ -(\d+)(?:,\d+)? /, "@@ -$1,999 "),
            );
        const publish = vi.spyOn(fixture.store, "writeShelfGeneration");
        const object = vi.spyOn(fixture.store, "putObject");
        await expect(
            fixture.store.withLock(() =>
                captureSelectedShelf(request, {
                    repositoryRoot: fixture.root,
                    executor: fixture.executor,
                    store: fixture.store,
                    recordBaseRevisions: true,
                    materializeEntry: async () => undefined,
                }),
            ),
        ).rejects.toThrow(
            kind === "nonselected patch"
                ? "Selected patch contains different or non-selected changes."
                : undefined,
        );
        expect(publish).not.toHaveBeenCalled();
        expect(object).not.toHaveBeenCalled();
        expect((await fixture.store.listShelves()).shelfIds).toEqual([]);
    });

    it.each([true, false])(
        "preserves CRLF and missing-final-newline bytes with recordBase=%s",
        async (recordBaseRevisions) => {
            const fixture = await selectedFixture(
                "one\r\ntwo\r\nthree\r\nfour\r\nfive\r\nsix\r\nseven\r\neight\r\nnine",
            );
            const result = await fixture.store.withLock(() =>
                captureSelectedShelf(fixture.request, {
                    repositoryRoot: fixture.root,
                    executor: fixture.executor,
                    store: fixture.store,
                    recordBaseRevisions,
                    materializeEntry: async () => undefined,
                }),
            );
            const manifest = await fixture.store.readCurrentShelfManifest(result.shelfId);
            for (const entry of manifest.files) {
                expect(entry.baseAvailability).toBe(recordBaseRevisions ? "full" : "history");
                expect(Boolean(entry.worktreeBlock?.baseObjectHash)).toBe(recordBaseRevisions);
                if (entry.worktreeBlock?.baseObjectHash)
                    expect(
                        await fixture.store.readObject(
                            result.shelfId,
                            entry.worktreeBlock.baseObjectHash,
                        ),
                    ).toEqual(Buffer.from(fixture.base));
                expect(
                    await fixture.store.readObject(
                        result.shelfId,
                        entry.worktreeBlock!.patchObjectHash!,
                    ),
                ).toEqual(
                    fixture.selected.find(
                        (item) => item.snapshot.view.path === entry.worktreeBlock!.path,
                    )!.patch,
                );
            }
        },
    );

    it("assembles staged whole-file layers and selected text in one generation", async () => {
        const fixture = await selectedFixture();
        const file = fixture.selected[0].snapshot.view.path;
        await git(fixture.root, ["add", "--", file]);
        await writeFile(path.join(fixture.root, file), "working after staged\n");
        const selected = fixture.selected[1];
        selected.snapshot = await readPartialSnapshot(
            fixture.executor,
            fixture.root,
            selected.snapshot.view.path,
            "working",
        );
        const indexPatch = await git(fixture.root, [
            "diff",
            "--cached",
            "--binary",
            "--full-index",
            "-M",
            "--no-textconv",
            "--no-ext-diff",
            "--no-color",
            "--",
            file,
        ]);
        const worktreePatch = await git(fixture.root, [
            "diff",
            "--binary",
            "--full-index",
            "-M",
            "--no-textconv",
            "--no-ext-diff",
            "--no-color",
            "--",
            file,
        ]);
        const result = await fixture.store.withLock(() =>
            captureSelectedShelf(
                {
                    ...fixture.request,
                    selected: [selected],
                    whole: [{ path: file, sourceListIds: [fixture.sourceLists[0].id] }],
                },
                {
                    repositoryRoot: fixture.root,
                    executor: fixture.executor,
                    store: fixture.store,
                    recordBaseRevisions: true,
                    materializeEntry: async () => undefined,
                },
            ),
        );
        const manifest = await fixture.store.readCurrentShelfManifest(result.shelfId);
        expect(manifest.generation).toBe(1);
        expect(manifest.files).toHaveLength(2);
        const whole = manifest.files.find((entry) => entry.indexBlock?.path === file)!;
        expect(
            await fixture.store.readObject(result.shelfId, whole.indexBlock!.patchObjectHash!),
        ).toEqual(indexPatch);
        expect(
            await fixture.store.readObject(result.shelfId, whole.worktreeBlock!.patchObjectHash!),
        ).toEqual(worktreePatch);
        expect(
            manifest.metadata.selection!.entries.find((entry) => entry.changeId === whole.changeId)!
                .sourceListIds,
        ).toEqual([fixture.sourceLists[0].id]);
    });

    it("whole mixed-owner text retains every owner and immutable source anchor", async () => {
        const fixture = await selectedFixture();
        const first = fixture.selected[0];
        const lines = first.snapshot.view.blocks
            .flatMap((block) => block.lines)
            .filter((line) => line.kind !== "context");
        const owners = Object.fromEntries(
            lines.map((line, index) => [line.fingerprint, fixture.sourceLists[index % 2].id]),
        );
        const result = await fixture.store.withLock(() =>
            captureSelectedShelf(
                {
                    ...fixture.request,
                    selected: [fixture.selected[1]],
                    whole: [
                        {
                            path: first.snapshot.view.path,
                            sourceListIds: fixture.sourceLists.map((list) => list.id),
                            ownership: { snapshot: first.snapshot, owners },
                        },
                    ],
                },
                {
                    repositoryRoot: fixture.root,
                    executor: fixture.executor,
                    store: fixture.store,
                    recordBaseRevisions: true,
                    materializeEntry: async () => undefined,
                },
            ),
        );
        const manifest = await fixture.store.readCurrentShelfManifest(result.shelfId);
        const entry = manifest.metadata.selection!.entries.find(
            (entry) => entry.sourceListIds.length === 2,
        )!;
        const evidence = JSON.parse(
            (await fixture.store.readObject(result.shelfId, entry.ownershipObjectHash!)).toString(),
        );
        expect(evidence.lines).toEqual(owners);
        expect(evidence.tracking.anchors).toHaveLength(lines.length);
    });

    it("rename and lifecycle preserve provenance while plain patch import invents none", async () => {
        const fixture = await selectedFixture();
        const result = await fixture.store.withLock(() =>
            captureSelectedShelf(fixture.request, {
                repositoryRoot: fixture.root,
                executor: fixture.executor,
                store: fixture.store,
                recordBaseRevisions: true,
                materializeEntry: async () => undefined,
            }),
        );
        const original = await fixture.store.readCurrentShelfManifest(result.shelfId);
        await fixture.service.renameShelf({ id: result.shelfId, name: "renamed" });
        const renamed = await fixture.store.readCurrentShelfManifest(result.shelfId);
        await fixture.store.writeShelfGeneration(result.shelfId, {
            ...renamed,
            metadata: { ...renamed.metadata, lifecycle: "retained" },
        });
        const retained = await fixture.store.readCurrentShelfManifest(result.shelfId);
        expect(retained.metadata.selection).toEqual(original.metadata.selection);
        const patch = await fixture.service.exportPatch({ id: result.shelfId });
        expect(patch).toEqual(Buffer.concat(fixture.selected.map((entry) => entry.patch)));
        expect(await fixture.store.readCurrentShelfManifest(result.shelfId)).toEqual(retained);
        const file = path.join(fixture.directory, "plain.patch");
        await writeFile(file, patch);
        const destination = await createShelfFixture();
        const imported = await destination.service.importPatch({ fileUris: [file] });
        const manifest = await destination.store.readCurrentShelfManifest(imported.shelfId!);
        expect(manifest.files).toHaveLength(2);
        expect(manifest.metadata.selection).toBeUndefined();
    });

    it("captures two selected paths once with exact patches, immutable ownership and distinct drafts", async () => {
        const fixture = await selectedFixture();
        const before = {
            metadata: await readFile(
                path.join(fixture.root, ".git/intelligit/changelists/state.json"),
            ),
            rawIndex: await readFile(path.join(fixture.root, ".git/index")),
            head: await git(fixture.root, ["rev-parse", "HEAD"]),
            index: await indexSnapshot(fixture.root),
            files: await Promise.all(
                fixture.selected.map((entry) =>
                    readFile(path.join(fixture.root, entry.snapshot.view.path)),
                ),
            ),
        };
        const result = await fixture.store.withLock(() =>
            captureSelectedShelf(fixture.request, {
                repositoryRoot: fixture.root,
                executor: fixture.executor,
                store: fixture.store,
                recordBaseRevisions: true,
                materializeEntry: async () => undefined,
            }),
        );
        const reopened = await createSecondService(fixture.root, fixture.storageRoot);
        const listing = await reopened.store.listShelves();
        expect(listing.shelfIds).toEqual([result.shelfId]);
        const manifest = await reopened.store.readCurrentShelfManifest(result.shelfId);
        expect(manifest.generation).toBe(1);
        expect(manifest.files).toHaveLength(2);
        expect(new Set(manifest.files.map((entry) => entry.changeId)).size).toBe(2);
        expect(manifest.metadata.selection?.sourceLists).toEqual(fixture.sourceLists);
        expect(manifest.metadata.selection?.scopeDraft).toBe("All draft");
        const target = path.join(fixture.directory, "apply");
        await mkdir(target);
        for (const selected of fixture.selected) {
            const file = manifest.files.find(
                (entry) => entry.worktreeBlock?.path === selected.snapshot.view.path,
            )!;
            const patch = await reopened.store.readObject(
                result.shelfId,
                file.worktreeBlock!.patchObjectHash!,
            );
            expect(patch).toEqual(selected.patch);
            const provenance = manifest.metadata.selection!.entries.find(
                (entry) => entry.changeId === file.changeId,
            )!;
            expect(provenance.ownershipObjectHash).toBeTypeOf("string");
            expect(provenance.ownershipObjectHash).toMatch(/^[a-f0-9]{64}$/);
            const ownership = JSON.parse(
                (
                    await reopened.store.readObject(result.shelfId, provenance.ownershipObjectHash!)
                ).toString(),
            );
            expect(ownership.lines).toEqual(selected.owners);
            expect(ownership.tracking.anchors.map((anchor: { id: string }) => anchor.id)).toEqual(
                selected.lineIds,
            );
            await writeFile(path.join(target, selected.snapshot.view.path), fixture.base);
            execFileSync("git", ["apply", "--check", "-"], { cwd: target, input: patch });
            execFileSync("git", ["apply", "-"], { cwd: target, input: patch });
            expect(await readFile(path.join(target, selected.snapshot.view.path), "utf8")).toBe(
                selectedContent(
                    selected.snapshot.view.base,
                    selected.snapshot.view.blocks,
                    selected.lineIds,
                ),
            );
        }
        expect(await git(fixture.root, ["rev-parse", "HEAD"])).toEqual(before.head);
        expect(
            await readFile(path.join(fixture.root, ".git/intelligit/changelists/state.json")),
        ).toEqual(before.metadata);
        expect(await indexSnapshot(fixture.root)).toEqual(before.index);
        expect(await readFile(path.join(fixture.root, ".git/index"))).toEqual(before.rawIndex);
        expect(
            await Promise.all(
                fixture.selected.map((entry) =>
                    readFile(path.join(fixture.root, entry.snapshot.view.path)),
                ),
            ),
        ).toEqual(before.files);
    });
});

describe("whole capture source freshness", () => {
    it.for([
        ["working", "first", true],
        ["HEAD", "first", true],
        ["index", "first", true],
        ["working", "last", false],
        ["HEAD", "last", false],
        ["index", "last", false],
        ["mode", "first", false],
        ["type", "first", false],
        ["rename source", "first", false],
    ] as const)(
        "refuses whole-only %s drift after %s object (materialize=%s)",
        async ([change, timing, materialize], { skip }) => {
            skip(
                process.platform === "win32" && change === "mode",
                "chmod cannot set an execute bit on Windows, so there is no mode drift to refuse",
            );
            const fixture = await createShelfFixture({
                initialFiles: { "tracked.txt": "base\n", "other.txt": "other\n" },
            });
            await fixture.store.withLock(() => fixture.store.migrateWithHeldLocks());
            const renamed = change === "rename source";
            if (renamed) {
                await git(fixture.root, ["config", "status.renames", "false"]);
                await git(fixture.root, ["mv", "tracked.txt", "renamed.txt"]);
            }
            const file = renamed ? "renamed.txt" : "tracked.txt";
            if (!renamed) await writeFile(path.join(fixture.root, file), "captured\n");
            const baseCommit = (await git(fixture.root, ["rev-parse", "HEAD"])).toString().trim();
            const indexPath = path.join(fixture.root, ".git/index");
            let externalHead: Buffer | undefined;
            let externalIndex: Buffer | undefined;
            let externalBytes: Buffer | undefined;
            let externalMode: number | undefined;
            const object = fixture.store.putObject.bind(fixture.store);
            let writes = 0;
            let immutable: { shelfId: string; hash: string; bytes: Buffer } | undefined;
            vi.spyOn(fixture.store, "putObject").mockImplementation(async (...args) => {
                const result = await object(...args);
                immutable ??= { shelfId: args[0], hash: result.hash, bytes: Buffer.from(args[1]) };
                // One patch followed by its historical base; the rename also has exactly two objects.
                if (++writes !== (timing === "first" ? 1 : 2)) return result;
                if (change === "working")
                    await writeFile(path.join(fixture.root, file), "external newer bytes\n");
                if (change === "HEAD") {
                    const tree = (await git(fixture.root, ["rev-parse", "HEAD^{tree}"]))
                        .toString()
                        .trim();
                    const commit = (
                        await git(fixture.root, [
                            "commit-tree",
                            tree,
                            "-p",
                            baseCommit,
                            "-m",
                            "external HEAD",
                        ])
                    )
                        .toString()
                        .trim();
                    await git(fixture.root, ["update-ref", "HEAD", commit]);
                }
                // Staging the captured bytes moves only its index entry; the worktree bytes stay put.
                if (change === "index") await git(fixture.root, ["add", "--", file]);
                if (change === "mode") await chmod(path.join(fixture.root, file), 0o755);
                if (change === "type") {
                    await unlink(path.join(fixture.root, file));
                    await symlink("other.txt", path.join(fixture.root, file));
                }
                if (renamed)
                    await writeFile(
                        path.join(fixture.root, "tracked.txt"),
                        "external rename source\n",
                    );
                externalHead = await git(fixture.root, ["rev-parse", "HEAD"]);
                externalIndex = await readFile(indexPath);
                externalBytes = await readFile(
                    path.join(fixture.root, renamed ? "tracked.txt" : file),
                );
                externalMode = (await lstat(path.join(fixture.root, file))).mode;
                return result;
            });
            const publish = vi.spyOn(fixture.store, "writeShelfGeneration");
            await expect(
                fixture.store.withLock(() =>
                    captureSelectedShelf(
                        {
                            name: "freshness",
                            baseCommit,
                            scope: "files",
                            sourceLists: [lists[0]],
                            selected: [],
                            whole: [{ path: file, sourceListIds: ["default"] }],
                        },
                        {
                            repositoryRoot: fixture.root,
                            executor: fixture.executor,
                            store: fixture.store,
                            recordBaseRevisions: true,
                            materializeEntry: materialize
                                ? (
                                      fixture.service as unknown as {
                                          materializeEntry: ShelfCaptureDependencies["materializeEntry"];
                                      }
                                  ).materializeEntry.bind(fixture.service)
                                : async () => undefined,
                        },
                    ),
                ),
            ).rejects.toThrow("Whole-file capture source changed before publication.");
            expect(
                publish,
                "stale whole capture must not publish a generation",
            ).not.toHaveBeenCalled();
            expect((await fixture.store.listShelves()).shelfIds).toEqual([]);
            expect(immutable).toBeDefined();
            expect(await fixture.store.readObject(immutable!.shelfId, immutable!.hash)).toEqual(
                immutable!.bytes,
            );
            expect(externalHead, "fault injection must run").toBeDefined();
            expect(await git(fixture.root, ["rev-parse", "HEAD"])).toEqual(externalHead);
            expect(await readFile(indexPath), "external index bytes must survive refusal").toEqual(
                externalIndex,
            );
            expect(await readFile(path.join(fixture.root, renamed ? "tracked.txt" : file))).toEqual(
                externalBytes,
            );
            expect((await lstat(path.join(fixture.root, file))).mode).toBe(externalMode);
        },
    );

    it("revalidates whole identity after the final selected ownership object", async () => {
        const fixture = await selectedFixture();
        await writeFile(path.join(fixture.root, "whole.txt"), "whole captured\n");
        const original = fixture.store.putObject.bind(fixture.store);
        // Two selected paths each write patch + base + ownership; whole untracked writes one patch.
        let writes = 0;
        vi.spyOn(fixture.store, "putObject").mockImplementation(async (...args) => {
            const result = await original(...args);
            if (++writes === 7)
                await writeFile(path.join(fixture.root, "whole.txt"), "external late edit\n");
            return result;
        });
        const publish = vi.spyOn(fixture.store, "writeShelfGeneration");
        await expect(
            fixture.store.withLock(() =>
                captureSelectedShelf(
                    {
                        ...fixture.request,
                        whole: [{ path: "whole.txt", sourceListIds: ["default"] }],
                    },
                    {
                        repositoryRoot: fixture.root,
                        executor: fixture.executor,
                        store: fixture.store,
                        recordBaseRevisions: true,
                        materializeEntry: async () => undefined,
                    },
                ),
            ),
        ).rejects.toThrow("Whole-file capture source changed before publication.");
        expect(writes).toBe(7);
        expect(publish).not.toHaveBeenCalled();
        expect((await fixture.store.listShelves()).shelfIds).toEqual([]);
        expect(await readFile(path.join(fixture.root, "whole.txt"), "utf8")).toBe(
            "external late edit\n",
        );
    });

    it("publishes unchanged whole-only capture without ownership evidence", async () => {
        const fixture = await createShelfFixture();
        await fixture.store.withLock(() => fixture.store.migrateWithHeldLocks());
        await writeFile(path.join(fixture.root, "tracked.txt"), "captured\n");
        const index = await readFile(path.join(fixture.root, ".git/index"));
        const result = await fixture.store.withLock(async () =>
            captureSelectedShelf(
                {
                    name: "unchanged",
                    baseCommit: (await git(fixture.root, ["rev-parse", "HEAD"])).toString().trim(),
                    scope: "files",
                    sourceLists: [lists[0]],
                    selected: [],
                    whole: [{ path: "tracked.txt", sourceListIds: ["default"] }],
                },
                {
                    repositoryRoot: fixture.root,
                    executor: fixture.executor,
                    store: fixture.store,
                    recordBaseRevisions: true,
                    materializeEntry: async () => Buffer.from("captured\n"),
                },
            ),
        );
        expect((await fixture.store.readCurrentShelfManifest(result.shelfId)).files).toHaveLength(
            1,
        );
        expect(await readFile(path.join(fixture.root, ".git/index"))).toEqual(index);
    });

    it.for(["stat-only index refresh", "unrelated staged path"] as const)(
        "publishes whole capture across an outside %s",
        async (drift) => {
            const fixture = await createShelfFixture({
                initialFiles: { "tracked.txt": "base\n", "other.txt": "other\n" },
            });
            await fixture.store.withLock(() => fixture.store.migrateWithHeldLocks());
            const file = path.join(fixture.root, "tracked.txt");
            await writeFile(file, "captured\n");
            // Staged, so a refresh rewrites the captured entry's own cached stat data.
            await git(fixture.root, ["add", "tracked.txt"]);
            const indexPath = path.join(fixture.root, ".git/index");
            const object = fixture.store.putObject.bind(fixture.store);
            let injected = false;
            vi.spyOn(fixture.store, "putObject").mockImplementation(async (...args) => {
                const result = await object(...args);
                if (injected) return result;
                injected = true;
                const rawIndex = await readFile(indexPath);
                const listing = await indexSnapshot(fixture.root);
                if (drift === "stat-only index refresh") {
                    // Same bytes, older mtime: `git status` re-hashes, finds no change and
                    // rewrites the index file with refreshed stat data alone.
                    await utimes(file, 1_000_000_000, 1_000_000_000);
                    await git(fixture.root, ["status", "--porcelain"]);
                    expect(await indexSnapshot(fixture.root), "entries unchanged").toEqual(listing);
                } else {
                    await writeFile(path.join(fixture.root, "other.txt"), "external index\n");
                    await git(fixture.root, ["add", "other.txt"]);
                    expect(await indexSnapshot(fixture.root), "entries changed").not.toEqual(
                        listing,
                    );
                }
                expect(await readFile(indexPath), "index file rewritten").not.toEqual(rawIndex);
                return result;
            });
            const result = await fixture.store.withLock(async () =>
                captureSelectedShelf(
                    {
                        name: "refreshed",
                        baseCommit: (await git(fixture.root, ["rev-parse", "HEAD"]))
                            .toString()
                            .trim(),
                        scope: "files",
                        sourceLists: [lists[0]],
                        selected: [],
                        whole: [{ path: "tracked.txt", sourceListIds: ["default"] }],
                    },
                    {
                        repositoryRoot: fixture.root,
                        executor: fixture.executor,
                        store: fixture.store,
                        recordBaseRevisions: true,
                        materializeEntry: async () => undefined,
                    },
                ),
            );
            expect(injected, "fault injection must run").toBe(true);
            expect(
                (await fixture.store.readCurrentShelfManifest(result.shelfId)).files,
            ).toHaveLength(1);
        },
    );
});
