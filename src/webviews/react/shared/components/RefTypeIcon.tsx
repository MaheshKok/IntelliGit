import React from "react";
import { LuGitBranch, LuTag } from "react-icons/lu";

export const BRANCH_REF_ICON_COLOR = "var(--vscode-charts-blue, #58a6ff)";
export const TAG_REF_ICON_COLOR = "var(--vscode-charts-orange, #FF9800)";

function RefTypeIconInner({
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

export const RefTypeIcon = React.memo(RefTypeIconInner);
