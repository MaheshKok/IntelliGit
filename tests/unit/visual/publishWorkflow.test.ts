import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const WORKFLOW_PATH = resolve(__dirname, "../../../.github/workflows/publish.yml");

describe("publish visual workflow", () => {
    it("runs the visual suite through the pinned container wrapper", () => {
        const workflow = readFileSync(WORKFLOW_PATH, "utf8");

        expect(workflow).toMatch(
            /- name: Run visual suite in the pinned container\n\s+run: \.\/tests\/e2e\/docker\/run\.sh .*bun run test:visual/,
        );
    });

    it("can fail: the visual command never appears as a bare runner step", () => {
        const workflow = readFileSync(WORKFLOW_PATH, "utf8");
        const visualCommandLines = workflow
            .split("\n")
            .filter((line) => line.includes("bun run test:visual"));

        expect(visualCommandLines).toHaveLength(1);
        expect(visualCommandLines[0]).toContain("./tests/e2e/docker/run.sh");
    });
});
