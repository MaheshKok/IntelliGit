import React from "react";
import { createPortal } from "react-dom";
import type { Commit } from "../../../types";
import { RefTypeIcon } from "../shared/components/RefTypeIcon";
import { formatDateTime } from "../shared/date";
import { JETBRAINS_UI, REF_BADGE_COLORS } from "../shared/tokens";
import { splitCommitRefs } from "../shared/utils/refs";
import { AUTHOR_COL_WIDTH, DATE_COL_WIDTH, ROW_SIDE_PADDING } from "./styles";
import { ROW_HEIGHT } from "../graph";
import { getSettings } from "../shared/settings";
import { t } from "../shared/i18n";
import { CommitChecksButton, type CommitChecksValue } from "./CommitChecksPopover";

interface Props {
    commit: Commit;
    graphWidth: number;
    isSelected: boolean;
    isUnpushed: boolean;
    laneColor?: string;
    onSelect: (hash: string) => void;
    onContextMenu: (event: React.MouseEvent, commit: Commit) => void;
    onHover?: (commit: Commit, event: React.MouseEvent) => void;
    onUnhover?: () => void;
    showAuthorDate?: boolean;
    checks?: CommitChecksValue;
    onRequestChecks?: (hash: string) => void;
    onOpenCheckUrl?: (url: string) => void;
    onSignIn?: (host: string) => void;
}

const REF_BADGE_BASE_STYLE: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    maxWidth: 200,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    borderRadius: 3,
    padding: "1px 6px",
    fontSize: 12,
    lineHeight: "15px",
};
const TOOLTIP_REF_ROW_STYLE: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    minWidth: 0,
    fontSize: 12,
    lineHeight: "16px",
};
const TOOLTIP_REF_ICON_STYLE: React.CSSProperties = {
    display: "inline-flex",
    flexShrink: 0,
};
const TOOLTIP_REF_TEXT_STYLE: React.CSSProperties = {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: "var(--vscode-foreground)",
};
const MESSAGE_CELL_STYLE: React.CSSProperties = {
    flex: 1,
    minWidth: 0,
    display: "flex",
    alignItems: "center",
    overflow: "hidden",
};
const MESSAGE_TEXT_STYLE: React.CSSProperties = {
    overflow: "hidden",
    textOverflow: "ellipsis",
    minWidth: 0,
    flex: 1,
};
const BRANCH_REF_COUNT_STYLE: React.CSSProperties = {
    marginLeft: 6,
    display: "inline-flex",
    alignItems: "center",
    gap: 3,
    flexShrink: 0,
    fontSize: "12px",
    opacity: 0.85,
    color: "var(--vscode-charts-blue, #6eb3ff)",
};
const TAG_REF_WRAPPER_STYLE: React.CSSProperties = {
    marginLeft: 5,
    flexShrink: 0,
};
const HIDDEN_TAG_COUNT_STYLE: React.CSSProperties = {
    marginLeft: 5,
    flexShrink: 0,
    display: "inline-flex",
    alignItems: "center",
    gap: 3,
    fontSize: "12px",
    opacity: 0.75,
};
const COMMIT_TOOLTIP_BASE_STYLE: React.CSSProperties = {
    position: "fixed",
    background: JETBRAINS_UI.color.tooltipBackground,
    color: "var(--vscode-editorHoverWidget-foreground, #d8dbe2)",
    border: `1px solid ${JETBRAINS_UI.color.tooltipBorder}`,
    borderRadius: JETBRAINS_UI.size.radius,
    fontSize: 12,
    lineHeight: "15px",
    padding: "8px 9px",
    whiteSpace: "normal",
    maxWidth: "560px",
    minWidth: "240px",
    zIndex: 30,
    pointerEvents: "none",
    boxShadow: "0 10px 28px rgba(0,0,0,0.42)",
};
const COMMIT_TOOLTIP_MESSAGE_BASE_STYLE: React.CSSProperties = {
    display: "block",
    color: "var(--vscode-foreground)",
    fontSize: "12px",
    lineHeight: "16px",
    wordBreak: "break-word",
};
const COMMIT_TOOLTIP_SECTION_LABEL_STYLE: React.CSSProperties = {
    display: "block",
    fontSize: 12,
    opacity: 0.82,
    marginBottom: 5,
};
const COMMIT_TOOLTIP_SECTION_LIST_STYLE: React.CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: 3,
};

