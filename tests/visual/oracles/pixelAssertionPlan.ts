import type { EnvironmentVerdict } from "../playwright/visualEnvironmentGuard";

/** The pixel assertion action after provenance and renderer agreement are evaluated. */
export type PixelAssertionPlan =
    | { readonly kind: "run" }
    | { readonly kind: "skip"; readonly reason: string }
    | { readonly kind: "fail"; readonly reason: string };

/** Applies provenance before renderer agreement so an ordinary host run stays actionable green. */
export function planPixelAssertions(verdict: EnvironmentVerdict): PixelAssertionPlan {
    if (verdict.provenance.kind === "unpinned") {
        return {
            kind: "skip",
            reason:
                `${verdict.provenance.reason} ` +
                "Run bun run test:visual:container to compare pixel baselines.",
        };
    }

    if (verdict.agreement.kind === "match") return { kind: "run" };

    const message = "message" in verdict.agreement ? ` ${verdict.agreement.message}` : "";
    return {
        kind: "fail",
        reason: `Visual environment agreement is ${verdict.agreement.kind}.${message}`,
    };
}
