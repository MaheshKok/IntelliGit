import { describe, expect, it } from "vitest";
import type { BlameLine } from "../../../src/git/blame";
import { blameAgeRange, blameAnnotationColors } from "../../../src/services/blameAnnotationColors";

const line = (authorTime: number, commit = "a".repeat(40)): BlameLine => ({
    authorTime,
    commit,
    line: 0,
    author: "Author",
    authorTimezone: "+0000",
    summary: "Subject",
});

describe("blame age colors", () => {
    it("keeps the oldest label on the theme's muted description foreground", () => {
        expect(blameAnnotationColors(line(100), { oldest: 100, newest: 900 })).toEqual({
            backgroundColor: "var(--vscode-editor-background)",
            color: "var(--vscode-descriptionForeground)",
        });
    });

    it("orders actual timestamps rather than author names, hashes or input positions", () => {
        const lines = [line(900, "c".repeat(40)), line(100), line(500, "b".repeat(40))];
        const range = blameAgeRange(lines);
        expect(range).toEqual({ oldest: 100, newest: 900 });
        expect(blameAnnotationColors(lines[1], range)?.backgroundColor).toBe(
            "var(--vscode-editor-background)",
        );
        expect(blameAnnotationColors(lines[2], range)?.backgroundColor).toContain("#83bf54 50%");
        expect(blameAnnotationColors(lines[0], range)).toEqual({
            backgroundColor: "#83bf54",
            color: "#000000",
        });
    });

    it("uses the same colors for different commits with identical timestamps", () => {
        const left = line(500);
        const right = line(500, "b".repeat(40));
        expect(blameAnnotationColors(left, { oldest: 100, newest: 900 })).toBe(
            blameAnnotationColors(right, { oldest: 100, newest: 900 }),
        );
        expect(blameAnnotationColors(left, blameAgeRange([left, right]))?.backgroundColor).toBe(
            "#83bf54",
        );
    });

    it.each(["0".repeat(40), "0".repeat(64)])(
        "excludes unsaved pseudo-commit %s from both range and color assignment",
        (commit) => {
            const uncommitted = line(9_000, commit);
            const range = blameAgeRange([line(100), line(900), uncommitted]);
            expect(range).toEqual({ oldest: 100, newest: 900 });
            expect(blameAnnotationColors(uncommitted, range)).toBeUndefined();
            expect(blameAgeRange([uncommitted])).toBeUndefined();
        },
    );

    it.each([NaN, Infinity, -Infinity, 8_640_000_000_001])(
        "keeps an unsupported timestamp neutral: %s",
        (time) => {
            const unknown = line(time);
            expect(blameAgeRange([line(100), unknown])).toEqual({ oldest: 100, newest: 100 });
            expect(blameAnnotationColors(unknown, { oldest: 100, newest: 900 })).toBeUndefined();
        },
    );

    it("does not manufacture an age for an empty or unknown snapshot", () => {
        expect(blameAgeRange([])).toBeUndefined();
        expect(blameAnnotationColors(line(100), undefined)).toBeUndefined();
    });

    it("does not inherit a translucent background's alpha for tinted annotation text", () => {
        expect(blameAnnotationColors(line(500), { oldest: 100, newest: 900 })?.color).toMatch(
            / \/ 1\)$/,
        );
    });

    it("accepts pre-epoch commits and clamps stale out-of-range times to endpoint colors", () => {
        const range = blameAgeRange([line(-100), line(100)])!;
        expect(blameAnnotationColors(line(-200), range)?.backgroundColor).toBe(
            "var(--vscode-editor-background)",
        );
        expect(blameAnnotationColors(line(200), range)?.backgroundColor).toBe("#83bf54");
    });

    it("bounds style variants independently of file size", () => {
        const colors = new Set(
            Array.from({ length: 20_000 }, (_, time) =>
                blameAnnotationColors(line(time), { oldest: 0, newest: 19_999 }),
            ),
        );
        expect(colors.size).toBe(101);
        for (const color of colors) expect(Object.isFrozen(color)).toBe(true);
    });
});
