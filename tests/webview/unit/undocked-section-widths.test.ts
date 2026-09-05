import { describe, expect, it } from "vitest";
import {
    computeDefaultSectionWidths,
    migrateSectionWidths,
    normalizeSectionWidths,
} from "../../../src/webviews/react/undocked/sectionWidths";
import { resizeSectionPair } from "../../../src/webviews/react/undocked/useColumnPairDrag";

describe("undocked section widths", () => {
    it("prioritizes history in the default five-pane layout budget", () => {
        const widths = computeDefaultSectionWidths(1200);

        expect(widths).toEqual({
            repositoryWidth: 168,
            branchWidth: 220,
            graphWidth: 316,
            infoWidth: 220,
            commitPanelWidth: 260,
        });
        const normalized = normalizeSectionWidths(widths, 1200);
        expect(Object.values(normalized.widths).reduce((sum, width) => sum + width, 0)).toBe(1184);
        expect(normalized.hidden).toEqual([]);
    });

    it("restores history emphasis after a narrow first render widens", () => {
        const preferences = computeDefaultSectionWidths(320);
        expect(normalizeSectionWidths(preferences, 320).widths).toEqual({ graphWidth: 320 });
        expect(normalizeSectionWidths(preferences, 1200)).toEqual({
            widths: {
                repositoryWidth: 168,
                branchWidth: 220,
                graphWidth: 316,
                infoWidth: 220,
                commitPanelWidth: 260,
            },
            hidden: [],
        });
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

        expect(resizeSectionPair(widths, "repositoryWidth", "commitPanelWidth", -20)).toMatchObject(
            {
                repositoryWidth: 120,
                commitPanelWidth: 220,
            },
        );
    });

    it("drops low-priority panes instead of scaling below their true minima", () => {
        const normalized = normalizeSectionWidths(
            {
                repositoryWidth: 168,
                branchWidth: 254,
                graphWidth: 254,
                infoWidth: 254,
                commitPanelWidth: 254,
            },
            320,
        );

        expect(normalized.hidden).toEqual([
            "infoWidth",
            "repositoryWidth",
            "branchWidth",
            "commitPanelWidth",
        ]);
        expect(normalized.widths).toEqual({ graphWidth: 320 });
        expect(
            Object.entries(normalized.widths).every(
                ([key, width]) => width >= (key === "repositoryWidth" ? 120 : 220),
            ),
        ).toBe(true);
    });
});
