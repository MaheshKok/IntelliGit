import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { changeFingerprint } from "../changes/parseDiff";
import type { ShelfReverter } from "../shelf/recovery";
import { changeIds, selectedContent, validateSelection } from "../changes/selection";
import type { ChangeFileView, SelectedFileChanges } from "../webviews/protocol/changeSelection";
import type { GitExecutor } from "./executor";
import { mapWithConcurrency } from "../utils/concurrency";
import {
    assertPartialSnapshotCurrent,
    MAX_PARTIAL_TEXT_BYTES,
    readPartialSnapshot,
    readPartialRef,
    type PartialFileSnapshot,
} from "./partialSnapshot";
import {
    preparePartialCommit,
    discardPartialRecovery,
    publishPartialIndex,
    recoverPartialIndexes,
    type PartialRecoveryIssue,
    type PartialTransactionFaults,
} from "./partialIndexTransaction";

/** Transaction-local readers keep whole-owned commits independent of the editor cache. */
type PreparedCommitFile = { snapshot: PartialFileSnapshot; content: string };
type ReadPreparedCommitFile = (index: number) => Promise<PreparedCommitFile>;

type DirtyBufferGuard = (paths: readonly string[]) => void | Promise<void>;
const MAX_SESSION_BYTES = 32 * 1024 * 1024;
const MAX_COMMIT_BYTES = 16 * 1024 * 1024;

/** Root-bound ordinary-text staging and commits, separate from whole-file panel actions. */
export class PartialChanges {
    private readonly snapshots = new Map<string, PartialFileSnapshot>();
    private bytes = 0;
    private issues: PartialRecoveryIssue[] = [];

    /** The executor is derived for this captured worktree and shares activation's mutation gate. */
    constructor(
        private readonly executor: GitExecutor,
        private readonly root: string,
    ) {}

    /** Captures a server-owned snapshot; the browser receives only its immutable view. */
    async open(file: string, side: "working" | "index" = "working"): Promise<ChangeFileView> {
        await this.recover();
        const snapshot = await readPartialSnapshot(this.executor, this.root, file, side);
        const old = this.snapshots.get(snapshot.view.snapshotId);
        if (old) {
            this.snapshots.delete(snapshot.view.snapshotId);
            this.snapshots.set(snapshot.view.snapshotId, old);
            return structuredClone(old.view);
        }
        this.snapshots.set(snapshot.view.snapshotId, snapshot);
        this.bytes += snapshotBytes(snapshot);
        while (this.snapshots.size > 64 || this.bytes > MAX_SESSION_BYTES) {
            const oldest = this.snapshots.entries().next().value;
            if (!oldest) break;
            this.snapshots.delete(oldest[0]);
            this.bytes -= snapshotBytes(oldest[1]);
        }
        return structuredClone(snapshot.view);
    }

    /** Resolves metadata identities from the host cache, never a supplied filename or patch. */
    snapshot(id: string): PartialFileSnapshot {
        const snapshot = this.snapshots.get(id);
        if (!snapshot) throw new Error("The change snapshot expired. Reopen its changes.");
        return snapshot;
    }

    /** Each path's stage entries and flag tag, the per-file index state a snapshot reads, in one Git call. */
    async indexEntries(): Promise<Map<string, string>> {
        const entries = new Map<string, string>();
        const output = await this.executor.run(["ls-files", "--stage", "-v", "-z"]);
        for (const record of output.split("\0")) {
            if (!record) continue;
            const file = record.slice(record.indexOf("\t") + 1);
            entries.set(file, (entries.get(file) ?? "") + record);
        }
        return entries;
    }

