import { describe, expect, it } from "vitest";

import { isExactGhApiNotFound } from "../../../scripts/verifyGhApiNotFound.js";

describe("verifyGhApiNotFound", () => {
    it("accepts only the exact missing-resource diagnostic emitted by gh api", () => {
        expect(isExactGhApiNotFound("gh: Not Found (HTTP 404)\n")).toBe(true);
    });

    it.each([
        "gh: Forbidden (HTTP 403)\n",
        "gh: rate limit exceeded (HTTP 429)\n",
        "gh: server error (HTTP 500)\n",
        "network connection reset\n",
        "gh: upstream returned (HTTP 404) (HTTP 500)\n",
        "gh: Not Found (HTTP 404)\ngh: server error (HTTP 500)\n",
    ])("fails closed for ambiguous or non-404 diagnostics: %s", (diagnostic) => {
        expect(isExactGhApiNotFound(diagnostic)).toBe(false);
    });
});
