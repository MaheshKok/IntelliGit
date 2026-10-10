import React from "react";
import { VscDiscard, VscRedo, VscSearch, VscVersions, VscCheck, VscClose } from "react-icons/vsc";
import {
    IconArrowRight,
    IconArrowLeft,
    IconChevronUp,
    IconChevronDown,
    IconSpark,
    IconEye,
    IconLock,
    IconWarning,
} from "./icons";
import { t } from "../shared/i18n";
import type { MergeEditorData } from "./types";
import type { MergeChoice } from "./workbenchModel";

type ToolbarProps = {
    total: number;
    unresolved: number;
    autoResolvedCount: number;
    active: number | null;
    busy: boolean;
    canUndo: boolean;
    canRedo: boolean;
    baseVisible: boolean;
    selectedResolved: boolean;
    highlightWords: boolean;
    showDetails: boolean;
    ignoreMode: "none" | "whitespace";
    onIgnoreModeChange: (mode: "none" | "whitespace") => void;
    onMoveActive: (delta: -1 | 1) => void;
    onUndo: () => void;
    onRedo: () => void;
    onSearch: () => void;
    onToggleBase: () => void;
    onMarkResolved: () => void;
    onToggleWords: () => void;
    onToggleDetails: () => void;
    onApplyNonConflicting: () => void;
    onAcceptAll: (side: "ours" | "theirs") => void;
    onResolve: (choice: MergeChoice) => void;
};
export function WorkbenchToolbar({
    total,
    unresolved,
    autoResolvedCount,
    active,
    busy,
    canUndo,
    canRedo,
    baseVisible,
    selectedResolved,
    highlightWords,
    showDetails,
    ignoreMode,
    onIgnoreModeChange,
    onMoveActive,
    onUndo,
    onRedo,
    onSearch,
    onToggleBase,
    onMarkResolved,
    onToggleWords,
    onToggleDetails,
    onApplyNonConflicting,
    onAcceptAll,
    onResolve,
}: ToolbarProps) {
    return (
        <div className="merge-toolbar">
            <div className="toolbar-left">
                <div className="toolbar-nav-group">
                    <button
                        type="button"
                        className="toolbar-icon-btn"
                        onClick={() => onMoveActive(-1)}
                        title={t("merge.toolbar.prevConflict.title")}
                        aria-label={t("merge.toolbar.prevConflict.label")}
                        disabled={total === 0}
                    >
                        <IconChevronUp />
                    </button>
                    <button
                        type="button"
                        className="toolbar-icon-btn"
                        onClick={() => onMoveActive(1)}
                        title={t("merge.toolbar.nextConflict.title")}
                        aria-label={t("merge.toolbar.nextConflict.label")}
                        disabled={total === 0}
                    >
                        <IconChevronDown />
                    </button>
                </div>
                <button
                    type="button"
                    className="toolbar-icon-btn"
                    title={t("merge.workbench.undo")}
                    aria-label={t("merge.workbench.undo")}
                    onClick={onUndo}
                    disabled={!canUndo || busy}
                >
                    <VscDiscard />
                </button>
                <button
                    type="button"
                    className="toolbar-icon-btn"
                    title={t("merge.workbench.redo")}
                    aria-label={t("merge.workbench.redo")}
                    onClick={onRedo}
                    disabled={!canRedo || busy}
                >
                    <VscRedo />
                </button>
                <button
                    type="button"
                    className="toolbar-icon-btn"
                    title={t("merge.workbench.search")}
                    aria-label={t("merge.workbench.search")}
                    onClick={onSearch}
                >
                    <VscSearch />
                </button>
                <button
                    type="button"
                    className="toolbar-icon-btn"
                    title={t("merge.workbench.base")}
                    aria-label={t("merge.workbench.base")}
                    onClick={onToggleBase}
                    aria-pressed={baseVisible}
                >
                    <VscVersions />
                </button>
                <button
                    type="button"
                    className="toolbar-icon-btn"
                    title={t("merge.workbench.markResolved")}
                    aria-label={t("merge.workbench.markResolved")}
                    onClick={onMarkResolved}
                    disabled={active === null || busy}
                    aria-pressed={selectedResolved}
                >
                    <VscCheck />
                </button>
                <div className="toolbar-separator" />
                <select
                    className="toolbar-select"
                    value={ignoreMode}
                    onChange={(event) =>
                        onIgnoreModeChange(event.target.value as "none" | "whitespace")
                    }
                    disabled={busy}
                    title={t("merge.toolbar.ignoreMode.title")}
                    aria-label={t("merge.toolbar.ignoreMode.title")}
                >
                    <option value="none">{t("merge.toolbar.ignoreMode.none")}</option>
                    <option value="whitespace">{t("merge.toolbar.ignoreMode.whitespace")}</option>
                </select>
                <button
                    type="button"
                    className={`toolbar-btn subtle ${highlightWords ? "active" : ""}`}
                    onClick={onToggleWords}
                    aria-pressed={highlightWords}
                >
                    <span className="toolbar-icon">
                        <IconEye />
                    </span>
                    {t("merge.toolbar.highlightWords")}
                </button>
                <button
                    type="button"
                    className={`toolbar-btn subtle ${showDetails ? "active" : ""}`}
                    onClick={onToggleDetails}
                    aria-expanded={showDetails}
                    aria-controls="merge-details"
                    title={
                        showDetails
                            ? t("merge.toolbar.hideDetails")
                            : t("merge.toolbar.showDetails")
                    }
                    aria-describedby="merge-keyboard-hint"
                >
                    {showDetails ? t("merge.toolbar.hideDetails") : t("merge.toolbar.showDetails")}
                </button>
                <div className="toolbar-separator" />
                <button
                    type="button"
                    className="toolbar-icon-btn"
                    onClick={onApplyNonConflicting}
                    disabled={autoResolvedCount === 0}
                    title={t("merge.toolbar.applyNonConflicting")}
                    aria-label={t("merge.toolbar.applyNonConflicting")}
                >
                    <IconSpark />
                </button>
                <button
                    type="button"
                    className="toolbar-icon-btn"
                    onClick={() => onAcceptAll("ours")}
                    title={t("merge.toolbar.acceptAllYours.title")}
                    aria-label={t("merge.toolbar.acceptAllYours.label")}
                >
                    <span className="toolbar-icon">
                        <IconArrowRight />
                    </span>
                </button>
                <button
                    type="button"
                    className="toolbar-icon-btn"
                    onClick={() => onAcceptAll("theirs")}
                    title={t("merge.toolbar.acceptAllTheirs.title")}
                    aria-label={t("merge.toolbar.acceptAllTheirs.label")}
                >
                    <span className="toolbar-icon">
                        <IconArrowLeft />
                    </span>
                </button>
                <select
                    className="toolbar-select"
                    aria-label={t("merge.workbench.combine")}
                    value=""
                    disabled={active === null || busy}
                    onChange={(event) => onResolve(event.target.value as MergeChoice)}
                >
                    <option value="" disabled>
                        {t("merge.workbench.combine")}
                    </option>
                    <option value="both">{t("merge.workbench.oursThenTheirs")}</option>
                    <option value="both-reversed">{t("merge.workbench.theirsThenOurs")}</option>
                    <option value="base">{t("merge.workbench.keepBase")}</option>
                    <option value="none">{t("merge.status.removeBlock")}</option>
                </select>
            </div>
            <div className="toolbar-right">
                {/* Non-conflicting hunks are already applied by getResultLines. */}
                <span
                    id="merge-remaining-status"
                    className={`merge-remaining-status${unresolved === 0 ? " resolved" : ""}`}
                    role="status"
                >
                    {unresolved === 0 ? (
                        <>
                            <VscCheck aria-hidden="true" />
                            {t("merge.status.allConflictsResolved")}
                        </>
                    ) : (
                        <>
                            {t("merge.status.noChanges")},{" "}
                            {t("merge.count.conflicts", { count: unresolved })}
                        </>
                    )}
                </span>
            </div>
        </div>
    );
}

