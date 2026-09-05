import { resolvePaneBudget, type PaneBudget } from "../shared/paneBudget";

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

/** Lowest-priority undocked panes, in the order they are dropped under pressure. */
const SECTION_DROP_ORDER: readonly SectionWidthKey[] = [
    "infoWidth",
    "repositoryWidth",
    "branchWidth",
    "commitPanelWidth",
];

/** Render-time widths; hidden panes are absent rather than represented by zero. */
export interface SectionLayout {
    readonly widths: Readonly<Partial<Record<SectionWidthKey, number>>>;
    readonly hidden: readonly SectionWidthKey[];
}

/**
 * Computes preferred pane widths after reserving space for four dividers.
 *
 * Supporting panes keep their readable preferred widths while the graph receives
 * the remaining space. The existing budget resolver still enforces minimums,
 * dropping panes in its established order when this preference does not fit.
 */
export function computeDefaultSectionWidths(totalWidth?: number): SectionWidths {
    if (typeof window === "undefined" && typeof totalWidth !== "number") {
        return fallbackSectionWidths();
    }

    const available = getAvailableSectionWidth(totalWidth);
    if (available <= 0) {
        return fallbackSectionWidths();
    }

    const repositoryWidth = DEFAULT_REPOSITORY_WIDTH;
    const branchWidth = 220;
    const infoWidth = 220;
    const commitPanelWidth = 260;
    // Preserve history emphasis when a narrow first render later widens. The budget
    // resolver projects these preferences into the currently available space.
    const graphWidth = Math.max(
        316,
        available - repositoryWidth - branchWidth - infoWidth - commitPanelWidth,
    );
    return {
        repositoryWidth,
        branchWidth,
        graphWidth,
        infoWidth,
        commitPanelWidth,
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

/** Returns the full container budget; the shared resolver subtracts visible dividers. */
function getTotalSectionWidth(totalWidth?: number): number {
    if (typeof totalWidth === "number") return Math.max(0, totalWidth);
    if (typeof window === "undefined") return SECTION_COUNT * FALLBACK_SECTION_WIDTH;
    return Math.max(0, window.innerWidth);
}

/** Sums every resizable pane width, excluding the fixed divider pixels. */
function sumWidths(widths: SectionWidths): number {
    return SECTION_WIDTH_KEYS.reduce((total, key) => total + widths[key], 0);
}

/** Returns a pane's true usable minimum. */
export function baseMinimumWidth(key: SectionWidthKey): number {
    return key === "repositoryWidth" ? MIN_REPOSITORY_WIDTH : MIN_SECTION_WIDTH;
}

/** Builds the fixed minimum map consumed by the shared pane-budget resolver. */
function sectionMinimums(): Record<SectionWidthKey, number> {
    return SECTION_WIDTH_KEYS.reduce(
        (minimums, key) => {
            minimums[key] = baseMinimumWidth(key);
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

function sectionLayoutFromBudget(budget: PaneBudget): SectionLayout {
    const visibleWidths = SECTION_WIDTH_KEYS.reduce(
        (next, key) => {
            const width = budget.widths[key];
            if (typeof width === "number") next[key] = width;
            return next;
        },
        {} as Partial<Record<SectionWidthKey, number>>,
    );
    return {
        widths: visibleWidths,
        hidden: budget.hidden as SectionWidthKey[],
    };
}

/** Projects persisted preferences into a usable, possibly hidden render layout. */
export function normalizeSectionWidths(widths: SectionWidths, totalWidth?: number): SectionLayout {
    const available = getTotalSectionWidth(totalWidth);
    const preferred = sumWidths(widths) > 0 ? widths : computeDefaultSectionWidths(totalWidth);
    const minimums = sectionMinimums();
    const budget = resolvePaneBudget(
        available,
        SECTION_WIDTH_KEYS.map((key) => ({
            key,
            min: minimums[key],
            preferred: preferred[key],
        })),
        SECTION_DROP_ORDER,
        DIVIDER_WIDTH,
    );
    return sectionLayoutFromBudget(budget);
}

/** Compares pane widths with a sub-pixel tolerance to avoid resize loops. */
export function sectionWidthsAreClose(a: SectionWidths, b: SectionWidths): boolean {
    return SECTION_WIDTH_KEYS.every((key) => Math.abs(a[key] - b[key]) < 0.5);
}
