export interface Rgba {
    readonly r: number;
    readonly g: number;
    readonly b: number;
    readonly a: number;
}

/** Composites `top` over `bottom` using the source-over alpha equation. */
export function compositeOver(top: Rgba, bottom: Rgba): Rgba {
    const outputAlpha = top.a + bottom.a * (1 - top.a);
    if (outputAlpha === 0) {
        return { r: 0, g: 0, b: 0, a: 0 };
    }

    return {
        r: (top.r * top.a + bottom.r * bottom.a * (1 - top.a)) / outputAlpha,
        g: (top.g * top.a + bottom.g * bottom.a * (1 - top.a)) / outputAlpha,
        b: (top.b * top.a + bottom.b * bottom.a * (1 - top.a)) / outputAlpha,
        a: outputAlpha,
    };
}

/** Flattens layers in painting order, where index zero is the bottom-most layer. */
export function flattenStack(layers: readonly Rgba[]): Rgba {
    return layers.reduce<Rgba>((flattened, layer) => compositeOver(layer, flattened), {
        r: 0,
        g: 0,
        b: 0,
        a: 0,
    });
}

function linearizeSrgbChannel(channel: number): number {
    const normalized = channel / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

/** Calculates WCAG 2.2 relative luminance from the colour's RGB channels. */
export function relativeLuminance(colour: Rgba): number {
    return (
        0.2126 * linearizeSrgbChannel(colour.r) +
        0.7152 * linearizeSrgbChannel(colour.g) +
        0.0722 * linearizeSrgbChannel(colour.b)
    );
}

/** Calculates the symmetric WCAG 2.2 contrast ratio for two colours. */
export function contrastRatio(a: Rgba, b: Rgba): number {
    const luminanceA = relativeLuminance(a);
    const luminanceB = relativeLuminance(b);
    const lighter = Math.max(luminanceA, luminanceB);
    const darker = Math.min(luminanceA, luminanceB);
    return (lighter + 0.05) / (darker + 0.05);
}

export type ContrastFailureKind = "below-floor" | "unresolved-background";

export interface ContrastSample {
    readonly id: string;
    readonly inactive: boolean;
    readonly foreground: Rgba;
    /** Background layers back-to-front; the element's own background is last. */
    readonly backgroundLayers: readonly Rgba[];
}

export interface ContrastViolation {
    readonly id: string;
    readonly kind: ContrastFailureKind;
    /** Undefined when the background never resolved to an opaque colour. */
    readonly ratio?: number;
}

/** Reports unresolved backgrounds and resolved foreground/background pairs below the given floor. */
export function findContrastViolations(
    samples: readonly ContrastSample[],
    floor: number,
): readonly ContrastViolation[] {
    const violations: ContrastViolation[] = [];

    samples.forEach((sample) => {
        if (sample.inactive) {
            return;
        }

        const background = flattenStack(sample.backgroundLayers);
        if (background.a < 1) {
            violations.push({ id: sample.id, kind: "unresolved-background" });
            return;
        }

        // The foreground is composited too, not scored at its declared colour. `relativeLuminance`
        // ignores alpha, so a semi-transparent foreground -- VS Code's `disabledForeground`, or any
        // rule setting `opacity` on secondary text -- would otherwise be measured as if it were
        // opaque and report a passing ratio for text that renders far below the floor. Flattening
        // only the background and not the foreground is the asymmetry that hides that false green.
        // An opaque foreground composites to itself, so this is a no-op for the common case.
        const foreground = compositeOver(sample.foreground, background);
        const ratio = contrastRatio(foreground, background);
        if (ratio < floor) {
            violations.push({ id: sample.id, kind: "below-floor", ratio });
        }
    });

    return violations;
}