type DetailsProps = {
    showDetails: boolean;
    filePath: string;
    resolved: number;
    total: number;
    unresolved: number;
    currentConflictIndex: number;
    changeCount: number;
    autoResolvedCount: number;
    canJumpUnresolved: boolean;
    onJumpUnresolved: () => void;
};
export function WorkbenchDetails({
    showDetails,
    filePath,
    resolved,
    total,
    unresolved,
    currentConflictIndex,
    changeCount,
    autoResolvedCount,
    canJumpUnresolved,
    onJumpUnresolved,
}: DetailsProps) {
    return (
        <div id="merge-details" className="merge-header" hidden={!showDetails}>
            <div className="merge-title">
                <span className="file-path">{filePath}</span>
                <span className="conflict-counter">
                    {t("merge.header.conflictsResolved", { resolved, total })}
                </span>
            </div>
            <div className="toolbar-center">
                <span className="toolbar-status-pill">
                    <span className="toolbar-icon">
                        <IconWarning />
                    </span>
                    {t("merge.status.unresolved", { count: unresolved })}
                </span>
                <span className="toolbar-status-pill muted">
                    {t("merge.status.resolved", { resolved, total })}
                </span>
                {currentConflictIndex > 0 ? (
                    <button
                        type="button"
                        className="toolbar-inline-link"
                        onClick={() => {
                            onJumpUnresolved();
                        }}
                        disabled={!canJumpUnresolved}
                        title={t("merge.toolbar.jumpUnresolved.title")}
                    >
                        {t("merge.status.hunk", { current: currentConflictIndex, total })}
                    </button>
                ) : null}
            </div>
            <div className="merge-stats">
                <span className="merge-stat-pill">
                    {t("merge.count.changes", { count: changeCount })}
                </span>
                {autoResolvedCount > 0 ? (
                    <span className="merge-stat-pill ok">
                        {t("merge.header.autoResolved", { count: autoResolvedCount })}
                    </span>
                ) : null}
                <span className={`merge-stat-pill ${unresolved > 0 ? "warn" : "ok"}`}>
                    {t("merge.count.conflicts", { count: unresolved })}
                </span>
            </div>
        </div>
    );
}

