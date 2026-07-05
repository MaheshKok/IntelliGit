// SVG icon components used by the merge editor UI.

import React from "react";

/** Right-pointing arrow used for accepting the left-side change into the result pane. */
export function IconArrowRight(): React.ReactElement {
    return (
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <path fill="currentColor" d="M5 3l5 5-5 5-.7-.7L8.6 8 4.3 3.7z" />
        </svg>
    );
}

/** Left-pointing arrow used for accepting the right-side change into the result pane. */
export function IconArrowLeft(): React.ReactElement {
    return (
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <path fill="currentColor" d="M11 3l.7.7L7.4 8l4.3 4.3-.7.7-5-5z" />
        </svg>
    );
}

/** Up chevron used by previous-conflict navigation controls. */
export function IconChevronUp(): React.ReactElement {
    return (
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <path fill="currentColor" d="M3.7 10.8L8 6.5l4.3 4.3.7-.7L8 5.1 3 10.1z" />
        </svg>
    );
}

/** Down chevron used by next-conflict and dropdown controls. */
export function IconChevronDown(): React.ReactElement {
    return (
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <path fill="currentColor" d="M3.7 5.2L3 5.9l5 5 5-5-.7-.7L8 9.5z" />
        </svg>
    );
}

/** Spark glyph used for the apply-non-conflicting-changes action. */
export function IconSpark(): React.ReactElement {
    return (
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <path
                fill="currentColor"
                d="M8 1l1.6 3.4L13 6l-3.4 1.6L8 11 6.4 7.6 3 6l3.4-1.6zM3 10l.8 1.7L5.5 13l-1.7.8L3 15l-.8-1.2L.5 13l1.7-.8zM12.5 10l.9 1.8L15 12.5l-1.6.7L12.5 15l-.8-1.8-1.7-.7 1.7-.7z"
            />
        </svg>
    );
}

/** Eye glyph used by word-highlight visibility controls. */
export function IconEye(): React.ReactElement {
    return (
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <path
                fill="currentColor"
                d="M8 3c3.4 0 6 3 6.7 4-.7 1-3.3 4-6.7 4S2 8 1.3 7C2 6 4.6 3 8 3zm0 1C5.5 4 3.4 6 2.5 7c.9 1 3 3 5.5 3s4.6-2 5.5-3c-.9-1-3-3-5.5-3zm0 1.5A1.5 1.5 0 1 1 8 8.5 1.5 1.5 0 0 1 8 5.5z"
            />
        </svg>
    );
}

/** Filter glyph used by ignore-mode controls. */
export function IconFilter(): React.ReactElement {
    return (
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <path fill="currentColor" d="M2 3h12L9.5 8v4.2l-3 1V8z" />
        </svg>
    );
}

/** Lock glyph marking read-only source panes. */
export function IconLock(): React.ReactElement {
    return (
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <path
                fill="currentColor"
                d="M11 6V5a3 3 0 00-6 0v1H4v8h8V6h-1zm-4-1a2 2 0 114 0v1H7V5zm3 8H6V7h4v6z"
            />
        </svg>
    );
}

/** Warning glyph used for unresolved-conflict status badges. */
export function IconWarning(): React.ReactElement {
    return (
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <path
                fill="currentColor"
                d="M8 1.6l6.5 11.3H1.5L8 1.6zm0 2L3.2 12h9.6L8 3.6zm-.7 2.1h1.4v3.7H7.3V5.7zm0 4.8h1.4v1.4H7.3v-1.4z"
            />
        </svg>
    );
}
