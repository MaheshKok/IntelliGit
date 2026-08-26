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
): Record<Pane, number> {
    return Object.fromEntries(
        paneIds.map((pane) => [pane, paneOffsetForCanonical(layout, pane, canonicalScroll)]),
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
 * Keeps a text layer that floats over a code plane level with the glyphs beneath it.
 *
 * `syncHorizontalScroll` clamps every scroller to its own content, which is the right thing for
 * panes -- each `.code-lines` track is sized to the widest line in the view, so they all reach
 * the same position. An overlaid `<textarea>` cannot: its scroll extent is only its own longest
 * line, so it stops short and the invisible text it holds stops lining up with the code it is
 * supposed to be sitting on. A caret then lands on a different character than the one under the
 * pointer -- measured at 400px, five characters, on a diff with one long line elsewhere.
 *
 * The part of the position the overlay could not scroll to is carried as a translation instead.
 * When it *can* reach the position -- a long draft line, or the browser scrolling the caret back
 * into view -- the shortfall is zero and no transform is applied at all, leaving the native
 * scroll to do the work and keeping the two mechanisms from fighting.
 */
export function alignScrollOverlays(overlays: Iterable<HTMLElement>, left: number): void {
    for (const overlay of overlays) {
        const shortfall = overlay.scrollLeft - left;
        overlay.style.transform = shortfall === 0 ? "" : `translateX(${shortfall}px)`;
    }
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
    // Un-hide before measuring, every time. `hidden` is `display: none`, so a bar hidden by an
    // earlier call reports a zero-width box AND a zero-width inner -- which computes a zero
    // scroll range, which hides it again. The state latches: once a view has no overflow, no
    // later widening can ever bring the bar back. Reachable as soon as the extent can grow
    // after mount, which an open editing draft does.
    sharedBar.hidden = false;
    const maxScroll = Math.max(0, sharedInner.offsetWidth - sharedBar.clientWidth);
    sharedBar.hidden = maxScroll < 1;
    if (currentLeft > maxScroll) syncToLeft(maxScroll);
}
