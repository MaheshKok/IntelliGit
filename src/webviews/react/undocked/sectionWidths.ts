const FALLBACK_SECTION_WIDTH = 300;
const DEFAULT_REPOSITORY_WIDTH = 168;
const DIVIDER_WIDTH = 4;
const SECTION_COUNT = 5;
const TOTAL_DIVIDER_WIDTH = (SECTION_COUNT - 1) * DIVIDER_WIDTH;
const SECTION_WIDTH_KEYS = [
    "repositoryWidth",
    "branchWidth",
    "graphWidth",
    "infoWidth",
    "commitPanelWidth",
] as const;

/** Minimum preferred width for each main undocked section before proportional shrinking. */
const MIN_SECTION_WIDTH = 220;
/** Minimum usable width for the repository/worktree selector. */
const MIN_REPOSITORY_WIDTH = 120;

/** Widths for the five resizable undocked sections, excluding divider pixels. */
export interface SectionWidths {
    repositoryWidth: number;
    branchWidth: number;
    graphWidth: number;
    infoWidth: number;
    commitPanelWidth: number;
}

/** Keys that may participate in a paired undocked divider drag. */
export type SectionWidthKey = (typeof SECTION_WIDTH_KEYS)[number];

/**
 * Computes the default repository selector plus equal widths for the four main
 * sections after subtracting the four divider pixels from the supplied total.
 */
export function computeEqualSectionWidths(totalWidth?: number): SectionWidths {
    if (typeof window === "undefined" && typeof totalWidth !== "number") {
        return fallbackSectionWidths();
    }

    const available = getAvailableSectionWidth(totalWidth);
    if (available <= 0) {
        return fallbackSectionWidths();
    }

    const repositoryWidth = Math.min(DEFAULT_REPOSITORY_WIDTH, available / SECTION_COUNT);
    const equalWidth = Math.max(0, (available - repositoryWidth) / (SECTION_COUNT - 1));
    return {
        repositoryWidth,
        branchWidth: equalWidth,
        graphWidth: equalWidth,
        infoWidth: equalWidth,
        commitPanelWidth: equalWidth,
    };
}

/** Returns a server-safe layout when no browser viewport is available. */
function fallbackSectionWidths(): SectionWidths {
    return {
        repositoryWidth: DEFAULT_REPOSITORY_WIDTH,
        branchWidth: FALLBACK_SECTION_WIDTH,
        graphWidth: FALLBACK_SECTION_WIDTH,
        infoWidth: FALLBACK_SECTION_WIDTH,
        commitPanelWidth: FALLBACK_SECTION_WIDTH,
    };
}

/** Returns the layout space remaining after all fixed-width dividers. */
function getAvailableSectionWidth(totalWidth?: number): number {
    if (typeof totalWidth === "number") return Math.max(0, totalWidth - TOTAL_DIVIDER_WIDTH);
    if (typeof window === "undefined") {
        return SECTION_COUNT * FALLBACK_SECTION_WIDTH - TOTAL_DIVIDER_WIDTH;
    }
    const containerWidth = window.innerWidth;
    return Math.max(0, containerWidth - TOTAL_DIVIDER_WIDTH);
}

/** Sums every resizable pane width, excluding the fixed divider pixels. */
function sumWidths(widths: SectionWidths): number {
    return SECTION_WIDTH_KEYS.reduce((total, key) => total + widths[key], 0);
}

/** Returns a pane's base minimum before it is scaled for a narrow viewport. */
export function baseMinimumWidth(key: SectionWidthKey): number {
    return key === "repositoryWidth" ? MIN_REPOSITORY_WIDTH : MIN_SECTION_WIDTH;
}

/**
 * Scales the five unequal pane minima just enough to fit a narrow viewport.
 * Keeping the repository minimum independent prevents a first drag from
 * forcing it to the 220px main-pane minimum.
 */
function sectionMinimums(available: number): Record<SectionWidthKey, number> {
    const minimumTotal = SECTION_WIDTH_KEYS.reduce(
        (total, key) => total + baseMinimumWidth(key),
        0,
    );
    const scale = Math.min(1, available / minimumTotal);
    return SECTION_WIDTH_KEYS.reduce(
        (minimums, key) => {
            minimums[key] = baseMinimumWidth(key) * scale;
            return minimums;
        },
        {} as Record<SectionWidthKey, number>,
    );
}

/**
 * Parses persisted section widths, accepting legacy states that predate a
 * separate graph width or repository width by applying compatible defaults.
 */
export function migrateSectionWidths(value: unknown): SectionWidths | undefined {
    if (!value || typeof value !== "object") return undefined;
    const record = value as Record<string, unknown>;
    const repositoryWidth = record.repositoryWidth;
    const branchWidth = record.branchWidth;
    const graphWidth = record.graphWidth;
    const infoWidth = record.infoWidth;
    const commitPanelWidth = record.commitPanelWidth;

    if (
        typeof branchWidth !== "number" ||
        !Number.isFinite(branchWidth) ||
        typeof infoWidth !== "number" ||
        !Number.isFinite(infoWidth) ||
        typeof commitPanelWidth !== "number" ||
        !Number.isFinite(commitPanelWidth)
    ) {
        return undefined;
    }

    return {
        repositoryWidth:
            typeof repositoryWidth === "number" && Number.isFinite(repositoryWidth)
                ? repositoryWidth
                : DEFAULT_REPOSITORY_WIDTH,
        branchWidth,
        graphWidth:
            typeof graphWidth === "number" && Number.isFinite(graphWidth) ? graphWidth : infoWidth,
        infoWidth,
        commitPanelWidth,
    };
}

/**
 * Scales section widths to the available viewport while preserving proportions
 * and enforcing the largest possible per-pane minimum, including the smaller
 * repository-selector minimum.
 */
export function normalizeSectionWidths(widths: SectionWidths, totalWidth?: number): SectionWidths {
    const available = getAvailableSectionWidth(totalWidth);
    if (available <= 0) return computeEqualSectionWidths(totalWidth);

    const rawTotal = sumWidths(widths);
    if (rawTotal <= 0) return computeEqualSectionWidths(totalWidth);

    const minimums = sectionMinimums(available);
    let normalized = SECTION_WIDTH_KEYS.reduce((next, key) => {
        next[key] = Math.max(minimums[key], widths[key] * (available / rawTotal));
        return next;
    }, {} as SectionWidths);

    const overflow = sumWidths(normalized) - available;
    if (overflow <= 0.01) return normalized;

    const reducible = SECTION_WIDTH_KEYS.reduce(
        (total, key) => total + Math.max(0, normalized[key] - minimums[key]),
        0,
    );
    if (reducible <= 0) return computeEqualSectionWidths(totalWidth);

    normalized = SECTION_WIDTH_KEYS.reduce(
        (next, key) => {
            const excess = Math.max(0, normalized[key] - minimums[key]);
            next[key] = Math.max(minimums[key], normalized[key] - overflow * (excess / reducible));
            return next;
        },
        { ...normalized },
    );

    return normalized;
}

/** Compares pane widths with a sub-pixel tolerance to avoid resize loops. */
export function sectionWidthsAreClose(a: SectionWidths, b: SectionWidths): boolean {
    return SECTION_WIDTH_KEYS.every((key) => Math.abs(a[key] - b[key]) < 0.5);
}