function getRefColors(kind: "branch" | "tag", name: string): { bg: string; fg: string } {
    if (kind === "tag") return REF_BADGE_COLORS.tag;
    if (name.includes("HEAD")) return REF_BADGE_COLORS.head;
    if (name.startsWith("origin/")) return REF_BADGE_COLORS.remote;
    return REF_BADGE_COLORS.local;
}

function RefBadge({ kind, name }: { kind: "branch" | "tag"; name: string }): React.ReactElement {
    const colors = getRefColors(kind, name);
    const style = React.useMemo<React.CSSProperties>(
        () => ({
            ...REF_BADGE_BASE_STYLE,
            color: colors.fg,
            background: colors.bg,
        }),
        [colors.bg, colors.fg],
    );
    return (
        <span style={style} title={name}>
            {name}
        </span>
    );
}

function TooltipRefRow({
    kind,
    name,
}: {
    kind: "branch" | "tag";
    name: string;
}): React.ReactElement {
    return (
        <span style={TOOLTIP_REF_ROW_STYLE} title={name}>
            <span style={TOOLTIP_REF_ICON_STYLE}>
                <RefTypeIcon
                    kind={kind}
                    size={12}
                    tagColor={kind === "tag" ? REF_BADGE_COLORS.tag.bg : undefined}
                />
            </span>
            <span style={TOOLTIP_REF_TEXT_STYLE}>{name}</span>
        </span>
    );
}

