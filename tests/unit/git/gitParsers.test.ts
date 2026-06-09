import { describe, expect, it } from "vitest";
import { parseStashEntries } from "../../../src/git/parsers";

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
});
