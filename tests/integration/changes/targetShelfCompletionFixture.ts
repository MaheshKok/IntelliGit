import { execFileSync } from "node:child_process";
import { lstat, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ChangelistPersistence } from "../../../src/changes/changelistPersistence";
import { ChangelistStore, type TargetOperationLease } from "../../../src/changes/changelistStore";
import { changeFingerprint } from "../../../src/changes/parseDiff";
import type {
    TargetOperationEvidence,
    TargetPathState,
} from "../../../src/changes/targetOperation";
import { RepositoryMutationCoordinator } from "../../../src/git/mutationCoordinator";
import { RepositoryLock } from "../../../src/git/repositoryLock";
import { RepositoryMutationGate } from "../../../src/git/repositoryMutationGate";
import { resolveShelfPaths } from "../../../src/shelf/paths";
import { ShelfStore, type ShelfStoreOptions } from "../../../src/shelf/store";

export const operationId = "00000000-0000-4000-8000-000000000071";
const files = ["one.txt", "two.txt"];

/** Connects independent durable stores; every metadata operation uses a real lease before the Git gate. */
export async function openCompletionFixture(root: string, shelfOptions: ShelfStoreOptions = {}) {
    const gitDir = path.join(root, ".git");
    const store = new ChangelistStore();
    await store.connect(root, gitDir);
    const persistence = await ChangelistPersistence.open(root, gitDir);
    const paths = await resolveShelfPaths({
        repositoryRoot: root,
        globalStoragePath: path.join(root, "storage"),
    });
    const shelf = new ShelfStore(paths, shelfOptions);
    const gate = new RepositoryMutationGate(
        new RepositoryMutationCoordinator(),
        new RepositoryLock(),
    );
    const git = (args: string[], input?: string) =>
        execFileSync("git", args, {
            cwd: root,
            input,
            timeout: 10_000,
            env: { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: "1" },
        });
    const objectWrites = new Map<string, Promise<{ hash: string; size: number }>>();
    const object = (bytes: Buffer) => {
        const hash = changeFingerprint(bytes);
        let stored = objectWrites.get(hash);
        if (!stored) {
            stored = persistence
                .storeTargetOperationObject(bytes)
                .then((hash) => ({ hash, size: bytes.length }));
            objectWrites.set(hash, stored);
        }
        return stored;
    };
    const capturePath = async (file: string): Promise<TargetPathState> => {
        const info = await lstat(path.join(root, file), { bigint: true });
        return {
            kind: "regular",
            executable: (info.mode & 0o111n) !== 0n,
            content: await object(await readFile(path.join(root, file))),
            identity: {
                device: String(info.dev),
                inode: String(info.ino),
                size: Number(info.size),
                modifiedNs: String(info.mtimeNs),
                changedNs: String(info.ctimeNs),
            },
        };
    };
    const capture = async (
        template: TargetOperationEvidence,
    ): Promise<TargetOperationEvidence> => ({
        ...template,
        head: git(["rev-parse", "HEAD"]).toString().trim(),
        indexFingerprint: changeFingerprint(await readFile(path.join(gitDir, "index"))),
        paths: await Promise.all(
            files.map(async (file) => ({ path: file, state: await capturePath(file) })),
        ),
        index: await Promise.all(
            git(["ls-files", "--stage", "-z", "--", ...files])
                .toString()
                .split("\0")
                .filter(Boolean)
                .map(async (line) => {
                    const [mode, oid, stage] = line.split(/[ \t]/);
                    return {
                        path: line.split("\t")[1],
                        mode: mode as "100644",
                        oid,
                        stage: Number(stage) as 0,
                        object: await object(git(["cat-file", "blob", oid])),
                        assumeUnchanged: false,
                        skipWorktree: false,
                        intentToAdd: false,
                    };
                }),
        ),
    });
    const withLease = async <T>(
        operation: (lease: TargetOperationLease) => Promise<T>,
    ): Promise<T> => {
        const lease = await store.acquireTargetOperationLease(root);
        try {
            return await gate.run(root, gitDir, () => operation(lease));
        } finally {
            await lease.release();
        }
    };
    const observation = async () => {
        const state = store.get(root);
        const pending = state.pendingTargetOperation!;
        const template = await persistence.loadTargetOperationEvidence(pending.evidenceHash);
        const observedEvidenceHash = await persistence.storeTargetOperationEvidence(
            await capture(template),
        );
        return {
            id: pending.id,
            revision: state.revision,
            expectedPhase: pending.phase,
            observedEvidenceHash,
            shelf: pending.shelf && {
                id: pending.shelf.id,
                generation: pending.shelf.generation,
                checksum: pending.shelf.checksum,
            },
        };
    };
    return {
        root,
        gitDir,
        paths,
        store,
        shelf,
        persistence,
        git,
        object,
        capture,
        withLease,
        observation,
    };
}

