import { describe, expect, it } from "vitest";
import {
    parseCommitNameStatus,
    parseCommitNumstat,
    parseStashEntries,
} from "../../../src/git/parsers";

describe("git parsers", () => {
    it("falls back to list order when stash ref is missing", () => {
        expect(parseStashEntries("abc123\n")).toEqual([
            {
                index: 0,
                message: "",
                date: "",
                hash: "abc123",
            },
        ]);
    });

    it("keeps the source path of a rename and the destination as the display path", () => {
        expect(
            parseCommitNameStatus("R100\0src/old-name.ts\0src/new-name.ts\0M\0plain.ts\0"),
        ).toEqual([
            { path: "src/new-name.ts", oldPath: "src/old-name.ts", status: "R" },
            { path: "plain.ts", status: "M" },
        ]);
    });

    it("preserves tabs and newlines inside NUL-delimited paths", () => {
        expect(parseCommitNameStatus("M\0a\tb\nc\0")).toEqual([{ path: "a\tb\nc", status: "M" }]);
    });

    it("ignores a truncated name-status record instead of inventing a path", () => {
        expect(parseCommitNameStatus("R100\0only-source.ts\0")).toEqual([]);
    });

    it("attaches rename numstat counts to the destination path", () => {
        expect(
            parseCommitNumstat("3\t2\tplain\tname.ts\0" + "1\t0\t\0src/old.ts\0src/new.ts\0"),
        ).toEqual([
            { path: "plain\tname.ts", additions: 3, deletions: 2 },
            { path: "src/new.ts", additions: 1, deletions: 0 },
        ]);
    });

    it("reads binary numstat markers and malformed counts as zero", () => {
        expect(parseCommitNumstat("-\t-\timage.png\0nope\t2\tbroken.ts\0")).toEqual([
            { path: "image.png", additions: 0, deletions: 0 },
            { path: "broken.ts", additions: 0, deletions: 2 },
        ]);
    });
});
