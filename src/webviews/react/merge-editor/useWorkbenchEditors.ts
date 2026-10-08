import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
    type RefObject,
    type Dispatch,
    type SetStateAction,
} from "react";
import type { HunkActionCallbacks } from "./workbenchGutter";
import { undoDepth, redoDepth } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { StateEffect, Transaction } from "@codemirror/state";
import {
    createMergeCodeEditor,
    setActiveHunk,
    setInputHunks,
    setMergeSyntax,
    type WorkbenchScrollHandler,
    type WorkbenchKeyCommands,
} from "./codeEditor";
import {
    type buildWorkbenchDocument,
    groupingField,
    groupingInit,
    hunkAtCaret,
    resolveActiveHunk,
    isPristineState,
    regroupSpec,
    type Grouping,
    replaceHunks,
    restoreDraftHunks,
    workbenchHunks,
} from "./workbenchModel";
import { getVsCodeApi } from "../shared/vscodeApi";
import { useDiffSyntaxTheme } from "../diff-viewer/useDiffSyntaxTheme";
import {
    parseMergeDraft,
    type MergeDraft,
    type MergeWorkbenchInbound,
    type MergeWorkbenchOutbound,
} from "../../protocol/mergeWorkbench";
import type { MergeEditorData } from "./types";
import { t } from "../shared/i18n";

/** The whitespace select: a pristine result regroups at once, an edited one asks first. */
export function useRegroupNotice(
    grouping: Grouping | null,
    isPristine: () => boolean,
    regroup: (next: boolean) => void,
) {
    const [pending, setPending] = useState<boolean | null>(null);
    // Undo/redo can reach the pending mode; the notice then has nothing left to ask.
    if (pending !== null && pending === grouping?.ignoreWhitespace) setPending(null);
    return {
        pending,
        change: (mode: "none" | "whitespace") => {
            const next = mode === "whitespace";
            if (next === grouping!.ignoreWhitespace) setPending(null);
            else if (isPristine()) {
                regroup(next);
                setPending(null);
            } else setPending(next);
        },
        apply: () => {
            regroup(pending!);
            setPending(null);
        },
        keep: () => setPending(null),
    };
}