    /** Revalidates host-owned selection identities and repository state under the mutation gate. */
    async validate(selection: SelectedFileChanges, guard: DirtyBufferGuard): Promise<void> {
        const snapshot = this.snapshot(selection.snapshotId);
        validateSelection(snapshot.view.blocks, selection.lineIds);
        if (!selection.lineIds.length) throw new Error("Select changes first.");
        await this.executor.runWithinMutationGate(() =>
            this.assertCurrent(
                [snapshot.view.path],
                () => Promise.resolve({ snapshot, content: snapshot.view.base }),
                guard,
            ),
        );
    }

    /** Creates a Git patch for exactly the selected content; no real index or worktree is written. */
    async exportPatch(selection: SelectedFileChanges, guard: DirtyBufferGuard): Promise<Buffer> {
        const snapshot = this.snapshot(selection.snapshotId);
        const content = selectedContent(
            snapshot.view.base,
            snapshot.view.blocks,
            selection.lineIds,
        );
        if (!selection.lineIds.length) throw new Error("Select changes first.");
        const assertCurrent = () =>
            this.assertCurrent(
                [snapshot.view.path],
                () => Promise.resolve({ snapshot, content }),
                guard,
            );
        return this.executor.runWithinMutationGate(async () => {
            await assertCurrent();
            const directory = await mkdtemp(path.join(tmpdir(), "intelligit-selected-patch-"));
            try {
                const index = path.join(directory, "index");
                await this.executor.runBinary(["read-tree", snapshot.head], {
                    env: { GIT_INDEX_FILE: index },
                });
                await this.writeBlob(index, snapshot, content);
                const patch = await this.executor.runBinary(
                    [
                        "-c",
                        "diff.suppressBlankEmpty=false",
                        "--literal-pathspecs",
                        "diff",
                        "--cached",
                        "--binary",
                        "--full-index",
                        "--no-ext-diff",
                        "--no-textconv",
                        "--no-color",
                        "--src-prefix=a/",
                        "--dst-prefix=b/",
                        snapshot.head,
                        "--",
                        snapshot.view.path,
                    ],
                    {
                        env: { GIT_INDEX_FILE: index },
                        maxOutputBytes: 8 * 1024 * 1024,
                        signal: AbortSignal.timeout(10_000),
                    },
                );
                if (patch.truncated || !patch.stdout.length)
                    throw new Error("The selected patch is empty or exceeds its supported size.");
                await assertCurrent();
                return patch.stdout;
            } finally {
                await rm(directory, { recursive: true, force: true });
            }
        });
    }

    /**
     * Removes reviewed working lines under the supplied reverter's single repository/store gate.
     * The host must hold its metadata lease and durably save an independent recovery shelf first;
     * shelf migration must already be complete. Completed failures must never be retried.
     */
    async rollback(
        selection: SelectedFileChanges,
        guard: DirtyBufferGuard,
        reverter: ShelfReverter,
        transactionId: string,
    ): Promise<{ readonly baseOid: string; readonly recoveryDirectory: string }> {
        return this.rollbackCaptured(
            this.snapshot(selection.snapshotId),
            selection.lineIds,
            guard,
            reverter,
            transactionId,
        );
    }

    /** Removes a host-captured selection after earlier removals invalidated the editor cache; validates its original bytes under the recovery gate. */
    async rollbackCaptured(
        snapshot: PartialFileSnapshot,
        lineIds: readonly string[],
        guard: DirtyBufferGuard,
        reverter: ShelfReverter,
        transactionId: string,
    ): Promise<{ readonly baseOid: string; readonly recoveryDirectory: string }> {
        if (snapshot.view.side !== "working")
            throw new Error("Rollback requires working-tree changes.");
        const ids = validateSelection(snapshot.view.blocks, lineIds);
        if (!ids.size) throw new Error("Select changes first.");
        const remaining = selectedContent(
            snapshot.view.base,
            snapshot.view.blocks,
            changeIds(snapshot.view.blocks).filter((id) => !ids.has(id)),
        );
        const before = await this.worktreeBytes(snapshot, snapshot.working);
        if (changeFingerprint(before) !== snapshot.worktreeHash)
            throw new Error("The file's line endings require the whole-file/native workflow.");
        const after = await this.worktreeBytes(snapshot, remaining);
        const afterSnapshot = {
            ...snapshot,
            working: remaining,
            worktreeHash: changeFingerprint(after),
        };
        const result = await reverter.revertWorktree({
            repositoryRoot: snapshot.root,
            transactionId,
            relativePath: snapshot.view.path,
            before,
            after,
            validateBefore: () =>
                this.assertCurrent(
                    [snapshot.view.path],
                    () => Promise.resolve({ snapshot, content: remaining }),
                    guard,
                ),
            validateAfter: () =>
                this.assertCurrent(
                    [snapshot.view.path],
                    () => Promise.resolve({ snapshot: afterSnapshot, content: remaining }),
                    guard,
                ),
        });
        this.clear();
        return result;
    }

