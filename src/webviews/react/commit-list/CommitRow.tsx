import React from "react";
import type { Commit } from "../../../types";
import { formatDateTime } from "../shared/date";
import { AUTHOR_COL_WIDTH, DATE_COL_WIDTH, ROW_SIDE_PADDING } from "./styles";
import { ROW_HEIGHT } from "../graph";

interface Props {
    commit: Commit;
    graphWidth: number;
    isSelected: boolean;
    isUnpushed: boolean;
    laneColor?: string;
    onSelect: (hash: string) => void;
    onContextMenu: (event: React.MouseEvent, commit: Commit) => void;
}

function CommitMessageCell({
    message,
    refs,
}: {
    message: string;
    refs: string[];
}): React.ReactElement {
    const [tooltipPos, setTooltipPos] = React.useState<{ x: number; y: number } | null>(null);
    const refsCount = refs.length;
    const refsCountLabel = refsCount > 0 ? `${refsCount} tag${refsCount === 1 ? "" : "s"}` : "";
    const tooltipText = refsCountLabel
        ? `${message}\n\nLabels: ${refs.join(" • ")}`
        : message;

    const showTooltip = (event: React.PointerEvent<HTMLElement>): void => {
        const rect = event.currentTarget.getBoundingClientRect();
        setTooltipPos({
            x: event.clientX > 0 ? event.clientX : rect.left + rect.width / 2,
            y: rect.top - 6,
        });
    };

    const hideTooltip = (): void => setTooltipPos(null);

    return (
        <span
            style={{
                flex: 1,
                minWidth: 0,
                display: "flex",
                alignItems: "center",
                overflow: "hidden",
            }}
            data-commit-tooltip={tooltipText}
            onPointerEnter={showTooltip}
            onPointerMove={showTooltip}
            onPointerLeave={hideTooltip}
        >
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }} title={message}>
                {message}
            </span>
            {refsCount > 0 && (
                <span
                    style={{
                        marginLeft: 6,
                        flexShrink: 0,
                        fontSize: "11px",
                        opacity: 0.72,
                    }}
                >
                    {refsCountLabel}
                </span>
            )}

            {tooltipPos && (
                <span
                    style={{
                        position: "fixed",
                        left: tooltipPos.x,
                        top: tooltipPos.y,
                        transform: "translate(-50%, -100%)",
                        background: "var(--vscode-editorHoverWidget-background, #2f3646)",
                        color: "var(--vscode-editorHoverWidget-foreground, #d8dbe2)",
                        border: "1px solid var(--vscode-editorHoverWidget-border, rgba(255,255,255,0.12))",
                        borderRadius: 4,
                        fontSize: 11,
                        lineHeight: "14px",
                        padding: "4px 7px",
                        whiteSpace: "pre-wrap",
                        maxWidth: "560px",
                        zIndex: 9999,
                        pointerEvents: "none",
                        boxShadow: "0 4px 14px rgba(0,0,0,0.35)",
                    }}
                >
                    {tooltipText}
                </span>
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
}: Props): React.ReactElement {
    const isMergeCommit = commit.parentHashes.length > 1;

    return (
        <div
            onClick={() => onSelect(commit.hash)}
            onContextMenu={(event) => onContextMenu(event, commit)}
            style={{
                height: ROW_HEIGHT,
                display: "flex",
                alignItems: "center",
                paddingLeft: graphWidth,
                paddingRight: ROW_SIDE_PADDING,
                cursor: "pointer",
                fontSize: "12px",
                whiteSpace: "nowrap",
                borderLeft: isUnpushed
                    ? `2px solid ${laneColor ?? "#4CAF50"}`
                    : "2px solid transparent",
                background: isSelected
                    ? "var(--vscode-list-activeSelectionBackground)"
                    : "transparent",
                color: isSelected
                    ? "var(--vscode-list-activeSelectionForeground)"
                    : isMergeCommit
                      ? "var(--vscode-disabledForeground)"
                      : "inherit",
            }}
        >
            <CommitMessageCell message={commit.message} refs={commit.refs} />

            <span
                style={{
                    width: AUTHOR_COL_WIDTH,
                    textAlign: "right",
                    opacity: isMergeCommit ? 1 : 0.7,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    flexShrink: 0,
                    marginLeft: 6,
                }}
            >
                {commit.author}
            </span>

            <span
                style={{
                    width: DATE_COL_WIDTH,
                    textAlign: "right",
                    opacity: isMergeCommit ? 0.8 : 0.5,
                    flexShrink: 0,
                    marginLeft: 6,
                    fontSize: "11px",
                }}
            >
                {formatDateTime(commit.date)}
            </span>
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
        prev.onSelect === next.onSelect &&
        prev.onContextMenu === next.onContextMenu
    );
}

export const CommitRow = React.memo(CommitRowInner, areEqual);
