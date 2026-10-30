import type { BlameLine } from "../git/blame";

/** The oldest and newest committed author timestamps in one displayed file. */
export interface BlameAgeRange {
    readonly oldest: number;
    readonly newest: number;
}

interface AnnotationColors {
    readonly backgroundColor: string;
    readonly color: string;
}

const EDITOR_BACKGROUND = "var(--vscode-editor-background)";
const RECENT_BACKGROUND = "#83bf54";

/** Zero hashes have a synthetic wall clock, not a committed age. */
function committedTime(line: BlameLine): number | undefined {
    return !/^0+$/.test(line.commit) &&
        Number.isFinite(line.authorTime) &&
        Number.isFinite(new Date(line.authorTime * 1000).getTime())
        ? line.authorTime
        : undefined;
}

/** Uses the file's committed history, never today's clock or unsaved pseudo-commits. */
export function blameAgeRange(lines: readonly BlameLine[]): BlameAgeRange | undefined {
    let oldest = Infinity;
    let newest = -Infinity;
    for (const line of lines) {
        const time = committedTime(line);
        if (time === undefined) continue;
        oldest = Math.min(oldest, time);
        newest = Math.max(newest, time);
    }
    return oldest === Infinity ? undefined : { oldest, newest };
}

/** Reads the resolved background's linear luminance, including live theme customizations. */
function contrastingText(background: string): string {
    // Black and white meet at WCAG luminance ~0.179; round makes the choice discrete.
    const white = "clamp(0, round(up, calc(0.179 - y), 1), 1)";
    return `color(from ${background} xyz-d65 calc(${white} * 0.9504559271) ${white} calc(${white} * 1.0890577508) / 1)`;
}

// A fixed 101-step palette bounds native style variants even for large blame results.
const PALETTE: readonly AnnotationColors[] = Array.from({ length: 101 }, (_, percent) => {
    const backgroundColor =
        percent === 0
            ? EDITOR_BACKGROUND
            : percent === 100
              ? RECENT_BACKGROUND
              : `color-mix(in srgb, ${RECENT_BACKGROUND} ${percent}%, ${EDITOR_BACKGROUND})`;
    return Object.freeze({
        backgroundColor,
        color:
            percent === 0
                ? "var(--vscode-descriptionForeground)"
                : percent === 100
                  ? "#000000"
                  : contrastingText(backgroundColor),
    });
});

/** Equal timestamps share a shade; a single-age file is entirely the newest green. */
export function blameAnnotationColors(
    line: BlameLine,
    range: BlameAgeRange | undefined,
): AnnotationColors | undefined {
    const time = committedTime(line);
    if (time === undefined || !range) return undefined;
    const position =
        range.newest === range.oldest
            ? 100
            : Math.round((100 * (time - range.oldest)) / (range.newest - range.oldest));
    return PALETTE[Math.max(0, Math.min(100, position))];
}