export function WorkbenchPaneHeaders({
    data,
    showDetails,
    oursChanges,
    theirsChanges,
    total,
}: {
    data: MergeEditorData;
    showDetails: boolean;
    oursChanges: number;
    theirsChanges: number;
    total: number;
}) {
    return (
        <div className="pane-meta-row">
            <div className="pane-meta">
                <span className="pane-meta-label">
                    <span className="toolbar-icon pane-lock">
                        <IconLock />
                    </span>
                    {t("merge.pane.changesFrom", { label: data.oursLabel })}
                </span>
                <span className="pane-meta-right-group" hidden={!showDetails}>
                    <span className="pane-meta-counts">
                        {t("merge.count.changes", { count: oursChanges })},{" "}
                        {t("merge.count.conflicts", { count: total })}
                    </span>
                </span>
            </div>
            <div className="pane-meta pane-meta-center">
                <span title={data.filePath}>{t("merge.pane.result", { path: data.filePath })}</span>
            </div>
            <div className="pane-meta pane-meta-right">
                <span className="pane-meta-label">
                    <span className="toolbar-icon pane-lock">
                        <IconLock />
                    </span>
                    {t("merge.pane.changesFrom", { label: data.theirsLabel })}
                </span>
                <span className="pane-meta-right-group" hidden={!showDetails}>
                    <span className="pane-meta-counts">
                        {t("merge.count.changes", { count: theirsChanges })},{" "}
                        {t("merge.count.conflicts", { count: total })}
                    </span>
                </span>
            </div>
        </div>
    );
}

