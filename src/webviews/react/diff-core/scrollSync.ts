// Shared scroll drivers for pane-based diff surfaces.
// The merge editor supplies its ordered pane ids and remains responsible for
// merge-only ribbon drawing; this module owns the common DOM synchronization.

import { paneOffsetForCanonical, type DiffVerticalLayout, type PaneId } from "./mergeScrollLayout";

/** Mutable state used to coalesce horizontal scroll events into one frame. */
export interface HorizontalScrollState {
    raf: number;
    left: number;
}

/**
 * Computes every pane's translation from one canonical scroll position.
 * Iterating the ordered ids keeps the result independent of pane names.
 */
export function paneOffsetsForCanonical<Pane extends PaneId>(
    layout: DiffVerticalLayout<Pane>,
    paneIds: readonly Pane[],
    canonicalScroll: number,
    viewportH: number,
): Record<Pane, number> {
    return Object.fromEntries(
        paneIds.map((pane) => [
            pane,
            paneOffsetForCanonical(layout, pane, canonicalScroll, viewportH),
        ]),
    ) as Record<Pane, number>;
}

/** Applies canonical offsets to each pane column's transform. */
export function applyPaneOffsets<Pane extends PaneId>(
    paneIds: readonly Pane[],
    getColumn: (pane: Pane) => HTMLElement | null,
    offsets: Readonly<Record<Pane, number>>,
): void {
    for (const pane of paneIds) {
        const column = getColumn(pane);
        if (column) column.style.transform = `translateY(${-offsets[pane]}px)`;
    }
}

/**
 * Synchronizes all pane code-line scrollers and the shared scrollbar. The
 * caller supplies each pane's code-line elements so differing pane DOM shapes
 * remain outside the generic driver.
 */
export function syncHorizontalScroll<Pane extends PaneId>(
    paneIds: readonly Pane[],
    getCodeLines: (pane: Pane) => Iterable<HTMLElement>,
    sharedBar: HTMLElement | null,
    state: HorizontalScrollState,
    left: number,
    source?: HTMLElement | null,
): void {
    state.left = left;
    if (state.raf) return;
    state.raf = requestAnimationFrame(() => {
        state.raf = 0;
        const targetLeft = state.left;
        for (const paneId of paneIds) {
            for (const pane of getCodeLines(paneId)) {
                if (pane === source) continue;
                const max = Math.max(0, pane.scrollWidth - pane.clientWidth);
                const paneLeft = Math.min(targetLeft, max);
                if (Math.abs(pane.scrollLeft - paneLeft) >= 1) pane.scrollLeft = paneLeft;
            }
        }
        if (sharedBar && sharedBar !== source && Math.abs(sharedBar.scrollLeft - targetLeft) >= 1) {
            sharedBar.scrollLeft = targetLeft;
        }
    });
}

/**
 * Sizes and exposes the synthetic shared horizontal scrollbar from the widest
 * line and the narrowest mounted pane, preserving the old skipped-layout
 * fallback when content-visibility reports no client width.
 */
export function updateSharedScrollbar<Pane extends PaneId>(
    paneIds: readonly Pane[],
    getColumn: (pane: Pane) => HTMLElement | null,
    sharedBar: HTMLElement | null,
    sharedInner: HTMLElement | null,
    maxLineLength: number,
    linePaddingPx: number,
    lastPaneClientWidth: { current: number },
    currentLeft: number,
    syncToLeft: (left: number) => void,
): void {
    if (!sharedBar || !sharedInner) return;
    let minClientWidth = Infinity;
    for (const paneId of paneIds) {
        const column = getColumn(paneId);
        if (!column) continue;
        for (const pane of column.querySelectorAll<HTMLElement>(".code-lines")) {
            if (pane.clientWidth > 0) {
                minClientWidth = Math.min(minClientWidth, pane.clientWidth);
                break;
            }
        }
    }
    if (minClientWidth === Infinity) {
        minClientWidth = lastPaneClientWidth.current;
    } else {
        lastPaneClientWidth.current = minClientWidth;
    }
    sharedInner.style.width = `calc(100% + ${maxLineLength}ch + ${linePaddingPx}px - ${minClientWidth}px)`;
    const maxScroll = Math.max(0, sharedInner.offsetWidth - sharedBar.clientWidth);
    sharedBar.hidden = maxScroll < 1;
    if (currentLeft > maxScroll) syncToLeft(maxScroll);
}
