import {
    useCallback,
    useLayoutEffect,
    type Dispatch,
    type MutableRefObject,
    type SetStateAction,
} from "react";
import { isolateHistory, undo, redo } from "@codemirror/commands";
import { openSearchPanel } from "@codemirror/search";
import {
    bulkResolve,
    dismissSide,
    replaceHunks,
    resultContent,
    type MergeChoice,
} from "./workbenchModel";
import { hunkView } from "./workbenchRows";
import type { HunkActionCallbacks } from "./workbenchGutter";
import type { useWorkbenchEditors } from "./useWorkbenchEditors";
import { getVsCodeApi } from "../shared/vscodeApi";
import type { OutboundMessage } from "./types";
import type { MergeWorkbenchOutbound } from "../../protocol/mergeWorkbench";

type CommandOptions = Pick<
    ReturnType<typeof useWorkbenchEditors>,
    "data" | "editors" | "hunks" | "busy" | "flushDraft" | "setBusy" | "setError"
> & {
    active: number | null;
    setActive: Dispatch<SetStateAction<number | null>>;
    actions: MutableRefObject<HunkActionCallbacks | null>;
    jumpTo: (index: number) => void;
};

const abort = () => getVsCodeApi<OutboundMessage>().postMessage({ type: "abortMerge" });
const useFile = (side: "ours" | "theirs") =>
    getVsCodeApi<OutboundMessage>().postMessage({
        type: side === "ours" ? "acceptYours" : "acceptTheirs",
    });

