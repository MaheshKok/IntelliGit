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

/**
 * Read-only evidence from Git's transient rebase directories.
 *
 * `merge` is the only layout IntelliGit can own. Missing or unreadable marker and metadata
 * files deliberately become `undefined`, because absence cannot authorize message injection.
 */
export type RebaseDirectoryEvidence =
    | { status: "none" }
    | {
          status: "merge";
          marker?: string;
          headName?: string;
          onto?: string;
          origHead?: string;
      }
    | { status: "apply" }
    | { status: "uncertain" };

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
        return deriveRebaseControlFromEvidence({
            rebaseDirectory: await readRebaseDirectoryEvidence(gitDir, false),
            liveManifest,
        });
    } catch {
        // A thrown filesystem error cannot prove ownership; retain the manifest but never inject.
        // Unreachable while both helpers below convert their own failures into a value, and kept
        // so that a future helper which throws fails closed rather than escaping to the caller.
        return liveManifest ? "foreign" : "unowned";
    }
}

/**
 * Reads one bounded snapshot of Git's rebase directory before any manifest is selected.
 *
 * The marker is always read before `head-name`, `onto`, and `orig-head`; callers can omit
 * those extra fields when they only need the existing marker-only control decision.
 */
export async function readRebaseDirectoryEvidence(
    gitDir: string,
    includeMetadata: boolean = true,
): Promise<RebaseDirectoryEvidence> {
    const [mergeState, applyState] = await Promise.all([
        inspectRebaseDirectory(path.join(gitDir, "rebase-merge")),
        inspectRebaseDirectory(path.join(gitDir, "rebase-apply")),
    ]);
    if (mergeState === "missing" && applyState === "missing") return { status: "none" };
    if (mergeState !== "readable" || applyState !== "missing") {
        return mergeState === "missing" && applyState === "readable"
            ? { status: "apply" }
            : { status: "uncertain" };
    }

    const rebaseDirectory = path.join(gitDir, "rebase-merge");
    const marker = await readBoundedRebaseText(path.join(rebaseDirectory, REBASE_SESSION_MARKER));
    if (!includeMetadata) return { status: "merge", marker };
    const [headName, onto, origHead] = await Promise.all([
        readBoundedRebaseText(path.join(rebaseDirectory, "head-name")),
        readBoundedRebaseText(path.join(rebaseDirectory, "onto")),
        readBoundedRebaseText(path.join(rebaseDirectory, "orig-head")),
    ]);
    return { status: "merge", marker, headName, onto, origHead };
}

/**
 * Applies the established marker correlation rule to a previously captured directory snapshot.
 *
 * `hasLiveManifest` distinguishes a terminal-started rebase with no live IntelliGit state from
 * a foreign rebase that conflicts with at least one retained live manifest.
 */
export function deriveRebaseControlFromEvidence({
    rebaseDirectory,
    liveManifest,
    hasLiveManifest = Boolean(liveManifest),
}: {
    /** Rebase-directory snapshot captured before manifest selection. */
    rebaseDirectory: RebaseDirectoryEvidence;
    /** The live manifest whose session identifier equals the captured marker, if any. */
    liveManifest?: LiveRebaseManifest;
    /** Whether repository storage contains any otherwise valid live manifest. */
    hasLiveManifest?: boolean;
}): RebaseControl | "none" {
    switch (rebaseDirectory.status) {
        case "none":
            return "none";
        case "merge":
            if (!liveManifest) return hasLiveManifest ? "foreign" : "unowned";
            return rebaseDirectory.marker === liveManifest.sessionId ? "owned" : "foreign";
        case "apply":
        case "uncertain":
            return hasLiveManifest ? "foreign" : "unowned";
        default:
            return assertNeverRebaseDirectoryEvidence(rebaseDirectory);
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

/** Reads no more than the fixed marker budget; a longer or unreadable value cannot authorize. */
async function readBoundedRebaseText(targetPath: string): Promise<string | undefined> {
    let handle;
    try {
        handle = await open(targetPath, "r");
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

/** Preserves exhaustiveness when a new physical rebase-directory state is introduced. */
function assertNeverRebaseDirectoryEvidence(evidence: never): never {
    void evidence;
    throw new Error("Unhandled interactive rebase directory evidence.");
}

/** Recognizes the one filesystem error that proves a path is absent. */
function isMissing(error: unknown): boolean {
    return (
        typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
    );
}
