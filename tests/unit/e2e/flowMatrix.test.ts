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

    // The race this pins, measured on CI run 31942358546: `branch-checkout` opened the command
    // palette, typed `>IntelliGit: Show Git Log` verbatim, and VS Code answered with its
    // zero-exact-match "similar commands" list. The window had loaded; the extension had not
    // activated, so the command did not exist yet. A loaded window is not an activated extension,
    // and the palette answers either way -- which is why this read as a dead command rather than a
    // race. Every flow therefore has to wait for the extension's own readiness marker before it
    // touches any IntelliGit surface. Source order is the only place a unit test can see this:
    // `runFlow` needs a real Electron host to execute.
    it("waits for the extension to activate before any flow touches IntelliGit", () => {
        const source = readFileSync(path.resolve(__dirname, "../../e2e/flows/matrix.ts"), "utf8");
        const bodyStart = source.indexOf("export async function runFlow");
        expect(
            bodyStart,
            "runFlow is no longer declared where this guard reads it",
        ).toBeGreaterThan(-1);
        const body = source.slice(bodyStart, source.indexOf("\n}", bodyStart));

        const readyAt = body.indexOf("await waitForE2eChannelReady(");
        expect(
            readyAt,
            "runFlow must wait for the extension's readiness marker before driving its UI",
        ).toBeGreaterThan(-1);

        // Both surfaces, because they are separate entry points into the same race: the palette
        // reaches IntelliGit by command name, the activity bar by view container, and a wait that
        // covers only one leaves the other racing.
        for (const interaction of ["runCommand(", "intelliGitView.reveal"]) {
            const interactionAt = body.indexOf(interaction);
            expect(interactionAt, `runFlow no longer contains ${interaction}`).toBeGreaterThan(-1);
            expect(
                readyAt,
                `runFlow reaches ${interaction} before waiting for the extension to activate`,
            ).toBeLessThan(interactionAt);
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
