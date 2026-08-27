import { exceedsDiffBudget } from "./diffBudgets";
import { trackDiffTab, type DiffViewKind } from "./diffViewSwitch";
import {
    documentIdForSides,
    editablePaneForSides,
    labelForDiffSide,
    type EditableDiffDescriptor,
    type EditableDiffNativeDelegate,
    type EditableDiffRequest,
    type EditableDiffSessionStarter,
} from "./editableDiffTypes";
import { loadDiffSide, toViewerSide } from "./sideLoader";
import { GitExecutor } from "../git/executor";
import { logGitOpsWarning } from "../git/operationSupport";
import {
    openEditableDiffEditor,
    refreshEditableDiffEditor,
} from "../views/EditableDiffEditorProvider";

/**
 * Opens a working-tree diff as a VS Code-owned custom text editor, and remembers the tab it
 * landed in so the title-bar buttons can move it to the other surface.
 *
 * `preferredView: "vscode"` sends it straight to the native diff instead. That is a request from
 * the title-bar switch, not a capability check, so it is honoured before any side is loaded --
 * the reader asked for the other surface, and making them wait for a load whose only result is
 * to be discarded would be the same as ignoring them.
 */
export async function openEditableDiff(
    request: EditableDiffRequest,
    nativeDelegate: EditableDiffNativeDelegate,
    beginSession: EditableDiffSessionStarter,
    preferredView?: DiffViewKind,
): Promise<void> {
    if (!(await openEditableDiffOnce(request, nativeDelegate, beginSession, preferredView))) return;
    await trackDiffTab((view) => openEditableDiff(request, nativeDelegate, beginSession, view));
}

/**
 * Opens the diff, reporting whether it put a tab on screen.
 *
 * Split from the tracking above so the answer is given per return rather than inferred from a
 * `finally`, which cannot tell a diff that opened from one that a newer request superseded
 * mid-load. Superseded requests land nothing, so recording them would bind whichever tab is in
 * front -- the file the reader actually clicked -- to the diff they clicked away from.
 */
async function openEditableDiffOnce(
    request: EditableDiffRequest,
    nativeDelegate: EditableDiffNativeDelegate,
    beginSession: EditableDiffSessionStarter,
    preferredView: DiffViewKind | undefined,
): Promise<boolean> {
    const editablePane = editablePaneForSides(request.left, request.right);
    const descriptorState: { current: EditableDiffDescriptor | undefined } = { current: undefined };
    const session = beginSession(
        request,
        nativeDelegate,
        async (left, right) => {
            if (!descriptorState.current || !editablePane) return;
            // Written back, not just posted: the error callback below rebuilds from this
            // descriptor, so without the write-back a later failure would rewind the
            // historical pane to its open-time content while claiming it had frozen.
            descriptorState.current = {
                ...descriptorState.current,
                immutableText: editablePane === "left" ? right.text : left.text,
            };
            await refreshEditableDiffEditor(request.fileUri, descriptorState.current);
        },
        async (message) => {
            if (!descriptorState.current) return;
            // Keeps the last good immutable side on screen and says why it stopped moving.
            await refreshEditableDiffEditor(request.fileUri, {
                ...descriptorState.current,
                loadError: message,
            });
        },
    );
    if (!editablePane || preferredView === "vscode") {
        await session.fallback();
        // The same contract every landing here reports under, and the same one the read-only
        // funnel reports under: a request that drew nothing must not claim a tab, or the
        // caller binds the winner's tab to this request's reopen thunk and the switch buttons
        // reopen a document the reader never asked for.
        //
        // Measured: on THIS surface it cannot currently come back false. `fallback()` releases
        // the loading slot before it awaits the native delegate, and an editable session claims
        // no viewer panel, so nothing cancels it inside its own fallback -- a mutant reverting
        // all six landings to a bare `true` survives the whole suite. It is kept because the
        // funnel's identical window is real and proven, and the two surfaces answer the same
        // question; what makes this one unreachable is the slot ordering, not the absence of
        // the race. Move that release after the await and this becomes load-bearing.
        return session.isCurrent();
    }

    const executor =
        request.left.kind === "ref" || request.right.kind === "ref"
            ? new GitExecutor(request.repoRoot)
            : undefined;
    let left: Awaited<ReturnType<typeof loadDiffSide>>;
    let right: Awaited<ReturnType<typeof loadDiffSide>>;
    try {
        left = await loadDiffSide({
            repoRoot: request.repoRoot,
            filePath: request.path,
            side: request.left,
            executor,
        });
        if (!session.isCurrent()) return false;
        right = await loadDiffSide({
            repoRoot: request.repoRoot,
            filePath: request.path,
            side: request.right,
            executor,
        });
        if (!session.isCurrent()) return false;
    } catch (error) {
        logGitOpsWarning("editableDiffOpener.openEditableDiff.resolve", error);
        await session.fallback();
        return session.isCurrent();
    }

    const editableSide = editablePane === "left" ? left : right;
    if (editableSide.status === "missing") {
        // The read-only opener tracks the tab it lands itself, and with the better thunk: this
        // file has no editable side, so reopening through here would only rediscover that and
        // hand back to the same viewer.
        await session.openReadOnly();
        return false;
    }
    if (
        (left.status !== "loaded" && left.status !== "missing") ||
        (right.status !== "loaded" && right.status !== "missing") ||
        editableSide.status !== "loaded"
    ) {
        await session.fallback();
        return session.isCurrent();
    }
    const viewerLeft = toViewerSide(left);
    const viewerRight = toViewerSide(right);
    if (exceedsDiffBudget(viewerLeft, viewerRight)) {
        await session.fallback();
        return session.isCurrent();
    }

    const descriptor: EditableDiffDescriptor = {
        path: request.path,
        title: request.title,
        leftLabel: labelForDiffSide(request.left),
        rightLabel: labelForDiffSide(request.right),
        languageId: request.languageId,
        documentId: documentIdForSides(request.left, request.right),
        editablePane,
        immutableText: editablePane === "left" ? viewerRight.text : viewerLeft.text,
        onSessionDisposed: () => session.dispose(),
    };
    descriptorState.current = descriptor;
    if (!session.setInitialSides(viewerLeft, viewerRight)) return false;
    try {
        await openEditableDiffEditor(request.fileUri, descriptor);
    } catch (error) {
        // A rejected open is just one more "the viewer cannot render this", so it ends where
        // every other decline above does. The slot is released either way — `dispose()` is
        // `onPanelDisposed`, which releases too — so what this buys is the native diff itself:
        // rethrowing surfaced an error toast and left the user with no diff at all.
        logGitOpsWarning("editableDiffOpener.openEditableDiff.open", error);
        await session.fallback();
        return session.isCurrent();
    }
    session.refreshIfPending();
    return session.isCurrent();
}
