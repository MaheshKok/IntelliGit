import React from "react";
import { BRANCH_HIGHLIGHT_STYLE } from "./styles";

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function renderHighlightedLabel(label: string, needle: string): React.ReactNode {
    if (!needle) return label;
    const regex = new RegExp(`(${escapeRegExp(needle)})`, "ig");
    const parts = label.split(regex);
    const lowerNeedle = needle.toLowerCase();

    return (
        <>
            {parts.map((part, idx) =>
                part.toLowerCase() === lowerNeedle ? (
                    <mark key={`${part}-${idx}`} style={BRANCH_HIGHLIGHT_STYLE}>
                        {part}
                    </mark>
                ) : (
                    <React.Fragment key={`${part}-${idx}`}>{part}</React.Fragment>
                ),
            )}
        </>
    );
}
