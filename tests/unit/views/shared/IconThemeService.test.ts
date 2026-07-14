import { describe, expect, it, vi } from "vitest";
import type { Branch } from "../../../../src/types";

vi.mock("vscode", () => ({}));

import { branchIconDisplayName } from "../../../../src/views/shared/IconThemeService";

function branch(overrides: Partial<Branch>): Branch {
    return {
        name: "",
        hash: "",
        isRemote: false,
        isCurrent: false,
        ahead: 0,
        behind: 0,
        ...overrides,
    };
}

describe("branchIconDisplayName", () => {
    it("removes a matching configured remote prefix", () => {
        expect(
            branchIconDisplayName(
                branch({ name: "origin/feature/work", isRemote: true, remote: "origin" }),
            ),
        ).toBe("feature/work");
    });

    it("drops the first remote segment when it differs from the configured remote", () => {
        expect(
            branchIconDisplayName(
                branch({ name: "upstream/feature/work", isRemote: true, remote: "origin" }),
            ),
        ).toBe("feature/work");
    });

    it("keeps local branch names unchanged", () => {
        expect(branchIconDisplayName(branch({ name: "feature/work" }))).toBe("feature/work");
    });
});
