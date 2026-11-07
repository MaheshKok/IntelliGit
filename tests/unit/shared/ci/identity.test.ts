import { describe, expect, it } from "vitest";
import { logicalCheckId } from "../../../../src/shared/ci/identity";

describe("logicalCheckId", () => {
    it("workflow and job form the GitHub logical id", () => {
        expect(logicalCheckId({ kind: "job", scope: "CI", name: "unit-tests" })).toBe(
            "CI\0unit-tests",
        );
        // Same job name in two workflows must stay two identities.
        expect(logicalCheckId({ kind: "job", scope: "Release", name: "unit-tests" })).not.toBe(
            logicalCheckId({ kind: "job", scope: "CI", name: "unit-tests" }),
        );
    });

    it("a missing pipeline name is an empty scope", () => {
        expect(logicalCheckId({ kind: "job", scope: null, name: "build" })).toBe("\0build");
        expect(logicalCheckId({ kind: "job", name: "build" })).toBe("\0build");
    });

    it("status checks are prefixed", () => {
        expect(logicalCheckId({ kind: "status", name: "ci/circleci" })).toBe("status\0ci/circleci");
        expect(logicalCheckId({ kind: "status", name: "build" })).not.toBe(
            logicalCheckId({ kind: "job", name: "build" }),
        );
    });
});
