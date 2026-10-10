import { createHash } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { lstat, readFile } from "node:fs/promises";
import { getVsCodeApi } from "./operationSupport";
import path from "node:path";
import type { GitExecutor } from "./executor";
import { assertRepoRelativePath } from "../utils/repoRelativePath";
import { assertContainedParent } from "../shelf/recoveryPaths";
import { replaceMergeWorktreeFile } from "../shelf/safeWorktreeWrite";

/** Literal pathspec mode prevents user filenames from becoming Git path expressions. */
function withLiteralPathspecs(args: string[]): string[] {
    return ["--literal-pathspecs", ...args];
}

/** Bounded UTF-8 inputs for one immutable Git conflict session. */
export interface MergeResolutionSnapshot {
    readonly id: string;
    readonly index: string;
    readonly worktree: string;
    readonly operation: string;
    readonly base: string;
    readonly ours: string;
    readonly theirs: string;
}

/** Keeps Git operations usable in non-extension tests while honoring host localization. */
function mergeError(message: string, options?: ErrorOptions): Error {
    return new Error(getVsCodeApi()?.l10n.t(message) ?? message, options);
}

const MAX_TEXT_BYTES = 2 * 1024 * 1024;

/** Identifies raw bytes without storing their contents in session identity. */
function fingerprint(bytes: Uint8Array): string {
    return createHash("sha256").update(bytes).digest("hex");
}

/** Reads only an existing, contained regular file and refuses binary or oversized input. */
async function readWorktree(root: string, relativePath: string): Promise<Buffer> {
    const target = path.join(root, relativePath);
    await assertContainedParent(root, target);
    const before = await lstat(target);
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_TEXT_BYTES) {
        throw mergeError("This conflict requires a regular text file of at most 2 MiB.");
    }
    const bytes = await readFile(target);
    const after = await lstat(target);
    if (
        !after.isFile() ||
        after.isSymbolicLink() ||
        before.ino !== after.ino ||
        before.mtimeMs !== after.mtimeMs ||
        before.size !== after.size ||
        bytes.length > MAX_TEXT_BYTES
    )
        throw mergeError(
            "The conflict file changed while it was being read. Reopen the merge editor.",
        );
    if (!isUtf8(bytes) || bytes.includes(0)) {
        throw mergeError(
            "Binary and non-UTF-8 conflicts must be resolved outside the text merge editor.",
        );
    }
    return bytes;
}

/** Captures exact index stages, distinguishing a missing stage from an empty blob. */
async function operationIdentity(executor: GitExecutor): Promise<string> {
    const markers = [
        "MERGE_HEAD",
        "CHERRY_PICK_HEAD",
        "REVERT_HEAD",
        "rebase-merge",
        "rebase-apply",
    ];
    const identities = await Promise.all(
        markers.map(async (marker) => {
            const markerPath = (
                await executor.run(["rev-parse", "--path-format=absolute", "--git-path", marker])
            ).trim();
            try {
                const stats = await lstat(markerPath);
                return [
                    marker,
                    stats.ino,
                    stats.mtimeMs,
                    stats.isFile() ? fingerprint(await readFile(markerPath)) : stats.birthtimeMs,
                ];
            } catch (error) {
                if (
                    typeof error === "object" &&
                    error !== null &&
                    "code" in error &&
                    error.code === "ENOENT"
                )
                    return [marker, null];
                throw error;
            }
        }),
    );
    return JSON.stringify(identities);
}

