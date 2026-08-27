import { describe, expect, it } from "vitest";
import {
    documentIdForSides,
    editablePaneForSides,
    identityForDiffSide,
    labelForDiffSide,
} from "../../../src/diff/editableDiffTypes";
import type { SideSpec } from "../../../src/diff/editableDiffTypes";

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

describe("labelForDiffSide", () => {
    const FULL = "8ba1f109551bd432803012645ac136ddd475d6a8";

    it("shows a resolved commit the way git shows one to a person", () => {
        expect(labelForDiffSide({ kind: "ref", ref: FULL })).toBe("8ba1f10");
    });

    // The other direction, and the one a blind `slice(0, 7)` gets wrong: these are already
    // the short form of themselves, and truncating them produces a ref that either means
    // something else or does not resolve at all.
    it.each(["HEAD", "main", "v1.2.0", "HEAD~1", "origin/feature/long-branch-name"])(
        "leaves the symbolic ref %s alone",
        (ref) => {
            expect(labelForDiffSide({ kind: "ref", ref })).toBe(ref);
        },
    );

    // A short hash is not lengthened, and an over-long or non-hex string is not a commit at
    // all -- only an exact object name is rewritten.
    it.each(["8ba1f10", `${FULL}0`, "8ba1f109551bd432803012645ac136ddd475d6ag"])(
        "leaves %s alone because it is not a whole object name",
        (ref) => {
            expect(labelForDiffSide({ kind: "ref", ref })).toBe(ref);
        },
    );

    // How "Open Commit File Diff" addresses a merge commit's parent. The suffix is the half
    // that says WHICH parent, so it survives; only the object name in front of it shrinks.
    it.each([
        [`${FULL}^2`, "8ba1f10^2"],
        [`${FULL}^1`, "8ba1f10^1"],
        [`${FULL}~1`, "8ba1f10~1"],
    ])(
        "shortens the object name in the revspec %s and keeps what selects the parent",
        (ref, expected) => {
            expect(labelForDiffSide({ kind: "ref", ref })).toBe(expected);
        },
    );

    // A provider names itself and a working tree has no revision to name, so neither side
    // kind reaches the shortening at all.
    it("keeps the other two side kinds naming themselves", () => {
        expect(labelForDiffSide({ kind: "worktree" })).toBe("Working tree");
        expect(
            labelForDiffSide({
                kind: "provider",
                label: "Stash@{0}",
                identity: "stash-oid",
                load: async () => ({ status: "missing" as const }),
            }),
        ).toBe("Stash@{0}");
    });
});

describe("documentIdForSides", () => {
    const shelfSide = (identity: string): SideSpec => ({
        kind: "provider",
        // Every shelf entry is captioned the same word, which is why the label cannot be the
        // thing that tells two of them apart.
        label: "Shelved",
        identity,
        load: async () => ({ status: "missing" as const }),
    });

    // The defect this exists for: two shelved versions of one file agree on path, on both
    // captions, and on the window title. The provider identity is the only field that moves,
    // so it has to reach the id -- otherwise the viewer reads the second entry as the first
    // and hands the reader the first one's scroll offset.
    it("separates two shelf entries whose labels and path are identical", () => {
        const first = documentIdForSides(shelfSide("shelf-a:1:baseToShelved"), {
            kind: "worktree",
        });
        const second = documentIdForSides(shelfSide("shelf-b:1:baseToShelved"), {
            kind: "worktree",
        });
        expect(first).not.toBe(second);
    });

    it("gives one pair of sides the same id every time, so a refresh is not a new document", () => {
        const sides = [
            { kind: "ref" as const, ref: "HEAD" },
            { kind: "worktree" as const },
        ] as const;
        expect(documentIdForSides(...sides)).toBe(documentIdForSides(...sides));
    });

    // Order carries meaning -- left is the base and right is the change -- so a swap is a
    // different comparison, not the same one spelled backwards.
    it("distinguishes a swapped pair", () => {
        expect(documentIdForSides({ kind: "ref", ref: "HEAD" }, { kind: "worktree" })).not.toBe(
            documentIdForSides({ kind: "worktree" }, { kind: "ref", ref: "HEAD" }),
        );
    });

    // The id survives shortening: `labelForDiffSide` abbreviates for the reader, and if the
    // identity abbreviated too, two commits sharing a seven-character prefix would collide.
    it("keeps the whole object name a label would have shortened", () => {
        const full = "8ba1f109551bd432803012645ac136ddd475d6a8";
        expect(identityForDiffSide({ kind: "ref", ref: full })).toBe(full);
    });

    it.each([
        [{ kind: "worktree" } as SideSpec, "worktree"],
        [{ kind: "ref", ref: "HEAD" } as SideSpec, "HEAD"],
    ])("reads %o as the identity %s", (side, expected) => {
        expect(identityForDiffSide(side)).toBe(expected);
    });
});
