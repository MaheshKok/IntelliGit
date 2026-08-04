import { useCallback, useRef, useState } from "react";
import type { RebaseTodoEntry } from "../../../protocol/commitGraphTypes";

type RebaseDialogInbound = { type: "showRebaseDialog"; requestId: string };
type RebaseDialogOutbound =
    | { type: "cancelRebaseDialog"; requestId: string }
    | { type: "startInteractiveRebase"; requestId: string; entries: RebaseTodoEntry[] };

/**
 * Owns the one-shot interactive-rebase dialog lifecycle shared by docked and undocked graphs.
 *
 * A replacement dialog cancels its predecessor before becoming active, and submission or cancellation
 * clears local state before notifying the extension so stale callbacks cannot submit the same request twice.
 */
export function useRebaseDialogController<TDialog extends RebaseDialogInbound>(
    postMessage: (message: RebaseDialogOutbound) => void,
): {
    rebaseDialog: TDialog | null;
    handleShowRebaseDialog: (dialog: TDialog) => void;
    handleRebaseDialogSubmit: (entries: readonly RebaseTodoEntry[]) => void;
    handleRebaseDialogCancel: () => void;
} {
    const [rebaseDialog, setRebaseDialog] = useState<TDialog | null>(null);
    const rebaseDialogRef = useRef<TDialog | null>(null);
    const postMessageRef = useRef(postMessage);
    postMessageRef.current = postMessage;
    const handleShowRebaseDialog = useCallback((dialog: TDialog): void => {
        const previous = rebaseDialogRef.current;
        if (previous)
            postMessageRef.current({ type: "cancelRebaseDialog", requestId: previous.requestId });
        rebaseDialogRef.current = dialog;
        setRebaseDialog(dialog);
    }, []);
    const handleRebaseDialogSubmit = useCallback((entries: readonly RebaseTodoEntry[]): void => {
        const dialog = rebaseDialogRef.current;
        if (!dialog) return;
        rebaseDialogRef.current = null;
        setRebaseDialog(null);
        postMessageRef.current({
            type: "startInteractiveRebase",
            requestId: dialog.requestId,
            entries: [...entries],
        });
    }, []);
    const handleRebaseDialogCancel = useCallback((): void => {
        const dialog = rebaseDialogRef.current;
        if (!dialog) return;
        rebaseDialogRef.current = null;
        setRebaseDialog(null);
        postMessageRef.current({ type: "cancelRebaseDialog", requestId: dialog.requestId });
    }, []);

    return {
        rebaseDialog,
        handleShowRebaseDialog,
        handleRebaseDialogSubmit,
        handleRebaseDialogCancel,
    };
}
