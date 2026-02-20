import React from "react";
import { LuGitBranch, LuTag } from "react-icons/lu";
import { REF_BADGE_COLORS } from "../tokens";

export const BRANCH_REF_ICON_COLOR = "var(--vscode-charts-blue, #58a6ff)";
export const TAG_REF_ICON_COLOR = REF_BADGE_COLORS.tag.bg;

export function RefTypeIcon({
    kind,
    size = 12,
    branchColor = BRANCH_REF_ICON_COLOR,
    tagColor = TAG_REF_ICON_COLOR,
}: {
    kind: "branch" | "tag";
    size?: number;
    branchColor?: string;
    tagColor?: string;
}): React.ReactElement {
    const Icon = kind === "branch" ? LuGitBranch : LuTag;
    const color = kind === "branch" ? branchColor : tagColor;
    return <Icon size={size} color={color} />;
}
