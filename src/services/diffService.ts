// Diff and comparison operations extracted from extension.ts.
// Handles opening diffs against git refs, commit file diffs,
// and applying/reverting single-file patches.

import * as path from "path";
import * as vscode from "vscode";
import { GitExecutor } from "../git/executor";
import { logGitOpsWarning } from "../git/operationSupport";
import { GitOps } from "../git/operations";
import { applyPatchTextToRepo } from "../git/patchApplication";
import { getErrorMessage } from "../utils/errors";
import { runWithNotificationProgress, showTimedInformationMessage } from "../utils/notifications";
import {
    getCommitParentHashes,
    pickMainlineParent,
    buildCommitFilePatch,
    isValidGitHash,
} from "./gitHelpers";
import { assertRepoRelativePath } from "../utils/fileOps";
import { EMPTY_TREE_HASH } from "../utils/constants";
import { exceedsDiffBudget } from "../diff/diffBudgets";
import {
    claimDiffViewerSession,
    clearDiffViewerSession,
    openDiffViewer,
    reportDiffViewerLoadError,
} from "../diff/diffViewerOpener";
import {
    loadDiffSide,
    toViewerSide,
    type LoadedDiffSide as ViewerDiffSide,
} from "../diff/sideLoader";
import { openEditableDiff } from "../diff/editableDiffOpener";
import { trackDiffTab, type DiffViewKind } from "../diff/diffViewSwitch";
import {
    documentIdForSides,
    labelForDiffSide,
    type EditableDiffSession,
} from "../diff/editableDiffTypes";
import {
    subscribeToRepositoryWorkingTreeChanges,
    type RepositoryWorkingTreeChange,
    type RepositoryWorkingTreeChangeSubscription,
} from "./repositoryChangeEvents";
import type {
    DiffViewerCancellationToken,
    NativeDiffDelegate,
    StableProviderIdentities,
    UnifiedDiffRequest,
} from "../diff/unifiedDiffTypes";

export type { SideSpec, UnifiedDiffRequest } from "../diff/unifiedDiffTypes";

const READONLY_DIFF_SCHEME = "intelligit-diff";
const readonlyDiffDocuments = new Map<string, string>();
let readonlyDiffDocumentSeq = 0;

/** Immutable text and loader metadata retained for an open diff session. */
interface FrozenDiffSideSnapshot {
    readonly text: string;
    readonly mode: number | undefined;
    readonly lineCount: number;
}

/** Generation-owned state for one panel request and its eventual native fallback. */
interface UnifiedDiffSession {
    readonly descriptor: UnifiedDiffRequest;
    readonly sideSnapshots: {
        readonly left?: FrozenDiffSideSnapshot;
        readonly right?: FrozenDiffSideSnapshot;
    };
    readonly stableProviderIdentities: StableProviderIdentities;
    readonly nativeDelegate: NativeDiffDelegate;
    generation: number;
}

class DiffViewerCancellationSource {
    private cancelled = false;
    private readonly listeners = new Set<() => void>();
    readonly token: DiffViewerCancellationToken;

    constructor() {
        this.token = createDiffViewerCancellationToken(this);
    }

    isCancellationRequested(): boolean {
        return this.cancelled;
    }

    addCancellationListener(listener: () => void): { dispose(): void } {
        if (this.cancelled) {
            listener();
            return { dispose: () => undefined };
        }
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
    }

    cancel(): void {
        if (this.cancelled) return;
        this.cancelled = true;
        for (const listener of this.listeners) listener();
        this.listeners.clear();
    }
}

function createDiffViewerCancellationToken(
    source: DiffViewerCancellationSource,
): DiffViewerCancellationToken {
    return {
        get isCancellationRequested() {
            return source.isCancellationRequested();
        },
        onCancellationRequested: (listener) => source.addCancellationListener(listener),
    };
}

interface ActiveUnifiedDiffSession extends Omit<UnifiedDiffSession, "sideSnapshots"> {
    readonly sideSnapshots: {
        left?: FrozenDiffSideSnapshot;
        right?: FrozenDiffSideSnapshot;
    };
    readonly cancellationSource: DiffViewerCancellationSource;
    onPanelDisposed: () => void;
    /** Takes this file's editable slot, retiring whichever session held it. */
    claimEditableSlot: () => void;
    /** Drops this session from both editable slot maps without disturbing a successor. */
    releaseEditableSlots: () => void;
    fallbackStarted: boolean;
    unsubscribe: () => void;
    changeSubscription: RepositoryWorkingTreeChangeSubscription | undefined;
    refreshInFlight: boolean;
    refreshPending: boolean;
    readonly claimViewerPanel: boolean;
    readonly onEditableRefresh:
        | ((left: Readonly<{ text: string }>, right: Readonly<{ text: string }>) => Promise<void>)
        | undefined;
    readonly onEditableRefreshError: ((message: string) => Promise<void>) | undefined;
}

let nextUnifiedDiffGeneration = 0;
let latestUnifiedDiffSession: ActiveUnifiedDiffSession | undefined;
/** Editable sessions whose editor is on screen, one per file. */
const editableDiffSessions = new Map<string, ActiveUnifiedDiffSession>();
/** Editable sessions still loading their sides, with nothing yet on screen. */
const loadingEditableSessions = new Map<string, ActiveUnifiedDiffSession>();

