import React from "react";
import { BRANCH_HIGHLIGHT_STYLE } from "./styles";

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Renders a branch label with case-insensitive search matches highlighted.
 *
 * The search string is escaped before building the regex, so Git branch names and
 * user-entered filters containing regex punctuation are treated literally.
 */
export function renderHighlightedLabel(label: string, needle: string): React.ReactNode {
    if (!needle) return label;
    const regex = new RegExp(`(${escapeRegExp(needle)})`, "i");
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