    /** Applies selected working changes, or removes selected indexed changes, without a worktree write. */
    async stage(
        selection: SelectedFileChanges,
        assertNoDirtyBuffer: DirtyBufferGuard,
    ): Promise<void> {
        const snapshot = this.snapshot(selection.snapshotId);
        const selectedLines = validateSelection(snapshot.view.blocks, selection.lineIds);
        if (!selection.lineIds.length) throw new Error("Select changes first.");
        await this.executor.runWithinMutationGate(async () => {
            await assertNoDirtyBuffer([snapshot.view.path]);
            await assertPartialSnapshotCurrent(this.executor, snapshot);
            const directory = await mkdtemp(path.join(tmpdir(), "intelligit-partial-stage-"));
            try {
                const index = path.join(directory, "index");
                await copyFile(snapshot.indexPath, index);
                await this.materializeIndex(index);
                const selected =
                    snapshot.view.side === "index"
                        ? changeIds(snapshot.view.blocks).filter((id) => !selectedLines.has(id))
                        : selection.lineIds;
                const content = selectedContent(snapshot.view.base, snapshot.view.blocks, selected);
                assertContentSize(content);
                const result =
                    snapshot.view.side === "index"
                        ? content
                        : await this.reconcileText(directory, snapshot, content);
                await this.writeBlob(index, snapshot, result);
                await publishPartialIndex(this.executor, snapshot, index, undefined, async () => {
                    await assertNoDirtyBuffer([snapshot.view.path]);
                    await assertPartialSnapshotCurrent(this.executor, snapshot);
                });
                this.clear();
            } finally {
                await rm(directory, { recursive: true, force: true });
            }
        });
    }

    /** Commits exactly selected text while retaining all unrelated index and worktree content. */
    async commit(
        selections: readonly SelectedFileChanges[],
        message: string,
        assertNoDirtyBuffer: DirtyBufferGuard,
        faults: PartialTransactionFaults = {},
    ): Promise<string> {
        if (!message.trim() || Buffer.byteLength(message, "utf8") > 256 * 1024) {
            throw new Error("Enter a supported commit message.");
        }
        if (!selections.length || selections.length > 64)
            throw new Error("Select 1 to 64 text files.");
        const snapshots = selections.map((selection) => this.snapshot(selection.snapshotId));
        const first = snapshots[0];
        const paths = snapshots.map((snapshot) => snapshot.view.path);
        if (new Set(paths).size !== paths.length)
            throw new Error("Duplicate partial-commit files.");
        if (
            snapshots.some(
                (snapshot) =>
                    snapshot.indexHash !== first.indexHash ||
                    snapshot.head !== first.head ||
                    snapshot.ref !== first.ref ||
                    snapshot.root !== first.root,
            )
        ) {
            throw new Error(
                "The selected files belong to different Git snapshots. Reopen their changes.",
            );
        }
        const contents = snapshots.map((snapshot, index) => {
            const ids = selections[index].lineIds;
            if (!ids.length) throw new Error("Select changes in every partial-commit file.");
            const content = selectedContent(snapshot.view.base, snapshot.view.blocks, ids);
            assertContentSize(content);
            return content;
        });
        if (
            contents.reduce((sum, content) => sum + Buffer.byteLength(content), 0) >
            MAX_COMMIT_BYTES
        ) {
            throw new Error("The selected commit exceeds its text budget.");
        }
        return this.commitPreparedFiles(
            paths,
            (index) => Promise.resolve({ snapshot: snapshots[index], content: contents[index] }),
            message,
            assertNoDirtyBuffer,
            faults,
        );
    }

