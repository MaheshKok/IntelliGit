import React, { useLayoutEffect, useRef, useState } from "react";
import type { MergeEditorData } from "./types";
import { buildWorkbenchDocument, resolveActiveHunk } from "./workbenchModel";
import { useWorkbenchCommands } from "./useWorkbenchCommands";
import { useWorkbenchKeyboard } from "./useWorkbenchKeyboard";
import type { HunkActionCallbacks } from "./workbenchGutter";
import { useRegroupNotice, useWorkbenchEditors } from "./useWorkbenchEditors";
import {
    WorkbenchToolbar,
    WorkbenchDetails,
    WorkbenchPaneHeaders,
    WorkbenchFooter,
    WorkbenchNotice,
    WorkbenchBasePane,
} from "./WorkbenchChrome";
import { workbenchCounts } from "./workbenchLayout";
import { paneChangeCount } from "./mergeState";
import { useWorkbenchLayout } from "./useWorkbenchLayout";
import type { WorkbenchScrollHandler, WorkbenchKeyCommands } from "./codeEditor";
import { MERGE_PANES } from "./mergeRibbons";
import { ConnectorLayer, OverviewRail } from "./segments";
import { scrollRangePx } from "../diff-core/mergeScrollLayout";
import { t } from "../shared/i18n";
import "./merge-workbench.css";

