import React from "react";
import { JETBRAINS_UI } from "../tokens";
import { RefBranchIcon, RefTagIcon } from "./Icons";

const BRANCH_REF_ICON_COLOR = JETBRAINS_UI.color.branch;
const TAG_REF_ICON_COLOR = JETBRAINS_UI.color.tag;

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
    const color = kind === "branch" ? branchColor : tagColor;
    return kind === "branch" ? (
        <RefBranchIcon size={size} color={color} />
    ) : (
        <RefTagIcon size={size} color={color} />
    );
}

export const RefTypeIcon = React.memo(RefTypeIconInner);
