import { describe, expect, it } from "vitest";
import { parseWorkingTreeStatus, planRollbackFiles } from "../../../src/git/workingTree";

describe("parseWorkingTreeStatus", () => {
    it("keeps staged-add deletions while suppressing duplicate staged-add modifications", () => {
        expect(parseWorkingTreeStatus("AM new.ts\0AD removed.ts\0")).toEqual([
            { path: "new.ts", status: "A", staged: true, additions: 0, deletions: 0 },
            { path: "removed.ts", status: "A", staged: true, additions: 0, deletions: 0 },
            { path: "removed.ts", status: "D", staged: false, additions: 0, deletions: 0 },
        ]);
    });
});

describe("planRollbackFiles", () => {
    it("includes both rename paths when the source path is selected", () => {
        expect(planRollbackFiles(["old.ts"], "R  new.ts\0old.ts\0")).toEqual({
            resetPaths: ["old.ts", "new.ts"],
            checkoutPaths: ["old.ts"],
            cleanupPaths: ["new.ts"],
        });
    });
});