    /**
     * Commits complete owned text through the protected transaction without partial aggregate limits.
     * The mandatory host predicate proves ownership; false returns before mutation for partial routing.
     * Private disk snapshots bound memory and survive editor-cache eviction only for this transaction.
     */
    async tryCommitWholeFiles(
        paths: readonly string[],
        message: string,
        ownsSnapshot: (snapshot: PartialFileSnapshot) => boolean,
        assertNoDirtyBuffer: DirtyBufferGuard,
        faults: PartialTransactionFaults = {},
    ): Promise<string | undefined> {
        if (!message.trim() || Buffer.byteLength(message, "utf8") > 256 * 1024) {
            throw new Error("Enter a supported commit message.");
        }
        if (!paths.length) throw new Error("Select changes before committing.");
        if (new Set(paths).size !== paths.length)
            throw new Error("Duplicate partial-commit files.");
        await this.recover();
        const directory = await mkdtemp(path.join(tmpdir(), "intelligit-owned-snapshots-"));
        try {
            for (const [index, file] of paths.entries()) {
                const snapshot = await readPartialSnapshot(
                    this.executor,
                    this.root,
                    file,
                    "working",
                );
                if (!ownsSnapshot(snapshot)) return undefined;
                await writeFile(path.join(directory, String(index)), JSON.stringify(snapshot), {
                    flag: "wx",
                    mode: 0o600,
                });
            }
            return await this.commitPreparedFiles(
                paths,
                async (index) => {
                    const snapshot = JSON.parse(
                        await readFile(path.join(directory, String(index)), "utf8"),
                    ) as PartialFileSnapshot;
                    return { snapshot, content: snapshot.working };
                },
                message,
                assertNoDirtyBuffer,
                faults,
            );
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    }

    /** Shares hook/tree, snapshot, index/ref publication and recovery fences for both commit entries. */
    private async commitPreparedFiles(
        paths: readonly string[],
        readPrepared: ReadPreparedCommitFile,
        message: string,
        assertNoDirtyBuffer: DirtyBufferGuard,
        faults: PartialTransactionFaults,
    ): Promise<string> {
        const first = (await readPrepared(0)).snapshot;
        for (let index = 0; index < paths.length; index++) {
            const { snapshot, content } = await readPrepared(index);
            if (
                snapshot.view.path !== paths[index] ||
                snapshot.indexHash !== first.indexHash ||
                snapshot.head !== first.head ||
                snapshot.ref !== first.ref ||
                snapshot.root !== first.root
            ) {
                throw new Error(
                    "The selected files belong to different Git snapshots. Reopen their changes.",
                );
            }
            assertContentSize(content);
        }
        return this.executor.runWithinMutationGate(async () => {
            await this.assertCurrent(paths, readPrepared, assertNoDirtyBuffer);
            const directory = await mkdtemp(path.join(tmpdir(), "intelligit-partial-commit-"));
            try {
                const selectedIndex = path.join(directory, "selected-index");
                const reconciledIndex = path.join(directory, "reconciled-index");
                await this.executor.runBinary(["read-tree", first.head], {
                    env: { GIT_INDEX_FILE: selectedIndex },
                });
                await copyFile(first.indexPath, reconciledIndex);
                await this.materializeIndex(reconciledIndex);
                for (let index = 0; index < paths.length; index++) {
                    const { snapshot, content } = await readPrepared(index);
                    const fileDirectory = path.join(directory, String(index));
                    const retained = await this.reconcileText(fileDirectory, snapshot, content);
                    await this.writeBlob(selectedIndex, snapshot, content);
                    await this.writeBlob(reconciledIndex, snapshot, retained);
                }
                const expectedTree = await this.treeOf(selectedIndex);
                const parentTree = (
                    await this.executor.run(["rev-parse", `${first.head}^{tree}`])
                ).trim();
                if (expectedTree === parentTree)
                    throw new Error("The selection does not change the commit tree.");
                const commit = await preparePartialCommit(
                    this.executor,
                    first,
                    selectedIndex,
                    directory,
                    message,
                    expectedTree,
                );
                await this.assertCurrent(paths, readPrepared, assertNoDirtyBuffer);
                await publishPartialIndex(
                    this.executor,
                    first,
                    reconciledIndex,
                    commit,
                    async () => {
                        await this.assertCurrent(paths, readPrepared, assertNoDirtyBuffer);
                    },
                    faults,
                );
                this.clear();
                return commit;
            } finally {
                await rm(directory, { recursive: true, force: true });
            }
        });
    }

    /** Pending reconciliation is replayed only under the same repository mutation gate. */
    async recover(faults: PartialTransactionFaults = {}): Promise<boolean> {
        return this.executor.runWithinMutationGate(async () => {
            const { root, gitDir } = await this.recoveryLocation();
            const result = await recoverPartialIndexes(this.executor, root, gitDir, faults);
            this.issues = result.issues;
            if (result.changed) this.clear();
            return result.changed;
        });
    }

    /** Native review UI receives identities and reasons, never prepared index bytes. */
    recoveryIssues(): readonly PartialRecoveryIssue[] {
        return structuredClone(this.issues);
    }

    /** Dismisses only an explicitly chosen quarantined record for this captured worktree. */
    async discardRecovery(
        id: string,
        location: "pending" | "quarantined" = "quarantined",
    ): Promise<void> {
        await this.executor.runWithinMutationGate(async () => {
            const { root, gitDir } = await this.recoveryLocation();
            await discardPartialRecovery(root, gitDir, id, location);
            this.issues = this.issues.filter(
                (issue) => issue.id !== id || (issue.location ?? "quarantined") !== location,
            );
        });
    }

    /** Metadata rollback needs a proven unchanged head/ref and repository, not a guessed error string. */
    async canRestoreInclusion(
        snapshot: Pick<PartialFileSnapshot, "root" | "gitDir" | "head" | "ref">,
    ): Promise<boolean> {
        return this.executor.runWithinMutationGate(async () => {
            try {
                const { root, gitDir } = await this.recoveryLocation();
                const head = (await this.executor.run(["rev-parse", "--verify", "HEAD"])).trim();
                return (
                    root === snapshot.root &&
                    gitDir === snapshot.gitDir &&
                    head === snapshot.head &&
                    (await readPartialRef(this.executor)) === snapshot.ref
                );
            } catch {
                return false;
            }
        });
    }
    private async recoveryLocation(): Promise<{ root: string; gitDir: string }> {
        const root = await realpath(this.root);
        const actual = await realpath(
            (await this.executor.run(["rev-parse", "--show-toplevel"])).trim(),
        );
        if (actual !== root) throw new Error("The repository changed.");
        const gitDir = await realpath(
            (await this.executor.run(["rev-parse", "--absolute-git-dir"])).trim(),
        );
        return { root, gitDir };
    }

    private clear(): void {
        this.snapshots.clear();
        this.bytes = 0;
    }

    /** Rechecks all captured files with bounded reads and metadata/dirty-buffer guards on both sides. */
    private async assertCurrent(
        paths: readonly string[],
        readPrepared: ReadPreparedCommitFile,
        guard: DirtyBufferGuard,
    ): Promise<void> {
        await guard(paths);
        await assertPartialSnapshotCurrent(this.executor, (await readPrepared(0)).snapshot);
        await mapWithConcurrency(paths.slice(1), 6, async (_file, index) =>
            assertPartialSnapshotCurrent(
                this.executor,
                (await readPrepared(index + 1)).snapshot,
                false,
            ),
        );
        await guard(paths);
    }

    private async materializeIndex(index: string): Promise<void> {
        await this.executor.runBinary(["update-index", "--no-split-index"], {
            env: { GIT_INDEX_FILE: index },
        });
    }

    private async treeOf(index: string): Promise<string> {
        const result = await this.executor.runBinary(["write-tree"], {
            env: { GIT_INDEX_FILE: index },
        });
        return result.stdout.toString("utf8").trim();
    }

    private async writeBlob(
        index: string,
        snapshot: PartialFileSnapshot,
        content: string,
    ): Promise<void> {
        assertContentSize(content);
        const hash = await this.executor.runBinary(["hash-object", "-w", "--stdin"], {
            input: Buffer.from(content),
        });
        await this.executor.runBinary(
            [
                "--literal-pathspecs",
                "update-index",
                "--add",
                "--cacheinfo",
                snapshot.mode,
                hash.stdout.toString("utf8").trim(),
                snapshot.view.path,
            ],
            { env: { GIT_INDEX_FILE: index } },
        );
    }

    private async reconcileText(
        directory: string,
        snapshot: PartialFileSnapshot,
        selected: string,
    ): Promise<string> {
        if (snapshot.indexed === snapshot.view.base || snapshot.indexed === selected)
            return selected;
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const selectedPath = path.join(directory, "selected");
        const basePath = path.join(directory, "base");
        const indexPath = path.join(directory, "indexed");
        await Promise.all([
            writeFile(selectedPath, selected, { mode: 0o600 }),
            writeFile(basePath, snapshot.view.base, { mode: 0o600 }),
            writeFile(indexPath, snapshot.indexed, { mode: 0o600 }),
        ]);
        const result = await this.executor.runBinary(
            ["merge-file", "-p", "--", selectedPath, basePath, indexPath],
            { expectedExitCodes: [0, 1], maxOutputBytes: MAX_PARTIAL_TEXT_BYTES },
        );
        if (result.exitCode !== 0 || result.truncated) {
            throw new Error(
                "The selection overlaps different staged content. Review the index before committing.",
            );
        }
        const content = result.stdout.toString("utf8");
        assertContentSize(content);
        return content;
    }
    /** Git performs the inverse clean conversion; a non-round-tripping original is never rewritten. */
    private async worktreeBytes(snapshot: PartialFileSnapshot, content: string): Promise<Buffer> {
        assertContentSize(content);
        const oid = await this.executor.runBinary(["hash-object", "-w", "--stdin"], {
            input: Buffer.from(content),
        });
        const result = await this.executor.runBinary(
            [
                "cat-file",
                "--filters",
                `--path=${snapshot.view.path}`,
                oid.stdout.toString("utf8").trim(),
            ],
            { maxOutputBytes: MAX_PARTIAL_TEXT_BYTES, signal: AbortSignal.timeout(10_000) },
        );
        if (result.truncated) throw new Error("The rollback exceeds the supported text size.");
        return result.stdout;
    }
}

function snapshotBytes(snapshot: PartialFileSnapshot): number {
    return (
        Buffer.byteLength(snapshot.view.base) +
        Buffer.byteLength(snapshot.indexed) +
        Buffer.byteLength(snapshot.working) +
        Buffer.byteLength(JSON.stringify(snapshot.view.blocks))
    );
}

function assertContentSize(content: string): void {
    if (Buffer.byteLength(content, "utf8") > MAX_PARTIAL_TEXT_BYTES || content.includes("\0")) {
        throw new Error("The selected result exceeds the supported text size.");
    }
}
