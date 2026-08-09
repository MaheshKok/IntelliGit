import { describe, expect, it } from "vitest";
import { visibleMetaColumns } from "../../../src/webviews/react/commit-list/styles";

describe("visibleMetaColumns", () => {
    it("shows the author column at its exact threshold", () => {
        expect(visibleMetaColumns(228)).toEqual({ author: true, date: false });
    });

    it("hides both metadata columns one pixel below the author threshold", () => {
        expect(visibleMetaColumns(227)).toEqual({ author: false, date: false });
    });

    it("shows both metadata columns at their exact threshold", () => {
        expect(visibleMetaColumns(350)).toEqual({ author: true, date: true });
    });

    it("keeps only the author column one pixel below the full threshold", () => {
        expect(visibleMetaColumns(349)).toEqual({ author: true, date: false });
    });

    it("hides both metadata columns at the measured narrow row width", () => {
        expect(visibleMetaColumns(202)).toEqual({ author: false, date: false });
    });
});