/**
 * Serves ephemeral read-only documents used as the left and right sides of VS Code diffs.
 *
 * Content is keyed by the full virtual URI and removed when the document closes
 * or the provider is disposed, so callers must not treat these URIs as stable
 * across sessions.
 */
class ReadonlyDiffContentProvider implements vscode.TextDocumentContentProvider {
    /** Returns the registered virtual document text, or an empty document for stale URIs. */
    provideTextDocumentContent(uri: vscode.Uri): string {
        return readonlyDiffDocuments.get(uri.toString()) ?? "";
    }

    /** Clears all virtual diff documents owned by this provider instance. */
    dispose(): void {
        readonlyDiffDocuments.clear();
    }
}

/**
 * Registers the virtual document provider backing commit and ref comparison diffs.
 *
 * The returned disposable unregisters the provider, removes the close listener,
 * and clears cached document content. Activation code should keep the disposable
 * in the extension context so virtual diff documents do not leak between sessions.
 */
export function registerReadonlyDiffContentProvider(
    context: vscode.ExtensionContext,
): vscode.Disposable {
    const provider = new ReadonlyDiffContentProvider();
    const providerRegistration = vscode.workspace.registerTextDocumentContentProvider(
        READONLY_DIFF_SCHEME,
        provider,
    );
    const closeListener = vscode.workspace.onDidCloseTextDocument((document) => {
        if (document.uri.scheme === READONLY_DIFF_SCHEME) {
            readonlyDiffDocuments.delete(document.uri.toString());
        }
    });
    const cleanup = {
        dispose: () => {
            providerRegistration.dispose();
            closeListener.dispose();
            provider.dispose();
        },
    };
    context.subscriptions.push(providerRegistration, closeListener, cleanup);
    return cleanup;
}

/**
 * Creates a unique virtual URI for immutable diff content from a Git ref or commit side.
 *
 * `filePath` must already be a repository-relative Git path. It is stored as a decoded
 * URI path so VS Code serializes special characters exactly once; it is never resolved
 * against the workspace filesystem. `refLabel` is stored as JSON `query.ref` so the
 * contributed resource formatter identifies each readonly diff side without changing
 * provider storage semantics.
 */
export function createReadonlyDiffUri(
    filePath: string,
    content: string,
    refLabel: string,
): vscode.Uri {
    readonlyDiffDocumentSeq += 1;
    const query = JSON.stringify({
        id: String(readonlyDiffDocumentSeq),
        ref: refLabel,
    });
    const uri = vscode.Uri.from({
        scheme: READONLY_DIFF_SCHEME,
        path: `/${filePath}`,
        query,
    });
    readonlyDiffDocuments.set(uri.toString(), content);
    return uri;
}

/**
 * Converts local path separators to the slash-separated path format expected by Git output.
 *
 * This does not resolve `..`, check containment, or touch the filesystem; callers
 * that receive user input must validate the path separately.
 */
export function normalizeGitPath(fsPathValue: string): string {
    return fsPathValue.split(path.sep).join("/");
}

/**
 * Converts a local file URI under the active repository root into a Git-relative path.
 *
 * Non-file URIs, the repository root itself, and paths outside `repoRoot` return
 * `null` so command handlers can show a user-facing availability error instead
 * of passing unsafe paths to Git or VS Code diff commands.
 */
