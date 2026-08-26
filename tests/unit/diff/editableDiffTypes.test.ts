import { describe, expect, it } from "vitest";
import { editablePaneForSides } from "../../../src/diff/editableDiffTypes";

describe("editablePaneForSides", () => {
    it.each([
        [
            "row 1 (panel HEAD-to-working-tree)",
            "right",
            { kind: "ref", ref: "HEAD" },
            { kind: "worktree" },
        ],
        [
            "row 2 (git-ref-to-working-tree)",
            "right",
            { kind: "ref", ref: "feature" },
            { kind: "worktree" },
        ],
        [
            "row 4 (single-file stash)",
            "left",
            { kind: "worktree" },
            {
                kind: "provider",
                label: "Stash",
                identity: "stash-oid",
                load: async () => ({ status: "missing" as const }),
            },
        ],
        [
            "row 5b (shelved-to-local)",
            "right",
            {
                kind: "provider",
                label: "Shelved",
                identity: "shelf-oid",
                load: async () => ({ status: "missing" as const }),
            },
            { kind: "worktree" },
        ],
    ] as const)("derives the %s pane from the working-tree side", (_row, pane, left, right) => {
        expect(editablePaneForSides(left, right)).toBe(pane);
    });

    it("does not create an editable pane when neither side is a working-tree file", () => {
        expect(
            editablePaneForSides({ kind: "ref", ref: "HEAD" }, { kind: "ref", ref: "HEAD^" }),
        ).toBeUndefined();
    });
});
