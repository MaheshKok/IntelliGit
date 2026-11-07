import { describe, expect, it } from "vitest";
import {
    CI_EXCERPT_MAX_BYTES,
    CI_EXCERPT_MAX_LINES,
    sanitizeExcerpt,
} from "../../../../src/shared/ci/excerpt";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const utf8Length = (text: string): number => new TextEncoder().encode(text).length;

describe("sanitizeExcerpt", () => {
    it("caps at 40 lines and 8 KB", () => {
        const manyLines = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
        const lines = sanitizeExcerpt(manyLines).split("\n");
        expect(CI_EXCERPT_MAX_LINES).toBe(40);
        expect(lines).toHaveLength(40);
        expect(lines[39]).toBe("line 39");

        // A 30 MB single-line log: the bound is bytes, not lines.
        const huge = "x".repeat(30 * 1024 * 1024);
        const capped = sanitizeExcerpt(huge);
        expect(CI_EXCERPT_MAX_BYTES).toBe(8 * 1024);
        expect(utf8Length(capped)).toBe(8 * 1024);
    });

    it("strips ANSI", () => {
        const text = `${ESC}[31;1mERROR${ESC}[0m: boom ${ESC}]0;title${BEL}done ${ESC}]8;;https://x${ESC}\\link`;
        expect(sanitizeExcerpt(text)).toBe("ERROR: boom done link");
    });

    it("replaces bidi controls", () => {
        const text = "a\u202eb\u2066c\u2069d\u202ae";
        expect(sanitizeExcerpt(text)).toBe("a\ufffdb\ufffdc\ufffdd\ufffde");
    });

    it("replaces other C0 and C1 controls but keeps newline and tab", () => {
        const text = `a\u0000b\u0008c\u009Bd\u007Fe\tf\ng${ESC}h`;
        expect(sanitizeExcerpt(text)).toBe("a\ufffdb\ufffdc\ufffdd\ufffde\tf\ng\ufffdh");
    });

    it("keeps CRLF logs on their lines and replaces a lone carriage return", () => {
        expect(sanitizeExcerpt("one\r\ntwo\rthree")).toBe("one\ntwo\ufffdthree");
    });

    it("HTML stays text", () => {
        const html = '<img src=x onerror="alert(1)"><script>x()</script>&amp;';
        expect(sanitizeExcerpt(html)).toBe(html);
    });

    it("cuts on a UTF-8 boundary", () => {
        // 8191 ASCII bytes then a 3-byte character: the character must not be split.
        const text = `${"a".repeat(CI_EXCERPT_MAX_BYTES - 1)}€tail`;
        const capped = sanitizeExcerpt(text);
        expect(capped).toBe("a".repeat(CI_EXCERPT_MAX_BYTES - 1));
        expect(capped).not.toContain("\ufffd");

        // A 4-byte emoji right at the edge.
        const emoji = `${"a".repeat(CI_EXCERPT_MAX_BYTES - 2)}😀`;
        expect(sanitizeExcerpt(emoji)).toBe("a".repeat(CI_EXCERPT_MAX_BYTES - 2));
        expect(sanitizeExcerpt("€😀")).toBe("€😀");
    });
});
