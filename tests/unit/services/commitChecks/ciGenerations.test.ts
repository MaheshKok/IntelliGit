import { describe, expect, it } from "vitest";
import { CiGenerations } from "../../../../src/services/commitChecks/ciGenerations";

describe("CiGenerations", () => {
    it("a fresh capture is current", () => {
        const generations = new CiGenerations();
        expect(generations.isCurrent(generations.capture("repo-a"), "repo-a")).toBe(true);
    });

    it("auth bump makes a captured ctx stale", () => {
        const generations = new CiGenerations();
        const ctx = generations.capture("repo-a");
        generations.bumpAuth();
        expect(generations.isCurrent(ctx, "repo-a")).toBe(false);
        expect(generations.isCurrent(generations.capture("repo-a"), "repo-a")).toBe(true);
    });

    it("lifecycle bump makes it stale", () => {
        const generations = new CiGenerations();
        const ctx = generations.capture("repo-a");
        generations.bumpLifecycle();
        expect(generations.isCurrent(ctx, "repo-a")).toBe(false);
    });

    it("different repoKey is stale", () => {
        const generations = new CiGenerations();
        const ctx = generations.capture("repo-a");
        expect(generations.isCurrent(ctx, "repo-b")).toBe(false);
    });
});
