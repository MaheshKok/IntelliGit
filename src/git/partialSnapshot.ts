import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { GitExecutor } from "./executor";
import { assertRepoRelativePath } from "../utils/repoRelativePath";
import { assertContainedParent } from "../shelf/recoveryPaths";
import { changeFingerprint, parseChangeDiff } from "../changes/parseDiff";
import type { ChangeFileView } from "../webviews/protocol/changeSelection";

/** The existing text limit also bounds this separately authorized workflow. */
export const MAX_PARTIAL_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_DIFF_BYTES = 8 * 1024 * 1024;
const MARKERS = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"];

/** Known eligibility refusal; unlike an I/O or stale-snapshot failure, whole-file handling is defined. */
export class PartialChangesUnsupportedError extends Error {}

/** The file, index or branch moved during a capture, as an outside `git status` index rewrite does. */
export class PartialSnapshotChangedError extends Error {}

/** Host-only fences never travel through a browser message. */
export interface PartialFileSnapshot {
    view: ChangeFileView;
    root: string;
    head: string;
    ref: string;
    gitDir: string;
    commonDir: string;
    indexPath: string;
    indexHash: string;
    worktreeHash: string;
    attributes: string;
    contentId: string;
    mode: string;
    indexed: string;
    working: string;
}

/** A partial workflow is available only outside whole-index Git operations. */
export async function assertPartialOperationIdle(gitDir: string): Promise<void> {
    const present = await Promise.all(
        MARKERS.map(async (marker) => {
            try {
                await lstat(path.join(gitDir, marker));
                return true;
            } catch (error) {
                if (isMissing(error)) return false;
                throw error;
            }
        }),
    );
    if (present.some(Boolean))
        throw new Error("Partial changes are unavailable during a Git operation.");
}

/** Reads contained, unchanged UTF-8 regular files without normalizing their bytes. */
async function readPartialWorktree(root: string, file: string): Promise<Buffer> {
    const target = path.join(root, assertRepoRelativePath(file));
    await assertContainedParent(root, target);
    const before = await lstat(target);
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_PARTIAL_TEXT_BYTES) {
        throw new PartialChangesUnsupportedError(
            "Partial changes require a regular text file of at most 2 MiB.",
        );
    }
    const bytes = await readFile(target);
    const after = await lstat(target);
    if (
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        !after.isFile() ||
        after.isSymbolicLink()
    ) {
        throw new Error("The file changed while reading. Reopen its changes.");
    }
    assertText(bytes);
    return bytes;
}

/** Reads the real index only if Git reports the normal, non-symlink index path. */
export async function readPartialIndex(
    snapshot: Pick<PartialFileSnapshot, "indexPath" | "gitDir">,
): Promise<Buffer> {
    if (path.resolve(snapshot.indexPath) !== path.join(snapshot.gitDir, "index")) {
        throw new Error("Custom Git indexes cannot use partial changes.");
    }
    const stats = await lstat(snapshot.indexPath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 64 * 1024 * 1024) {
        throw new Error("The Git index cannot be safely read.");
    }
    return readFile(snapshot.indexPath);
}

