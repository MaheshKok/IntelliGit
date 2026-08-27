import { exceedsDiffBudget } from "./diffBudgets";
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

/** Opens a working-tree diff as a VS Code-owned custom text editor. */
export async function openEditableDiff(
    request: EditableDiffRequest,
    nativeDelegate: EditableDiffNativeDelegate,
    beginSession: EditableDiffSessionStarter,
): Promise<void> {
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
    if (!editablePane) {
        await session.fallback();
        return;
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
        if (!session.isCurrent()) return;
        right = await loadDiffSide({
            repoRoot: request.repoRoot,
            filePath: request.path,
            side: request.right,
            executor,
        });
        if (!session.isCurrent()) return;
    } catch (error) {
        logGitOpsWarning("editableDiffOpener.openEditableDiff.resolve", error);
        await session.fallback();
        return;
    }

    const editableSide = editablePane === "left" ? left : right;
    if (editableSide.status === "missing") {
        await session.openReadOnly();
        return;
    }
    if (
        (left.status !== "loaded" && left.status !== "missing") ||
        (right.status !== "loaded" && right.status !== "missing") ||
        editableSide.status !== "loaded"
    ) {
        await session.fallback();
        return;
    }
    const viewerLeft = toViewerSide(left);
    const viewerRight = toViewerSide(right);
    if (exceedsDiffBudget(viewerLeft, viewerRight)) {
        await session.fallback();
        return;
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
    if (!session.setInitialSides(viewerLeft, viewerRight)) return;
    try {
        await openEditableDiffEditor(request.fileUri, descriptor);
    } catch (error) {
        // A rejected open is just one more "the viewer cannot render this", so it ends where
        // every other decline above does. The slot is released either way — `dispose()` is
        // `onPanelDisposed`, which releases too — so what this buys is the native diff itself:
        // rethrowing surfaced an error toast and left the user with no diff at all.
        logGitOpsWarning("editableDiffOpener.openEditableDiff.open", error);
        await session.fallback();
        return;
    }
    session.refreshIfPending();
}
