import type { CSSProperties } from "react";
import { JETBRAINS_UI } from "../tokens";

// Shared icon style constants for branch, tag, and file-tree glyph components.
// Kept outside component modules so shared constants do not trip Fast Refresh rules.

/** Base inline SVG style shared by compact branch/tag/folder icons. */
export const BASE_ICON_STYLE: CSSProperties = {
    flexShrink: 0,
    marginRight: 4,
    opacity: 0.92,
};

/** Default icon size aligned with the JetBrains-style webview token scale. */
export const ICON_SIZE = JETBRAINS_UI.size.icon;
