// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { buildVerticalLayout } from "../../../src/webviews/react/diff-core/mergeScrollLayout";
import {
    alignScrollOverlays,
    applyPaneOffsets,
    paneOffsetsForCanonical,
    syncHorizontalScroll,
    updateSharedScrollbar,
} from "../../../src/webviews/react/diff-core/scrollSync";

function fakeElement(overrides: Partial<HTMLElement> = {}): HTMLElement {
    return {
        clientWidth: 100,
        scrollWidth: 300,
        scrollLeft: 0,
        style: { transform: "", width: "" },
        querySelectorAll: () => [],
        ...overrides,
    } as unknown as HTMLElement;
}

describe("diff-core scroll synchronization", () => {
    it("computes pane offsets in canonical space", () => {
        const paneIds = ["left", "right"] as const;
        const layout = buildVerticalLayout(
            [{ paneLines: { left: 1, right: 3 }, conflict: false }],
            paneIds,
        );

        // A third of the way through the only segment, so each pane has advanced a third of its
        // own height: the tall side 20 of 60, the short side 6.67 of 20. The short side used to
        // read 0 here, clamped flat by a cap of `height - viewportH` that a one-line pane in a
        // 20px viewport reduces to nothing — the pane simply refused to move.
        const offsets = paneOffsetsForCanonical(layout, paneIds, 20);
        expect(offsets.right).toBe(20);
        expect(offsets.left).toBeCloseTo(20 / 3, 6);
    });

    it("applies translated offsets to every mounted pane", () => {
        const columns = { left: fakeElement(), right: fakeElement() };

        applyPaneOffsets(["left", "right"] as const, (pane) => columns[pane], {
            left: 12,
            right: 24,
        });

        expect(columns.left.style.transform).toBe("translateY(-12px)");
        expect(columns.right.style.transform).toBe("translateY(-24px)");
    });

    it("coalesces horizontal scrolling and clamps each pane", () => {
        vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
            callback(0);
            return 1;
        });
        const left = fakeElement({ clientWidth: 100, scrollWidth: 150 });
        const right = fakeElement({ clientWidth: 100, scrollWidth: 300 });
        const shared = fakeElement({ clientWidth: 100, scrollWidth: 300 });
        const state = { raf: 0, left: 0 };

        syncHorizontalScroll(
            ["left", "right"] as const,
            (pane) => (pane === "left" ? [left] : [right]),
            shared,
            state,
            180,
        );

        expect(left.scrollLeft).toBe(50);
        expect(right.scrollLeft).toBe(180);
        expect(shared.scrollLeft).toBe(180);
    });

    it("carries an overlay's unreachable scroll as a translation", () => {
        // The pane scrollers above clamp to their own content, which is correct for them: every
        // `.code-lines` track is sized to the widest line in the view, so they all arrive at the
        // same place. An overlaid textarea's extent is only its own longest line, so it stops
        // short -- and a text layer that stopped short puts the caret on a different character
        // than the glyph under the pointer.
        const stuck = fakeElement({ scrollLeft: 0 });
        const partly = fakeElement({ scrollLeft: 120 });

        alignScrollOverlays([stuck, partly], 180);

        expect(stuck.style.transform, "an overlay that could not scroll at all").toBe(
            "translateX(-180px)",
        );
        expect(partly.style.transform, "one that got part of the way").toBe("translateX(-60px)");
    });

    it("leaves an overlay that reached the position untransformed", () => {
        // Stated separately because it is the branch that keeps the two mechanisms from
        // fighting: when the browser scrolls the textarea itself to follow a caret, the sync
        // that follows must not then translate it back off its own scroll position.
        const reached = fakeElement({ scrollLeft: 180 });
        reached.style.transform = "translateX(-40px)";

        alignScrollOverlays([reached], 180);

        expect(reached.style.transform, "no shortfall left to carry").toBe("");
    });

    it("re-shows a shared scrollbar it hid earlier once the content outgrows the pane", () => {
        // `hidden` is `display: none`, so a hidden bar and its inner both measure zero -- which
        // computes a zero scroll range, which hides it again. The state latches: a view whose
        // lines all fit when it mounted could never grow a scrollbar afterwards. Reachable as
        // soon as the extent can change after mount, which an open editing draft does by
        // contributing its own longest line.
        const shared = fakeElement({ hidden: true } as Partial<HTMLElement>);
        Object.defineProperty(shared, "clientWidth", { get: () => (shared.hidden ? 0 : 100) });
        const inner = fakeElement();
        Object.defineProperty(inner, "offsetWidth", { get: () => (shared.hidden ? 0 : 1040) });

        updateSharedScrollbar(
            ["left"] as const,
            () => fakeElement({ querySelectorAll: () => [fakeElement({ clientWidth: 100 })] }),
            shared,
            inner,
            120,
            18,
            { current: 100 },
            0,
            vi.fn(),
        );

        expect(shared.hidden, "the bar the widened content now needs").toBe(false);
    });

    it("uses the last pane width when every layout is skipped", () => {
        const shared = fakeElement({ clientWidth: 100 });
        const inner = fakeElement({ offsetWidth: 260 } as Partial<HTMLElement>);
        const skippedCodeLines = fakeElement({ clientWidth: 0 });
        const column = fakeElement({
            querySelectorAll: () => [skippedCodeLines],
        });
        const lastPaneClientWidth = { current: 77 };
        const syncToLeft = vi.fn();

        updateSharedScrollbar(
            ["left"] as const,
            () => column,
            shared,
            inner,
            20,
            18,
            lastPaneClientWidth,
            200,
            syncToLeft,
        );

        expect(inner.style.width).toBe("calc(100% + 20ch + 18px - 77px)");
        expect(lastPaneClientWidth.current).toBe(77);
        expect(syncToLeft).toHaveBeenCalledWith(160);
    });
});
