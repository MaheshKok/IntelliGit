import { useEffect, useState } from "react";
import { GRAPH_LANE_COLORS, GRAPH_LANE_COLORS_LIGHT } from "./tokens";

/**
 * Theme-kind detection for the colors IntelliGit owns outright.
 *
 * Anything backed by a `--vscode-*` token adapts on its own and needs nothing here.
 * The commit-graph lanes have no host token, so they have to be chosen explicitly,
 * and the choice is made by measuring the resolved editor background rather than by
 * reading the `vscode-dark` / `vscode-light` body class. Measuring covers custom and
 * user-authored themes, which frequently carry a body class that does not match the
 * background they actually paint.
 */

/** Relative luminance above which a background counts as light. */
const LIGHT_THRESHOLD = 0.4;

/**
 * Parses the subset of CSS color syntax `getComputedStyle` returns for a resolved
 * custom property: `#rgb`, `#rrggbb`, and `rgb()` / `rgba()`.
 *
 * Returns `null` for anything else (named colors, `color()`, empty strings) so callers
 * can fall back rather than guess.
 */
function parseColorChannels(color: string): [number, number, number] | null {
    const value = color.trim();
    if (value.length === 0) return null;

    if (value.startsWith("#")) {
        const hex = value.slice(1);
        if (hex.length === 3) {
            const channels = [0, 1, 2].map((i) => parseInt(hex[i] + hex[i], 16) / 255);
            return channels.some(Number.isNaN) ? null : (channels as [number, number, number]);
        }
        if (hex.length === 6 || hex.length === 8) {
            const channels = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
            return channels.some(Number.isNaN) ? null : (channels as [number, number, number]);
        }
        return null;
    }

    const match = value.match(/^rgba?\(([^)]+)\)$/i);
    if (!match) return null;
    const parts = match[1].split(/[\s,/]+/).filter((part) => part.length > 0);
    if (parts.length < 3) return null;
    const channels = parts.slice(0, 3).map((part) => {
        const numeric = parseFloat(part);
        if (Number.isNaN(numeric)) return Number.NaN;
        return part.endsWith("%") ? numeric / 100 : numeric / 255;
    });
    return channels.some(Number.isNaN) ? null : (channels as [number, number, number]);
}

/**
 * Returns true when `color` is light enough that dark-tuned graphics would wash out.
 *
 * Unparseable input resolves to `false`, keeping the dark palette as the default.
 */
export function isLightBackground(color: string): boolean {
    const channels = parseColorChannels(color);
    if (!channels) return false;
    const [r, g, b] = channels.map((channel) =>
        channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
    );
    return 0.2126 * r + 0.7152 * g + 0.0722 * b > LIGHT_THRESHOLD;
}

/**
 * Reads the resolved editor background and reports whether the active theme is light.
 *
 * Module-internal: `resolveLanePalette` and `useIsLightTheme` are the surface callers
 * use. It was exported back when a component read it directly; nothing outside this
 * file has since `0952efe4`, and knip fails the build on an export nobody imports.
 */
function isLightTheme(): boolean {
    if (typeof document === "undefined") return false;
    const background = getComputedStyle(document.documentElement)
        .getPropertyValue("--vscode-editor-background")
        .trim();
    return isLightBackground(background);
}

/** Returns the commit-graph lane palette matching the active theme. */
export function resolveLanePalette(light = isLightTheme()): string[] {
    return light ? GRAPH_LANE_COLORS_LIGHT : GRAPH_LANE_COLORS;
}

/**
 * Tracks theme lightness across live theme switches.
 *
 * VS Code swaps the injected stylesheet in place, so the observer watches the same
 * attributes the graph canvas already watches for repaints.
 */
export function useIsLightTheme(): boolean {
    const [light, setLight] = useState(isLightTheme);

    useEffect(() => {
        const sync = (): void => {
            setLight((current) => {
                const next = isLightTheme();
                return next === current ? current : next;
            });
        };
        const observer = new MutationObserver(sync);
        const options: MutationObserverInit = {
            attributes: true,
            attributeFilter: ["class", "style", "data-vscode-theme-id", "data-vscode-theme-kind"],
        };
        observer.observe(document.documentElement, options);
        observer.observe(document.body, options);
        // Not an initializer -- `useState(isLightTheme)` above already seeds the first render.
        // This closes the window between that render and the observers attaching: a theme swap
        // landing in the gap produces no future mutation for the observer to see, so without
        // this re-read the hook would report the old theme for the rest of the session.
        // react-doctor-disable-next-line react-doctor/no-initialize-state
        sync();
        return () => observer.disconnect();
    }, []);

    return light;
}
