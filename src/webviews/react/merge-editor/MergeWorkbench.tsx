import React, { useCallback, useState } from "react";
import { EditorView } from "@codemirror/view";
import { isolateHistory, undo, redo, undoDepth, redoDepth } from "@codemirror/commands";
import { openSearchPanel } from "@codemirror/search";
import {
    VscArrowLeft,
    VscArrowRight,
    VscChevronUp,
    VscChevronDown,
    VscDiscard,
    VscCheck,
    VscSearch,
    VscDebugRestart,
    VscEye,
    VscClose,
    VscLink,
} from "react-icons/vsc";
import type { MergeEditorData, OutboundMessage } from "./types";
import { getVsCodeApi } from "../shared/vscodeApi";
import { bulkResolve, replaceHunks, resultContent, type MergeChoice } from "./workbenchModel";
import { useWorkbenchEditors } from "./useWorkbenchEditors";
import { t } from "../shared/i18n";
import type { MergeWorkbenchOutbound } from "../../protocol/mergeWorkbench";
import { useMergeScrollSync } from "./useMergeScrollSync";
import { MergeConnectors } from "./MergeConnectors";
import "./merge-workbench.css";

/** Full-document three-way merge with reversible decisions and immutable inputs. */
export function MergeWorkbench({ data: inputData }: { data: MergeEditorData }) {
    const {
        data,
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
    } = useWorkbenchEditors(inputData);
    const [active, setActive] = useState(0);
    const [baseVisible, setBaseVisible] = useState(false);
    const [linked, setLinked] = useState(true);
    useMergeScrollSync(editors, hunks, linked);
    const pending = hunks.filter((hunk) => hunk.conflict && !hunk.resolved).length;
    const selected = hunks[active];
    const result = editors.current[1]?.view;

    const jump = useCallback(
        (index: number) => {
            if (!hunks.length) return;
            const next = (index + hunks.length) % hunks.length;
            setActive(next);
            const hunk = hunks[next];
            const positions = [hunk.oursFrom, hunk.from, hunk.theirsFrom];
            editors.current.slice(0, 3).forEach(({ view }, pane) =>
                view.dispatch({
                    effects: EditorView.scrollIntoView(
                        Math.min(positions[pane], view.state.doc.length),
                        { y: "center" },
                    ),
                }),
            );
        },
        [editors, hunks],
    );

    const resolve = useCallback(
        (choice: MergeChoice, selectedIndex = active) => {
            const target = hunks[selectedIndex];
            const view = editors.current[1]?.view;
            if (!view || !target || busy) return;
            setActive(selectedIndex);
            view.dispatch(bulkResolve(view.state, new Map([[selectedIndex, choice]]), data), {
                selection: { anchor: target.from },
            });
            view.focus();
        },
        [active, busy, data, editors, hunks],
    );
    const markResolved = () => {
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
    const tool = (
        key: string,
        icon: React.ReactNode,
        action: () => void,
        disabled = false,
        pressed?: boolean,
    ) => (
        <button
            type="button"
            title={t(key)}
            aria-label={t(key)}
            disabled={disabled}
            aria-pressed={pressed}
            onClick={action}
        >
            {icon}
        </button>
    );

    return (
        <div
            className="merge-workbench"
            aria-busy={busy}
            style={
                data.editorFontSize
                    ? ({
                          "--vscode-editor-font-size": `${data.editorFontSize}px`,
                      } as React.CSSProperties)
                    : undefined
            }
        >
            <div className="mw-toolbar" role="toolbar">
                {tool(
                    "merge.toolbar.prevConflict.label",
                    <VscChevronUp />,
                    () => jump(active - 1),
                    !hunks.length,
                )}
                {tool(
                    "merge.toolbar.nextConflict.label",
                    <VscChevronDown />,
                    () => jump(active + 1),
                    !hunks.length,
                )}
                <span className="mw-divider" />
                {tool(
                    "merge.workbench.undo",
                    <VscDiscard />,
                    () => {
                        if (result) undo(result);
                    },
                    !result || !undoDepth(result.state) || busy,
                )}
                {tool(
                    "merge.workbench.redo",
                    <VscDebugRestart />,
                    () => {
                        if (result) redo(result);
                    },
                    !result || !redoDepth(result.state) || busy,
                )}
                {tool("merge.workbench.search", <VscSearch />, () => {
                    if (result) openSearchPanel(result);
                })}
                {tool(
                    "merge.workbench.base",
                    <VscEye />,
                    () => setBaseVisible(!baseVisible),
                    false,
                    baseVisible,
                )}
                {tool("merge.workbench.link", <VscLink />, () => setLinked(!linked), false, linked)}
                <span className="mw-divider" />
                {tool(
                    "merge.workbench.takeOurs",
                    <VscArrowRight />,
                    () => resolve("ours"),
                    !selected || busy,
                )}
                {tool(
                    "merge.workbench.takeTheirs",
                    <VscArrowLeft />,
                    () => resolve("theirs"),
                    !selected || busy,
                )}
                <select
                    aria-label={t("merge.workbench.combine")}
                    value=""
                    disabled={!selected || busy}
                    onChange={(event) => resolve(event.target.value as MergeChoice)}
                >
                    <option value="" disabled>
                        {t("merge.workbench.combine")}
                    </option>
                    <option value="both">{t("merge.workbench.oursThenTheirs")}</option>
                    <option value="both-reversed">{t("merge.workbench.theirsThenOurs")}</option>
                    <option value="base">{t("merge.workbench.keepBase")}</option>
                    <option value="none">{t("merge.status.removeBlock")}</option>
                </select>
                {tool(
                    "merge.workbench.markResolved",
                    <VscCheck />,
                    markResolved,
                    !selected || busy,
                    selected?.resolved ?? false,
                )}
                <span className="mw-status" role="status">
                    {t("merge.status.unresolved", { count: pending })}
                </span>
            </div>
            {error && (
                <div className="mw-error" role="alert">
                    {error}
                </div>
            )}
            {staleDraft && (
                <div className="mw-error" role="alert">
                    {t("merge.workbench.staleDraft")}
                    <details>
                        <summary>{t("merge.workbench.inspectDraft")}</summary>
                        <pre>{staleDraft.content}</pre>
                    </details>
                    <button onClick={discardStaleDraft}>{t("merge.workbench.discardDraft")}</button>
                </div>
            )}
            <div className="mw-headings">
                <span>{data.oursLabel}</span>
                <span>{t("merge.workbench.result")}</span>
                <span>{data.theirsLabel}</span>
            </div>
            <div className="mw-panes">
                {[0, 1, 2].map((pane) => (
                    <React.Fragment key={pane}>
                        {pane > 0 && (
                            <MergeConnectors
                                editors={editors}
                                hunks={hunks}
                                side={pane === 1 ? "ours" : "theirs"}
                                busy={busy}
                                accept={(index) => resolve(pane === 1 ? "ours" : "theirs", index)}
                            />
                        )}
                        <div
                            className="mw-editor"
                            data-testid={`merge-editor-${pane}`}
                            key={pane}
                            ref={(element) => {
                                hosts.current[pane] = element;
                            }}
                        />
                    </React.Fragment>
                ))}
            </div>
            <section className="mw-base" hidden={!baseVisible}>
                <header>
                    {t("merge.workbench.base")}
                    {tool("common.close", <VscClose />, () => setBaseVisible(false))}
                </header>
                <div
                    ref={(element) => {
                        hosts.current[3] = element;
                    }}
                />
            </section>
            <div className="mw-hunks" role="toolbar">
                {hunks.map((hunk, index) => (
                    <button
                        key={hunk.id}
                        className={index === active ? "active" : ""}
                        onClick={() => jump(index)}
                        aria-pressed={index === active}
                    >
                        {hunk.resolved ? <VscCheck /> : <span className="mw-pending" />}{" "}
                        {t("merge.workbench.change", { count: index + 1 })}
                    </button>
                ))}
            </div>
            <footer className="mw-footer">
                <button
                    title={t("merge.workbench.native")}
                    aria-label={t("merge.workbench.native")}
                    onClick={() => {
                        flushDraft();
                        getVsCodeApi<OutboundMessage>().postMessage({ type: "openNativeMerge" });
                    }}
                >
                    <VscEye />
                </button>
                <span>{data.filePath}</span>
                <span>{saved ? t("merge.workbench.draftSaved") : ""}</span>
                <button
                    onClick={() => {
                        flushDraft();
                        getVsCodeApi<OutboundMessage>().postMessage({
                            type: "openConflictSession",
                        });
                    }}
                >
                    {t("merge.workbench.files")}
                </button>
                <button onClick={close}>{t("common.cancel")}</button>
                <button className="primary" disabled={pending > 0 || busy} onClick={apply}>
                    {t("common.apply")}
                </button>
            </footer>
        </div>
    );
}
