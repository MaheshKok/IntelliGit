import { describe, expect, it } from "vitest";
import { blameDate, parseBlame } from "../../../src/git/blame";

const commit = "a".repeat(40);
const record = (line: number, source = "source", hash = commit) =>
    `${hash} ${line} ${line} 1\nauthor Ada Lovelace\nauthor-mail <ada@example.invalid>\nauthor-time 946684800\nauthor-tz -0800\ncommitter Ada\nsummary Fix *format* [link](command:bad)\nboundary\nfilename file with spaces.ts\n\t${source}\n`;

describe("porcelain blame", () => {
    it("parses metadata and zero-based line numbers for each line", () => {
        expect(parseBlame(record(1) + record(2, "\tauthor Fake"))).toEqual([
            {
                commit,
                line: 0,
                author: "Ada Lovelace",
                authorTime: 946684800,
                authorTimezone: "-0800",
                summary: "Fix *format* [link](command:bad)",
            },
            expect.objectContaining({ line: 1, author: "Ada Lovelace" }),
        ]);
    });

    it("handles SHA-256 repositories and uncommitted zero hashes", () => {
        expect(parseBlame(record(1, "", "b".repeat(64)))[0].commit).toHaveLength(64);
        expect(parseBlame(record(1, "", "0".repeat(40)))[0].commit).toBe("0".repeat(40));
    });

    it("accepts empty output and a final line without an output newline", () => {
        expect(parseBlame("")).toEqual([]);
        expect(parseBlame(record(1).trimEnd())).toHaveLength(1);
    });

    it.each(["Not Committed Yet", "External file (--contents)"])(
        "preserves version-dependent uncommitted author metadata: %s",
        (author) => {
            const hash = "0".repeat(40);
            const output = record(1, "unsaved", hash).replace("Ada Lovelace", author);
            expect(parseBlame(output)[0]).toMatchObject({ commit: hash, line: 0, author });
        },
    );

    it("reuses metadata for contiguous and interleaved short commit headers", () => {
        const secondCommit = "b".repeat(40);
        const second = record(3, "other", secondCommit).replace("Ada Lovelace", "Grace Hopper");
        const lines = parseBlame(
            record(1) +
                `${commit} 2 2\n\t\n` +
                second +
                `${commit} 3 4 1\n\t\tauthor Fake\n` +
                `${secondCommit} 4 5\n\tother\n`,
        );
        expect(lines).toEqual([
            expect.objectContaining({ line: 0, author: "Ada Lovelace" }),
            { ...lines[0], line: 1 },
            expect.objectContaining({ line: 2, commit: secondCommit, author: "Grace Hopper" }),
            { ...lines[0], line: 3 },
            { ...lines[2], line: 4 },
        ]);
    });

    it.each(["b".repeat(64), "0".repeat(40), "0".repeat(64)])(
        "reuses metadata for SHA-256 and uncommitted headers %s",
        (hash) => {
            const lines = parseBlame(record(1, "", hash) + `${hash} 2 2\n\tsource\n`);
            expect(lines[1]).toEqual({ ...lines[0], line: 1 });
        },
    );

    it("keeps the metadata cache local to one Git invocation", () => {
        parseBlame(record(1));
        const fresh = parseBlame(`${commit} 1 1\n\tsource\n`);
        expect(fresh[0].author).toBe("");
    });

    it.each([
        "unexpected",
        `${commit} 1 1\nauthor Ada\n`,
        "\tsource\n",
        `${commit} 1 1\n${commit} 2 2\n`,
    ])("rejects invalid or incomplete output %s", (output) =>
        expect(() => parseBlame(output)).toThrow(),
    );

    it("uses the author's timezone rather than the host timezone for the date", () => {
        const line = parseBlame(record(1))[0];
        expect(blameDate(line)).toBe("1999-12-31");
        expect(blameDate({ ...line, authorTimezone: "+1400" })).toBe("2000-01-01");
        expect(blameDate({ ...line, authorTime: NaN })).toBe("");
    });
});
