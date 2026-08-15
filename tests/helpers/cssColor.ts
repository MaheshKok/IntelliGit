/**
 * Resolves the slice of CSS colour syntax the webview token layer actually uses,
 * against a captured host theme's variables.
 *
 * This exists so a unit test can measure what a token BECOMES in a real theme
 * rather than pinning the string it is spelled with. Pinning the spelling passes
 * for any future transformation written a different way; resolving it catches
 * the transformation whatever syntax it arrives in.
 *
 * Unsupported syntax throws rather than being approximated. An oracle that
 * guesses at input it does not understand is an oracle that passes for the
 * wrong reason.
 */

import { readFileSync } from "node:fs";

export type Rgb = readonly [number, number, number];
export interface Rgba {
    readonly rgb: Rgb;
    /** 0 = fully transparent, 1 = opaque. */
    readonly alpha: number;
}

/** Reads the `--vscode-*` custom properties out of a captured host fixture. */
export function readFixtureVariables(fixturePath: string): Map<string, string> {
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
        documentElement?: { styleCssText?: string };
    };
    const cssText = fixture.documentElement?.styleCssText;
    if (!cssText) {
        throw new Error(
            `${fixturePath} has no documentElement.styleCssText to read variables from`,
        );
    }
    const variables = new Map<string, string>();
    for (const match of cssText.matchAll(/(--[a-zA-Z0-9\\.-]+):\s*([^;]+);/g)) {
        variables.set(match[1].replace(/\\/g, ""), match[2].trim());
    }
    return variables;
}

function parseLiteral(value: string): Rgba {
    const trimmed = value.trim();
    if (trimmed.toLowerCase() === "transparent") {
        return { rgb: [0, 0, 0], alpha: 0 };
    }

    const hex = /^#([0-9a-f]{3,8})$/i.exec(trimmed);
    if (hex && [3, 4, 6, 8].includes(hex[1].length)) {
        const digits =
            hex[1].length <= 4
                ? hex[1]
                      .split("")
                      .map((c) => c + c)
                      .join("")
                : hex[1];
        const channel = (index: number): number =>
            Number.parseInt(digits.slice(index * 2, index * 2 + 2), 16);
        return {
            rgb: [channel(0), channel(1), channel(2)],
            alpha: digits.length === 8 ? channel(3) / 255 : 1,
        };
    }

    const functional = /^rgba?\(([^)]+)\)$/i.exec(trimmed);
    if (functional) {
        // Percentages mean different things on the two channel kinds -- 100% is 255
        // for r/g/b but 1 for alpha -- so each token keeps its own "was this a %"
        // flag instead of being collapsed to a plain number before that is decided.
        const tokens = functional[1]
            .split(/[,/]/)
            .flatMap((part) => part.trim().split(/\s+/))
            .filter((part) => part.length > 0)
            .map((part) => ({ value: Number.parseFloat(part), isPercent: part.endsWith("%") }));
        if (
            tokens.length >= 3 &&
            tokens.slice(0, 3).every((token) => Number.isFinite(token.value))
        ) {
            const channel = (token: { value: number; isPercent: boolean }): number =>
                token.isPercent ? (token.value * 255) / 100 : token.value;
            return {
                rgb: [
                    Math.round(channel(tokens[0])),
                    Math.round(channel(tokens[1])),
                    Math.round(channel(tokens[2])),
                ],
                alpha:
                    tokens.length > 3 && Number.isFinite(tokens[3].value)
                        ? tokens[3].isPercent
                            ? tokens[3].value / 100
                            : tokens[3].value
                        : 1,
            };
        }
    }

    throw new Error(`cannot parse colour literal: ${value}`);
}

/**
 * Splits on top-level commas only, so a nested `var(--x, #fff)` inside a
 * `color-mix(...)` argument list is not torn in half at its own fallback comma.
 */
function splitTopLevel(input: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let current = "";
    for (const char of input) {
        if (char === "(") depth += 1;
        if (char === ")") depth -= 1;
        if (char === "," && depth === 0) {
            parts.push(current.trim());
            current = "";
            continue;
        }
        current += char;
    }
    if (current.trim()) parts.push(current.trim());
    return parts;
}

