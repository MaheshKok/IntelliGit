import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { TYPE_SCALE, TYPE_SCALE_PX } from "../../../src/webviews/react/shared/tokens";

/**
 * Guards DESIGN.md §3: the webview renders four font sizes and no others.
 *
 * The rule was documented long before anything checked it, and it had already
 * drifted twice by the time it was: down to 10px on the amend-context block and
 * the status badge — below the product's own stated caption floor, on the two
 * places that carry a commit's identity — and up to 14px on ten dialog headings.
 * One of those was a bug and the other was the rule being wrong, which is
 * exactly the distinction a prose rule cannot make and a test can. 14 is now in
 * the scale for modal titles; 10 is gone.
 *
 * The scan is textual on purpose. Sizes are written as Chakra props
 * (`fontSize="12px"`), style-object literals (`fontSize: "12px"`), and CSS
 * declarations (`font-size: 12px`), so there is no single typed surface to
 * assert against — only the source. Tokenizing every size through `TYPE_SCALE`
 * would be the stronger fix and a much larger diff; this catches the drift the
 * cheap way and names every offender.
 */

const WEBVIEW_ROOT = join(__dirname, "../../../src/webviews");
const SCANNED_EXTENSIONS = [".ts", ".tsx", ".css"];

/**
 * Sizes that are glyph geometry rather than type.
 *
 * Listed one by one rather than skipped by pattern, so a new exemption has to be
 * argued for here instead of quietly widening the rule.
 */
const EXEMPT: ReadonlyArray<{ file: string; size: number; why: string }> = [
    {
        file: "react/merge-editor/merge-editor.css",
        size: 18,
        why: "`.hunk-action-glyph` draws the accept/reject marks as text. It is an icon that happens to be a character, sized to the hunk gutter, and reads as an affordance rather than as a label. 18 is the ceiling, not a taste call: a text range's client rect is the FONT box (ascent+descent ≈ 1.29em), so the glyph must stay under 24px/1.29 to fit its 24px `.action-btn`. The previous 22.5 produced a 29px font box that overflowed the scrolling ancestor wherever an action row sat flush against its top edge.",
    },
    {
        file: "react/shared/components/ReviewPromptCard.css",
        size: 26,
        why: "`.review-prompt-star` draws the rating control as ★ characters. The size is the hit target of a five-star row, not type — at any size on the scale the stars are too small to aim at.",
    },
];

interface Hit {
    file: string;
    line: number;
    size: number;
    text: string;
}

/**
 * The key a scanned file is reported and matched under: its path relative to the webview root,
 * always written with `/`.
 *
 * EXEMPT is a hand-written list keyed with forward slashes, but `sourceFiles` builds absolute paths
 * with `path.join`, which uses `\` on Windows. Slicing that directly produced
 * `react\merge-editor\merge-editor.css`, which matches no exemption -- so on the Windows leg of
 * #223 BOTH exempted declarations were reported as offenders, and the pinning test read their
 * match counts as 0 instead of 1. Neither is a real drift in the type scale; both are the same
 * separator mismatch, counted twice.
 *
 * `separator` is a parameter rather than a read of `path.sep` so a macOS run can exercise the
 * Windows branch -- an assertion that only fires on the platform where it breaks is a gate that
 * cannot be developed against.
 */
function exemptionKey(absolute: string, root: string, separator: string = sep): string {
    return absolute
        .slice(root.length + 1)
        .split(separator)
        .join("/");
}

function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
            sourceFiles(full, out);
            continue;
        }
        if (SCANNED_EXTENSIONS.some((ext) => entry.endsWith(ext))) out.push(full);
    }
    return out;
}

/** Matches `fontSize="13px"`, `fontSize: "13px"`, and `font-size: 13px`. */
const SIZE_PATTERN = /(?:fontSize\s*[=:]\s*["']|font-size\s*:\s*)(\d+(?:\.\d+)?)px/g;

function collectHits(): Hit[] {
    const hits: Hit[] = [];
    for (const file of sourceFiles(WEBVIEW_ROOT)) {
        const relative = exemptionKey(file, WEBVIEW_ROOT);
        readFileSync(file, "utf8")
            .split("\n")
            .forEach((text, index) => {
                for (const match of text.matchAll(SIZE_PATTERN)) {
                    hits.push({
                        file: relative,
                        line: index + 1,
                        size: Number(match[1]),
                        text: text.trim(),
                    });
                }
            });
    }
    return hits;
}

describe("type scale", () => {
    it("keys a scanned file the way EXEMPT is written, whichever separator the host uses", () => {
        // Both branches asserted from one run: EXEMPT's keys are forward-slashed by hand, so a
        // Windows-shaped absolute path has to arrive at the same key a POSIX one does.
        expect(
            exemptionKey(
                "D:\\src\\webviews\\react\\merge-editor\\merge-editor.css",
                "D:\\src\\webviews",
                "\\",
            ),
        ).toBe("react/merge-editor/merge-editor.css");
        expect(
            exemptionKey("/src/webviews/react/merge-editor/merge-editor.css", "/src/webviews", "/"),
        ).toBe("react/merge-editor/merge-editor.css");
    });

    it("exposes exactly the four documented sizes", () => {
        expect(TYPE_SCALE).toEqual({ caption: 11, label: 12, body: 13, dialogTitle: 14 });
        expect([...TYPE_SCALE_PX].sort((a, b) => a - b)).toEqual([11, 12, 13, 14]);
    });

    it("renders no font size outside the scale anywhere in the webview", () => {
        const offenders = collectHits().filter(
            (hit) =>
                !TYPE_SCALE_PX.includes(hit.size) &&
                !EXEMPT.some((e) => e.file === hit.file && e.size === hit.size),
        );
        expect(
            offenders.map((hit) => `${hit.file}:${hit.line} → ${hit.size}px  (${hit.text})`),
        ).toEqual([]);
    });

    it("keeps every exemption pinned to exactly one declaration", () => {
        // An exemption is keyed on file+size, so it also covers a SECOND declaration of that size
        // in the same file, silently. That was academic while the glyph was 22.5px; at 18px --
        // a size common enough to be typed by accident -- it is a real hole. Requiring exactly one
        // match closes it in both directions: a second offender fails, and an exemption whose
        // declaration was deleted or resized fails instead of rotting into a permanent licence.
        const hits = collectHits();
        expect(
            EXEMPT.map((e) => {
                const matches = hits.filter((hit) => hit.file === e.file && hit.size === e.size);
                return `${e.file} @ ${e.size}px → ${matches.length}`;
            }),
        ).toEqual(EXEMPT.map((e) => `${e.file} @ ${e.size}px → 1`));
    });

    it("finds the sizes it is supposed to be scanning", () => {
        // Guards the regex itself: a pattern that silently matched nothing would
        // make the assertion above pass forever.
        const hits = collectHits();
        expect(hits.length).toBeGreaterThan(50);
        expect(new Set(hits.map((hit) => hit.size))).toContain(TYPE_SCALE.body);
    });
});
