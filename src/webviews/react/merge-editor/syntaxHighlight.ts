// Pure line tokenizer for the merge editor's lightweight syntax highlighting.
// Splits a single source line into classified tokens (comment, string,
// keyword, constant, number, plain) that the CodeBlock render layer maps to
// theme-colored spans. Single-line scan only: multi-line constructs such as
// block comments and regex literals are intentionally out of scope.

/** Classification of one slice of a source line. */
export type SyntaxTokenKind = "plain" | "comment" | "string" | "keyword" | "constant" | "number";

/** One contiguous slice of a line together with its classification. */
export interface SyntaxToken {
    text: string;
    kind: SyntaxTokenKind;
}

const KEYWORD_REGEX =
    /\b(import|from|const|let|var|class|interface|type|function|return|if|else|for|while|switch|case|break|continue|new|export|default|private|public|protected|readonly|static|async|await)\b|\b(true|false|null|undefined)\b|\b\d+(\.\d+)?\b/g;

/** Appends keyword/constant/number/plain tokens for a code-only slice. */
function appendCodeTokens(tokens: SyntaxToken[], text: string): void {
    if (!text) return;
    let last = 0;
    for (const match of text.matchAll(KEYWORD_REGEX)) {
        const start = match.index ?? 0;
        if (start > last) {
            tokens.push({ text: text.slice(last, start), kind: "plain" });
        }
        const kind: SyntaxTokenKind = match[1] ? "keyword" : match[2] ? "constant" : "number";
        tokens.push({ text: match[0], kind });
        last = start + match[0].length;
    }
    if (last < text.length) {
        tokens.push({ text: text.slice(last), kind: "plain" });
    }
}

/**
 * Returns the index one past the end of a string literal starting at `start`.
 * Honors backslash escapes; an unterminated literal extends to end of line.
 */
function scanStringEnd(line: string, start: number): number {
    const quote = line[start];
    let i = start + 1;
    while (i < line.length) {
        if (line[i] === "\\") {
            i += 2;
            continue;
        }
        if (line[i] === quote) return i + 1;
        i += 1;
    }
    return line.length;
}

/**
 * Tokenizes one source line into classified slices.
 *
 * The tokens concatenate back to the input exactly. String literals are
 * detected first so that `//` inside a string never starts a comment; the
 * first `//` outside a string turns the remainder of the line into a single
 * comment token.
 */
export function tokenizeSyntaxLine(line: string): SyntaxToken[] {
    const tokens: SyntaxToken[] = [];
    let codeStart = 0;
    let i = 0;
    while (i < line.length) {
        const ch = line[i];
        if (ch === '"' || ch === "'" || ch === "`") {
            appendCodeTokens(tokens, line.slice(codeStart, i));
            const end = scanStringEnd(line, i);
            tokens.push({ text: line.slice(i, end), kind: "string" });
            i = end;
            codeStart = i;
            continue;
        }
        if (ch === "/" && line[i + 1] === "/") {
            appendCodeTokens(tokens, line.slice(codeStart, i));
            tokens.push({ text: line.slice(i), kind: "comment" });
            return tokens;
        }
        i += 1;
    }
    appendCodeTokens(tokens, line.slice(codeStart));
    return tokens;
}