/** Captures a path-bound snapshot and delegates diff computation to Git, not a UI parser. */
export async function readPartialSnapshot(
    executor: GitExecutor,
    requestedRoot: string,
    filePath: string,
    side: "working" | "index",
): Promise<PartialFileSnapshot> {
    const file = assertRepoRelativePath(filePath);
    const root = await realpath(requestedRoot);
    // `--path-format` changes only the options after it, so the index path stays relative.
    const [actualTop, actualGitDir, gitIndexPath, actualCommonDir, head] = await revParse(
        executor,
        [
            "--show-toplevel",
            "--absolute-git-dir",
            "--git-path",
            "index",
            "--path-format=absolute",
            "--git-common-dir",
            "--verify",
            "HEAD",
        ],
        5,
    );
    if ((await realpath(actualTop)) !== root) throw new Error("The repository changed.");
    const gitDir = await realpath(actualGitDir);
    const commonDir = await realpath(actualCommonDir);
    await assertPartialOperationIdle(gitDir);
    const ref = await readPartialRef(executor);
    const indexPath = path.resolve(root, gitIndexPath);
    const indexHash = changeFingerprint(await readPartialIndex({ gitDir, indexPath }));
    // `-v` prefixes each stage line with its tag, so one read gives the entry and its flags.
    const index = await executor.run([
        "--literal-pathspecs",
        "ls-files",
        "--stage",
        "-v",
        "-z",
        "--",
        file,
    ]);
    const entry = singleBlobEntry(index.slice(2), file);
    if (!index.startsWith("H "))
        throw new PartialChangesUnsupportedError(
            "Sparse and assume-unchanged files require whole-file handling.",
        );
    const tree = await executor.run(["--literal-pathspecs", "ls-tree", "-z", head, "--", file]);
    const original = /^(100644|100755) blob ([a-f0-9]{40,64})\t([^\0]+)\0$/.exec(tree);
    if (!original || original[3] !== file || original[1] !== entry.mode) {
        throw new PartialChangesUnsupportedError(
            "Added, deleted, renamed and mode-changing files require whole-file handling.",
        );
    }
    const base = await readPartialBlob(executor, original[2]);
    const indexed = entry.oid === original[2] ? base : await readPartialBlob(executor, entry.oid);
    const raw = await readPartialWorktree(root, file);
    const attributes = await readAttributes(executor, file);
    const working = await canonicalWorktree(executor, file, raw);
    const target = side === "working" ? working : indexed;
    const blocks = await computeBlocks(executor, base, target);
    const contentId = changeFingerprint(JSON.stringify([base, target, blocks]));
    const worktreeHash = changeFingerprint(raw);
    const id = changeFingerprint(
        JSON.stringify([
            root,
            head,
            ref,
            indexHash,
            file,
            side,
            worktreeHash,
            attributes,
            working,
            contentId,
        ]),
    );
    const snapshot: PartialFileSnapshot = {
        root,
        head,
        ref,
        gitDir,
        commonDir,
        indexPath,
        indexHash,
        worktreeHash,
        attributes,
        mode: entry.mode,
        indexed,
        working,
        contentId,
        view: { snapshotId: id, path: file, side, base, blocks },
    };
    await assertPartialSnapshotCurrent(executor, snapshot);
    return snapshot;
}

/** Rechecks branch, operation, complete index, file bytes and clean-conversion identity. */
export async function assertPartialSnapshotCurrent(
    executor: GitExecutor,
    snapshot: PartialFileSnapshot,
    verifyRepository = true,
): Promise<void> {
    await assertPartialOperationIdle(snapshot.gitDir);
    const [head, ref, index, raw, attributes] = await Promise.all([
        verifyRepository
            ? executor.run(["rev-parse", "--verify", "HEAD"])
            : Promise.resolve(snapshot.head),
        verifyRepository ? readPartialRef(executor) : Promise.resolve(snapshot.ref),
        verifyRepository ? readPartialIndex(snapshot) : Promise.resolve(undefined),
        readPartialWorktree(snapshot.root, snapshot.view.path),
        readAttributes(executor, snapshot.view.path),
    ]);
    if (
        head.trim() !== snapshot.head ||
        ref !== snapshot.ref ||
        (index !== undefined && changeFingerprint(index) !== snapshot.indexHash) ||
        changeFingerprint(raw) !== snapshot.worktreeHash ||
        attributes !== snapshot.attributes ||
        (await canonicalWorktree(executor, snapshot.view.path, raw)) !== snapshot.working
    ) {
        throw new PartialSnapshotChangedError(
            "The file, index or branch changed. Your selection is retained; reopen its changes.",
        );
    }
    if (!verifyRepository) return;
    const [top, actualGitDir, gitIndexPath] = await revParse(
        executor,
        ["--show-toplevel", "--absolute-git-dir", "--git-path", "index"],
        3,
    );
    const root = await realpath(top);
    const gitDir = await realpath(actualGitDir);
    const indexPath = path.resolve(root, gitIndexPath);
    if (root !== snapshot.root || gitDir !== snapshot.gitDir || indexPath !== snapshot.indexPath) {
        throw new Error("The repository changed.");
    }
}

/** Answers several `rev-parse` questions with one Git process, one line per answer. */
async function revParse(executor: GitExecutor, args: string[], answers: number): Promise<string[]> {
    const lines = (await executor.run(["rev-parse", ...args])).trim().split("\n");
    if (lines.length !== answers) throw new Error("The repository changed.");
    return lines;
}

/** Detached HEAD is a valid identity; symbolic refs must remain exact. */
export async function readPartialRef(executor: GitExecutor): Promise<string> {
    const result = await executor.runBinary(["symbolic-ref", "--quiet", "HEAD"], {
        expectedExitCodes: [0, 1],
    });
    return result.exitCode === 0 ? result.stdout.toString("utf8").trim() : "HEAD";
}

