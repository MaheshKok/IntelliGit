import { describe, expect, it } from "vitest";
import {
    commitPanelReducer,
    initialCommitPanelState,
} from "../../../src/webviews/react/undocked/commitPanelState";

describe("commitPanelReducer", () => {
    it.each([
        [true, ""],
        [undefined, ""],
        [false, "fix: retain draft"],
    ])("clears only when clearCommitMessage is not false (%s)", (clearCommitMessage, commitMessage) => {
        const state = {
            ...initialCommitPanelState,
            commitMessage: "fix: retain draft",
            isAmend: true,
            amendBranchCommits: [
                { shortHash: "deadbee", subject: "feat: amend", date: "2026-07-23T00:00:00Z" },
            ],
            amendBranchHistoryLoaded: true,
        };

        expect(commitPanelReducer(state, { type: "COMMITTED", clearCommitMessage })).toMatchObject({
            commitMessage,
            isAmend: false,
            amendBranchCommits: [],
            amendBranchHistoryLoaded: false,
        });
    });
});
