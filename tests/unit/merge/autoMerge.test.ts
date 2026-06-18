// Spec-derived tests for the token-level three-way auto-merger. Contract:
// tryAutoMergeLines(base, ours, theirs) returns merged lines when the two
// sides' token edits never touch the same base region, and null whenever the
// merge would have to guess (overlap, ambiguous ordering, or line-count
// changes). A null result keeps the hunk a manual conflict — false positives
// here would silently corrupt user code, so the merger must be conservative.

import { describe, expect, it } from "vitest";
import { tryAutoMergeLines } from "../../../src/mergeEditor/autoMerge";

describe("tryAutoMergeLines", () => {
    it("merges edits to different tokens of the same line", () => {
        const merged = tryAutoMergeLines(
            ["const value = compute(a, b);"],
            ["const result = compute(a, b);"],
            ["const value = compute(a, c);"],
        );
        expect(merged).toEqual(["const result = compute(a, c);"]);
    });

    it("merges start-of-line and end-of-line edits regardless of side order", () => {
        const merged = tryAutoMergeLines(
            ["let port = config.port || 8080;"],
            ["let port = config.port || 9090;"],
            ["const port = config.port || 8080;"],
        );
        expect(merged).toEqual(["const port = config.port || 9090;"]);
    });

    it("returns null when both sides change the same token differently", () => {
        expect(
            tryAutoMergeLines(
                ["const parsed = yaml.parse(raw);"],
                ["const parsed = JSON.parse(raw);"],
                ["const parsed = toml.parse(raw);"],
            ),
        ).toBeNull();
    });

    it("returns the shared rewrite when both sides made the same change", () => {
        const merged = tryAutoMergeLines(
            ["let x = 1;"],
            ["const x = 1;"],
            ["const x = 1;"],
        );
        expect(merged).toEqual(["const x = 1;"]);
    });

    it("takes the changed side when the other side kept the base line", () => {
        const merged = tryAutoMergeLines(
            ["const a = 1;", "const b = 2;"],
            ["const a = 100;", "const b = 2;"],
            ["const a = 1;", "const b = 200;"],
        );
        expect(merged).toEqual(["const a = 100;", "const b = 200;"]);
    });

    it("returns null when any single line fails even if the others merge", () => {
        expect(
            tryAutoMergeLines(
                ["const a = 1;", "const mode = 'x';"],
                ["const a = 100;", "const mode = 'ours';"],
                ["const a = 1;", "const mode = 'theirs';"],
            ),
        ).toBeNull();
    });

    it("returns null when the sides change the number of lines", () => {
        expect(
            tryAutoMergeLines(
                ["original();"],
                ["replaced();"],
                ["expanded();", "second_line();"],
            ),
        ).toBeNull();
        expect(tryAutoMergeLines([], ["added_by_ours();"], ["added_by_theirs();"])).toBeNull();
    });

    it("returns null when both sides insert at the same position", () => {
        // Ordering of two insertions at one point is ambiguous; never guess.
        expect(
            tryAutoMergeLines(
                ["call(a);"],
                ["call(a, extraOurs);"],
                ["call(a, extraTheirs);"],
            ),
        ).toBeNull();
    });

    it("merges adjacent but non-overlapping token replacements", () => {
        // ours rewrites the identifier, theirs rewrites the operator right
        // after it; ranges share a boundary but no tokens.
        const merged = tryAutoMergeLines(["count += step;"], ["total += step;"], ["count -= step;"]);
        expect(merged).toEqual(["total -= step;"]);
    });

    it("preserves whitespace-only edits from one side alongside code edits from the other", () => {
        const merged = tryAutoMergeLines(
            ["if (ready) {start();}"],
            ["if (ready) { start(); }"],
            ["if (armed) {start();}"],
        );
        expect(merged).toEqual(["if (armed) { start(); }"]);
    });

    it("returns null rather than merging when one side empties the line", () => {
        expect(tryAutoMergeLines(["keep_or_drop();"], [""], ["keep_or_drop(); // note"])).toBeNull();
    });
});
