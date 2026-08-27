import type * as vscode from "vscode";
import type { LoadedDiffSide } from "./sideLoader";
import type { NativeDiffDelegate, SideSpec, UnifiedDiffRequest } from "./unifiedDiffTypes";

/** The left or right viewer pane that owns the live workspace document. */
export type EditableDiffPane = "left" | "right";

/** One working-tree diff that VS Code must own as a real text document. */
export interface EditableDiffRequest {
    readonly repoRoot: string;
    readonly path: string;
    readonly left: SideSpec;
    readonly right: SideSpec;
    readonly languageId: string;
    readonly title: string;
    readonly fileUri: vscode.Uri;
}

/** Session data retained by the custom editor after the immutable source has been loaded. */
export interface EditableDiffDescriptor {
    readonly path: string;
    readonly title: string;
    readonly leftLabel: string;
    readonly rightLabel: string;
    readonly languageId: string;
    /** Distinguishes two diffs whose path and labels read the same; see `DiffViewerData`. */
    readonly documentId?: string;
    readonly editablePane: EditableDiffPane;
    readonly immutableText: string;
    /**
     * Surfaces a failed refresh in the editor itself. Editable sessions never claim the
     * viewer panel, so `reportDiffViewerLoadError` drops their reports on its generation
     * guard and the pane would otherwise go stale in silence.
     */
    readonly loadError?: string;
    /** Releases the generation-owned refresh session when this editor closes. */
    readonly onSessionDisposed?: () => void;
}

/** Native fallback invoked when the custom editor cannot safely render a request. */
export type EditableDiffNativeDelegate = NativeDiffDelegate;

/** Existing generation-backed session control shared by the opener and diff service. */
export interface EditableDiffSession {
    isCurrent(): boolean;
    setInitialSides(left: LoadedDiffSide, right: LoadedDiffSide): boolean;
    refreshIfPending(): void;
    fallback(): Promise<void>;
    openReadOnly(): Promise<void>;
    dispose(): void;
}

/** Starts the existing refresh session without coupling the opener back to diffService. */
export type EditableDiffSessionStarter = (
    descriptor: UnifiedDiffRequest,
    nativeDelegate: EditableDiffNativeDelegate,
    onRefresh: (
        left: Readonly<{ text: string }>,
        right: Readonly<{ text: string }>,
    ) => Promise<void>,
    onRefreshError: (message: string) => Promise<void>,
) => EditableDiffSession;

/** Finds the pane backed by the real working-tree document, if this diff has one. */
export function editablePaneForSides(
    left: SideSpec,
    right: SideSpec,
): EditableDiffPane | undefined {
    if (left.kind === "worktree") return "left";
    if (right.kind === "worktree") return "right";
    return undefined;
}

/**
 * Returns the display label for one source side. The single definition on purpose: the
 * editable and read-only paths render the same pane, so a second copy is a casing drift
 * the user sees as two different labels for one file.
 */
export function labelForDiffSide(side: SideSpec): string {
    if (side.kind === "worktree") return "Working tree";
    if (side.kind === "provider") return side.label;
    return shortenObjectName(side.ref);
}

/**
 * A whole object name, as `git rev-parse` prints it, plus whatever the caller appended.
 *
 * The trailing group is what lets a merge parent through: `openCommitFileDiff` addresses one
 * by revspec, `<sha>^2`, and an anchored forty-character match would leave that whole
 * forty-two-character string in the header. The suffix may not begin with a hex character,
 * so a forty-one-character name is still not a match -- it is not an object name with
 * something appended, it is not an object name.
 */
const FULL_OBJECT_NAME = /^([0-9a-f]{40})($|[^0-9a-f].*$)/;

/**
 * Shows a resolved commit the way git shows one to a person: seven characters.
 *
 * Callers that already resolved a revision hand over all forty, which fills the pane
 * header with a string nobody reads and pushes the part they do read out of sight. Only an
 * actual object name is shortened -- `HEAD`, `main`, `v1.2.0` and `HEAD~1` are already the
 * short form of themselves, and truncating those would produce a ref that means something
 * else or nothing at all.
 *
 * A revspec keeps its suffix, because the suffix is the half that says which parent: an
 * abbreviated `<sha>^2` still resolves, and still reads as the second parent.
 */
function shortenObjectName(ref: string): string {
    const match = FULL_OBJECT_NAME.exec(ref);
    return match ? `${match[1].slice(0, 7)}${match[2] ?? ""}` : ref;
}

/**
 * What tells two diffs apart when their labels cannot.
 *
 * `labelForDiffSide` answers "what should the reader see", and several sources answer that
 * with a constant: every shelf entry is captioned `Shelved`, whatever it holds. That is
 * right for a caption and useless as an identity, so the viewer would treat two different
 * shelved versions of one file as one document and keep the scroll position between them --
 * the exact defect the viewport reset exists to prevent, on the one entry point whose
 * labels never vary.
 *
 * A provider already carries `identity` for its content cache, which is the value that
 * varies per shelf entry, so this exposes it rather than inventing a second one. A
 * `worktree` side is the one live file at that path and has nothing further to say.
 */
export function identityForDiffSide(side: SideSpec): string {
    if (side.kind === "worktree") return "worktree";
    if (side.kind === "provider") return side.identity;
    return side.ref;
}

/**
 * The identity of a two-sided diff, as the viewer's viewport reset compares it.
 *
 * One definition because the open path and the refresh path both build it: a refresh that
 * spelled the identity differently would read as a different document and throw the reader
 * back to line 1 every time the file changed on disk. Same reason `labelForDiffSide` is
 * shared, with a sharper failure -- a label drift is a cosmetic inconsistency, an identity
 * drift is a scroll jump mid-read.
 */
export function documentIdForSides(left: SideSpec, right: SideSpec): string {
    return JSON.stringify([identityForDiffSide(left), identityForDiffSide(right)]);
}