/** Owns editors for one snapshot; asynchronous draft loads never overwrite an already edited result. */
export function useWorkbenchEditors(
    inputData: MergeEditorData,
    initial: ReturnType<typeof buildWorkbenchDocument>,
    active: number | null,
    actions: RefObject<HunkActionCallbacks | null>,
    {
        findHost,
        scrollHandler,
        layout,
        keymap,
        onActiveFromCaret,
    }: {
        findHost: RefObject<HTMLElement | null>;
        scrollHandler: RefObject<WorkbenchScrollHandler | null>;
        layout: RefObject<(() => void) | null>;
        keymap: RefObject<WorkbenchKeyCommands | null>;
        onActiveFromCaret: Dispatch<SetStateAction<number | null>>;
    },
) {
    const [data] = useState(inputData);
    const hosts = useRef<Array<HTMLDivElement | null>>([]);
    const editors = useRef<ReturnType<typeof createMergeCodeEditor>[]>([]);
    const [hunks, setHunks] = useState(initial.hunks);
    const [grouping, setGrouping] = useState<Grouping | null>(null);
    const [editorStats, setEditorStats] = useState<{
        maxLines: number;
        canUndo: boolean;
        canRedo: boolean;
    } | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [saved, setSaved] = useState(false);
    const [staleDraft, setStaleDraft] = useState<MergeDraft | null>(null);
    const revision = useRef(0);
    const restoring = useRef(true);
    const applied = useRef(false);
    const blockedDraft = useRef(false);
    const dirtyDraft = useRef(false);
    const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const latestDraft = useRef<MergeDraft | null>(null);
    const theme = useDiffSyntaxTheme();
    const initialTheme = useRef(theme);
    const activeFromCaret = useRef(onActiveFromCaret);
    useLayoutEffect(() => {
        activeFromCaret.current = onActiveFromCaret;
    }, [onActiveFromCaret]);

    const flushDraft = useCallback(() => {
        clearTimeout(saveTimer.current);
        if (applied.current) return;
        const view = editors.current[1]?.view;
        if (dirtyDraft.current && view) {
            latestDraft.current = {
                snapshotId: data.workbench!.snapshotId,
                content: view.state.doc.toString(),
                hunks: view.state
                    .field(workbenchHunks)
                    .map(({ id, from, to, resolved, decision, edited, dismissed }) => ({
                        id,
                        from,
                        to,
                        resolved,
                        ...(decision !== undefined ? { decision } : {}),
                        edited,
                        dismissedOurs: dismissed.ours,
                        dismissedTheirs: dismissed.theirs,
                    })),
                ignoreWhitespace: view.state.field(groupingField).ignoreWhitespace,
            };
            dirtyDraft.current = false;
            getVsCodeApi().setState(latestDraft.current);
        }
        if (latestDraft.current && !blockedDraft.current)
            getVsCodeApi<MergeWorkbenchOutbound>().postMessage({
                type: "saveMergeDraft",
                draft: latestDraft.current,
                revision: revision.current,
            });
    }, [data]);
    const update = useCallback(
        (view: EditorView) => {
            const current = view.state.field(workbenchHunks);
            setHunks([...current]);
            const currentGrouping = view.state.field(groupingField);
            setGrouping((previous) => (previous === currentGrouping ? previous : currentGrouping));
            setEditorStats({
                maxLines: Math.max(
                    ...editors.current
                        .slice(0, 3)
                        .map(({ view: editor }) => editor.state.doc.lines),
                ),
                canUndo: undoDepth(view.state) > 0,
                canRedo: redoDepth(view.state) > 0,
            });
            if (restoring.current) return;
            revision.current++;
            setSaved(false);
            dirtyDraft.current = true;
            clearTimeout(saveTimer.current);
            saveTimer.current = setTimeout(flushDraft, 250);
        },
        [flushDraft],
    );

    useEffect(() => {
        const input = data.workbench!;
        const contents = [input.ours, initial.content, input.theirs, input.base];
        const labels = [
            data.oursLabel,
            t("merge.workbench.result"),
            data.theirsLabel,
            t("merge.workbench.base"),
        ];
        const views = hosts.current.map((host, pane) =>
            createMergeCodeEditor(host!, contents[pane], {
                pane: (["ours", "result", "theirs", "base"] as const)[pane],
                readOnly: pane !== 1,
                filePath: data.filePath,
                label: labels[pane],
                theme: initialTheme.current,
                update: pane === 1 ? update : undefined,
                actions: pane === 0 || pane === 2 ? actions : undefined,
                scrollHandler: pane < 3 ? scrollHandler : undefined,
                layout: pane < 3 ? layout : undefined,
                keymap: pane === 1 ? keymap : undefined,
                findHost: pane === 1 ? (findHost.current ?? undefined) : undefined,
            }),
        );
        editors.current = views;
        views[1].view.dispatch({
            effects: [
                StateEffect.appendConfig.of([
                    groupingInit(data),
                    EditorView.updateListener.of((update) => {
                        if (restoring.current) return;
                        // The appendConfig transaction's start state has no grouping yet.
                        if (!update.startState.field(groupingField, false)) return;
                        // Merge commands set the active hunk themselves; their caret can sit mid-line.
                        const command = update.transactions.some((transaction) =>
                            transaction.isUserEvent("input.merge"),
                        );
                        const regrouped =
                            update.startState.field(groupingField) !==
                            update.state.field(groupingField);
                        const caretChanged = (update.selectionSet && !command) || regrouped;
                        if (
                            caretChanged ||
                            update.startState.field(workbenchHunks) !==
                                update.state.field(workbenchHunks)
                        )
                            activeFromCaret.current((previous) =>
                                resolveActiveHunk(
                                    update.state.field(workbenchHunks),
                                    regrouped ? null : previous,
                                    caretChanged ? hunkAtCaret(update.state) : null,
                                ),
                            );
                    }),
                ]),
                replaceHunks.of(initial.hunks),
            ],
            annotations: Transaction.addToHistory.of(false),
        });
        const restore = (value: unknown) => {
            const draft = parseMergeDraft(value);
            if (!draft) return;
            if (draft.snapshotId !== input.snapshotId) {
                blockedDraft.current = true;
                setStaleDraft(draft);
                return;
            }
            if (revision.current > 0 || latestDraft.current) return;
            const view = views[1].view;
            const regroup =
                draft.ignoreWhitespace !== undefined &&
                draft.ignoreWhitespace !== view.state.field(groupingField).ignoreWhitespace
                    ? regroupSpec(view.state, data, draft.ignoreWhitespace, { history: false })
                    : undefined;
            const original = regroup
                ? view.state.update(regroup).state.field(workbenchHunks)
                : initial.hunks;
            const ranges = restoreDraftHunks(original, draft.hunks, draft.content.length);
            if (!ranges) return;
            restoring.current = true;
            if (regroup) view.dispatch(regroup);
            views[1].view.dispatch({
                changes: { from: 0, to: views[1].view.state.doc.length, insert: draft.content },
                effects: replaceHunks.of(ranges),
                annotations: Transaction.addToHistory.of(false),
            });
            restoring.current = false;
            // Only a regroup invalidates the selection's hunk index.
            activeFromCaret.current((previous) =>
                resolveActiveHunk(ranges, regroup ? null : previous),
            );
            latestDraft.current = draft;
            getVsCodeApi().setState(draft);
        };
        restore(getVsCodeApi().getState());
        restoring.current = false;
        const receive = (event: MessageEvent<MergeWorkbenchInbound>) => {
            const message = event.data;
            if (message.type === "mergeDraft") restore(message.draft);
            if (message.type === "mergeDraftSaved" && message.revision === revision.current)
                setSaved(true);
            if (message.type === "resolutionError") {
                setError(message.message);
                setBusy(false);
            }
            if (message.type === "resolutionApplied") {
                applied.current = true;
                clearTimeout(saveTimer.current);
                getVsCodeApi().setState(null);
            }
        };
        window.addEventListener("message", receive);
        window.addEventListener("pagehide", flushDraft);
        getVsCodeApi<MergeWorkbenchOutbound>().postMessage({ type: "loadMergeDraft" });
        return () => {
            flushDraft();
            window.removeEventListener("message", receive);
            window.removeEventListener("pagehide", flushDraft);
            for (const editor of views) editor.view.destroy();
        };
    }, [data, initial, update, flushDraft, actions, findHost, scrollHandler, layout, keymap]);

    useEffect(() => {
        editors.current.forEach(({ view }) =>
            view.dispatch({
                effects: setMergeSyntax.of(theme),
                annotations: Transaction.addToHistory.of(false),
            }),
        );
    }, [theme]);
    useEffect(() => {
        [0, 2].forEach((pane) => {
            const view = editors.current[pane]?.view;
            if (!view) return;
            const ranges = hunks.map((hunk) => ({
                ...hunk,
                from: Math.min(pane === 0 ? hunk.oursFrom : hunk.theirsFrom, view.state.doc.length),
                to: Math.min(pane === 0 ? hunk.oursTo : hunk.theirsTo, view.state.doc.length),
            }));
            view.dispatch({ effects: setInputHunks.of(ranges) });
        });
    }, [hunks]);

    useEffect(() => {
        editors.current
            .slice(0, 3)
            .forEach(({ view }) => view.dispatch({ effects: setActiveHunk.of(active) }));
    }, [active]);

    useEffect(() => {
        editors.current[1]?.setReadOnly(busy);
    }, [busy]);

    const discardStaleDraft = () => {
        if (!staleDraft) return;
        const snapshotId = staleDraft.snapshotId;
        blockedDraft.current = false;
        setStaleDraft(null);
        getVsCodeApi<MergeWorkbenchOutbound>().postMessage({
            type: "discardMergeDraft",
            snapshotId,
        });
        flushDraft();
    };
    const isPristine = () => {
        const view = editors.current[1]?.view;
        return !!view && isPristineState(view.state, data);
    };
    const regroup = (next: boolean) => {
        const view = editors.current[1]?.view;
        if (view) view.dispatch(regroupSpec(view.state, data, next, { history: true }));
    };
    return {
        data,
        initial,
        hosts,
        editors,
        hunks,
        grouping,
        editorStats,
        error,
        setError,
        busy,
        setBusy,
        saved,
        staleDraft,
        discardStaleDraft,
        flushDraft,
        isPristine,
        regroup,
    };
}
