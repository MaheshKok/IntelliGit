import { open, stat } from "node:fs/promises";
import path from "node:path";
import { REBASE_SESSION_MARKER } from "./editorCommand";

/** The ownership states that determine which rebase controls may safely mutate a live rebase. */
export type RebaseControl = "owned" | "unowned" | "foreign";

/** The only live-manifest fields needed to correlate an on-disk rebase marker. */
export type LiveRebaseManifest = {
    /** Session identifier that the sequence helper writes into Git's transient state. */
    sessionId: string;
    /** Only an active helper session may authorize message injection. */
    lifecycle: "starting" | "running" | "paused";
};

const REBASE_SESSION_MARKER_MAX_BYTES = 4_096;

type RebaseDirectoryState = "missing" | "readable" | "uncertain";

/**
 * Derives the safe control scope for an existing Git rebase without changing any state.
 *
 * `owned` is the only state that authorizes helper-message injection, so every read or directory
 * uncertainty returns the non-authorizing `foreign` when a live manifest exists. Without a live
 * manifest, the same uncertainty is `unowned`: controls may operate on Git, but cannot affect any
 * IntelliGit session. `rebase-apply` is always foreign with a live manifest because our sequence
 * helper writes its marker only in `rebase-merge`.
 */
export async function deriveRebaseControl({
    gitDir,
    liveManifest,
}: {
    /** Worktree-local Git directory containing rebase state. */
    gitDir: string;
    /** Caller-selected active manifest, if any. */
    liveManifest?: LiveRebaseManifest;
}): Promise<RebaseControl | "none"> {
    try {
        const [mergeState, applyState] = await Promise.all([
            inspectRebaseDirectory(path.join(gitDir, "rebase-merge")),
            inspectRebaseDirectory(path.join(gitDir, "rebase-apply")),
        ]);
        if (mergeState === "missing" && applyState === "missing") return "none";
        if (!liveManifest) return "unowned";
        if (applyState !== "missing" || mergeState !== "readable") return "foreign";
        const marker = await readMarker(path.join(gitDir, "rebase-merge", REBASE_SESSION_MARKER));
        return marker === liveManifest.sessionId ? "owned" : "foreign";
    } catch {
        // A thrown filesystem error cannot prove ownership; retain the manifest but never inject.
        // Unreachable while both helpers below convert their own failures into a value, and kept
        // so that a future helper which throws fails closed rather than escaping to the caller.
        return liveManifest ? "foreign" : "unowned";
    }
}

/** Distinguishes absence from a directory that cannot positively support an ownership claim. */
async function inspectRebaseDirectory(directory: string): Promise<RebaseDirectoryState> {
    try {
        return (await stat(directory)).isDirectory() ? "readable" : "uncertain";
    } catch (error) {
        return isMissing(error) ? "missing" : "uncertain";
    }
}

/** Reads no more than the fixed marker budget; a longer or unreadable marker cannot authorize. */
async function readMarker(markerPath: string): Promise<string | undefined> {
    let handle;
    try {
        handle = await open(markerPath, "r");
        const bytes = Buffer.alloc(REBASE_SESSION_MARKER_MAX_BYTES + 1);
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
        if (bytesRead > REBASE_SESSION_MARKER_MAX_BYTES) return undefined;
        return bytes.subarray(0, bytesRead).toString("utf8").trim();
    } catch {
        // A missing, unreadable, or racing marker is not positive evidence of our session.
        return undefined;
    } finally {
        await handle?.close().catch(() => undefined);
    }
}

/** Recognizes the one filesystem error that proves a path is absent. */
function isMissing(error: unknown): boolean {
    return (
        typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
    );
}
