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
    return side.kind === "provider" ? side.label : side.ref;
}