function CommitMessageCell({
    message,
    refs,
}: {
    message: string;
    refs: string[];
}): React.ReactElement {
    const [tooltipPos, setTooltipPos] = React.useState<{
        x: number;
        y: number;
        placement: "above" | "below";
    } | null>(null);
    const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const { branches: branchRefs, tags: tagRefs } = splitCommitRefs(refs);
    const branchRefsCount = branchRefs.length;
    const visibleTagRefs = tagRefs.slice(0, 2);
    const hiddenTagCount = Math.max(0, tagRefs.length - visibleTagRefs.length);
    const tooltipStyle = React.useMemo<React.CSSProperties | undefined>(
        () =>
            tooltipPos
                ? {
                      ...COMMIT_TOOLTIP_BASE_STYLE,
                      left: tooltipPos.x,
                      top: tooltipPos.y,
                      transform:
                          tooltipPos.placement === "above"
                              ? "translate(-50%, -100%)"
                              : "translate(-50%, 0)",
                  }
                : undefined,
        [tooltipPos],
    );
    const tooltipMessageStyle = React.useMemo<React.CSSProperties>(
        () => ({
            ...COMMIT_TOOLTIP_MESSAGE_BASE_STYLE,
            marginBottom: refs.length > 0 ? 14 : 0,
        }),
        [refs.length],
    );
    const tooltipTagLabelStyle = React.useMemo<React.CSSProperties>(
        () => ({
            ...COMMIT_TOOLTIP_SECTION_LABEL_STYLE,
            marginTop: branchRefs.length > 0 ? 12 : 0,
        }),
        [branchRefs.length],
    );
    const refSummaryLines: string[] = [];
    if (branchRefs.length > 0) {
        refSummaryLines.push(t("commit.tooltip.branchesList", { refs: branchRefs.join(" • ") }));
    }
    if (tagRefs.length > 0) {
        refSummaryLines.push(t("commit.tooltip.tagsList", { refs: tagRefs.join(" • ") }));
    }
    const tooltipText =
        refSummaryLines.length > 0 ? `${message}\n\n${refSummaryLines.join("\n")}` : message;

    const clearTooltipTimer = React.useCallback(() => {
        if (timerRef.current) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
        }
    }, []);

    const showTooltip = (event: React.PointerEvent<HTMLElement>): void => {
        const { hoverDelay, tooltipsEnabled } = getSettings();
        if (!tooltipsEnabled) return;

        const rect = event.currentTarget.getBoundingClientRect();
        const baseX = event.clientX > 0 ? event.clientX : rect.left + rect.width / 2;
        const x = Math.max(220, Math.min(window.innerWidth - 220, baseX));
        const shouldShowBelow = rect.top < 96;
        const placement: "above" | "below" = shouldShowBelow ? "below" : "above";

        const newPos = {
            x,
            y: shouldShowBelow ? rect.bottom + 6 : rect.top - 8,
            placement,
        };

        if (tooltipPos) {
            setTooltipPos(newPos);
        } else {
            clearTooltipTimer();
            timerRef.current = setTimeout(() => {
                setTooltipPos(newPos);
            }, hoverDelay);
        }
    };

    const hideTooltip = (): void => {
        clearTooltipTimer();
        setTooltipPos(null);
    };

    React.useEffect(() => clearTooltipTimer, [clearTooltipTimer]);

    return (
        <span
            style={MESSAGE_CELL_STYLE}
            data-commit-tooltip={tooltipText}
            onPointerEnter={showTooltip}
            onPointerMove={showTooltip}
            onPointerLeave={hideTooltip}
        >
            <span style={MESSAGE_TEXT_STYLE} title={message}>
                {message}
            </span>
            {branchRefsCount > 0 && (
                <span
                    style={BRANCH_REF_COUNT_STYLE}
                    title={t("commit.tooltip.branchLabels", { count: branchRefsCount })}
                >
                    <RefTypeIcon kind="branch" size={12} />
                    {branchRefsCount}
                </span>
            )}
            {visibleTagRefs.map((tagRef) => (
                <span key={`tag:${tagRef}`} style={TAG_REF_WRAPPER_STYLE}>
                    <RefBadge kind="tag" name={tagRef} />
                </span>
            ))}
            {hiddenTagCount > 0 && (
                <span
                    style={HIDDEN_TAG_COUNT_STYLE}
                    title={t("commit.tooltip.moreTags", { count: hiddenTagCount })}
                >
                    <RefTypeIcon kind="tag" size={11} tagColor={REF_BADGE_COLORS.tag.bg} />
                    {`+${hiddenTagCount}`}
                </span>
            )}

            {tooltipPos &&
                createPortal(
                    <span style={tooltipStyle}>
                        <span style={tooltipMessageStyle}>{message}</span>
                        {(branchRefs.length > 0 || tagRefs.length > 0) && (
                            <>
                                {branchRefs.length > 0 && (
                                    <>
                                        <span style={COMMIT_TOOLTIP_SECTION_LABEL_STYLE}>
                                            {t("common.branches")}
                                        </span>
                                        <span style={COMMIT_TOOLTIP_SECTION_LIST_STYLE}>
                                            {branchRefs.map((name) => (
                                                <TooltipRefRow
                                                    key={`branch:${name}`}
                                                    kind="branch"
                                                    name={name}
                                                />
                                            ))}
                                        </span>
                                    </>
                                )}
                                {tagRefs.length > 0 && (
                                    <>
                                        <span style={tooltipTagLabelStyle}>{t("common.tags")}</span>
                                        <span style={COMMIT_TOOLTIP_SECTION_LIST_STYLE}>
                                            {tagRefs.map((name) => (
                                                <TooltipRefRow
                                                    key={`tag:${name}`}
                                                    kind="tag"
                                                    name={name}
                                                />
                                            ))}
                                        </span>
                                    </>
                                )}
                            </>
                        )}
                    </span>,
                    document.body,
                )}
        </span>
    );
}