/** Resolves an expression to a colour that may carry alpha. */
export function resolveRgba(expression: string, variables: Map<string, string>): Rgba {
    const trimmed = expression.trim();

    const varMatch = /^var\(\s*(--[^,)]+?)\s*(?:,([\s\S]+))?\)$/.exec(trimmed);
    if (varMatch) {
        const declared = variables.get(varMatch[1].trim());
        if (declared !== undefined) return resolveRgba(declared, variables);
        if (varMatch[2] === undefined) {
            throw new Error(`${varMatch[1]} is undefined in this fixture and has no fallback`);
        }
        return resolveRgba(varMatch[2], variables);
    }

    const mixMatch = /^color-mix\(\s*in\s+srgb\s*,([\s\S]+)\)$/i.exec(trimmed);
    if (mixMatch) {
        const args = splitTopLevel(mixMatch[1]);
        if (args.length !== 2) {
            throw new Error(`color-mix with ${args.length} arguments is not supported: ${trimmed}`);
        }
        const parsed = args.map((arg) => {
            const percent = /\s([0-9.]+)%$/.exec(arg);
            return {
                color: percent ? arg.slice(0, percent.index).trim() : arg,
                weight: percent ? Number.parseFloat(percent[1]) / 100 : undefined,
            };
        });
        let weightA: number;
        let weightB: number;
        // Only the both-given-and-undersubscribed branch below moves this off 1.
        let alphaMultiplier = 1;
        if (parsed[0].weight !== undefined && parsed[1].weight !== undefined) {
            const sum = parsed[0].weight + parsed[1].weight;
            if (sum === 0) {
                throw new Error(`color-mix weights sum to 0%, which is not valid CSS: ${trimmed}`);
            }
            // Two explicit weights are both honoured by normalizing their ratio,
            // rather than letting the second one silently lose to the first. A
            // combined weight under 100% is topped up with implicit `transparent`,
            // which is why it also scales the mixed alpha down below.
            weightA = parsed[0].weight / sum;
            weightB = parsed[1].weight / sum;
            if (sum < 1) alphaMultiplier = sum;
        } else {
            weightA =
                parsed[0].weight ?? (parsed[1].weight !== undefined ? 1 - parsed[1].weight : 0.5);
            weightB = 1 - weightA;
        }
        const a = resolveRgba(parsed[0].color, variables);
        const b = resolveRgba(parsed[1].color, variables);

        // color-mix interpolates PREMULTIPLIED channels, which is why mixing an
        // opaque colour with `transparent` keeps the colour and only drops the
        // alpha. Averaging the raw channels instead would drag every tint toward
        // black and make a translucent overlay measure far darker than it paints.
        const mixedAlpha = a.alpha * weightA + b.alpha * weightB;
        const alpha = mixedAlpha * alphaMultiplier;
        if (mixedAlpha === 0) return { rgb: [0, 0, 0], alpha: 0 };
        const rgb = [0, 1, 2].map((i) =>
            Math.round((a.rgb[i] * a.alpha * weightA + b.rgb[i] * b.alpha * weightB) / mixedAlpha),
        ) as unknown as Rgb;
        return { rgb, alpha };
    }

    return parseLiteral(trimmed);
}

/**
 * Resolves an expression that must be fully opaque.
 *
 * Fails closed on translucency: a token that quietly became a fade would
 * otherwise be measured as if it were solid, and every ratio computed from it
 * would be wrong in the safe-looking direction.
 */
export function resolveColor(expression: string, variables: Map<string, string>): Rgb {
    const resolved = resolveRgba(expression, variables);
    if (resolved.alpha !== 1) {
        throw new Error(
            `${expression} resolves to alpha ${resolved.alpha}; composite it over a backdrop instead of treating it as opaque`,
        );
    }
    return resolved.rgb;
}

/** Paints `layer` over an opaque `backdrop` and returns the opaque result. */
export function compositeOver(layer: Rgba, backdrop: Rgb): Rgb {
    return [0, 1, 2].map((i) =>
        Math.round(layer.rgb[i] * layer.alpha + backdrop[i] * (1 - layer.alpha)),
    ) as unknown as Rgb;
}

function channelLuminance(value: number): number {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(rgb: Rgb): number {
    const [r, g, b] = rgb.map(channelLuminance);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio, 1:1 to 21:1. */
export function contrastRatio(a: Rgb, b: Rgb): number {
    const [la, lb] = [relativeLuminance(a), relativeLuminance(b)];
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** HSL hue and saturation -- saturation is the "how colourful is it" channel. */
export function hueAndSaturation(rgb: Rgb): { hue: number; saturation: number } {
    const [r, g, b] = rgb.map((c) => c / 255);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const lightness = (max + min) / 2;
    const delta = max - min;
    if (delta === 0) return { hue: 0, saturation: 0 };
    const saturation = delta / (1 - Math.abs(2 * lightness - 1));
    let hue: number;
    if (max === r) hue = ((g - b) / delta) % 6;
    else if (max === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;
    hue *= 60;
    return { hue: hue < 0 ? hue + 360 : hue, saturation };
}

/** Shortest distance between two hues on the colour wheel, in degrees. */
export function hueDistance(a: number, b: number): number {
    const raw = Math.abs(a - b);
    return Math.min(raw, 360 - raw);
}