type FooterProps = {
    isShelfSession: boolean;
    saved: boolean;
    canApply: boolean;
    onAbort: () => void;
    onOpenConflictSession: () => void;
    onUseFile: (side: "ours" | "theirs") => void;
    onClose: () => void;
    onApply: () => void;
};
export function WorkbenchFooter({
    isShelfSession,
    saved,
    canApply,
    onAbort,
    onOpenConflictSession,
    onUseFile,
    onClose,
    onApply,
}: FooterProps) {
    return (
        <div className="merge-footer">
            <div className="footer-left">
                {!isShelfSession ? (
                    <button type="button" className="footer-btn secondary" onClick={onAbort}>
                        {t("merge.action.abortMerge")}
                    </button>
                ) : null}
                {!isShelfSession ? (
                    <button
                        type="button"
                        className="footer-btn secondary ghost"
                        onClick={onOpenConflictSession}
                    >
                        {t("mergeSession.title")}
                    </button>
                ) : null}
                {saved && (
                    <span className="footer-draft-status" role="status">
                        {t("merge.workbench.draftSaved")}
                    </span>
                )}
                <span id="merge-keyboard-hint" className="footer-hint">
                    {t("merge.footer.hint")}
                </span>
            </div>
            <div className="footer-right">
                <button
                    type="button"
                    className="footer-btn secondary"
                    onClick={() => onUseFile("ours")}
                >
                    {t("merge.footer.useFileOurs")}
                </button>
                <button
                    type="button"
                    className="footer-btn secondary"
                    onClick={() => onUseFile("theirs")}
                >
                    {t("merge.footer.useFileTheirs")}
                </button>
                <button type="button" className="footer-btn secondary" onClick={onClose}>
                    {t("common.cancel")}
                </button>
                <button
                    type="button"
                    className={`footer-btn primary ${canApply ? "" : "disabled"}`}
                    onClick={onApply}
                    disabled={!canApply}
                    aria-describedby="merge-remaining-status"
                >
                    {t("common.apply")}
                </button>
            </div>
        </div>
    );
}

export function WorkbenchNotice(
    props:
        | { kind: "error"; message: string }
        | { kind: "stale"; content: string; onDiscard: () => void }
        | {
              kind: "regroup";
              message: string;
              busy: boolean;
              onApply: () => void;
              onKeep: () => void;
          },
) {
    return (
        <div className={`merge-notice merge-notice-${props.kind}`} role="alert">
            {props.kind === "error" ? (
                props.message
            ) : props.kind === "regroup" ? (
                <>
                    {props.message}
                    <button
                        type="button"
                        className="footer-btn secondary"
                        onClick={props.onApply}
                        disabled={props.busy}
                    >
                        {t("merge.workbench.regroupApply")}
                    </button>
                    <button
                        type="button"
                        className="footer-btn secondary"
                        onClick={props.onKeep}
                        disabled={props.busy}
                    >
                        {t("merge.workbench.regroupKeep")}
                    </button>
                </>
            ) : (
                <>
                    {t("merge.workbench.staleDraft")}
                    <details>
                        <summary>{t("merge.workbench.inspectDraft")}</summary>
                        <pre>{props.content}</pre>
                    </details>
                    <button
                        type="button"
                        className="footer-btn secondary"
                        onClick={props.onDiscard}
                    >
                        {t("merge.workbench.discardDraft")}
                    </button>
                </>
            )}
        </div>
    );
}

export function WorkbenchBasePane({
    visible,
    hostRef,
    onClose,
}: {
    visible: boolean;
    hostRef: React.Ref<HTMLDivElement>;
    onClose: () => void;
}) {
    return (
        <section className="merge-base" hidden={!visible}>
            <header>
                {t("merge.workbench.base")}
                <button
                    type="button"
                    className="toolbar-icon-btn"
                    title={t("common.close")}
                    aria-label={t("common.close")}
                    onClick={onClose}
                >
                    <VscClose />
                </button>
            </header>
            <div className="pane-base" ref={hostRef} />
        </section>
    );
}
