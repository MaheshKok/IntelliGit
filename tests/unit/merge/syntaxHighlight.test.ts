import { describe, it, expect } from "vitest";
import { tokenizeSyntaxLine } from "../../../src/webviews/react/merge-editor/syntaxHighlight";
import type { SyntaxToken } from "../../../src/webviews/react/merge-editor/syntaxHighlight";

function joined(tokens: SyntaxToken[]): string {
    return tokens.map((token) => token.text).join("");
}

describe("tokenizeSyntaxLine", () => {
    it("returns no tokens for an empty line", () => {
        expect(tokenizeSyntaxLine("")).toEqual([]);
    });

    it("classifies a whitespace-only line as plain", () => {
        expect(tokenizeSyntaxLine("    ")).toEqual([{ text: "    ", kind: "plain" }]);
    });

    it("concatenates tokens back to the exact input line", () => {
        const lines = [
            "const url = \"https://example.com\"; // trailing note",
            "\tif (x <= 10) { return 'a\\'b'; }",
            "let n = 3.14 + arr[0];",
            "// whole line comment",
            "plain words only",
        ];
        for (const line of lines) {
            expect(joined(tokenizeSyntaxLine(line))).toBe(line);
        }
    });

    it("classifies keywords, numbers, and plain text in a code line", () => {
        const tokens = tokenizeSyntaxLine("const count = 42;");

        expect(tokens).toEqual([
            { text: "const", kind: "keyword" },
            { text: " count = ", kind: "plain" },
            { text: "42", kind: "number" },
            { text: ";", kind: "plain" },
        ]);
    });

    it("classifies language constants distinctly from keywords", () => {
        const tokens = tokenizeSyntaxLine("return value ?? null;");

        expect(tokens).toContainEqual({ text: "return", kind: "keyword" });
        expect(tokens).toContainEqual({ text: "null", kind: "constant" });
    });

    it("matches decimal numbers as a single token", () => {
        expect(tokenizeSyntaxLine("x = 3.14")).toContainEqual({ text: "3.14", kind: "number" });
    });

    it("does not classify digits inside an identifier as a number", () => {
        const tokens = tokenizeSyntaxLine("vec2 = base64");

        expect(tokens.every((token) => token.kind === "plain")).toBe(true);
    });

    it("does not classify keyword prefixes of longer identifiers", () => {
        const tokens = tokenizeSyntaxLine("constructor(iffy, classy)");

        expect(tokens.some((token) => token.kind === "keyword")).toBe(false);
    });

    it("classifies double, single, and backtick strings", () => {
        for (const line of ['a = "txt"', "a = 'txt'", "a = `txt`"]) {
            const tokens = tokenizeSyntaxLine(line);
            expect(tokens).toContainEqual({ text: line.slice(4), kind: "string" });
        }
    });

    it("keeps an escaped quote inside its string literal", () => {
        const tokens = tokenizeSyntaxLine('say("he said \\"hi\\"")');

        expect(tokens).toContainEqual({ text: '"he said \\"hi\\""', kind: "string" });
    });

    it("extends an unterminated string to the end of the line", () => {
        const tokens = tokenizeSyntaxLine('msg = "unterminated');

        expect(tokens[tokens.length - 1]).toEqual({ text: '"unterminated', kind: "string" });
    });

    it("does not start a comment from slashes inside a string", () => {
        const tokens = tokenizeSyntaxLine('const url = "https://example.com";');

        expect(tokens.some((token) => token.kind === "comment")).toBe(false);
        expect(tokens).toContainEqual({ text: '"https://example.com"', kind: "string" });
    });

    it("does not ignore keywords inside string literals", () => {
        const tokens = tokenizeSyntaxLine('a = "return if"');

        expect(tokens.some((token) => token.kind === "keyword")).toBe(false);
    });

    it("classifies a whole-line comment", () => {
        expect(tokenizeSyntaxLine("// note about const")).toEqual([
            { text: "// note about const", kind: "comment" },
        ]);
    });

    it("classifies an indented comment with leading whitespace as plain", () => {
        expect(tokenizeSyntaxLine("    // indented")).toEqual([
            { text: "    ", kind: "plain" },
            { text: "// indented", kind: "comment" },
        ]);
    });

    it("classifies a trailing comment after code while keeping code tokens", () => {
        const tokens = tokenizeSyntaxLine("let x = 1; // counter");

        expect(tokens).toContainEqual({ text: "let", kind: "keyword" });
        expect(tokens).toContainEqual({ text: "1", kind: "number" });
        expect(tokens[tokens.length - 1]).toEqual({ text: "// counter", kind: "comment" });
    });

    it("starts the comment only at slashes that follow a closed string", () => {
        const tokens = tokenizeSyntaxLine('go("https://a.b"); // done');

        expect(tokens).toContainEqual({ text: '"https://a.b"', kind: "string" });
        expect(tokens[tokens.length - 1]).toEqual({ text: "// done", kind: "comment" });
    });

    it("does not treat a single division slash as a comment", () => {
        const tokens = tokenizeSyntaxLine("ratio = a / b");

        expect(tokens.some((token) => token.kind === "comment")).toBe(false);
    });
});
