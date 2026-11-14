import type React from "react";
import { JETBRAINS_UI } from "../../shared/tokens";

/** Inline styles shared by the Checks tab components. */
export const checksStyles = {
    visuallyHidden: {
        position: "absolute",
        width: 1,
        height: 1,
        padding: 0,
        margin: -1,
        overflow: "hidden",
        clip: "rect(0, 0, 0, 0)",
        whiteSpace: "nowrap",
        border: 0,
    },
    iconButton: {
        width: 22,
        height: 22,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        border: "none",
        borderRadius: 4,
        background: "transparent",
        color: "inherit",
        padding: 0,
        cursor: "pointer",
        flexShrink: 0,
    },
    linkButton: {
        border: "none",
        background: "transparent",
        color: "var(--vscode-textLink-foreground)",
        padding: 0,
        font: "inherit",
        textAlign: "left",
        cursor: "pointer",
    },
    note: {
        display: "flex",
        flexWrap: "wrap",
        alignItems: "baseline",
        gap: 8,
        padding: "4px 12px",
        color: JETBRAINS_UI.color.muted,
        fontSize: 12,
    },
    muted: {
        color: JETBRAINS_UI.color.muted,
        fontVariantNumeric: "tabular-nums",
        whiteSpace: "nowrap",
    },
    tag: {
        border: "1px solid currentColor",
        borderRadius: 3,
        padding: "0 4px",
        fontSize: 11,
        lineHeight: "14px",
        whiteSpace: "nowrap",
        flexShrink: 0,
    },
} satisfies Record<string, React.CSSProperties>;