/** Binds the classic chrome and action gutters to the result editor's single history. */
export function useWorkbenchCommands({
    data,
    editors,
    hunks,
    busy,
    flushDraft,
    setBusy,
    setError,
    active,
    setActive,
    actions,
    jumpTo,
}: CommandOptions) {
    const selected = active === null ? undefined : hunks[active];
    const pending = hunks.filter((hunk) => hunk.conflict && !hunk.resolved).length;
    const conflictIndices = hunks.flatMap((hunk, index) => (hunk.conflict ? [index] : []));
    const unresolvedIndices = conflictIndices.filter((index) => !hunks[index].resolved);
    const nextUnresolved =
        unresolvedIndices[(unresolvedIndices.indexOf(active ?? -1) + 1) % unresolvedIndices.length];
    const jump = useCallback(
        (index: number) => {
            if (!hunks.length) return;
            const next = (index + hunks.length) % hunks.length;
            setActive(next);
            jumpTo(next);
        },
        [jumpTo, hunks, setActive],
    );

    const resolve = useCallback(
        (choice: MergeChoice, selectedIndex = active, { focus = true } = {}) => {
            const target = selectedIndex === null ? undefined : hunks[selectedIndex];
            const view = editors.current[1]?.view;
            if (!view || !target || selectedIndex === null || busy) return;
            setActive(selectedIndex);
            view.dispatch(bulkResolve(view.state, new Map([[selectedIndex, choice]]), data), {
                selection: { anchor: target.from },
            });
            if (focus) view.focus();
            return true;
        },
        [active, busy, data, editors, hunks, setActive],
    );
    const resolveFromKeyboard = (choice: MergeChoice) => {
        const target = active ?? hunks.findIndex((hunk) => hunk.conflict && !hunk.resolved);
        const hunk = hunks[target];
        if (!hunk) return;
        if (
            (choice === "both" || choice === "both-reversed") &&
            hunk.segment.changeKind !== "conflict"
        )
            return;
        if (!resolve(choice, target, { focus: false })) return;
        const targetPos = conflictIndices.indexOf(target);
        const ordered = [
            ...conflictIndices.slice(targetPos + 1),
            ...conflictIndices.slice(0, Math.max(targetPos, 0)),
        ];
        const next = ordered.find(
            (index) => index !== target && hunks[index].conflict && !hunks[index].resolved,
        );
        if (next !== undefined) jump(next);
    };
    const callbacks: HunkActionCallbacks = {
        accept(index, side) {
            const target = hunks[index];
            if (!target || busy) return;
            const view = hunkView(target);
            resolve(
                side === "ours"
                    ? view.leftAppend
                        ? "both-reversed"
                        : "ours"
                    : view.rightAppend
                      ? "both"
                      : "theirs",
                index,
            );
        },
        dismiss(index, side) {
            const target = hunks[index];
            const resultView = editors.current[1]?.view;
            if (!resultView || !target || busy) return;
            const view = hunkView(target);
            if (side === "ours" ? view.theirsDismissed : view.oursDismissed) {
                resolve("none", index);
                return;
            }
            setActive(index);
            resultView.dispatch({
                effects: replaceHunks.of(dismissSide(hunks, index, side)),
                userEvent: "input.merge",
                annotations: isolateHistory.of("full"),
            });
        },
    };
    useLayoutEffect(() => {
        const { accept, dismiss } = callbacks;
        actions.current = { accept, dismiss };
    });
    const markResolved = () => {
        const result = editors.current[1]?.view;
        if (result && selected)
            result.dispatch({
                effects: replaceHunks.of(
                    hunks.map((hunk) =>
                        hunk.id === selected.id ? { ...hunk, resolved: !hunk.resolved } : hunk,
                    ),
                ),
                userEvent: "input.merge",
                annotations: isolateHistory.of("full"),
            });
    };
    const apply = () => {
        const result = editors.current[1]?.view;
        if (!result || pending || busy) return;
        flushDraft();
        setBusy(true);
        setError(null);
        getVsCodeApi<MergeWorkbenchOutbound>().postMessage({
            type: "applyResolution",
            snapshotId: data.workbench!.snapshotId,
            content: resultContent(result.state.doc, data),
        });
    };
    const close = () => {
        flushDraft();
        getVsCodeApi<OutboundMessage>().postMessage({ type: "close" });
    };
    const moveActive = (delta: -1 | 1) => {
        if (!conflictIndices.length) return;
        const current = conflictIndices.indexOf(active ?? -1);
        const start = current === -1 ? (delta > 0 ? -1 : 0) : current;
        jump(conflictIndices[(start + delta + conflictIndices.length) % conflictIndices.length]);
    };
    const acceptAll = (side: "ours" | "theirs") => {
        const view = editors.current[1]?.view;
        if (!view || busy) return;
        const picks = new Map<number, MergeChoice>();
        hunks.forEach((hunk, index) => {
            if (hunk.segment.type === "conflict") picks.set(index, side);
        });
        view.dispatch(bulkResolve(view.state, picks, data));
    };
    const applyNonConflicting = () => {
        const view = editors.current[1]?.view;
        if (!view || busy) return;
        const picks = new Map<number, MergeChoice>();
        hunks.forEach((hunk, index) => {
            if (hunk.segment.changeKind === "ours-only") picks.set(index, "ours");
            else if (hunk.segment.changeKind === "theirs-only") picks.set(index, "theirs");
        });
        view.dispatch(bulkResolve(view.state, picks, data));
    };
    const undoResult = () => {
        const view = editors.current[1]?.view;
        if (view && !busy) undo(view);
    };
    const redoResult = () => {
        const view = editors.current[1]?.view;
        if (view && !busy) redo(view);
    };
    const search = () => {
        const view = editors.current[1]?.view;
        if (view) openSearchPanel(view);
    };
    const openConflictSession = () => {
        flushDraft();
        getVsCodeApi<OutboundMessage>().postMessage({ type: "openConflictSession" });
    };
    const jumpUnresolved = () => {
        if (nextUnresolved !== undefined) jump(nextUnresolved);
    };
    return {
        selected,
        currentConflictIndex: conflictIndices.indexOf(active ?? -1) + 1,
        canJumpUnresolved: nextUnresolved !== undefined,
        jumpUnresolved,
        jump,
        resolve,
        resolveFromKeyboard,
        markResolved,
        apply,
        close,
        moveActive,
        acceptAll,
        applyNonConflicting,
        undoResult,
        redoResult,
        search,
        openConflictSession,
        abort,
        useFile,
    };
}