function CommitRowInner({
    commit,
    graphWidth,
    isSelected,
    isUnpushed,
    laneColor,
    onSelect,
    onContextMenu,
    onHover,
    onUnhover,
    showAuthorDate = true,
    checks,
    onRequestChecks,
    onOpenCheckUrl,
    onSignIn,
}: Props): React.ReactElement {
    const isMergeCommit = commit.parentHashes.length > 1;
    const rowStyle = React.useMemo<React.CSSProperties>(
        () => ({
            height: ROW_HEIGHT,
            display: "flex",
            alignItems: "center",
            marginLeft: graphWidth,
            paddingRight: ROW_SIDE_PADDING,
            cursor: "pointer",
            fontSize: "12px",
            whiteSpace: "nowrap",
            borderLeft: isUnpushed
                ? `2px solid ${laneColor ?? JETBRAINS_UI.color.head}`
                : "2px solid transparent",
            background: isSelected ? JETBRAINS_UI.color.selected : "transparent",
            color: isSelected
                ? JETBRAINS_UI.color.selectedForeground
                : isMergeCommit
                  ? "var(--vscode-disabledForeground)"
                  : JETBRAINS_UI.color.foreground,
        }),
        [graphWidth, isMergeCommit, isSelected, isUnpushed, laneColor],
    );
    const authorStyle = React.useMemo<React.CSSProperties>(
        () => ({
            width: AUTHOR_COL_WIDTH,
            textAlign: "right",
            opacity: isMergeCommit ? 1 : 0.7,
            overflow: "hidden",
            textOverflow: "ellipsis",
            flexShrink: 0,
            marginLeft: 4,
        }),
        [isMergeCommit],
    );
    const dateStyle = React.useMemo<React.CSSProperties>(
        () => ({
            width: DATE_COL_WIDTH,
            textAlign: "right",
            opacity: isMergeCommit ? 0.8 : 0.5,
            flexShrink: 0,
            marginLeft: 4,
            fontSize: "12px",
        }),
        [isMergeCommit],
    );
    const handleSelect = React.useCallback(() => {
        onSelect(commit.hash);
    }, [commit.hash, onSelect]);
    const handleKeyDown = React.useCallback(
        (event: React.KeyboardEvent<HTMLDivElement>) => {
            if (event.currentTarget !== event.target) return;
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            handleSelect();
        },
        [handleSelect],
    );

    return (
        <div
            // Native button would wrap nested commit-check controls; keep the row div keyboard-activated.
            // react-doctor-disable-next-line react-doctor/prefer-tag-over-role
            role="button"
            tabIndex={0}
            aria-current={isSelected ? "true" : undefined}
            onClick={handleSelect}
            onKeyDown={handleKeyDown}
            onContextMenu={(event) => onContextMenu(event, commit)}
            onMouseEnter={(event) => onHover?.(commit, event)}
            onMouseLeave={() => onUnhover?.()}
            style={rowStyle}
        >
            <CommitMessageCell message={commit.message} refs={commit.refs} />

            {showAuthorDate && (
                <>
                    <span style={authorStyle}>{commit.author}</span>

                    <span style={dateStyle}>{formatDateTime(commit.date)}</span>
                </>
            )}

            {onRequestChecks && onOpenCheckUrl ? (
                <CommitChecksButton
                    hash={commit.hash}
                    checks={checks}
                    onRequestChecks={onRequestChecks}
                    onOpenCheckUrl={onOpenCheckUrl}
                    onSignIn={onSignIn}
                />
            ) : null}
        </div>
    );
}

function areEqual(prev: Props, next: Props): boolean {
    return (
        prev.commit.hash === next.commit.hash &&
        prev.commit.message === next.commit.message &&
        prev.commit.author === next.commit.author &&
        prev.commit.date === next.commit.date &&
        prev.commit.refs === next.commit.refs &&
        prev.commit.parentHashes === next.commit.parentHashes &&
        prev.isSelected === next.isSelected &&
        prev.isUnpushed === next.isUnpushed &&
        prev.laneColor === next.laneColor &&
        prev.graphWidth === next.graphWidth &&
        prev.showAuthorDate === next.showAuthorDate &&
        prev.checks === next.checks &&
        prev.onRequestChecks === next.onRequestChecks &&
        prev.onOpenCheckUrl === next.onOpenCheckUrl &&
        prev.onSignIn === next.onSignIn &&
        prev.onSelect === next.onSelect &&
        prev.onContextMenu === next.onContextMenu
    );
}

/**
 * Memoized commit list row with graph lane indicator, ref badges, and a hover tooltip.
 *
 * Unpushed commits show a colored left border matching their graph lane. The
 * message cell renders branch-count and tag-ref badges inline, and a portal-based
 * tooltip on hover/pointer-move with the full message plus branch and tag ref
 * breakdown. Merge commits are rendered with muted colors for visual distinction.
 *
 * The memo comparator (`areEqual`) checks commit identity, selection, unpushed
 * status, lane color, graph width, and callback referential stability to skip
 * re-renders when only sibling rows change.
 */
export const CommitRow = React.memo(CommitRowInner, areEqual);
