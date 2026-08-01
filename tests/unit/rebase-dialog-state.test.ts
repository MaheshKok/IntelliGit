import { describe, expect, it } from "vitest";
import type { InteractiveRebaseRangeCommit } from "../../src/git/interactiveRebase/types";
import {
    changeRebaseAction,
    changeRebaseMessage,
    createRebaseEntries,
    moveRebaseEntry,
    reorderRebaseEntries,
} from "../../src/webviews/react/shared/components/RebaseDialog/rebaseDialogState";

const commits: InteractiveRebaseRangeCommit[] = [
    {
        hash: "a".repeat(40),
        authorName: "Ada",
        authoredAt: "2026-01-01",
        body: "First subject\nFirst body",
        isPushed: false,
    },
    {
        hash: "b".repeat(40),
        authorName: "Ben",
        authoredAt: "2026-01-02",
        body: "Second subject\nSecond body",
        isPushed: false,
    },
    {
        hash: "c".repeat(40),
        authorName: "Cy",
        authoredAt: "2026-01-03",
        body: "Third subject",
        isPushed: false,
    },
];

describe("rebase dialog state", () => {
    it("creates entries in offered todo order and updates message-bearing actions", () => {
        const entries = createRebaseEntries(commits);
        expect(entries.map((entry) => entry.hash)).toEqual(commits.map((commit) => commit.hash));
        expect(changeRebaseAction(entries, commits, commits[1].hash, "reword").entries[1]).toEqual({
            hash: commits[1].hash,
            action: "reword",
            message: commits[1].body,
        });
        expect(changeRebaseAction(entries, commits, commits[1].hash, "squash").entries[1]).toEqual({
            hash: commits[1].hash,
            action: "squash",
            message: `${commits[0].body}\n\n${commits[1].body}`,
        });
    });

    it("reorders immutably and resets a promoted squash or fixup entry", () => {
        const entries = changeRebaseAction(
            createRebaseEntries(commits),
            commits,
            commits[1].hash,
            "squash",
        ).entries;
        const result = moveRebaseEntry(entries, commits[1].hash, "up");
        expect(result.entries.map((entry) => entry.hash)).toEqual([
            commits[1].hash,
            commits[0].hash,
            commits[2].hash,
        ]);
        expect(result.entries[0].action).toBe("pick");
        expect(result.firstActionCleared).toBe(true);
        expect(
            reorderRebaseEntries(entries, commits[2].hash, commits[0].hash).entries.map(
                (entry) => entry.hash,
            ),
        ).toEqual([commits[2].hash, commits[0].hash, commits[1].hash]);
    });

    it("recomputes the first active entry after dropping earlier entries", () => {
        let entries = changeRebaseAction(
            createRebaseEntries(commits),
            commits,
            commits[1].hash,
            "squash",
        ).entries;
        const result = changeRebaseAction(entries, commits, commits[0].hash, "drop");
        entries = result.entries;
        expect(entries[0].action).toBe("drop");
        expect(entries[1].action).toBe("pick");
        expect(result.firstActionCleared).toBe(true);
    });

    it("prefills squash from the nearest preceding commit that remains after rebase", () => {
        const range = [
            ...commits,
            {
                hash: "d".repeat(40),
                authorName: "Dee",
                authoredAt: "2026-01-04",
                body: "Fourth subject\nFourth body",
                isPushed: false,
            },
        ];
        let entries = createRebaseEntries(range);
        entries = changeRebaseAction(entries, range, range[1].hash, "fixup").entries;
        entries = changeRebaseAction(entries, range, range[2].hash, "drop").entries;

        const result = changeRebaseAction(entries, range, range[3].hash, "squash");

        expect(result.entries[3]).toEqual({
            hash: range[3].hash,
            action: "squash",
            message: `${range[0].body}\n\n${range[3].body}`,
        });
    });

    it("recomputes an unedited squash prefill after reorder while preserving an edited one", () => {
        const entries = changeRebaseAction(
            createRebaseEntries(commits),
            commits,
            commits[2].hash,
            "squash",
        ).entries;

        expect(
            moveRebaseEntry(entries, commits[1].hash, "down", commits, new Set()).entries[1],
        ).toEqual({
            hash: commits[2].hash,
            action: "squash",
            message: `${commits[0].body}\n\n${commits[2].body}`,
        });
        const editedEntries = changeRebaseMessage(entries, commits[2].hash, "User draft");
        expect(
            moveRebaseEntry(
                editedEntries,
                commits[1].hash,
                "down",
                commits,
                new Set([commits[2].hash]),
            ).entries[1],
        ).toEqual({
            hash: commits[2].hash,
            action: "squash",
            message: "User draft",
        });
    });
});
