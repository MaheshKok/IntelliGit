import React from "react";
import type { Commit } from "../../../types";
import { formatDateTime } from "../shared/date";
import { REF_BADGE_COLORS } from "../shared/tokens";
import {
    AUTHOR_COL_WIDTH,
    DATE_COL_WIDTH,
    REF_CONTAINER_STYLE,
    REF_LABEL_STYLE,
    ROW_SIDE_PADDING,
} from "./styles";
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

function RefLabel({ name }: { name: string }): React.ReactElement {
    const isHead = name.includes("HEAD");
    const isTag = name.startsWith("tag:");
    let bg: string;
    let fg: string;

    if (isHead) {
        bg = REF_BADGE_COLORS.head.bg;
        fg = REF_BADGE_COLORS.head.fg;
    } else if (isTag) {
        bg = REF_BADGE_COLORS.tag.bg;
        fg = REF_BADGE_COLORS.tag.fg;
    } else if (name.startsWith("origin/")) {
        bg = REF_BADGE_COLORS.remote.bg;
        fg = REF_BADGE_COLORS.remote.fg;
    } else {
        bg = REF_BADGE_COLORS.local.bg;
        fg = REF_BADGE_COLORS.local.fg;
    }

    return <span style={{ ...REF_LABEL_STYLE, background: bg, color: fg }}>{name}</span>;
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
            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>
                {commit.message}
            </span>

            {commit.refs.length > 0 && (
                <span style={REF_CONTAINER_STYLE}>
                    {commit.refs.map((ref) => (
                        <RefLabel key={ref} name={ref} />
                    ))}
                </span>
            )}

            <span
                style={{
                    width: AUTHOR_COL_WIDTH,
                    textAlign: "right",
                    opacity: isMergeCommit ? 1 : 0.7,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    flexShrink: 0,
                    marginLeft: 8,
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
                    marginLeft: 8,
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
