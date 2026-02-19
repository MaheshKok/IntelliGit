import React from "react";
import { ChevronIcon } from "../icons";
import { SECTION_HEADER_STYLE } from "../styles";

interface Props {
    label: string;
    expanded: boolean;
    onToggle: () => void;
}

export function BranchSectionHeader({ label, expanded, onToggle }: Props): React.ReactElement {
    return (
        <div onClick={onToggle} style={SECTION_HEADER_STYLE}>
            <ChevronIcon expanded={expanded} />
            <span>{label}</span>
        </div>
    );
}
