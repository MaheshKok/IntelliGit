import React from "react";
import { ChevronIcon } from "../icons";
import { SECTION_HEADER_STYLE } from "../styles";

interface Props {
    label: string;
    expanded: boolean;
    onToggle: () => void;
    leadingIcon?: React.ReactNode;
}

/**
 * Keyboard-accessible collapsible section header for branch groups.
 *
 * Toggles expansion with a native button so screen readers announce the current
 * collapsed state via `aria-expanded`.
 */
export function BranchSectionHeader({
    label,
    expanded,
    onToggle,
    leadingIcon,
}: Props): React.ReactElement {
    return (
        <button
            type="button"
            aria-expanded={expanded}
            onClick={onToggle}
            style={SECTION_HEADER_STYLE}
        >
            <ChevronIcon expanded={expanded} />
            {leadingIcon}
            <span>{label}</span>
        </button>
    );
}
