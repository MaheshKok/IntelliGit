import React from "react";
import { ChevronIcon } from "../icons";
import { SECTION_HEADER_STYLE } from "../styles";

interface Props {
    label: string;
    expanded: boolean;
    onToggle: () => void;
    leadingIcon?: React.ReactNode;
}

export function BranchSectionHeader({
    label,
    expanded,
    onToggle,
    leadingIcon,
}: Props): React.ReactElement {
    return (
        <div
            role="button"
            tabIndex={0}
            aria-expanded={expanded}
            onClick={onToggle}
            onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                    if (event.key === " ") event.preventDefault();
                    onToggle();
                }
            }}
            style={SECTION_HEADER_STYLE}
        >
            <ChevronIcon expanded={expanded} />
            {leadingIcon}
            <span>{label}</span>
        </div>
    );
}
