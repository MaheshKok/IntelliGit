import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { CANONICAL_FLOW_IDS, FLOW_MATRIX, IMPLEMENTED_FLOW_IDS } from "../../e2e/flows/matrix";

const DECLARED_IMPLEMENTED_FLOW_IDS = [
    "commit",
    "branch-checkout",
    "pull",
    "push",
    "interactive-rebase",
    "discard-changes",
    "shelf-apply",
    "abort-active-operation",
    "merge-conflict-resolve",
    "force-push-with-lease",
] as const;

describe("E2E flow matrix completeness", () => {
    it("has one matrix registrar and no second flow spec discovery path", () => {
        const flowsDirectory = path.resolve(__dirname, "../../e2e/flows");
        const flowSpecs = readdirSync(flowsDirectory)
            .filter((entry) => entry.endsWith(".spec.ts"))
            .sort();
        const registrar = readFileSync(path.join(flowsDirectory, "flows.spec.ts"), "utf8");

        expect(flowSpecs).toEqual(["flows.spec.ts"]);
        expect(registrar).toContain("FLOW_MATRIX");
        expect(registrar).toContain("runFlow");
    });

    it("has exactly the ids declared implemented by this slice in both directions", () => {
        const matrixIds = FLOW_MATRIX.map((flow) => flow.id);
        const matrixIdSet = new Set(matrixIds);
        const declaredIdSet = new Set(DECLARED_IMPLEMENTED_FLOW_IDS);

        expect(matrixIds).toHaveLength(DECLARED_IMPLEMENTED_FLOW_IDS.length);
        expect(matrixIdSet.size).toBe(matrixIds.length);
        expect(IMPLEMENTED_FLOW_IDS).toEqual([...DECLARED_IMPLEMENTED_FLOW_IDS]);

        for (const id of matrixIdSet) {
            expect(declaredIdSet.has(id)).toBe(true);
        }
        for (const id of declaredIdSet) {
            expect(matrixIdSet.has(id)).toBe(true);
        }
    });

    it("keeps the implemented declaration inside the ten canonical step-25 flows", () => {
        expect(CANONICAL_FLOW_IDS).toEqual([
            "commit",
            "push",
            "pull",
            "interactive-rebase",
            "merge-conflict-resolve",
            "shelf-apply",
            "branch-checkout",
            "force-push-with-lease",
            "discard-changes",
            "abort-active-operation",
        ]);

        for (const id of IMPLEMENTED_FLOW_IDS) {
            expect(CANONICAL_FLOW_IDS).toContain(id);
        }
    });

    it("binds each rebase row to the fixture that makes its branch reachable", () => {
        expect(FLOW_MATRIX.find((flow) => flow.id === "interactive-rebase")).toMatchObject({
            scenario: "ahead-only",
        });
        expect(FLOW_MATRIX.find((flow) => flow.id === "force-push-with-lease")).toMatchObject({
            scenario: "pushed-tip",
        });
    });
});