/** Full-document three-way merge with reversible decisions and immutable inputs. */
export function MergeWorkbench({ data: inputData }: { data: MergeEditorData }) {
    const [initial] = useState(() => buildWorkbenchDocument(inputData));
    // The initial pick becomes an independent user selection after load.
    const [active, setActive] = useState<number | null>(() =>
        resolveActiveHunk(initial.hunks, null),
    );
    const actions = useRef<HunkActionCallbacks | null>(null);
    const findHost = useRef<HTMLDivElement | null>(null);
    const scrollHandler = useRef<WorkbenchScrollHandler | null>(null);
    const layoutFrame = useRef<(() => void) | null>(null);
    const keymap = useRef<WorkbenchKeyCommands | null>(null);
    const {
        data,
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
    } = useWorkbenchEditors(inputData, initial, active, actions, {
        findHost,
        scrollHandler,
        layout: layoutFrame,
        keymap,
        onActiveFromCaret: setActive,
    });
    const [baseVisible, setBaseVisible] = useState(false);
    const [highlightWords, setHighlightWords] = useState(true);
    const [showDetails, setShowDetails] = useState(false);
    const regroupNotice = useRegroupNotice(grouping, isPristine, regroup);
    const {
        layout,
        markers,
        viewportH,
        contentRef,
        viewportRef,
        onScroll,
        onWheel,
        jumpTo,
        horizontalRef,
        horizontalInnerRef,
        onHorizontalScroll,
        handleScrollRequest,
        connectorSpecs,
        registerPath,
    } = useWorkbenchLayout(editors, hunks);
    useLayoutEffect(() => {
        scrollHandler.current = handleScrollRequest;
        layoutFrame.current = onScroll;
    }, [handleScrollRequest, onScroll]);
    const counts = workbenchCounts(hunks);
    const pending = counts.unresolved;

    const commands = useWorkbenchCommands({
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
    });
    useWorkbenchKeyboard(hunks, commands, keymap);
    const rootStyle = {
        ...(editorStats
            ? {
                  "--merge-line-number-gutter": `max(33px, calc(${Math.max(2, String(editorStats.maxLines).length)}ch + 12px))`,
              }
            : {}),
        ...(data.editorFontSize ? { "--merge-code-font-size": `${data.editorFontSize}px` } : {}),
    } as React.CSSProperties;

    return (
        <div
            className={[
                "merge-editor",
                "workbench",
                highlightWords ? "words-highlighted" : "",
                showDetails ? "details-expanded" : "",
            ]
                .filter(Boolean)
                .join(" ")}
            style={rootStyle}
            aria-busy={busy}
        >
            {grouping && editorStats && (
                <WorkbenchToolbar
                    total={counts.total}
                    unresolved={pending}
                    autoResolvedCount={counts.autoResolvedCount}
                    active={active}
                    busy={busy}
                    canUndo={editorStats.canUndo}
                    canRedo={editorStats.canRedo}
                    baseVisible={baseVisible}
                    selectedResolved={commands.selected?.resolved ?? false}
                    highlightWords={highlightWords}
                    showDetails={showDetails}
                    ignoreMode={grouping.ignoreWhitespace ? "whitespace" : "none"}
                    onIgnoreModeChange={regroupNotice.change}
                    onMoveActive={commands.moveActive}
                    onUndo={commands.undoResult}
                    onRedo={commands.redoResult}
                    onSearch={commands.search}
                    onToggleBase={() => setBaseVisible(!baseVisible)}
                    onMarkResolved={commands.markResolved}
                    onToggleWords={() => setHighlightWords(!highlightWords)}
                    onToggleDetails={() => setShowDetails(!showDetails)}
                    onApplyNonConflicting={commands.applyNonConflicting}
                    onAcceptAll={commands.acceptAll}
                    onResolve={commands.resolve}
                />
            )}
            <WorkbenchDetails
                showDetails={showDetails}
                filePath={data.filePath}
                resolved={counts.resolved}
                total={counts.total}
                unresolved={pending}
                currentConflictIndex={commands.currentConflictIndex}
                changeCount={hunks.length}
                autoResolvedCount={counts.autoResolvedCount}
                canJumpUnresolved={commands.canJumpUnresolved}
                onJumpUnresolved={commands.jumpUnresolved}
            />
            {regroupNotice.pending !== null && (
                <WorkbenchNotice
                    kind="regroup"
                    message={t("merge.workbench.regroupNotice")}
                    busy={busy}
                    onApply={regroupNotice.apply}
                    onKeep={regroupNotice.keep}
                />
            )}
            {error && <WorkbenchNotice kind="error" message={error} />}
            {staleDraft && (
                <WorkbenchNotice
                    kind="stale"
                    content={staleDraft.content}
                    onDiscard={discardStaleDraft}
                />
            )}
            <div className="merge-find-host" ref={findHost} />
            {grouping && (
                <WorkbenchPaneHeaders
                    data={data}
                    showDetails={showDetails}
                    oursChanges={paneChangeCount(grouping.segments, "ours")}
                    theirsChanges={paneChangeCount(grouping.segments, "theirs")}
                    total={counts.total}
                />
            )}
            <div className="merge-content-shell">
                <div
                    className="merge-content"
                    ref={contentRef}
                    onScroll={onScroll}
                    onWheel={onWheel}
                >
                    <div className="merge-viewport" ref={viewportRef}>
                        {MERGE_PANES.map((pane, index) => (
                            <React.Fragment key={pane}>
                                {index > 0 && (
                                    <div
                                        className={`merge-gutter merge-gutter-${index === 1 ? "left" : "right"}`}
                                        aria-hidden="true"
                                    />
                                )}
                                <div className={`merge-col col-${pane}`}>
                                    <div
                                        className={`workbench-editor pane-${["ours", "result", "theirs"][index]}`}
                                        data-testid={`merge-editor-${index}`}
                                        ref={(element) => {
                                            hosts.current[index] = element;
                                        }}
                                    />
                                </div>
                            </React.Fragment>
                        ))}
                        <ConnectorLayer specs={connectorSpecs} registerPath={registerPath} />
                    </div>
                    <div
                        className="merge-vscroll-spacer"
                        style={{ height: scrollRangePx(layout.canonicalTotalPx, viewportH) }}
                        aria-hidden="true"
                    />
                </div>
                <div
                    ref={horizontalRef}
                    className="merge-horizontal-scroll"
                    aria-hidden="true"
                    onScroll={onHorizontalScroll}
                >
                    <div ref={horizontalInnerRef} className="merge-horizontal-scroll-inner" />
                </div>
                <OverviewRail
                    markers={markers}
                    activeConflictId={commands.selected?.id ?? null}
                    onJump={(id) => commands.jump(hunks.findIndex((hunk) => hunk.id === id))}
                />
            </div>
            <WorkbenchBasePane
                visible={baseVisible}
                hostRef={(element) => {
                    hosts.current[3] = element;
                }}
                onClose={() => setBaseVisible(false)}
            />
            <WorkbenchFooter
                isShelfSession={data.sessionKind === "shelf"}
                saved={saved}
                canApply={pending === 0 && !busy}
                onAbort={commands.abort}
                onOpenConflictSession={commands.openConflictSession}
                onUseFile={commands.useFile}
                onClose={commands.close}
                onApply={commands.apply}
            />
        </div>
    );
}
