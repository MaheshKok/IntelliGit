import { describe, expect, it } from "vitest";
import { visibleMetaColumns } from "../../../src/webviews/react/commit-list/styles";

describe("visibleMetaColumns", () => {
    it("reserves message-and-ref space before revealing the author", () => {
        expect(visibleMetaColumns(274, false)).toEqual({ author: false, date: false });
    });
    it("shows the author column at its exact threshold", () => {
        expect(visibleMetaColumns(320, true)).toEqual({ author: true, date: false });
    });

    it("hides both metadata columns one pixel below the author threshold", () => {
        expect(visibleMetaColumns(319, true)).toEqual({ author: false, date: false });
    });

    it("shows both metadata columns at their exact threshold", () => {
        expect(visibleMetaColumns(442, true)).toEqual({ author: true, date: true });
    });

    it("keeps only the author column one pixel below the full threshold", () => {
        expect(visibleMetaColumns(441, true)).toEqual({ author: true, date: false });
    });

    it("hides both metadata columns at the measured narrow row width", () => {
        expect(visibleMetaColumns(202, true)).toEqual({ author: false, date: false });
    });

    // Hiding checks must reclaim its width at both metadata breakpoints.
    it("reclaims the checks-column budget when the checks column is hidden", () => {
        expect(visibleMetaColumns(288, false)).toEqual({ author: true, date: false });
        expect(visibleMetaColumns(287, false)).toEqual({ author: false, date: false });
        expect(visibleMetaColumns(410, false)).toEqual({ author: true, date: true });
        expect(visibleMetaColumns(409, false)).toEqual({ author: true, date: false });
    });
});
