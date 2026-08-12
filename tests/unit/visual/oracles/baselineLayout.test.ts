import { describe, expect, it } from "vitest";

import {
    expectedBaselineName,
    findBaselineLayoutFindings,
} from "../../../visual/oracles/baselineLayout";

const contextIds = ["commit-graph-card", "history-panel"] as const;
const projectNames = ["dark-modern-narrow", "light-modern-wide"] as const;

describe("findBaselineLayoutFindings", () => {
    it("returns no findings for the exact matrix", () => {
        const actualFilenames = contextIds.flatMap((contextId) =>
            projectNames.map((projectName) => expectedBaselineName(contextId, projectName)),
        );

        expect(findBaselineLayoutFindings(contextIds, projectNames, actualFilenames)).toEqual([]);
    });

    it("can fail: reports an orphan file by filename", () => {
        const orphanFilename = "pixel-baseline-screenshots-unowned.png";
        const actualFilenames = [
            ...contextIds.flatMap((contextId) =>
                projectNames.map((projectName) => expectedBaselineName(contextId, projectName)),
            ),
            orphanFilename,
        ];

        expect(findBaselineLayoutFindings(contextIds, projectNames, actualFilenames)).toEqual([
            { kind: "orphan", filename: orphanFilename },
        ]);
    });

    it("can fail: reports a missing matrix cell by expected filename", () => {
        const missingFilename = expectedBaselineName("history-panel", "light-modern-wide");
        const actualFilenames = contextIds.flatMap((contextId) =>
            projectNames
                .map((projectName) => expectedBaselineName(contextId, projectName))
                .filter((filename) => filename !== missingFilename),
        );

        expect(findBaselineLayoutFindings(contextIds, projectNames, actualFilenames)).toEqual([
            { kind: "gap", filename: missingFilename },
        ]);
    });
});

describe("expectedBaselineName", () => {
    it("matches the literal filename Playwright writes", () => {
        expect(expectedBaselineName("commit-graph-card", "dark-modern-narrow")).toBe(
            "pixel-baseline-screenshots-commit-graph-card-matches-the-pixel-baseline-1-dark-modern-narrow.png",
        );
    });
});
