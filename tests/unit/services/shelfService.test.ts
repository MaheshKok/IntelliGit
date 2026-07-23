import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { GitExecutor } from "../../../src/git/executor";
import { RepositoryMutationCoordinator } from "../../../src/git/mutationCoordinator";
import { RepositoryLock } from "../../../src/git/repositoryLock";
import { RepositoryMutationGate } from "../../../src/git/repositoryMutationGate";
import { resolveShelfPaths } from "../../../src/shelf/paths";
import { ShelfStore } from "../../../src/shelf/store";
import { ShelfService } from "../../../src/services/shelfService";
import { pathFingerprint } from "../../../src/services/shelfServiceOperations";

const execFileAsync = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
    await Promise.all(
        directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
});

async function git(repositoryRoot: string, args: string[]): Promise<void> {
    await execFileAsync("git", args, {
        cwd: repositoryRoot,
        env: {
            ...process.env,
            GIT_AUTHOR_NAME: "Test",
            GIT_AUTHOR_EMAIL: "test@example.invalid",
            GIT_COMMITTER_NAME: "Test",
            GIT_COMMITTER_EMAIL: "test@example.invalid",
        },
    });
}

async function makeService(): Promise<{
    readonly root: string;
    readonly service: ShelfService;
    readonly store: ShelfStore;
    readonly executor: GitExecutor;
}> {
    const root = await mkdtemp(path.join(tmpdir(), "intelligit-shelf-service-"));
    directories.push(root);
    await git(root, ["init"]);
    await writeFile(path.join(root, "tracked.txt"), "base\n");
    await git(root, ["add", "tracked.txt"]);
    await git(root, ["commit", "-m", "base"]);
    const store = new ShelfStore(
        await resolveShelfPaths({
            repositoryRoot: root,
            globalStoragePath: path.join(root, "shelf-storage"),
        }),
    );
    const gate = new RepositoryMutationGate(
        new RepositoryMutationCoordinator(),
        new RepositoryLock(),
    );
    const executor = new GitExecutor(root);
    return {
        root,
        store,
        executor,
        service: new ShelfService({ repositoryRoot: root, executor, store, gate }),
    };
}

async function createMergeConflictShelf(
    root: string,
    service: ShelfService,
    relativePath: string,
): Promise<string> {
    const target = path.join(root, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "one\nbase\nthree\n");
    await git(root, ["add", relativePath]);
    await git(root, ["commit", "-m", "merge conflict base"]);
    await writeFile(target, "one\nshelved\nthree\n");
    const shelf = await service.shelve({
        name: "merge",
        paths: [relativePath],
        silent: true,
        keepLocal: false,
    });
    await writeFile(target, "one\nlocal\nthree\n");
    return shelf.shelfId!;
}

async function writeStructuralShelf(
    store: ShelfStore,
    shelfId: string,
    relativePath: string,
    status: "D" | "R",
): Promise<void> {
    const patch = await store.putObject(shelfId, Buffer.from("structural patch"));
    await store.writeShelfGeneration(shelfId, {
        schemaVersion: 1,
        objectHashes: [patch.hash],
        metadata: { name: shelfId, lifecycle: "shelved" },
        files: [
            {
                changeId: "structural",
                worktreeBlock: { path: relativePath, status, patchObjectHash: patch.hash },
                binary: false,
                untracked: false,
                baseAvailability: "none",
                exactReconstruction: true,
                lifecycle: "shelved",
            },
        ],
    });
}

