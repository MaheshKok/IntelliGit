import { describe, expect, it } from "vitest";
import {
    commitPanelReducer,
    initialCommitPanelState,
} from "../../../src/webviews/react/undocked/commitPanelState";

describe("commitPanelReducer", () => {
    it("preserves the commit draft while clearing amend state after commit completion", () => {
        const state = {
            ...initialCommitPanelState,
            commitMessage: "fix: retain draft",
            isAmend: true,
            amendBranchCommits: [
                { shortHash: "deadbee", subject: "feat: amend", date: "2026-07-23T00:00:00Z" },
            ],
            amendBranchHistoryLoaded: true,
        };

        expect(commitPanelReducer(state, { type: "COMMITTED" })).toMatchObject({
            commitMessage: "fix: retain draft",
            isAmend: false,
            amendBranchCommits: [],
            amendBranchHistoryLoaded: false,
        });
    });
});
