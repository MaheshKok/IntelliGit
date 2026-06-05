const FALLBACK_SECTION_WIDTH = 300;
const DIVIDER_WIDTH = 4;
const SECTION_COUNT = 4;
const TOTAL_DIVIDER_WIDTH = 3 * DIVIDER_WIDTH;
const SECTION_WIDTH_KEYS = ["branchWidth", "graphWidth", "infoWidth", "commitPanelWidth"] as const;

export const MIN_SECTION_WIDTH = 220;

export interface SectionWidths {
    branchWidth: number;
    graphWidth: number;
    infoWidth: number;
    commitPanelWidth: number;
}

export type SectionWidthKey = (typeof SECTION_WIDTH_KEYS)[number];

// Compute equal initial widths for all four sections from the viewport.
// Sections: Commit | Branches | Graph | Changes (Info)
// Three dividers (4px each) sit between the four sections.
export function computeEqualSectionWidths(totalWidth?: number): SectionWidths {
    if (typeof window === "undefined") {
        return fallbackSectionWidths();
    }

    const available = getAvailableSectionWidth(totalWidth);
    if (available <= 0) {
        return fallbackSectionWidths();
    }

    const equalWidth = available / SECTION_COUNT;
    return {
        branchWidth: equalWidth,
        graphWidth: equalWidth,
        infoWidth: equalWidth,
        commitPanelWidth: equalWidth,
    };
}

function fallbackSectionWidths(): SectionWidths {
    return {
        branchWidth: FALLBACK_SECTION_WIDTH,
        graphWidth: FALLBACK_SECTION_WIDTH,
        infoWidth: FALLBACK_SECTION_WIDTH,
        commitPanelWidth: FALLBACK_SECTION_WIDTH,
    };
}

function getAvailableSectionWidth(totalWidth?: number): number {
    if (typeof window === "undefined") return SECTION_COUNT * FALLBACK_SECTION_WIDTH;
    const containerWidth = typeof totalWidth === "number" ? totalWidth : window.innerWidth;
    return Math.max(0, containerWidth - TOTAL_DIVIDER_WIDTH);
}

function sumWidths(widths: SectionWidths): number {
    return SECTION_WIDTH_KEYS.reduce((total, key) => total + widths[key], 0);
}

export function migrateSectionWidths(value: unknown): SectionWidths | undefined {
    if (!value || typeof value !== "object") return undefined;
    const record = value as Record<string, unknown>;
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
        branchWidth,
        graphWidth:
            typeof graphWidth === "number" && Number.isFinite(graphWidth) ? graphWidth : infoWidth,
        infoWidth,
        commitPanelWidth,
    };
}

export function normalizeSectionWidths(widths: SectionWidths, totalWidth?: number): SectionWidths {
    const available = getAvailableSectionWidth(totalWidth);
    if (available <= 0) return computeEqualSectionWidths(totalWidth);

    const rawTotal = sumWidths(widths);
    if (rawTotal <= 0) return computeEqualSectionWidths(totalWidth);

    const sectionMin = Math.min(MIN_SECTION_WIDTH, available / SECTION_COUNT);
    let normalized: SectionWidths = {
        branchWidth: Math.max(sectionMin, widths.branchWidth * (available / rawTotal)),
        graphWidth: Math.max(sectionMin, widths.graphWidth * (available / rawTotal)),
        infoWidth: Math.max(sectionMin, widths.infoWidth * (available / rawTotal)),
        commitPanelWidth: Math.max(sectionMin, widths.commitPanelWidth * (available / rawTotal)),
    };

    const overflow = sumWidths(normalized) - available;
    if (overflow <= 0.01) return normalized;

    const reducible = SECTION_WIDTH_KEYS.reduce(
        (total, key) => total + Math.max(0, normalized[key] - sectionMin),
        0,
    );
    if (reducible <= 0) return computeEqualSectionWidths(totalWidth);

    normalized = SECTION_WIDTH_KEYS.reduce(
        (next, key) => {
            const excess = Math.max(0, normalized[key] - sectionMin);
            next[key] = Math.max(sectionMin, normalized[key] - overflow * (excess / reducible));
            return next;
        },
        { ...normalized },
    );

    return normalized;
}

export function sectionWidthsAreClose(a: SectionWidths, b: SectionWidths): boolean {
    return SECTION_WIDTH_KEYS.every((key) => Math.abs(a[key] - b[key]) < 0.5);
}