describe("ShelfService", () => {
    it("returns immutable base and shelved bytes for a shelf diff", async () => {
        const { root, service } = await makeService();
        await writeFile(path.join(root, "tracked.txt"), "shelved\n");
        const created = await service.shelve({
            name: "diff",
            paths: ["tracked.txt"],
            silent: true,
            keepLocal: true,
        });
        const [entry] = await service.getShelfFiles(created.shelfId!);

        await expect(service.getShelfDiffContents(created.shelfId!, entry!.changeId)).resolves.toEqual({
            path: "tracked.txt",
            binary: false,
            base: Buffer.from("base\n"),
            shelved: Buffer.from("shelved\n"),
        });
    });

    it("keeps tree and index byte-identical for Save to Shelf", async () => {
        const { root, service } = await makeService();
        await writeFile(path.join(root, "tracked.txt"), "edited\n");
        await git(root, ["add", "tracked.txt"]);
        await writeFile(path.join(root, "tracked.txt"), "edited twice\n");
        const beforeTree = await readFile(path.join(root, "tracked.txt"));
        const beforeIndex = (
            await execFileAsync("git", ["ls-files", "--stage", "-v", "-z"], { cwd: root })
        ).stdout;

        const result = await service.shelve({
            name: "save",
            paths: ["tracked.txt"],
            silent: true,
            keepLocal: true,
        });

        expect(result.status).toBe("ok");
        expect(await readFile(path.join(root, "tracked.txt"))).toEqual(beforeTree);
        await expect(
            execFileAsync("git", ["ls-files", "--stage", "-v", "-z"], { cwd: root }),
        ).resolves.toMatchObject({
            stdout: beforeIndex,
        });
        await expect(service.getShelfFiles(result.shelfId)).resolves.toHaveLength(1);
    });

    it("shelves normal changes only after durable capture and reverts both worktree and index", async () => {
        const { root, service, store } = await makeService();
        await writeFile(path.join(root, "tracked.txt"), "staged\n");
        await git(root, ["add", "tracked.txt"]);
        await writeFile(path.join(root, "tracked.txt"), "unstaged\n");

        const result = await service.shelve({
            name: "move",
            paths: ["tracked.txt"],
            silent: true,
            keepLocal: false,
        });

        expect(result.status).toBe("ok");
        await expect(readFile(path.join(root, "tracked.txt"), "utf8")).resolves.toBe("base\n");
        await expect(
            execFileAsync("git", ["diff", "--cached", "--quiet"], { cwd: root }),
        ).resolves.toBeDefined();
        await expect(service.getShelfFiles(result.shelfId)).resolves.toHaveLength(1);
        await expect(store.readJournals()).resolves.toEqual([
            expect.objectContaining({
                state: "shelved",
                shelf: { id: result.shelfId, generation: 1 },
            }),
        ]);
    });

    it("unshelves a staged and unstaged entry in flattened mode without touching the pre-existing index", async () => {
        const { root, service } = await makeService();
        await writeFile(path.join(root, "tracked.txt"), "staged\n");
        await git(root, ["add", "tracked.txt"]);
        await writeFile(path.join(root, "tracked.txt"), "unstaged\n");
        const shelf = await service.shelve({
            name: "move",
            paths: ["tracked.txt"],
            silent: true,
            keepLocal: false,
        });
        const beforeIndex = (
            await execFileAsync("git", ["ls-files", "--stage", "-v", "-z"], { cwd: root })
        ).stdout;

        const result = await service.unshelve({
            id: shelf.shelfId!,
            removeFromShelf: false,
            mode: "flattened",
        });

        expect(result).toMatchObject({ status: "ok", entries: [{ kind: "applied" }] });
        await expect(readFile(path.join(root, "tracked.txt"), "utf8")).resolves.toBe("unstaged\n");
        await expect(
            execFileAsync("git", ["ls-files", "--stage", "-v", "-z"], { cwd: root }),
        ).resolves.toMatchObject({
            stdout: beforeIndex,
        });
    });

    it("turns a B/A cancelling layer pair into flattened unstaged residue", async () => {
        const { root, service } = await makeService();
        await writeFile(path.join(root, "tracked.txt"), "staged\n");
        await git(root, ["add", "tracked.txt"]);
        await writeFile(path.join(root, "tracked.txt"), "base\n");
        const shelf = await service.shelve({
            name: "cancel",
            paths: ["tracked.txt"],
            silent: true,
            keepLocal: false,
        });
        const beforeIndex = (
            await execFileAsync("git", ["ls-files", "--stage", "-v", "-z"], { cwd: root })
        ).stdout;

        const result = await service.unshelve({
            id: shelf.shelfId!,
            removeFromShelf: false,
            mode: "flattened",
        });

        expect(result).toMatchObject({ status: "ok", entries: [{ kind: "flattenedResidue" }] });
        await expect(readFile(path.join(root, "tracked.txt"), "utf8")).resolves.toBe("staged\n");
        await expect(
            execFileAsync("git", ["ls-files", "--stage", "-v", "-z"], { cwd: root }),
        ).resolves.toMatchObject({
            stdout: beforeIndex,
        });
    });

    it("restores both layers in exact-state mode and refuses existing same-path index divergence", async () => {
        const exact = await makeService();
        await writeFile(path.join(exact.root, "tracked.txt"), "staged\n");
        await git(exact.root, ["add", "tracked.txt"]);
        await writeFile(path.join(exact.root, "tracked.txt"), "unstaged\n");
        const shelf = await exact.service.shelve({
            name: "exact",
            paths: ["tracked.txt"],
            silent: true,
            keepLocal: false,
        });

        await expect(
            exact.service.unshelve({
                id: shelf.shelfId!,
                removeFromShelf: false,
                mode: "exactState",
            }),
        ).resolves.toMatchObject({
            status: "ok",
            entries: [{ kind: "applied" }],
        });
        await expect(readFile(path.join(exact.root, "tracked.txt"), "utf8")).resolves.toBe(
            "unstaged\n",
        );
        await expect(
            execFileAsync("git", ["show", ":tracked.txt"], { cwd: exact.root }),
        ).resolves.toMatchObject({ stdout: "staged\n" });

        const refused = await makeService();
        await writeFile(path.join(refused.root, "tracked.txt"), "shelved\n");
        const refusedShelf = await refused.service.shelve({
            name: "refuse",
            paths: ["tracked.txt"],
            silent: true,
            keepLocal: false,
        });
        await writeFile(path.join(refused.root, "tracked.txt"), "other index\n");
        await git(refused.root, ["add", "tracked.txt"]);
        await expect(
            refused.service.unshelve({
                id: refusedShelf.shelfId!,
                removeFromShelf: false,
                mode: "exactState",
            }),
        ).resolves.toMatchObject({
            status: "partial",
            entries: [{ kind: "refused" }],
        });
    });

    it("uses merge-file after a same-hunk patch check fails", async () => {
        const merged = await makeService();
        await writeFile(path.join(merged.root, "tracked.txt"), "one\nbase\nthree\n");
        await git(merged.root, ["add", "tracked.txt"]);
        await git(merged.root, ["commit", "-m", "multiline base"]);
        await writeFile(path.join(merged.root, "tracked.txt"), "one\nshelved\nthree\n");
        const shelf = await merged.service.shelve({
            name: "merge",
            paths: ["tracked.txt"],
            silent: true,
            keepLocal: false,
        });
        await writeFile(path.join(merged.root, "tracked.txt"), "one\nlocal\nthree\n");

        await expect(
            merged.service.unshelve({
                id: shelf.shelfId!,
                removeFromShelf: false,
                mode: "flattened",
            }),
        ).resolves.toMatchObject({
            status: "conflicts",
            entries: [{ kind: "conflicted" }],
        });
        await expect(readFile(path.join(merged.root, "tracked.txt"), "utf8")).resolves.toContain(
            "<<<<<<<",
        );
        await expect(readFile(path.join(merged.root, "tracked.txt"), "utf8")).resolves.toContain(
            "local",
        );
        await expect(readFile(path.join(merged.root, "tracked.txt"), "utf8")).resolves.toContain(
            "shelved",
        );
    });

    it("refuses a merge conflict write through a symlinked parent without writing through", async () => {
        const { root, service, executor } = await makeService();
        const shelfId = await createMergeConflictShelf(root, service, "nested/tracked.txt");
        const outside = await mkdtemp(path.join(tmpdir(), "intelligit-shelf-outside-"));
        directories.push(outside);
        const outsideTarget = path.join(outside, "tracked.txt");
        await writeFile(outsideTarget, "one\nlocal\nthree\n");
        await rm(path.join(root, "nested"), { recursive: true, force: true });
        await symlink(outside, path.join(root, "nested"));
        const originalRunBinary = executor.runBinary.bind(executor);
        let merged = false;
        executor.runBinary = async (args, options) => {
            const result = await originalRunBinary(args, options);
            if (args[0] === "merge-file") merged = true;
            return result;
        };

        await expect(
            service.unshelve({ id: shelfId, removeFromShelf: false, mode: "flattened" }),
        ).rejects.toThrow("escaped");
        expect(merged).toBe(true);
        await expect(readFile(outsideTarget, "utf8")).resolves.toBe("one\nlocal\nthree\n");
    });

    it("refuses a merge conflict target swapped to a symlink after merge-file returns", async () => {
        const { root, service, executor } = await makeService();
        const shelfId = await createMergeConflictShelf(root, service, "tracked.txt");
        const target = path.join(root, "tracked.txt");
        const outside = path.join(root, "outside.txt");
        await writeFile(outside, "outside\n");
        const originalRunBinary = executor.runBinary.bind(executor);
        let merged = false;
        executor.runBinary = async (args, options) => {
            const result = await originalRunBinary(args, options);
            if (args[0] === "merge-file") {
                merged = true;
                await rm(target);
                await symlink(outside, target);
            }
            return result;
        };

        await expect(
            service.unshelve({ id: shelfId, removeFromShelf: false, mode: "flattened" }),
        ).rejects.toThrow("regular file");
        expect(merged).toBe(true);
        await expect(readFile(outside, "utf8")).resolves.toBe("outside\n");
    });

    it("falls back to the clean stored history base when a manifest block has no base object", async () => {
        const { root, service, store } = await makeService();
        const baseCommit = (
            await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })
        ).stdout.trim();
        const patch = await store.putObject(
            "history-shelf",
            Buffer.from(
                "diff --git a/tracked.txt b/tracked.txt\n--- a/tracked.txt\n+++ b/tracked.txt\n@@ -1 +1 @@\n-base\n+shelved\n",
            ),
        );
        await store.writeShelfGeneration("history-shelf", {
            schemaVersion: 1,
            objectHashes: [patch.hash],
            metadata: { name: "history", baseCommit, lifecycle: "shelved" },
            files: [
                {
                    changeId: "history",
                    worktreeBlock: {
                        path: "tracked.txt",
                        status: "M",
                        patchObjectHash: patch.hash,
                    },
                    binary: false,
                    untracked: false,
                    baseAvailability: "history",
                    exactReconstruction: true,
                    lifecycle: "shelved",
                },
            ],
        });
        await writeFile(path.join(root, "tracked.txt"), "local\n");

        await expect(
            service.unshelve({ id: "history-shelf", removeFromShelf: false, mode: "flattened" }),
        ).resolves.toMatchObject({
            status: "conflicts",
            entries: [{ kind: "conflicted", changeId: "history" }],
        });
        await expect(readFile(path.join(root, "tracked.txt"), "utf8")).resolves.toContain(
            "shelved",
        );
    });

    it("uses raw before/after artifacts without git apply and replays durable idempotency safely", async () => {
        const { root, service, store } = await makeService();
        const patch = await store.putObject("raw-shelf", Buffer.from("placeholder patch"));
        const before = await store.putObject("raw-shelf", Buffer.from("base\n"));
        const after = await store.putObject("raw-shelf", Buffer.from("raw after\n"));
        await store.writeShelfGeneration("raw-shelf", {
            schemaVersion: 1,
            objectHashes: [patch.hash, before.hash, after.hash],
            metadata: { name: "raw", lifecycle: "shelved" },
            files: [
                {
                    changeId: "raw",
                    worktreeBlock: {
                        path: "tracked.txt",
                        status: "M",
                        patchObjectHash: patch.hash,
                        rawBeforeObjectHash: before.hash,
                        rawAfterObjectHash: after.hash,
                    },
                    binary: false,
                    untracked: false,
                    baseAvailability: "none",
                    exactReconstruction: false,
                    lifecycle: "shelved",
                },
            ],
        });

        await expect(
            service.unshelve({ id: "raw-shelf", removeFromShelf: false, mode: "flattened" }),
        ).resolves.toMatchObject({
            status: "ok",
            entries: [{ kind: "applied" }],
        });
        await expect(readFile(path.join(root, "tracked.txt"), "utf8")).resolves.toBe("raw after\n");

        await writeFile(path.join(root, "tracked.txt"), "saved\n");
        const request = {
            name: "replay",
            paths: ["tracked.txt"],
            silent: true,
            keepLocal: true,
            idempotencyToken: "replay-token",
        };
        const first = await service.shelve(request);
        await expect(service.shelve(request)).resolves.toMatchObject({ shelfId: first.shelfId });
        await expect(service.shelve({ ...request, name: "conflicting replay" })).rejects.toThrow(
            "already used",
        );
    });

    it("refuses raw writes through a symlinked worktree target", async () => {
        const { root, service, store } = await makeService();
        const patch = await store.putObject("raw-link", Buffer.from("placeholder patch"));
        const before = await store.putObject("raw-link", Buffer.from("base\n"));
        const after = await store.putObject("raw-link", Buffer.from("raw after\n"));
        await store.writeShelfGeneration("raw-link", {
            schemaVersion: 1,
            objectHashes: [patch.hash, before.hash, after.hash],
            metadata: { name: "raw-link", lifecycle: "shelved" },
            files: [
                {
                    changeId: "raw-link",
                    worktreeBlock: {
                        path: "tracked.txt",
                        status: "M",
                        patchObjectHash: patch.hash,
                        rawBeforeObjectHash: before.hash,
                        rawAfterObjectHash: after.hash,
                    },
                    binary: false,
                    untracked: false,
                    baseAvailability: "none",
                    exactReconstruction: false,
                    lifecycle: "shelved",
                },
            ],
        });
        const outside = path.join(root, "outside.txt");
        await writeFile(outside, "base\n");
        await rm(path.join(root, "tracked.txt"));
        await symlink(outside, path.join(root, "tracked.txt"));

        await expect(
            service.unshelve({ id: "raw-link", removeFromShelf: false, mode: "flattened" }),
        ).rejects.toThrow("regular file");
        await expect(readFile(outside, "utf8")).resolves.toBe("base\n");
    });

    it("captures an EOL-divergent worktree as a raw-fidelity shelf entry", async () => {
        const { root, service } = await makeService();
        await writeFile(path.join(root, ".gitattributes"), "*.txt text eol=crlf\n");
        await git(root, ["add", ".gitattributes"]);
        await git(root, ["commit", "-m", "eol filter"]);
        await writeFile(path.join(root, "tracked.txt"), "edited\r\n");

        const shelf = await service.shelve({
            name: "eol",
            paths: ["tracked.txt"],
            silent: true,
            keepLocal: true,
        });
        const [entry] = await service.getShelfFiles(shelf.shelfId!);

        expect(entry.exactReconstruction).toBe(false);
        expect(entry.worktreeBlock?.rawBeforeObjectHash).toMatch(/^[a-f0-9]{64}$/);
        expect(entry.worktreeBlock?.rawAfterObjectHash).toMatch(/^[a-f0-9]{64}$/);
    });

    it("stores one immutable base object for both captured layers", async () => {
        const { root, service, store } = await makeService();
        const originalPutObject = store.putObject.bind(store);
        const baseWrites: Buffer[] = [];
        store.putObject = async (shelfId, bytes) => {
            const copy = Buffer.from(bytes);
            if (copy.equals(Buffer.from("base\n"))) baseWrites.push(copy);
            return originalPutObject(shelfId, bytes);
        };
        await writeFile(path.join(root, "tracked.txt"), "staged\n");
        await git(root, ["add", "tracked.txt"]);
        await writeFile(path.join(root, "tracked.txt"), "unstaged\n");

        const shelf = await service.shelve({
            name: "two layers",
            paths: ["tracked.txt"],
            silent: true,
            keepLocal: true,
        });
        const [entry] = await service.getShelfFiles(shelf.shelfId!);

        expect(baseWrites).toHaveLength(1);
        expect(entry.indexBlock?.baseObjectHash).toMatch(/^[a-f0-9]{64}$/);
        expect(entry.worktreeBlock?.baseObjectHash).toBe(entry.indexBlock?.baseObjectHash);
    });

    it("keeps metadata-looking added text as a normal non-binary capture and import", async () => {
        const { root, service } = await makeService();
        const literalText = [
            "rename from x",
            "new file mode 100644",
            "old mode 100644",
            "deleted file mode 100644",
            "Binary files a and b differ",
            "",
        ].join("\n");
        await writeFile(path.join(root, "tracked.txt"), literalText);

        const captured = await service.shelve({
            name: "literal text",
            paths: ["tracked.txt"],
            silent: true,
            keepLocal: false,
        });
        const [capturedEntry] = await service.getShelfFiles(captured.shelfId!);

        expect(capturedEntry.worktreeBlock).toMatchObject({ path: "tracked.txt", status: "M" });
        expect(capturedEntry.worktreeBlock?.renamedFrom).toBeUndefined();
        expect(capturedEntry.binary).toBe(false);
        await expect(
            service.unshelve({ id: captured.shelfId!, removeFromShelf: false, mode: "flattened" }),
        ).resolves.toMatchObject({
            status: "ok",
            entries: [{ kind: "applied" }],
        });
        await expect(readFile(path.join(root, "tracked.txt"), "utf8")).resolves.toBe(literalText);

        const patchFile = path.join(root, "literal.patch");
        await writeFile(
            patchFile,
            [
                "diff --git a/tracked.txt b/tracked.txt",
                "--- a/tracked.txt",
                "+++ b/tracked.txt",
                "@@ -1 +1,5 @@",
                "-base",
                "+rename from x",
                "+new file mode 100644",
                "+old mode 100644",
                "+deleted file mode 100644",
                "+Binary files a and b differ",
                "",
            ].join("\n"),
        );
        const imported = await service.importPatch({ fileUris: [patchFile] });
        const [importedEntry] = await service.getShelfFiles(imported.shelfId!);

        expect(importedEntry.worktreeBlock).toMatchObject({ path: "tracked.txt", status: "M" });
        expect(importedEntry.worktreeBlock?.renamedFrom).toBeUndefined();
        expect(importedEntry.binary).toBe(false);
    });

    it("exports content-only patches, rejects hostile imports, and retains a base-less failed apply", async () => {
        const { root, service } = await makeService();
        await writeFile(path.join(root, "tracked.txt"), "shelved\n");
        const shelf = await service.shelve({
            name: "export",
            paths: ["tracked.txt"],
            silent: true,
            keepLocal: true,
        });
        expect((await service.exportPatch({ id: shelf.shelfId! })).toString("utf8")).toContain(
            "diff --git",
        );

        const patchFile = path.join(root, "import.patch");
        await writeFile(
            patchFile,
            "diff --git a/tracked.txt b/tracked.txt\n--- a/tracked.txt\n+++ b/tracked.txt\n@@ -1 +1 @@\n-base\n+imported\n",
        );
        const importRequest = {
            fileUris: [patchFile],
            idempotencyToken: "import-token",
            expectedCatalogGeneration: (await service.listShelves()).catalogGeneration,
        };
        const imported = await service.importPatch(importRequest);
        await expect(service.importPatch(importRequest)).resolves.toMatchObject({
            shelfId: imported.shelfId,
        });
        await expect(service.getShelfFiles(imported.shelfId!)).resolves.toMatchObject([
            { worktreeBlock: { path: "tracked.txt" }, baseAvailability: "none" },
        ]);
        const hostilePatchFile = path.join(root, "hostile.patch");
        await writeFile(
            hostilePatchFile,
            "diff --git a/../escape b/../escape\n--- a/../escape\n+++ b/../escape\n@@ -0,0 +1 @@\n+blocked\n",
        );
        await expect(service.importPatch({ fileUris: [hostilePatchFile] })).rejects.toThrow(
            "Invalid imported shelf patch",
        );
        await expect(
            service.importPatch({ fileUris: [patchFile], expectedCatalogGeneration: 0 }),
        ).rejects.toThrow("stale");
        await writeFile(path.join(root, "tracked.txt"), "local\n");

        await expect(
            service.unshelve({ id: imported.shelfId!, removeFromShelf: false, mode: "flattened" }),
        ).resolves.toMatchObject({
            status: "partial",
            entries: [{ kind: "retained" }],
        });
    });

    it("restores and cleans up ghosts, and applies structural patches with a fresh fingerprint", async () => {
        const ghost = await makeService();
        await writeFile(path.join(ghost.root, "tracked.txt"), "shelved\n");
        const shelf = await ghost.service.shelve({
            name: "ghost",
            paths: ["tracked.txt"],
            silent: true,
            keepLocal: false,
        });
        await ghost.service.unshelve({
            id: shelf.shelfId!,
            removeFromShelf: true,
            mode: "flattened",
        });
        const generation = (await ghost.service.listShelves()).shelves[0].generation;
        await expect(
            ghost.service.restoreGhost({ id: shelf.shelfId!, expectedShelfGeneration: generation }),
        ).resolves.toMatchObject({ status: "ok" });
        const restoredGeneration = (await ghost.service.listShelves()).shelves[0].generation;
        await ghost.service.unshelve({
            id: shelf.shelfId!,
            removeFromShelf: true,
            mode: "flattened",
        });
        await expect(ghost.service.cleanUp({ shelfIds: [shelf.shelfId!] })).resolves.toMatchObject({
            status: "ok",
        });
        await expect(ghost.service.listShelves()).resolves.toMatchObject({ shelves: [] });
        expect(restoredGeneration).toBeGreaterThan(generation);

        const structural = await makeService();
        const binary = Buffer.from([0, 1, 2, 3]);
        await writeFile(path.join(structural.root, "tracked.txt"), binary);
        const binaryShelf = await structural.service.shelve({
            name: "structural",
            paths: ["tracked.txt"],
            silent: true,
            keepLocal: false,
        });
        const file = (await structural.service.getShelfFiles(binaryShelf.shelfId!))[0];
        const currentFingerprint = await pathFingerprint(path.join(structural.root, "tracked.txt"));
        await expect(
            structural.service.resolveStructural({
                id: binaryShelf.shelfId!,
                changeId: file.changeId,
                expectedShelfGeneration: 1,
                expectedPathFingerprint: currentFingerprint,
                action: "useShelved",
            }),
        ).resolves.toMatchObject({ status: "ok", entries: [{ kind: "applied" }] });
        await expect(readFile(path.join(structural.root, "tracked.txt"))).resolves.toEqual(binary);
        await expect(
            structural.service.resolveStructural({
                id: binaryShelf.shelfId!,
                changeId: file.changeId,
                expectedShelfGeneration: 1,
                expectedPathFingerprint: "stale",
                action: "keepLocal",
            }),
        ).rejects.toThrow("stale");
    });

    it("refuses structural deletion through a symlinked source parent", async () => {
        const { root, service, store } = await makeService();
        const outside = path.join(root, "contained-target");
        await mkdir(outside);
        const source = path.join(outside, "source.txt");
        await writeFile(source, "outside\n");
        await symlink(outside, path.join(root, "linked"));
        await writeStructuralShelf(store, "delete-link", "linked/source.txt", "D");

        await expect(
            service.resolveStructural({
                id: "delete-link",
                changeId: "structural",
                expectedShelfGeneration: 1,
                expectedPathFingerprint: await pathFingerprint(
                    path.join(root, "linked", "source.txt"),
                ),
                action: "deleteLocal",
            }),
        ).rejects.toThrow("escaped");
        await expect(readFile(source, "utf8")).resolves.toBe("outside\n");
    });

    it("refuses structural rename through a symlinked target parent", async () => {
        const { root, service, store } = await makeService();
        const outside = await mkdtemp(path.join(tmpdir(), "intelligit-structural-outside-"));
        directories.push(outside);
        await symlink(outside, path.join(root, "linked-target"));
        await writeStructuralShelf(store, "rename-link", "tracked.txt", "R");

        await expect(
            service.resolveStructural({
                id: "rename-link",
                changeId: "structural",
                expectedShelfGeneration: 1,
                expectedPathFingerprint: await pathFingerprint(path.join(root, "tracked.txt")),
                action: "renameLocal",
                targetPath: "linked-target/renamed.txt",
            }),
        ).rejects.toThrow("escaped");
        await expect(readFile(path.join(root, "tracked.txt"), "utf8")).resolves.toBe("base\n");
        await expect(readFile(path.join(outside, "renamed.txt"))).rejects.toThrow();
    });

    it("rejects unknown whole-entry selection before changing the flattened index", async () => {
        const { root, service } = await makeService();
        await writeFile(path.join(root, "tracked.txt"), "shelved\n");
        const shelf = await service.shelve({
            name: "selected",
            paths: ["tracked.txt"],
            silent: true,
            keepLocal: false,
        });
        const index = (
            await execFileAsync("git", ["ls-files", "--stage", "-v", "-z"], { cwd: root })
        ).stdout;

        await expect(
            service.unshelve({
                id: shelf.shelfId!,
                changeIds: ["missing"],
                removeFromShelf: false,
                mode: "flattened",
            }),
        ).rejects.toThrow("unknown change ID");
        await expect(
            execFileAsync("git", ["ls-files", "--stage", "-v", "-z"], { cwd: root }),
        ).resolves.toMatchObject({ stdout: index });
    });
});
