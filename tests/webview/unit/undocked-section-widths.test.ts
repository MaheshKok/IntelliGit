import { describe, expect, it } from "vitest";
import {
    computeEqualSectionWidths,
    migrateSectionWidths,
    normalizeSectionWidths,
} from "../../../src/webviews/react/undocked/sectionWidths";
import { resizeSectionPair } from "../../../src/webviews/react/undocked/useColumnPairDrag";

describe("undocked section widths", () => {
    it("reserves a persisted repository selector width within the five-pane layout budget", () => {
        const widths = computeEqualSectionWidths(1200);

        expect(widths).toEqual({
            repositoryWidth: 168,
            branchWidth: 254,
            graphWidth: 254,
            infoWidth: 254,
            commitPanelWidth: 254,
        });
        expect(Object.values(normalizeSectionWidths(widths, 1200)).reduce((sum, width) => sum + width, 0)).toBe(1184);
    });

    it("migrates four-pane persisted layouts with the repository default", () => {
        expect(
            migrateSectionWidths({
                branchWidth: 400,
                graphWidth: 300,
                infoWidth: 300,
                commitPanelWidth: 200,
            }),
        ).toEqual({
            repositoryWidth: 168,
            branchWidth: 400,
            graphWidth: 300,
            infoWidth: 300,
            commitPanelWidth: 200,
        });
    });

    it("clamps repository and adjacent panes to their unequal minima", () => {
        const widths = {
            repositoryWidth: 120,
            branchWidth: 254,
            graphWidth: 254,
            infoWidth: 254,
            commitPanelWidth: 220,
        };

        expect(resizeSectionPair(widths, "repositoryWidth", "commitPanelWidth", -20)).toMatchObject({
            repositoryWidth: 120,
            commitPanelWidth: 220,
        });
    });
});
