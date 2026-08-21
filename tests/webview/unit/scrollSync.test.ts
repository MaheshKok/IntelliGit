// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { buildVerticalLayout } from "../../../src/webviews/react/diff-core/mergeScrollLayout";
import {
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

        expect(paneOffsetsForCanonical(layout, paneIds, 20, 20)).toEqual({ left: 0, right: 20 });
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
