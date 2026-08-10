import { describe, expect, it } from "vitest";
import { visibleMetaColumns } from "../../../src/webviews/react/commit-list/styles";

describe("visibleMetaColumns", () => {
    it("shows the author column at its exact threshold", () => {
        expect(visibleMetaColumns(260, true)).toEqual({ author: true, date: false });
    });

    it("hides both metadata columns one pixel below the author threshold", () => {
        expect(visibleMetaColumns(259, true)).toEqual({ author: false, date: false });
    });

    it("shows both metadata columns at their exact threshold", () => {
        expect(visibleMetaColumns(382, true)).toEqual({ author: true, date: true });
    });

    it("keeps only the author column one pixel below the full threshold", () => {
        expect(visibleMetaColumns(381, true)).toEqual({ author: true, date: false });
    });

    it("hides both metadata columns at the measured narrow row width", () => {
        expect(visibleMetaColumns(202, true)).toEqual({ author: false, date: false });
    });

    // Without the checks column the thresholds must fall back to the pre-checks budget;
    // every case above passes showChecks=true, which leaves this branch unmeasured.
    it("reclaims the checks-column budget when the checks column is hidden", () => {
        expect(visibleMetaColumns(228, false)).toEqual({ author: true, date: false });
        expect(visibleMetaColumns(227, false)).toEqual({ author: false, date: false });
        expect(visibleMetaColumns(350, false)).toEqual({ author: true, date: true });
        expect(visibleMetaColumns(349, false)).toEqual({ author: true, date: false });
    });
});