/** Reads a bounded Git blob and refuses truncated or unsupported text before exposing it as a snapshot. */
async function readPartialBlob(executor: GitExecutor, oid: string): Promise<string> {
    const result = await executor.runBinary(["cat-file", "blob", oid], {
        maxOutputBytes: MAX_PARTIAL_TEXT_BYTES,
        signal: AbortSignal.timeout(10_000),
    });
    if (result.truncated)
        throw new PartialChangesUnsupportedError("The file exceeds the partial-change text limit.");
    assertText(result.stdout);
    return result.stdout.toString("utf8");
}

/** Rejects binary, invalid UTF-8, and excessive byte or line sizes instead of silently reducing a selection. */
function assertText(bytes: Buffer): void {
    if (bytes.length > MAX_PARTIAL_TEXT_BYTES || !isUtf8(bytes) || bytes.includes(0)) {
        throw new PartialChangesUnsupportedError(
            "Binary, non-UTF-8 and oversized files require whole-file handling.",
        );
    }
    let lines = 0;
    let width = 0;
    for (const byte of bytes) {
        if (byte === 10) {
            lines++;
            width = 0;
        } else width++;
        if (lines > 100_000 || width > 16_384) {
            throw new PartialChangesUnsupportedError(
                "Very long lines and large line counts require whole-file handling.",
            );
        }
    }
}

/** Requires one exact stage-zero regular-file entry; conflicts and special entries stay on the whole-file path. */
function singleBlobEntry(index: string, file: string) {
    const match = /^(100644|100755) ([a-f0-9]{40,64}) 0\t([^\0]+)\0$/.exec(index);
    if (!match || match[3] !== file || /^0+$/.test(match[2])) {
        throw new PartialChangesUnsupportedError(
            "Conflicts and special index entries require whole-file handling.",
        );
    }
    return { mode: match[1], oid: match[2] };
}

/** Refuses custom filters and encodings, returning the checked attributes for later snapshot identity checks. */
async function readAttributes(executor: GitExecutor, file: string): Promise<string> {
    const output = await executor.run([
        "--literal-pathspecs",
        "check-attr",
        "-z",
        "filter",
        "working-tree-encoding",
        "--",
        file,
    ]);
    const values = output.split("\0");
    for (let i = 0; i + 2 < values.length; i += 3) {
        if (values[i] !== file || !["unspecified", "unset"].includes(values[i + 2])) {
            throw new PartialChangesUnsupportedError(
                "Custom filters and working-tree encodings require whole-file handling.",
            );
        }
    }
    return output;
}

/** Accepts unchanged bytes or Git-equivalent CRLF normalization; other clean conversions fail closed. */
async function canonicalWorktree(
    executor: GitExecutor,
    file: string,
    raw: Buffer,
): Promise<string> {
    const clean = (
        await executor.runBinary(["hash-object", `--path=${file}`, "--stdin"], { input: raw })
    ).stdout
        .toString("utf8")
        .trim();
    // Git hashes unfiltered bytes as `blob <size>\0<bytes>`; the clean hash's length names the
    // repository's object format, so this equals `git hash-object --stdin` without a process.
    const unfiltered = (bytes: Buffer) =>
        createHash(clean.length === 64 ? "sha256" : "sha1")
            .update(`blob ${bytes.length}\0`)
            .update(bytes)
            .digest("hex");
    if (clean === unfiltered(raw)) return raw.toString("utf8");
    const normalized = Buffer.from(raw.toString("utf8").replace(/\r\n/g, "\n"));
    if (clean !== unfiltered(normalized)) {
        throw new PartialChangesUnsupportedError(
            "Unsupported clean conversion. Use whole-file handling.",
        );
    }
    return normalized.toString("utf8");
}

/** Diffs private temporary text without external diff helpers; bounded output is parsed before files are removed. */
async function computeBlocks(executor: GitExecutor, base: string, target: string) {
    if (base === target) return [];
    const directory = await mkdtemp(path.join(tmpdir(), "intelligit-change-diff-"));
    try {
        const before = path.join(directory, "base");
        const after = path.join(directory, "target");
        await writeFile(before, base, { mode: 0o600 });
        await writeFile(after, target, { mode: 0o600 });
        const result = await executor.runBinary(
            [
                "-c",
                "diff.suppressBlankEmpty=false",
                "diff",
                "--no-index",
                "--no-ext-diff",
                "--no-textconv",
                "--no-color",
                "--unified=3",
                "--",
                before,
                after,
            ],
            {
                expectedExitCodes: [0, 1],
                maxOutputBytes: MAX_DIFF_BYTES,
                signal: AbortSignal.timeout(10_000),
            },
        );
        if (result.truncated)
            throw new PartialChangesUnsupportedError("The diff exceeds the supported size.");
        return parseChangeDiff(result.stdout.toString("utf8"), base, target);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

function isMissing(error: unknown): boolean {
    return (
        typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
    );
}
