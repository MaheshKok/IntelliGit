import { describe, expect, it } from "vitest";

import type { EnvironmentVerdict } from "../../../visual/playwright/visualEnvironmentGuard";
import { planPixelAssertions } from "../../../visual/oracles/pixelAssertionPlan";

const provenanceReason = "Host renderer is not the reviewed container image.";

/** Builds the smallest verdict fixture needed to exercise one planner branch. */
function verdict(
    agreement: EnvironmentVerdict["agreement"],
    provenance: EnvironmentVerdict["provenance"] = { kind: "pinned" },
): EnvironmentVerdict {
    return { agreement, provenance };
}

describe("planPixelAssertions", () => {
    it("skips unpinned runs with the provenance reason and container command", () => {
        expect(
            planPixelAssertions(
                verdict({ kind: "match" }, { kind: "unpinned", reason: provenanceReason }),
            ),
        ).toEqual({
            kind: "skip",
            reason: `${provenanceReason} Run bun run test:visual:container to compare pixel baselines.`,
        });
    });

    it("can skip: unpinned drift is skipped before the agreement failure branch", () => {
        expect(
            planPixelAssertions(
                verdict(
                    { kind: "drift", message: "browserVersion changed." },
                    { kind: "unpinned", reason: provenanceReason },
                ),
            ),
        ).toEqual({
            kind: "skip",
            reason: `${provenanceReason} Run bun run test:visual:container to compare pixel baselines.`,
        });
    });

    it("runs when the pinned renderer matches the committed environment", () => {
        expect(planPixelAssertions(verdict({ kind: "match" }))).toEqual({ kind: "run" });
    });

    it.each([
        ["no-baseline", { kind: "no-baseline" }],
        ["unreadable", { kind: "unreadable", message: "malformed JSON." }],
        ["drift", { kind: "drift", message: "browserVersion changed." }],
    ] as const)("fails a pinned %s agreement", (agreementKind, agreement) => {
        const plan = planPixelAssertions(verdict(agreement));

        expect(plan.kind).toBe("fail");
        if (plan.kind === "fail") {
            expect(plan.reason).toContain(agreementKind);
            if ("message" in agreement) expect(plan.reason).toContain(agreement.message);
        }
    });
});
