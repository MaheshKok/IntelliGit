import { describe, expect, it } from "vitest";
import { editablePaneForSides } from "../../../src/diff/editableDiffTypes";

describe("editablePaneForSides", () => {
    it.each([
        ["right", { kind: "ref", ref: "HEAD" }, { kind: "worktree" }],
        [
            "left",
            { kind: "worktree" },
            {
                kind: "provider",
                label: "Stash",
                identity: "stash-oid",
                load: async () => ({ status: "missing" as const }),
            },
        ],
    ] as const)("derives %s from the working-tree side", (pane, left, right) => {
        expect(editablePaneForSides(left, right)).toBe(pane);
    });

    it("does not create an editable pane when neither side is a working-tree file", () => {
        expect(
            editablePaneForSides({ kind: "ref", ref: "HEAD" }, { kind: "ref", ref: "HEAD^" }),
        ).toBeUndefined();
    });
});