export function getRepoRelativeFilePathFromUri(uri: vscode.Uri, repoRoot: string): string | null {
    if (uri.scheme !== "file") return null;
    const relative = path.relative(repoRoot, uri.fsPath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
    return normalizeGitPath(relative);
}

/**
 * Opens one read-only diff in the IntelliGit viewer, falling back to the caller's exact native
 * behaviour for anything the viewer cannot render, and remembers the tab it landed in so the
 * title-bar buttons can move it to the other surface.
 *
 * `nativeDelegate` is still not a preference: it exists for content the viewer must refuse —
 * binary, invalid UTF-8, symlink, submodule, or over-budget sides. `preferredView` is the
 * preference, and it arrives only from those buttons.
 */
export async function openUnifiedDiff(
    request: UnifiedDiffRequest,
    nativeDelegate: NativeDiffDelegate,
    preferredView?: DiffViewKind,
): Promise<void> {
    if (!(await openUnifiedDiffOnce(request, nativeDelegate, preferredView))) return;
    await trackDiffTab((view) => openUnifiedDiff(request, nativeDelegate, view));
}

/**
 * Opens the diff, reporting whether it put a tab on screen.
 *
 * Split from the tracking above so the answer is given per return rather than inferred from a
 * `finally`, which cannot tell a diff that opened from one a newer request superseded mid-load.
 * Superseded requests land nothing, so recording them would bind whichever tab is in front --
 * the file the reader actually clicked -- to the diff they clicked away from.
 */
async function openUnifiedDiffOnce(
    request: UnifiedDiffRequest,
    nativeDelegate: NativeDiffDelegate,
    preferredView: DiffViewKind | undefined,
): Promise<boolean> {
    const session = beginUnifiedDiffSession(request, nativeDelegate);
    // Honoured before either side loads, for the same reason the editable opener honours it
    // there: this is the reader asking for the other surface, not a check on what we can render.
    if (preferredView === "vscode") {
        await transitionToNativeFallback(session);
        return true;
    }
    const executor =
        request.left.kind === "ref" || request.right.kind === "ref"
            ? new GitExecutor(request.repoRoot)
            : undefined;
    let leftResult: Awaited<ReturnType<typeof loadDiffSide>> | undefined;
    let rightResult: Awaited<ReturnType<typeof loadDiffSide>> | undefined;
    let left: ViewerDiffSide | undefined;
    let right: ViewerDiffSide | undefined;
    let overBudget = false;

    try {
        const loadGeneration = session.generation;
        leftResult = await loadDiffSide({
            repoRoot: request.repoRoot,
            filePath: request.path,
            side: request.left,
            executor,
        });
        if (!isCurrentUnifiedDiffSession(session, loadGeneration)) return false;
        if (leftResult.status === "loaded" || leftResult.status === "missing") {
            left = toViewerSide(leftResult);
            rightResult = await loadDiffSide({
                repoRoot: request.repoRoot,
                filePath: request.path,
                side: request.right,
                executor,
            });
            if (!isCurrentUnifiedDiffSession(session, loadGeneration)) return false;
            if (rightResult.status === "loaded" || rightResult.status === "missing") {
                right = toViewerSide(rightResult);
                overBudget = exceedsDiffBudget(left, right);
            }
        }
    } catch (error) {
        if (!isCurrentUnifiedDiffSession(session)) return false;
        logGitOpsWarning("diffService.openUnifiedDiff.resolve", error);
        await transitionToNativeFallback(session);
        return true;
    }

    // Every outcome the viewer cannot render ends at the native editor: a side that
    // resolved to something unviewable (left undefined by the block above), a path
    // absent from both sides, or a pair over budget. One missing side is viewable —
    // that is how an added or deleted file renders.
    const bothMissing = leftResult?.status === "missing" && rightResult?.status === "missing";
    if (!left || !right || bothMissing || overBudget) {
        await transitionToNativeFallback(session);
        return true;
    }

    // Keep decoded sides for 3.6 partial re-resolution; the raw bytes are no longer needed
    // after the budget check and UTF-8 decode, so retaining copies would only waste memory.
    // The container stays mutable so refresh can replace mutable sides; freezeDiffSide still
    // protects each published snapshot from mutation.
    session.sideSnapshots.left = freezeDiffSide(left);
    session.sideSnapshots.right = freezeDiffSide(right);
    if (!isCurrentUnifiedDiffSession(session)) return false;

    await openDiffViewer({
        path: request.path,
        title: request.title,
        leftLabel: labelForDiffSide(request.left),
        rightLabel: labelForDiffSide(request.right),
        languageId: request.languageId,
        documentId: documentIdForSides(request.left, request.right),
        leftText: left.text,
        rightText: right.text,
        sessionGeneration: session.generation,
        onSessionDisposed: session.onPanelDisposed,
    });
    if (session.refreshPending) {
        session.refreshPending = false;
        requestUnifiedDiffRefresh(session);
    }
    // openDiffViewer awaits, so a newer request can start and win the panel while this one is
    // inside it -- the panel is a singleton and declines a stale generation. Re-check here so a
    // request that drew nothing never reports a landed tab: the caller would otherwise bind the
    // winner's tab to this request's reopen thunk, and the switch buttons would then reopen a
    // document the reader never asked for.
    return isCurrentUnifiedDiffSession(session);
}

interface BeginUnifiedDiffSessionOptions {
    readonly claimViewerPanel?: boolean;
    readonly editableSessionKey?: string;
    readonly onEditableRefresh?: (
        left: Readonly<{ text: string }>,
        right: Readonly<{ text: string }>,
    ) => Promise<void>;
    readonly onEditableRefreshError?: (message: string) => Promise<void>;
}

function beginUnifiedDiffSession(
    descriptor: UnifiedDiffRequest,
    nativeDelegate: NativeDiffDelegate,
    options: BeginUnifiedDiffSessionOptions = {},
): ActiveUnifiedDiffSession {
    const claimViewerPanel = options.claimViewerPanel ?? true;
    const previousSession = claimViewerPanel ? latestUnifiedDiffSession : undefined;
    previousSession?.cancellationSource.cancel();
    // An editable request supersedes a sibling that is still LOADING — nothing of that one
    // is on screen yet. It does not touch the session that already owns the editor: both
    // sides still have to load and pass the budget, and a request that then declines
    // (deleted working-tree file, over budget) would otherwise leave a visible tab bound to
    // a dead session that never refreshes again.
    if (options.editableSessionKey) {
        loadingEditableSessions.get(options.editableSessionKey)?.onPanelDisposed();
    }
    const cancellationSource = new DiffViewerCancellationSource();
    const sideSnapshots: {
        left?: FrozenDiffSideSnapshot;
        right?: FrozenDiffSideSnapshot;
    } = {};
    const session: ActiveUnifiedDiffSession = {
        descriptor,
        sideSnapshots,
        stableProviderIdentities: {
            left: getStableProviderIdentity(descriptor.left),
            right: getStableProviderIdentity(descriptor.right),
        },
        nativeDelegate,
        generation: ++nextUnifiedDiffGeneration,
        cancellationSource,
        onPanelDisposed: () => undefined,
        claimEditableSlot: () => undefined,
        releaseEditableSlots: () => undefined,
        fallbackStarted: false,
        unsubscribe: () => undefined,
        changeSubscription: undefined,
        refreshInFlight: false,
        refreshPending: false,
        claimViewerPanel,
        onEditableRefresh: options.onEditableRefresh,
        onEditableRefreshError: options.onEditableRefreshError,
    };
    session.onPanelDisposed = () => {
        cancellationSource.cancel();
        session.unsubscribe();
        session.unsubscribe = () => undefined;
        session.releaseEditableSlots();
    };
    session.releaseEditableSlots = () => {
        const key = options.editableSessionKey;
        if (!key) return;
        if (loadingEditableSessions.get(key) === session) loadingEditableSessions.delete(key);
        if (editableDiffSessions.get(key) === session) editableDiffSessions.delete(key);
    };
    session.claimEditableSlot = () => {
        const key = options.editableSessionKey;
        if (!key) return;
        if (loadingEditableSessions.get(key) === session) loadingEditableSessions.delete(key);
        const previous = editableDiffSessions.get(key);
        if (previous && previous !== session) previous.onPanelDisposed();
        editableDiffSessions.set(key, session);
    };
    if (options.editableSessionKey) {
        loadingEditableSessions.set(options.editableSessionKey, session);
    }
    if (session.claimViewerPanel) {
        latestUnifiedDiffSession = session;
        claimDiffViewerSession({
            generation: session.generation,
            onDispose: session.onPanelDisposed,
        });
    }
    bindUnifiedDiffSessionSubscription(session, previousSession);
    return session;
}

/** Starts an independently refreshable session for one VS Code-managed editable editor. */
export function beginEditableDiffSession(
    descriptor: UnifiedDiffRequest,
    nativeDelegate: NativeDiffDelegate,
    onRefresh: (
        left: Readonly<{ text: string }>,
        right: Readonly<{ text: string }>,
    ) => Promise<void>,
    onRefreshError: (message: string) => Promise<void>,
): EditableDiffSession {
    const session = beginUnifiedDiffSession(descriptor, nativeDelegate, {
        claimViewerPanel: false,
        editableSessionKey: [descriptor.repoRoot, descriptor.path].join("\u0000"),
        onEditableRefresh: onRefresh,
        onEditableRefreshError: onRefreshError,
    });
    return {
        isCurrent: () => isCurrentUnifiedDiffSession(session),
        setInitialSides: (left, right) => {
            if (!isCurrentUnifiedDiffSession(session)) return false;
            session.sideSnapshots.left = freezeDiffSide(left);
            session.sideSnapshots.right = freezeDiffSide(right);
            // The last point before the editor opens, and the first at which retiring the
            // previous session for this file cannot strand a still-visible editor.
            session.claimEditableSlot();
            return true;
        },
        refreshIfPending: () => {
            if (!session.refreshPending || !isCurrentUnifiedDiffSession(session)) return;
            session.refreshPending = false;
            requestUnifiedDiffRefresh(session);
        },
        fallback: () => transitionToNativeFallback(session),
        openReadOnly: async () => {
            session.onPanelDisposed();
            await openUnifiedDiff(descriptor, nativeDelegate);
        },
        dispose: session.onPanelDisposed,
    };
}

/** Moves the panel's mutable-side listener synchronously when a new descriptor replaces it. */
function bindUnifiedDiffSessionSubscription(
    session: ActiveUnifiedDiffSession,
    previousSession: ActiveUnifiedDiffSession | undefined,
): void {
    if (!hasMutableDiffSide(session.descriptor)) {
        previousSession?.unsubscribe();
        return;
    }
    const listener = (event: RepositoryWorkingTreeChange) =>
        requestUnifiedDiffRefresh(session, event);
    const transferred = previousSession?.changeSubscription;
    if (transferred) {
        transferred.rebind(session.descriptor.repoRoot, listener);
        previousSession.changeSubscription = undefined;
        previousSession.unsubscribe = () => undefined;
        session.changeSubscription = transferred;
    } else {
        session.changeSubscription = subscribeToRepositoryWorkingTreeChanges(
            session.descriptor.repoRoot,
            listener,
        );
    }
    session.unsubscribe = () => {
        const subscription = session.changeSubscription;
        session.changeSubscription = undefined;
        subscription?.dispose();
    };
}

/** Requests one serialized refresh when a root event can change at least one mutable side. */
function requestUnifiedDiffRefresh(
    session: ActiveUnifiedDiffSession,
    event?: RepositoryWorkingTreeChange,
): void {
    if (!isCurrentUnifiedDiffSession(session)) return;
    if (event && !shouldRefreshForChange(session.descriptor, event)) return;
    if (
        session.refreshInFlight ||
        session.sideSnapshots.left === undefined ||
        session.sideSnapshots.right === undefined
    ) {
        session.refreshPending = true;
        return;
    }
    session.refreshInFlight = true;
    void refreshUnifiedDiffSession(session)
        .catch((error) => {
            logGitOpsWarning("diffService.openUnifiedDiff.refresh.unhandled", error);
        })
        .finally(() => {
            session.refreshInFlight = false;
            if (!session.refreshPending || !isCurrentUnifiedDiffSession(session)) return;
            session.refreshPending = false;
            requestUnifiedDiffRefresh(session);
        });
}

/** Reloads only mutable snapshots and retains the prior panel content when the reload fails. */
async function refreshUnifiedDiffSession(session: ActiveUnifiedDiffSession): Promise<void> {
    const generation = ++nextUnifiedDiffGeneration;
    session.generation = generation;
    if (session.claimViewerPanel) {
        claimDiffViewerSession({ generation, onDispose: session.onPanelDisposed });
    }
    const needsGitExecutor = [session.descriptor.left, session.descriptor.right].some(
        (side) => side.kind === "ref" && isMutableDiffSide(side),
    );
    const executor = needsGitExecutor ? new GitExecutor(session.descriptor.repoRoot) : undefined;

    try {
        const left = await resolveRefreshSide(session, "left", executor);
        if (!isCurrentUnifiedDiffSession(session, generation)) return;
        const right = await resolveRefreshSide(session, "right", executor);
        if (!isCurrentUnifiedDiffSession(session, generation)) return;
        if (exceedsDiffSnapshotBudget(left, right)) {
            throw new Error("The refreshed diff exceeds the viewer budget.");
        }
        session.sideSnapshots.left = left;
        session.sideSnapshots.right = right;
        if (session.onEditableRefresh) {
            await session.onEditableRefresh(left, right);
            return;
        }
        await openDiffViewer({
            path: session.descriptor.path,
            title: session.descriptor.title,
            leftLabel: labelForDiffSide(session.descriptor.left),
            rightLabel: labelForDiffSide(session.descriptor.right),
            languageId: session.descriptor.languageId,
            documentId: documentIdForSides(session.descriptor.left, session.descriptor.right),
            leftText: left.text,
            rightText: right.text,
            sessionGeneration: generation,
            onSessionDisposed: session.onPanelDisposed,
        });
    } catch (error) {
        if (!isCurrentUnifiedDiffSession(session, generation)) return;
        logGitOpsWarning("diffService.openUnifiedDiff.refresh", error);
        try {
            // An editable session never claims the viewer panel, so `postLoadError` would
            // drop this on its generation guard and the editor would go quietly stale.
            if (session.onEditableRefreshError) {
                await session.onEditableRefreshError(getErrorMessage(error));
            } else {
                await reportDiffViewerLoadError(generation, getErrorMessage(error));
            }
        } catch (postError) {
            logGitOpsWarning("diffService.openUnifiedDiff.refresh.loadError", postError);
        }
    }
}

/** Resolves a mutable source again and returns an initial frozen snapshot for immutable sides. */
async function resolveRefreshSide(
    session: ActiveUnifiedDiffSession,
    sideName: "left" | "right",
    executor: GitExecutor | undefined,
): Promise<FrozenDiffSideSnapshot> {
    const side = session.descriptor[sideName];
    const snapshot = session.sideSnapshots[sideName];
    if (!isMutableDiffSide(side)) {
        if (snapshot === undefined) throw new Error("The frozen diff side is unavailable.");
        return snapshot;
    }
    const result = await loadDiffSide({
        repoRoot: session.descriptor.repoRoot,
        filePath: session.descriptor.path,
        side,
        executor,
    });
    if (result.status !== "loaded" && result.status !== "missing") {
        throw new Error("The refreshed diff side is no longer renderable.");
    }
    return freezeDiffSide(toViewerSide(result));
}

/** Applies the existing measured budget gates to the decoded snapshots retained by a session. */
function exceedsDiffSnapshotBudget(
    left: FrozenDiffSideSnapshot,
    right: FrozenDiffSideSnapshot,
): boolean {
    return exceedsDiffBudget(
        { bytes: Buffer.from(left.text, "utf8"), lineCount: left.lineCount, text: left.text },
        { bytes: Buffer.from(right.text, "utf8"), lineCount: right.lineCount, text: right.text },
    );
}

/** Selects events that can affect the requested file or a mutable symbolic reference. */
function shouldRefreshForChange(
    descriptor: UnifiedDiffRequest,
    event: RepositoryWorkingTreeChange,
): boolean {
    const hasMutableRef = [descriptor.left, descriptor.right].some(
        (side) => side.kind === "ref" && isMutableDiffSide(side),
    );
    if (event.path === undefined) return true;
    const requestedPath = descriptor.path.replace(/\\/g, "/");
    if (event.path === requestedPath) return true;
    return hasMutableRef && event.source !== "workspace-file";
}

/** Identifies worktree and symbolic-ref sides that must be resolved again after a root change. */
function hasMutableDiffSide(descriptor: UnifiedDiffRequest): boolean {
    return isMutableDiffSide(descriptor.left) || isMutableDiffSide(descriptor.right);
}

/** Treats full object IDs and provider sides as frozen snapshots for the lifetime of a session. */
function isMutableDiffSide(side: UnifiedDiffRequest["left"]): boolean {
    return side.kind === "worktree" || (side.kind === "ref" && !isObjectIdRef(side.ref));
}

/** Matches Git object-ID syntax without treating symbolic names as immutable. */
function isObjectIdRef(ref: string): boolean {
    const value = ref.trim();
    return isValidGitHash(value) || /^[0-9a-f]{64}$/i.test(value);
}

function isCurrentUnifiedDiffSession(
    session: ActiveUnifiedDiffSession,
    generation = session.generation,
): boolean {
    return (
        !session.cancellationSource.isCancellationRequested() && session.generation === generation
    );
}

async function transitionToNativeFallback(session: ActiveUnifiedDiffSession): Promise<void> {
    if (!isCurrentUnifiedDiffSession(session) || session.fallbackStarted) return;
    session.fallbackStarted = true;

    if (session.claimViewerPanel) clearDiffViewerSession(session.generation);
    session.unsubscribe();
    // A session that hands off to the native editor owns no editable surface any more, so
    // it must vacate its slots or nothing ever deletes them.
    session.releaseEditableSlots();
    await session.nativeDelegate(
        session.cancellationSource.token,
        session.stableProviderIdentities,
    );
}

function freezeDiffSide(side: ViewerDiffSide): FrozenDiffSideSnapshot {
    return Object.freeze({
        text: side.text,
        mode: side.mode,
        lineCount: side.lineCount,
    });
}

function getStableProviderIdentity(side: UnifiedDiffRequest["left"]): string | undefined {
    return side.kind === "provider" ? side.identity : undefined;
}

function getEditorContextFileUri(ctx?: unknown): vscode.Uri | null {
    if (ctx instanceof vscode.Uri) return ctx;
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    return activeUri?.scheme === "file" ? activeUri : null;
}

interface CommitInfoFileContext {
    filePath: string;
    commitHash: string;
    commitShortHash?: string;
}

/**
 * Extracts the commit-info context supplied by tree and webview command handlers.
 *
 * The object is treated as untrusted boundary data: missing or whitespace-only
 * commit hashes and file paths are ignored before any Git or filesystem work runs.
 */
function getCommitInfoFileContext(value: unknown): CommitInfoFileContext | null {
    if (!value || typeof value !== "object") return null;
    const maybe = value as {
        filePath?: unknown;
        commitHash?: unknown;
        commitShortHash?: unknown;
    };
    if (typeof maybe.filePath !== "string" || typeof maybe.commitHash !== "string") return null;
    const filePath = maybe.filePath.trim();
    const commitHash = maybe.commitHash.trim();
    const commitShortHash =
        typeof maybe.commitShortHash === "string" ? maybe.commitShortHash.trim() : undefined;
    if (!filePath || !commitHash) return null;
    return { filePath, commitHash, commitShortHash };
}

/**
 * Opens a diff between a working-tree file and its content at a Git ref.
 *
 * `repoRelativeFilePath` must already be validated and slash-separated. Routes through the unified
 * diff viewer, falling back to the exact prior direct-read-then-`vscode.diff` behavior for content the
 * viewer must refuse. Git read failures inside the native fallback still propagate to the caller so UI
 * command handlers can display the workflow-specific error message.
 */
async function openDiffAgainstGitRef(
    fileUri: vscode.Uri,
    repoRoot: string,
    repoRelativeFilePath: string,
    ref: string,
    sourceLabel: "revision" | "branch",
    gitOps: GitOps,
): Promise<void> {
    const trimmedRef = ref.trim();
    if (!trimmedRef) return;

    const title = `${repoRelativeFilePath} (${sourceLabel}: ${trimmedRef}) <-> Working Tree`;
    await openEditableDiff(
        {
            repoRoot,
            path: repoRelativeFilePath,
            left: { kind: "ref", ref: trimmedRef },
            right: { kind: "worktree" },
            languageId: "",
            title,
            fileUri,
        },
        async (cancellationToken) => {
            const refContent = await gitOps.getFileContentAtRef(repoRelativeFilePath, trimmedRef);
            if (cancellationToken.isCancellationRequested) return;
            const leftUri = createReadonlyDiffUri(repoRelativeFilePath, refContent, trimmedRef);
            await vscode.commands.executeCommand("vscode.diff", leftUri, fileUri, title);
        },
        beginEditableDiffSession,
    );
}

/**
 * Opens a read-only diff for the selected file as changed by a specific commit.
 *
 * The commit hash is validated before Git is called and `filePath` must be a
 * repository-relative path. Merge commits prompt for the mainline parent; files
 * missing on either side are represented as empty virtual documents so deletes
 * and adds still open in the diff editor.
 *
 * @throws When the commit hash or file path is unsafe, or when parent discovery
 * fails before the user can choose a merge mainline.
 */
export async function openCommitFileDiff(
    commitHash: string,
    filePath: string,
    repoRoot: string,
    gitOps: GitOps,
    executor: GitExecutor,
): Promise<void> {
    const validatedHash = commitHash.trim();
    if (!isValidGitHash(validatedHash)) {
        throw new Error("Invalid commit hash received for file diff action.");
    }
    const safePath = assertRepoRelativePath(filePath);
    const parents = await getCommitParentHashes(validatedHash, executor);

    let parentRef: string;
    let parentDisplayHash: string;
    if (parents.length > 1) {
        const result = await pickMainlineParent(
            validatedHash,
            "Open Commit File Diff",
            executor,
            parents,
        );
        if (result.kind === "cancelled") return;
        if (result.kind === "notMerge") return;
        parentRef = `${validatedHash}^${result.parentNumber}`;
        parentDisplayHash = parents[result.parentNumber! - 1] ?? parentRef;
    } else {
        parentRef = parents.length === 0 ? EMPTY_TREE_HASH : parents[0];
        parentDisplayHash = parentRef;
    }

    const shortParent = parentDisplayHash.slice(0, 8);
    const shortCommit = validatedHash.slice(0, 8);
    const title = `${safePath} (${shortParent} ↔ ${shortCommit})`;

    await openUnifiedDiff(
        {
            repoRoot,
            path: safePath,
            left: { kind: "ref", ref: parentRef },
            right: { kind: "ref", ref: validatedHash },
            languageId: "",
            title,
        },
        async (cancellationToken) => {
            let leftContent: string;
            try {
                leftContent = await gitOps.getFileContentAtRef(safePath, parentRef);
            } catch {
                leftContent = "";
            }

            let rightContent: string;
            try {
                rightContent = await gitOps.getFileContentAtRef(safePath, validatedHash);
            } catch {
                rightContent = "";
            }

            if (cancellationToken.isCancellationRequested) return;
            const leftUri = createReadonlyDiffUri(safePath, leftContent, shortParent);
            const rightUri = createReadonlyDiffUri(safePath, rightContent, shortCommit);
            await vscode.commands.executeCommand("vscode.diff", leftUri, rightUri, title);
        },
    );
}

/**
 * Prompts for a branch and opens a read-only comparison with the active editor file.
 *
 * The command is safe to invoke only when a local file under `repoRoot` is active.
 * Invalid editor context and Git failures are shown to the user; the comparison
 * does not mutate the repository.
 */
export async function compareEditorFileWithBranch(
    ctx: unknown,
    repoRoot: string,
    gitOps: GitOps,
): Promise<void> {
    const fileUri = getEditorContextFileUri(ctx);
    if (!fileUri) {
        vscode.window.showErrorMessage(
            vscode.l10n.t("Compare with Branch is only available for local files."),
        );
        return;
    }

    const repoRelativeFilePath = getRepoRelativeFilePathFromUri(fileUri, repoRoot);
    if (!repoRelativeFilePath) {
        vscode.window.showErrorMessage(
            vscode.l10n.t("Selected file is outside the current IntelliGit repository workspace."),
        );
        return;
    }

    try {
        const branches = await gitOps.getBranches();
        const picks = branches
            .slice()
            .sort((a, b) => {
                if (a.isRemote !== b.isRemote) return a.isRemote ? 1 : -1;
                if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
                return a.name.localeCompare(b.name);
            })
            .map((branch) => ({
                label: branch.isCurrent ? `${branch.name} (current)` : branch.name,
                description: branch.isRemote ? "remote branch" : "local branch",
                detail: branch.hash,
                refName: branch.name,
            }));

        const picked = await vscode.window.showQuickPick(picks, {
            title: vscode.l10n.t("Compare with Branch"),
            placeHolder: vscode.l10n.t("Select a branch for {path}", {
                path: repoRelativeFilePath,
            }),
            ignoreFocusOut: true,
            matchOnDescription: true,
            matchOnDetail: true,
        });
        if (!picked) return;

        await openDiffAgainstGitRef(
            fileUri,
            repoRoot,
            repoRelativeFilePath,
            picked.refName,
            "branch",
            gitOps,
        );
    } catch (error) {
        const message = getErrorMessage(error);
        vscode.window.showErrorMessage(
            vscode.l10n.t("Compare with branch failed: {message}", { message }),
        );
    }
}

/**
 * Prompts for a recent or manually entered revision and compares it with the active file.
 *
 * Recent history is limited to the selected repository-relative file path. Prompt
 * cancellation is a no-op, and any Git or diff opening error is converted into a
 * user-facing message without changing repository state.
 */
export async function compareEditorFileWithRevision(
    ctx: unknown,
    repoRoot: string,
    gitOps: GitOps,
): Promise<void> {
    const fileUri = getEditorContextFileUri(ctx);
    if (!fileUri) {
        vscode.window.showErrorMessage(
            vscode.l10n.t("Compare with Revision is only available for local files."),
        );
        return;
    }

    const repoRelativeFilePath = getRepoRelativeFilePathFromUri(fileUri, repoRoot);
    if (!repoRelativeFilePath) {
        vscode.window.showErrorMessage(
            vscode.l10n.t("Selected file is outside the current IntelliGit repository workspace."),
        );
        return;
    }

    try {
        const historyEntries = await gitOps.getFileHistoryEntries(repoRelativeFilePath, 20);
        const MANUAL_SENTINEL = "__manual__";
        const historyPicks = historyEntries.map((entry) => ({
            label: `${entry.shortHash}  ${entry.subject || "(no subject)"}`,
            description: entry.author,
            detail: entry.date,
            refName: entry.hash,
        }));
        const picks = [
            ...historyPicks,
            {
                label: vscode.l10n.t("$(edit) Enter revision manually"),
                description: vscode.l10n.t("Commit hash, tag, or ref name"),
                detail: undefined as string | undefined,
                refName: MANUAL_SENTINEL,
            },
        ];

        const picked = await vscode.window.showQuickPick(picks, {
            title: vscode.l10n.t("Compare with Revision"),
            placeHolder:
                historyPicks.length > 0
                    ? vscode.l10n.t("Select a recent revision for {path}", {
                          path: repoRelativeFilePath,
                      })
                    : vscode.l10n.t("No recent file history found. Enter a revision for {path}", {
                          path: repoRelativeFilePath,
                      }),
            ignoreFocusOut: true,
            matchOnDescription: true,
            matchOnDetail: true,
        });
        if (!picked) return;

        let refName = picked.refName;
        if (refName === MANUAL_SENTINEL) {
            const input = await vscode.window.showInputBox({
                title: vscode.l10n.t("Compare with Revision"),
                prompt: vscode.l10n.t("Enter a commit hash, tag, or ref for {path}", {
                    path: repoRelativeFilePath,
                }),
                placeHolder: "HEAD~1",
                ignoreFocusOut: true,
            });
            if (!input?.trim()) return;
            refName = input.trim();
        }

        await openDiffAgainstGitRef(
            fileUri,
            repoRoot,
            repoRelativeFilePath,
            refName,
            "revision",
            gitOps,
        );
    } catch (error) {
        const message = getErrorMessage(error);
        vscode.window.showErrorMessage(
            vscode.l10n.t("Compare with revision failed: {message}", { message }),
        );
    }
}

/**
 * Opens a diff from a commit-info file entry to the current local workspace file.
 *
 * The context object may come from a tree item or webview message and is ignored
 * when it lacks a commit hash or file path. The file path must validate as
 * repository-relative before it is joined with `repoRoot` for the local side.
 */
export async function compareCommitInfoFileWithLocal(
    ctx: unknown,
    repoRoot: string,
    gitOps: GitOps,
): Promise<void> {
    const fileCtx = getCommitInfoFileContext(ctx);
    if (!fileCtx) return;
    try {
        const safePath = assertRepoRelativePath(fileCtx.filePath);
        const fileUri = vscode.Uri.file(path.join(repoRoot, safePath));
        await openDiffAgainstGitRef(
            fileUri,
            repoRoot,
            safePath,
            fileCtx.commitHash,
            "revision",
            gitOps,
        );
    } catch (error) {
        const message = getErrorMessage(error);
        vscode.window.showErrorMessage(
            vscode.l10n.t("Compare with local failed: {message}", { message }),
        );
    }
}

/**
 * Applies or reverts the selected commit's change for a single file.
 *
 * This workflow mutates both the working tree and index through `git apply --index --3way`
 * after a modal confirmation. Merge commits may prompt for a
 * mainline parent, empty patches notify without mutation, errors are shown to
 * the user, and conflict UI refresh runs best-effort in `finally`.
 */
export async function applySelectedCommitFileChange(
    ctx: unknown,
    mode: "cherry-pick" | "revert",
    executor: GitExecutor,
    refreshConflictUi: () => Promise<void>,
): Promise<void> {
    const fileCtx = getCommitInfoFileContext(ctx);
    if (!fileCtx) return;

    const short = fileCtx.commitShortHash || fileCtx.commitHash.slice(0, 8);
    const labels = COMMIT_FILE_CHANGE_MODE_LABELS[mode];
    const confirmLabel = labels.confirmLabel();

    const confirmed = await vscode.window.showWarningMessage(
        labels.confirmPrompt(short, fileCtx.filePath),
        { modal: true },
        confirmLabel,
    );
    if (confirmed !== confirmLabel) return;

    try {
        const patchText = await buildCommitFilePatch(
            fileCtx.commitHash,
            fileCtx.filePath,
            labels.actionTitle(),
            executor,
        );
        if (patchText === null) return; // merge parent selection cancelled
        if (!patchText.trim()) {
            showTimedInformationMessage(
                vscode.l10n.t("No file-level patch found for {path} in {short}.", {
                    path: fileCtx.filePath,
                    short,
                }),
            );
            return;
        }

        await runWithNotificationProgress(labels.progressMessage(fileCtx.filePath), async () => {
            await applyPatchTextToRepo(patchText, mode === "revert", executor);
        });

        showTimedInformationMessage(labels.successMessage(short, fileCtx.filePath));
    } catch (error) {
        const message = getErrorMessage(error);
        vscode.window.showErrorMessage(labels.errorMessage(message));
    } finally {
        await refreshConflictUi().catch(() => {});
    }
}

const COMMIT_FILE_CHANGE_MODE_LABELS = {
    "cherry-pick": {
        actionTitle: () => vscode.l10n.t("Cherry-pick Selected Change"),
        confirmLabel: () => vscode.l10n.t("Apply Change"),
        confirmPrompt: (short: string, filePath: string) =>
            vscode.l10n.t(
                "Apply the change from {short} for {path} to your working tree and stage it?",
                { short, path: filePath },
            ),
        progressMessage: (filePath: string) =>
            vscode.l10n.t("Applying selected change for {path}...", { path: filePath }),
        successMessage: (short: string, filePath: string) =>
            vscode.l10n.t("Applied selected change from {short} for {path}.", {
                short,
                path: filePath,
            }),
        errorMessage: (message: string) =>
            vscode.l10n.t("Cherry-pick selected change failed: {message}", { message }),
    },
    revert: {
        actionTitle: () => vscode.l10n.t("Revert Selected Change"),
        confirmLabel: () => vscode.l10n.t("Revert Change"),
        confirmPrompt: (short: string, filePath: string) =>
            vscode.l10n.t(
                "Apply the inverse of the change from {short} for {path} to your working tree and stage it?",
                { short, path: filePath },
            ),
        progressMessage: (filePath: string) =>
            vscode.l10n.t("Reverting selected change for {path}...", { path: filePath }),
        successMessage: (short: string, filePath: string) =>
            vscode.l10n.t("Reverted selected change from {short} for {path}.", {
                short,
                path: filePath,
            }),
        errorMessage: (message: string) =>
            vscode.l10n.t("Revert selected change failed: {message}", { message }),
    },
} as const;