/** Applies one real Git patch once and checkpoints immutable before/after evidence for the successful subset. */
export async function createCompletionFixture(
    options: { root?: string; remove?: boolean; successes?: number; ownership?: boolean } = {},
) {
    const root = await realpath(
        options.root ?? (await mkdtemp(path.join(os.tmpdir(), "target-shelf-completion-"))),
    );
    execFileSync("git", ["init", "-q", root]);
    const f = await openCompletionFixture(root);
    for (const file of files) await writeFile(path.join(root, file), "base\n");
    f.git(["add", "--", ...files]);
    f.git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "base"]);
    await f.shelf.withLock(() => f.shelf.migrateWithHeldLocks());
    const patch = (file: string) =>
        `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-base\n+operation\n`;
    const patchObject = await f.shelf.putObject("source", Buffer.from(files.map(patch).join("")));
    const source = await f.shelf.writeShelfGeneration("source", {
        schemaVersion: 2,
        objectHashes: [patchObject.hash],
        metadata: {
            name: "Source",
            lifecycle: "shelved",
            createdAt: 1,
            selection: {
                version: 1,
                scope: "files",
                sourceLists: [
                    {
                        id: "default",
                        name: "Source list",
                        description: "Original",
                        draft: "captured shelf draft",
                    },
                ],
                entries: files.map((file) => ({ changeId: file, sourceListIds: ["default"] })),
            },
        },
        files: files.map((file) => ({
            changeId: file,
            worktreeBlock: { path: file, status: "M", patchObjectHash: patchObject.hash },
            binary: false,
            untracked: false,
            baseAvailability: "none",
            exactReconstruction: true,
            lifecycle: "shelved",
        })),
    });
    const head = f.git(["rev-parse", "HEAD"]).toString().trim();
    const before = await f.capture({
        version: 1,
        operationId,
        root,
        gitDir: f.gitDir,
        checkpoint: "before",
        head,
        indexFingerprint: "0".repeat(64),
        paths: [],
        index: [],
        native: ["cherryPickHead", "revertHead", "mergeHead", "sequencer"].map((name) => ({
            name: name as "cherryPickHead",
            present: false,
        })),
        entries: files.map((file) => ({ path: file, changeId: file, outcome: "pending" })),
        wholeFileBefore: await Promise.all(
            files.map(async (file) => {
                const oid = f
                    .git(["rev-parse", `HEAD:${file}`])
                    .toString()
                    .trim();
                return {
                    path: file,
                    unowned: true,
                    head: {
                        kind: "present" as const,
                        mode: "100644" as const,
                        oid,
                        object: await f.object(f.git(["cat-file", "blob", oid])),
                    },
                };
            }),
        ),
    });
    const beforeHash = await f.persistence.storeTargetOperationEvidence(before);
    const successes = options.successes ?? 1;
    await f.withLease(async (lease) => {
        const prepared = (
            await f.store.prepareTargetOperation(lease, {
                id: operationId,
                kind: "shelfRestore",
                target: { kind: "new", name: "Destination", revision: f.store.revision(root) },
                headBefore: head,
                evidenceHash: beforeHash,
                shelf: {
                    id: "source",
                    generation: source.generation,
                    checksum: source.checksum,
                    changeIds: [...files],
                    removeFromShelf: options.remove ?? true,
                },
                draftChoice: {
                    kind: "copySource",
                    sourceListId: "default",
                    expectedDestinationDraft: "",
                },
                sourceDraft: "captured shelf draft",
            })
        ).state;
        if (successes) {
            f.git(["apply"], files.slice(0, successes).map(patch).join(""));
            await writeFile(path.join(root, "git-apply-count"), "1", { flag: "wx" });
        }
        const after = await f.capture({
            ...before,
            wholeFileBefore: undefined,
            checkpoint: "after",
            previousEvidenceHash: beforeHash,
            entries: before.entries.map((entry, index) => ({
                ...entry,
                outcome: index < successes ? "applied" : "refused",
            })),
            wholeFileAttribution: files
                .slice(0, successes)
                .map((file) => ({ path: file, changeIds: [file] })),
        });
        const evidenceHash = await f.persistence.storeTargetOperationEvidence(after);
        await f.store.checkpointTargetOperation(lease, {
            id: operationId,
            revision: prepared.revision,
            expectedPhase: "prepared",
            phase: "gitApplied",
            evidenceHash,
        });
        if (successes && options.ownership !== false)
            await f.store.publishTargetOwnership(lease, await f.observation());
    });
    return { ...f, source, before };
}
