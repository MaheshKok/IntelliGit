import React from "react";
import type { ThemeIconFont } from "../../../../types";

const ALLOWED_FONT_STYLES = new Set(["normal", "italic", "oblique"]);
const ALLOWED_FONT_WEIGHTS = new Set([
    "normal",
    "bold",
    "100",
    "200",
    "300",
    "400",
    "500",
    "600",
    "700",
    "800",
    "900",
]);

function escapeCssString(value: string): string {
    return value
        .replace(/\\/g, "\\\\")
        .replace(/\r/g, "\\r ")
        .replace(/\n/g, "\\a ")
        .replace(/'/g, "\\'");
}

function normalizeFontStyle(style: string | undefined): string {
    if (!style) return "normal";
    const normalized = style.trim().toLowerCase();
    return ALLOWED_FONT_STYLES.has(normalized) ? normalized : "normal";
}

function normalizeFontWeight(weight: string | undefined): string {
    if (!weight) return "normal";
    const normalized = weight.trim().toLowerCase();
    return ALLOWED_FONT_WEIGHTS.has(normalized) ? normalized : "normal";
}

export function ThemeIconFontFaces({
    fonts,
}: {
    fonts?: ThemeIconFont[];
}): React.ReactElement | null {
    const safeFonts = Array.isArray(fonts) ? fonts : [];
    if (!safeFonts.length) return null;

    const css = safeFonts
        .flatMap((font) => {
            if (!font || typeof font.fontFamily !== "string" || typeof font.src !== "string") {
                return [];
            }
            const family = escapeCssString(font.fontFamily);
            const src = escapeCssString(font.src);
            if (!family || !src) return [];
            const format =
                typeof font.format === "string" && font.format.trim().length > 0
                    ? ` format('${escapeCssString(font.format)}')`
                    : "";
            const weight = normalizeFontWeight(font.weight);
            const style = normalizeFontStyle(font.style);
            return [
                `@font-face{font-family:'${family}';src:url('${src}')${format};font-weight:${weight};font-style:${style};font-display:block;}`,
            ];
        })
        .join("");

    if (!css) return null;
    return <style>{css}</style>;
}
