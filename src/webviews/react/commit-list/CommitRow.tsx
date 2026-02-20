import React from "react";
import { createPortal } from "react-dom";
import type { Commit } from "../../../types";
import { RefTypeIcon } from "../shared/components";
import { formatDateTime } from "../shared/date";
import { REF_BADGE_COLORS } from "../shared/tokens";
import { splitCommitRefs, stripTagPrefix, withTagPrefix } from "../shared/utils";
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

function getRefColors(name: string): { bg: string; fg: string } {
    if (name.includes("HEAD")) return REF_BADGE_COLORS.head;
    if (name.startsWith("tag:")) return REF_BADGE_COLORS.tag;
    if (name.startsWith("origin/")) return REF_BADGE_COLORS.remote;
    return REF_BADGE_COLORS.local;
}

function RefBadge({ name }: { name: string }): React.ReactElement {
    const colors = getRefColors(name);
    const label = stripTagPrefix(name);
    return (
        <span
            style={{
                display: "inline-flex",
                alignItems: "center",
                maxWidth: 200,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                borderRadius: 3,
                padding: "1px 6px",
                fontSize: 10,
                lineHeight: "15px",
                color: colors.fg,
                background: colors.bg,
            }}
            title={name}
        >
            {label}
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
        <span
            style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                minWidth: 0,
                fontSize: 11,
                lineHeight: "16px",
            }}
            title={name}
        >
            <span style={{ display: "inline-flex", flexShrink: 0 }}>
                <RefTypeIcon kind={kind} size={12} />
            </span>
            <span
                style={{
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    color: "var(--vscode-foreground)",
                }}
            >
                {name}
            </span>
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
    const { branches: branchRefs, tags: tagRefs } = splitCommitRefs(refs);
    const branchRefsCount = branchRefs.length;
    const visibleTagRefs = tagRefs.slice(0, 2).map((tag) => withTagPrefix(tag));
    const hiddenTagCount = Math.max(0, tagRefs.length - visibleTagRefs.length);
    const tooltipText =
        refs.length > 0
            ? `${message}\n\nBranches: ${branchRefs.join(" • ")}${
                  tagRefs.length > 0 ? `\nTags: ${tagRefs.join(" • ")}` : ""
              }`
            : message;

    const showTooltip = (event: React.PointerEvent<HTMLElement>): void => {
        const rect = event.currentTarget.getBoundingClientRect();
        const baseX = event.clientX > 0 ? event.clientX : rect.left + rect.width / 2;
        const x = Math.max(220, Math.min(window.innerWidth - 220, baseX));
        const shouldShowBelow = rect.top < 96;
        setTooltipPos({
            x,
            y: shouldShowBelow ? rect.bottom + 6 : rect.top - 8,
            placement: shouldShowBelow ? "below" : "above",
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
            <span
                style={{ overflow: "hidden", textOverflow: "ellipsis", minWidth: 0, flex: 1 }}
                title={message}
            >
                {message}
            </span>
            {branchRefsCount > 0 && (
                <span
                    style={{
                        marginLeft: 6,
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 3,
                        flexShrink: 0,
                        fontSize: "11px",
                        opacity: 0.85,
                        color: "var(--vscode-charts-blue, #6eb3ff)",
                    }}
                    title={`${branchRefsCount} branch label${branchRefsCount === 1 ? "" : "s"}`}
                >
                    <RefTypeIcon kind="branch" size={12} />
                    {branchRefsCount}
                </span>
            )}
            {visibleTagRefs.map((tagRef) => (
                <span key={tagRef} style={{ marginLeft: 5, flexShrink: 0 }}>
                    <RefBadge name={tagRef} />
                </span>
            ))}
            {hiddenTagCount > 0 && (
                <span
                    style={{
                        marginLeft: 5,
                        flexShrink: 0,
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 3,
                        fontSize: "10px",
                        opacity: 0.75,
                    }}
                    title={`${hiddenTagCount} more tag${hiddenTagCount === 1 ? "" : "s"}`}
                >
                    <RefTypeIcon kind="tag" size={11} />+{hiddenTagCount}
                </span>
            )}

            {tooltipPos &&
                createPortal(
                    <span
                        style={{
                            position: "fixed",
                            left: tooltipPos.x,
                            top: tooltipPos.y,
                            transform:
                                tooltipPos.placement === "above"
                                    ? "translate(-50%, -100%)"
                                    : "translate(-50%, 0)",
                            background: "var(--vscode-editorHoverWidget-background, #2f3646)",
                            color: "var(--vscode-editorHoverWidget-foreground, #d8dbe2)",
                            border: "1px solid var(--vscode-editorHoverWidget-border, rgba(255,255,255,0.12))",
                            borderRadius: 6,
                            fontSize: 11,
                            lineHeight: "15px",
                            padding: "8px 9px",
                            whiteSpace: "normal",
                            maxWidth: "560px",
                            minWidth: "240px",
                            zIndex: 9999,
                            pointerEvents: "none",
                            boxShadow: "0 10px 28px rgba(0,0,0,0.45)",
                        }}
                    >
                        <span
                            style={{
                                display: "block",
                                color: "var(--vscode-foreground)",
                                fontSize: "12px",
                                lineHeight: "16px",
                                marginBottom: refs.length > 0 ? 14 : 0,
                                wordBreak: "break-word",
                            }}
                        >
                            {message}
                        </span>
                        {(branchRefs.length > 0 || tagRefs.length > 0) && (
                            <>
                                <span
                                    style={{
                                        display: "block",
                                        fontSize: 11,
                                        opacity: 0.82,
                                        marginBottom: 5,
                                    }}
                                >
                                    Branches
                                </span>
                                <span style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                                    {branchRefs.map((name) => (
                                        <TooltipRefRow key={name} kind="branch" name={name} />
                                    ))}
                                </span>
                                {tagRefs.length > 0 && (
                                    <>
                                        <span
                                            style={{
                                                display: "block",
                                                fontSize: 11,
                                                opacity: 0.82,
                                                marginTop: 12,
                                                marginBottom: 5,
                                            }}
                                        >
                                            Tags
                                        </span>
                                        <span
                                            style={{
                                                display: "flex",
                                                flexDirection: "column",
                                                gap: 3,
                                            }}
                                        >
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
                marginLeft: graphWidth,
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
                    marginLeft: 4,
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
                    marginLeft: 4,
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
