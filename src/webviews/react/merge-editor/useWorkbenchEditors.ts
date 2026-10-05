import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { HunkActionCallbacks } from "./workbenchGutter";
import { EditorView } from "@codemirror/view";
import { StateEffect, Transaction } from "@codemirror/state";
import { createMergeCodeEditor, setActiveHunk, setInputHunks, setMergeSyntax } from "./codeEditor";
import {
    buildWorkbenchDocument,
    groupingField,
    groupingInit,
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

/** Owns editors for one snapshot; asynchronous draft loads never overwrite an already edited result. */
export function useWorkbenchEditors(
    inputData: MergeEditorData,
    active: number | null,
    actions: RefObject<HunkActionCallbacks | null>,
) {
    const [data] = useState(inputData);
    const [initial] = useState(() => buildWorkbenchDocument(data));
    const hosts = useRef<Array<HTMLDivElement | null>>([]);
    const editors = useRef<ReturnType<typeof createMergeCodeEditor>[]>([]);
    const [hunks, setHunks] = useState(initial.hunks);
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
            }),
        );
        editors.current = views;
        views[1].view.dispatch({
            effects: [
                StateEffect.appendConfig.of(groupingInit(data)),
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
            const ranges = restoreDraftHunks(initial.hunks, draft.hunks, draft.content.length);
            if (!ranges) return;
            restoring.current = true;
            views[1].view.dispatch({
                changes: { from: 0, to: views[1].view.state.doc.length, insert: draft.content },
                effects: replaceHunks.of(ranges),
                annotations: Transaction.addToHistory.of(false),
            });
            restoring.current = false;
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
    }, [data, initial, update, flushDraft, actions]);

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
    return {
        data,
        initial,
        hosts,
        editors,
        hunks,
        error,
        setError,
        busy,
        setBusy,
        saved,
        staleDraft,
        discardStaleDraft,
        flushDraft,
    };
}
