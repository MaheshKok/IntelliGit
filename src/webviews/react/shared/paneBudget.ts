/** Describes a pane's usable minimum and preferred render width. */
export interface PaneSpec {
    readonly key: string;
    /** Width below which this pane is not usable and should be dropped instead. */
    readonly min: number;
    /** Width this pane wants when there is room. */
    readonly preferred: number;
}

/** Contains the widths of visible panes and the panes removed to fit the budget. */
export interface PaneBudget {
    /** Visible panes only, keyed as in the input. Hidden panes are absent. */
    readonly widths: Readonly<Record<string, number>>;
    /** Panes dropped because the viewport could not seat them, in the order dropped. */
    readonly hidden: readonly string[];
}

interface NormalizedPane extends PaneSpec {
    readonly min: number;
    readonly preferred: number;
}

function finiteNonNegative(value: number): number {
    return Number.isFinite(value) && value > 0 ? value : 0;
}

function normalizePanes(panes: readonly PaneSpec[]): NormalizedPane[] {
    const seen = new Set<string>();
    const normalized: NormalizedPane[] = [];
    for (const pane of panes) {
        if (seen.has(pane.key)) continue;
        seen.add(pane.key);
        const min = finiteNonNegative(pane.min);
        normalized.push({
            key: pane.key,
            min,
            preferred: Math.max(min, finiteNonNegative(pane.preferred)),
        });
    }
    return normalized;
}

function sumWidths(
    panes: readonly NormalizedPane[],
    width: (pane: NormalizedPane) => number,
): number {
    return panes.reduce((total, pane) => total + width(pane), 0);
}

function allocateWidths(panes: readonly NormalizedPane[], target: number): Record<string, number> {
    const widths: Record<string, number> = {};
    const preferredTotal = sumWidths(panes, (pane) => pane.preferred);
    if (preferredTotal === 0) {
        const equalWidth = target / panes.length;
        for (const pane of panes) widths[pane.key] = equalWidth;
        return widths;
    }

    if (target >= preferredTotal) {
        const scale = target / preferredTotal;
        for (const pane of panes) widths[pane.key] = pane.preferred * scale;
        return widths;
    }

    const fixed = new Map<string, number>();
    let active = [...panes];
    while (active.length > 0) {
        const fixedTotal = [...fixed.values()].reduce((total, width) => total + width, 0);
        const activePreferred = sumWidths(active, (pane) => pane.preferred);
        const scale = activePreferred === 0 ? 0 : (target - fixedTotal) / activePreferred;
        const constrained = active.filter((pane) => pane.preferred * scale < pane.min);
        if (constrained.length === 0) {
            for (const pane of active) widths[pane.key] = pane.preferred * scale;
            break;
        }
        for (const pane of constrained) {
            widths[pane.key] = pane.min;
            fixed.set(pane.key, pane.min);
        }
        active = active.filter((pane) => !fixed.has(pane.key));
    }

    return widths;
}

function dividerTotal(count: number, dividerWidth: number): number {
    return Math.max(0, count - 1) * dividerWidth;
}

function pickHighestPriority(
    panes: readonly NormalizedPane[],
    dropOrder: readonly string[],
): NormalizedPane {
    const order = new Set(dropOrder);
    const nonDroppable = panes.filter((pane) => !order.has(pane.key));
    if (nonDroppable.length > 0) return nonDroppable[nonDroppable.length - 1];
    for (let index = dropOrder.length - 1; index >= 0; index -= 1) {
        // "As your list grows" does not apply: panes are a compile-time constant set, 3 in
        // CommitGraphPanel and 5 in SECTION_WIDTH_KEYS, and nothing appends at runtime. A Map
        // here would cost more to build than the scan it replaces.
        // react-doctor-disable-next-line react-doctor/js-index-maps
        const pane = panes.find((candidate) => candidate.key === dropOrder[index]);
        if (pane) return pane;
    }
    return panes[panes.length - 1];
}

/** Resolves pane widths by squeezing to true minima before dropping panes by priority. */
export function resolvePaneBudget(
    available: number,
    panes: readonly PaneSpec[],
    dropOrder: readonly string[],
    dividerWidth: number,
): PaneBudget {
    const normalizedPanes = normalizePanes(panes);
    if (normalizedPanes.length === 0) return { widths: {}, hidden: [] };
    const budget = finiteNonNegative(available);
    const divider = finiteNonNegative(dividerWidth);
    let visible = [...normalizedPanes];
    const hidden: string[] = [];
    const candidates = [...new Set(dropOrder)].filter((key) =>
        normalizedPanes.some((pane) => pane.key === key),
    );

    for (const key of candidates) {
        const minimumTotal =
            sumWidths(visible, (pane) => pane.min) + dividerTotal(visible.length, divider);
        if (minimumTotal <= budget || visible.length === 1) break;
        if (!visible.some((pane) => pane.key === key)) continue;
        hidden.push(key);
        visible = visible.filter((pane) => pane.key !== key);
    }

    const minimumTotal =
        sumWidths(visible, (pane) => pane.min) + dividerTotal(visible.length, divider);
    if (minimumTotal > budget) {
        const survivor = pickHighestPriority(visible, dropOrder);
        const finalWidths = { [survivor.key]: budget };
        const finalHidden = [...hidden];
        for (const pane of visible) if (pane.key !== survivor.key) finalHidden.push(pane.key);
        return { widths: finalWidths, hidden: finalHidden };
    }

    const widths = allocateWidths(visible, budget - dividerTotal(visible.length, divider));
    return { widths: { ...widths }, hidden: [...hidden] };
}
