// Spec-derived tests for the commit-list metadata column resize model (issue #155).
// The drag handle sits on the LEFT edge of a right-aligned column, so moving the
// pointer left (negative delta) makes the column wider.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
    fitMetaColumnWidths,
    META_COLUMN_WIDTHS_STORAGE_KEY,
    MIN_META_COL_WIDTH,
    readStoredMetaColumnWidths,
    resizeMetaColumn,
} from "../../../src/webviews/react/commit-list/metaColumnResize";
import {
    DEFAULT_META_COLUMN_WIDTHS,
    visibleMetaColumns,
} from "../../../src/webviews/react/commit-list/styles";

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("resizeMetaColumn", () => {
    it("widens the column when the handle is dragged left", () => {
        expect(resizeMetaColumn(DEFAULT_META_COLUMN_WIDTHS, "author", -40, 1000, false)).toEqual({
            author: DEFAULT_META_COLUMN_WIDTHS.author + 40,
            date: DEFAULT_META_COLUMN_WIDTHS.date,
        });
    });

    it("narrows the date column when its handle is dragged right, leaving author alone", () => {
        expect(resizeMetaColumn(DEFAULT_META_COLUMN_WIDTHS, "date", 30, 1000, false)).toEqual({
            author: DEFAULT_META_COLUMN_WIDTHS.author,
            date: DEFAULT_META_COLUMN_WIDTHS.date - 30,
        });
    });

    it("never shrinks a column below the minimum width", () => {
        expect(
            resizeMetaColumn(DEFAULT_META_COLUMN_WIDTHS, "author", 5000, 1000, false).author,
        ).toBe(MIN_META_COL_WIDTH);
    });

    it("caps growth so both columns still fit beside the minimum message cell", () => {
        // Growing past this point would make visibleMetaColumns hide the column, taking
        // its own drag handle with it — the user could never shrink it back.
        const widths = resizeMetaColumn(DEFAULT_META_COLUMN_WIDTHS, "author", -5000, 500, false);
        expect(widths.author).toBeGreaterThan(DEFAULT_META_COLUMN_WIDTHS.author);
        expect(visibleMetaColumns(500, false, widths)).toEqual({ author: true, date: true });
        expect(visibleMetaColumns(499, false, widths)).toEqual({ author: true, date: false });
    });

    it("reserves the checks column in the growth cap", () => {
        const without = resizeMetaColumn(DEFAULT_META_COLUMN_WIDTHS, "date", -5000, 500, false);
        const withChecks = resizeMetaColumn(DEFAULT_META_COLUMN_WIDTHS, "date", -5000, 500, true);
        expect(withChecks.date).toBeLessThan(without.date);
        expect(visibleMetaColumns(500, true, withChecks)).toEqual({ author: true, date: true });
    });

    it("rounds to whole pixels", () => {
        expect(resizeMetaColumn(DEFAULT_META_COLUMN_WIDTHS, "author", -0.4, 1000, false)).toEqual(
            DEFAULT_META_COLUMN_WIDTHS,
        );
    });

    // At 300px only the author column fits (date needs 410). A cap that still
    // reserved the hidden date column's 118px sat below the author's own 104px, so
    // the first pixel of any drag snapped the author to 40px and persisted it.
    it("ignores a hidden column when capping growth, so a drag never snaps down", () => {
        expect(visibleMetaColumns(300, false)).toEqual({ author: true, date: false });
        expect(resizeMetaColumn(DEFAULT_META_COLUMN_WIDTHS, "author", -1, 300, false).author).toBe(
            DEFAULT_META_COLUMN_WIDTHS.author + 1,
        );
        const widened = resizeMetaColumn(DEFAULT_META_COLUMN_WIDTHS, "author", -5000, 300, false);
        expect(widened.author).toBe(116);
        expect(visibleMetaColumns(300, false, widened).author).toBe(true);
    });
});

describe("fitMetaColumnWidths", () => {
    it("leaves default widths untouched on any pane, keeping the pre-resize layout", () => {
        expect(fitMetaColumnWidths(DEFAULT_META_COLUMN_WIDTHS, 400, false)).toBe(
            DEFAULT_META_COLUMN_WIDTHS,
        );
        expect(fitMetaColumnWidths(DEFAULT_META_COLUMN_WIDTHS, 200, true)).toBe(
            DEFAULT_META_COLUMN_WIDTHS,
        );
    });

    // A width saved on a wide pane must not hide the column, and its only reset
    // handle, when the pane is narrower.
    it("shrinks a stored width to what the pane can show", () => {
        const fitted = fitMetaColumnWidths({ author: 300, date: 118 }, 300, false);
        expect(fitted).toEqual({ author: 116, date: 118 });
        expect(visibleMetaColumns(300, false, fitted).author).toBe(true);
    });

    it("fits the date column into what the author column leaves over", () => {
        const fitted = fitMetaColumnWidths({ author: 104, date: 300 }, 500, false);
        expect(fitted).toEqual({ author: 104, date: 208 });
        expect(visibleMetaColumns(500, false, fitted)).toEqual({ author: true, date: true });
    });
});

describe("readStoredMetaColumnWidths", () => {
    function stubStorage(raw: string | null): void {
        vi.stubGlobal("localStorage", {
            getItem: (key: string) => (key === META_COLUMN_WIDTHS_STORAGE_KEY ? raw : null),
        });
    }

    it("returns defaults when nothing is stored", () => {
        stubStorage(null);
        expect(readStoredMetaColumnWidths()).toEqual(DEFAULT_META_COLUMN_WIDTHS);
    });

    it("returns defaults for unparsable or malformed payloads", () => {
        stubStorage("{not json");
        expect(readStoredMetaColumnWidths()).toEqual(DEFAULT_META_COLUMN_WIDTHS);
        stubStorage(JSON.stringify({ author: "wide", date: null }));
        expect(readStoredMetaColumnWidths()).toEqual(DEFAULT_META_COLUMN_WIDTHS);
    });

    it("restores stored widths, clamping each to the allowed range", () => {
        stubStorage(JSON.stringify({ author: 150, date: 2 }));
        expect(readStoredMetaColumnWidths()).toEqual({ author: 150, date: MIN_META_COL_WIDTH });
    });

    it("returns defaults when localStorage itself throws", () => {
        vi.stubGlobal("localStorage", {
            getItem: () => {
                throw new Error("blocked");
            },
        });
        expect(readStoredMetaColumnWidths()).toEqual(DEFAULT_META_COLUMN_WIDTHS);
    });
});
