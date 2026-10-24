import { describe, expect, it } from "vitest";
import {
    changelistFiles,
    changelistsInUse,
} from "../../../src/webviews/react/commit-panel/hooks/useChangelists";
import type { ChangelistState } from "../../../src/webviews/protocol/changeSelection";
import type { WorkingFile } from "../../../src/types";

const file: WorkingFile = {
    path: "one.txt",
    status: "M",
    staged: false,
    additions: 2,
    deletions: 2,
};

describe("changelist file projection", () => {
    it("does not show an empty default membership when all known lines moved to another list", () => {
        const state: ChangelistState = {
            revision: 1,
            activeId: "default",
            lists: [
                { id: "default", name: "Default" },
                { id: "feature", name: "Feature" },
            ],
            files: { "one.txt": "default" },
            changes: {
                "one.txt": {
                    contentId: "content",
                    totalChanges: 2,
                    lines: { first: "feature", second: "feature" },
                },
            },
        };
        expect(changelistFiles([file], state, "default")).toEqual([]);
        expect(changelistFiles([file], state, "feature")).toEqual([file]);
        expect(changelistFiles([file], state, "all")).toEqual([file]);
    });

    it("retains whole-file structural changes and stale assignments for explicit review", () => {
        const state: ChangelistState = {
            revision: 1,
            activeId: "default",
            lists: [{ id: "default", name: "Default" }],
            files: { "one.txt": "default" },
            changes: { "one.txt": { contentId: "content", totalChanges: 0, lines: {} } },
        };
        expect(changelistFiles([file], state, "default")).toEqual([file]);
    });
});

describe("changelists in use", () => {
    const single: ChangelistState = {
        revision: 1,
        activeId: "default",
        lists: [{ id: "default", name: "Changes" }],
        files: {},
        // Stale ownership alone happens after ordinary edits and must not reveal the list UI.
        changes: { "one.txt": { contentId: "content", lines: {}, stale: true } },
    };

    it("keeps the plain panel for one list with no line selections", () => {
        expect(changelistsInUse(single, false)).toBe(false);
    });

    it("reveals the list UI for a second list, a line selection, or a recovery issue", () => {
        expect(
            changelistsInUse(
                { ...single, lists: [...single.lists, { id: "feature", name: "Feature" }] },
                false,
            ),
        ).toBe(true);
        expect(
            changelistsInUse(
                {
                    ...single,
                    changes: {
                        "one.txt": {
                            contentId: "content",
                            lines: {},
                            selections: {
                                all: { contentId: "content", lineIds: ["a"], total: 2 },
                            },
                        },
                    },
                },
                false,
            ),
        ).toBe(true);
        expect(changelistsInUse(single, true)).toBe(true);
    });
});