/** Captures exact index stages, distinguishing a missing stage from an empty blob. */
export async function readMergeResolutionSnapshot(
    executor: GitExecutor,
    root: string,
    filePath: string,
): Promise<MergeResolutionSnapshot> {
    const safePath = assertRepoRelativePath(filePath);
    const initialHead = await executor.run(["rev-parse", "HEAD"]);
    const operation = await operationIdentity(executor);
    const index = await executor.run(
        withLiteralPathspecs(["ls-files", "-u", "-z", "--", safePath]),
    );
    const entries = index.split("\0").filter(Boolean);
    if (!entries.length)
        throw mergeError("The file is no longer conflicted. Reopen the conflict list.");
    const versions = new Map<number, string>();
    for (const entry of entries) {
        const match = /^(100644|100755) ([a-f\d]{40,64}) ([123])\t/.exec(entry);
        if (!match || entry.slice(match[0].length) !== safePath) {
            throw mergeError(
                "Submodule, symlink and special-file conflicts require a different resolver.",
            );
        }
        const result = await executor.runBinary(["cat-file", "blob", match[2]], {
            maxOutputBytes: MAX_TEXT_BYTES,
            signal: AbortSignal.timeout(10_000),
        });
        if (result.truncated || !isUtf8(result.stdout) || result.stdout.includes(0)) {
            throw mergeError(
                "Binary, non-UTF-8 or oversized conflicts cannot use the text merge editor.",
            );
        }
        versions.set(Number(match[3]), result.stdout.toString("utf8"));
    }
    // A deleted side needs an explicit keep/delete decision, not an empty text replacement.
    if (!versions.has(2) || !versions.has(3)) {
        throw mergeError(
            "A deleted-side conflict needs an explicit keep/delete resolution. Use the conflict list or Git.",
        );
    }
    const worktree = fingerprint(await readWorktree(root, safePath));
    const head = await executor.run(["rev-parse", "HEAD"]);
    // Fence the complete read so stages cannot be assembled across two operations.
    if (
        initialHead !== head ||
        operation !== (await operationIdentity(executor)) ||
        index !==
            (await executor.run(withLiteralPathspecs(["ls-files", "-u", "-z", "--", safePath]))) ||
        worktree !== fingerprint(await readWorktree(root, safePath))
    ) {
        throw mergeError("The conflict changed while opening. Reopen the merge editor.");
    }
    return {
        id: fingerprint(Buffer.from(JSON.stringify([safePath, head, operation, index, worktree]))),
        index,
        worktree,
        operation,
        base: versions.get(1) ?? "",
        ours: versions.get(2)!,
        theirs: versions.get(3)!,
    };
}

/** Applies only a current snapshot under the existing repository mutation gate. */
export async function applyMergeResolution(
    executor: GitExecutor,
    root: string,
    filePath: string,
    snapshot: MergeResolutionSnapshot,
    content: string,
    assertNoDirtyEditor: () => void | Promise<void>,
): Promise<void> {
    const safePath = assertRepoRelativePath(filePath);
    if (Buffer.byteLength(content, "utf8") > MAX_TEXT_BYTES || content.includes("\0")) {
        throw mergeError("The merge result exceeds the supported text size.");
    }
    // Equals/pipe underlines are valid document content; only reject opening/closing markers.
    if (/^(?:<{7}|>{7})(?: [^\r\n]*)?\r?$/m.test(content)) {
        throw mergeError(
            "The result still contains conflict markers. Resolve them before applying.",
        );
    }
    await executor.runWithinMutationGate(async (run) => {
        await assertNoDirtyEditor();
        const current = await readMergeResolutionSnapshot(executor, root, safePath);
        if (current.id !== snapshot.id) {
            throw mergeError(
                "Git stages or the working file changed. Your draft is retained; reopen the merge editor before applying.",
            );
        }
        await assertNoDirtyEditor();
        await replaceMergeWorktreeFile(root, safePath, Buffer.from(content, "utf8"), async () => {
            await assertNoDirtyEditor();
            if ((await readMergeResolutionSnapshot(executor, root, safePath)).id !== snapshot.id) {
                throw mergeError(
                    "The conflict changed before saving. Your draft is retained; reopen the merge editor.",
                );
            }
        });
        const after = await run(withLiteralPathspecs(["ls-files", "-u", "-z", "--", safePath]));
        if (
            after !== snapshot.index ||
            (await operationIdentity(executor)) !== snapshot.operation
        ) {
            throw mergeError(
                "Git stages changed during the write. The result was saved but not staged; inspect it before continuing.",
            );
        }
        const bytes = await readWorktree(root, safePath);
        if (!bytes.equals(Buffer.from(content, "utf8"))) {
            throw mergeError(
                "The file changed during the write. It was not staged; your draft is retained.",
            );
        }
        await assertNoDirtyEditor();
        try {
            await run(withLiteralPathspecs(["add", "--", safePath]));
        } catch (cause) {
            throw mergeError(
                "The result was saved but staging failed. Your draft is retained; inspect the file and stage it before continuing.",
                { cause },
            );
        }
    });
}
