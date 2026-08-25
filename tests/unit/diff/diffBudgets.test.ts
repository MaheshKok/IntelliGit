import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
    FileType: { Directory: 2, SymbolicLink: 64 },
    Uri: {
        file: (fsPath: string) => ({ fsPath, toString: () => `file://${fsPath}` }),
        joinPath: (root: { fsPath: string }, filePath: string) => ({
            fsPath: `${root.fsPath}/${filePath}`,
            toString: () => `file://${root.fsPath}/${filePath}`,
        }),
    },
    workspace: { fs: { stat: vi.fn(), readFile: vi.fn() }, textDocuments: [] },
}));
import { timingBudgetsApply } from "../../helpers/timingBudgets";
import { computeDiffSegments } from "../../../src/diff/diffSegments";
import { countLines } from "../../../src/diff/sideLoader";
import {
    exceedsDiffBudget,
    MAX_DIFF_BYTES,
    MAX_DIFF_COMPUTE_MS,
    MAX_DIFF_DP_CELLS,
    MAX_DIFF_LINES,
    MAX_DIFF_PAYLOAD_BYTES,
} from "../../../src/diff/diffBudgets";

function buildLines(count: number, prefix: string, width = 0): string {
    return Array.from({ length: count }, (_, index) => {
        const value = `${prefix}-${index}`;
        return width > value.length ? value + "x".repeat(width - value.length) : value;
    }).join("\n");
}

function readMeasuredFile(relativePath: string): string {
    return readFileSync(new URL(`../../../${relativePath}`, import.meta.url), "utf8");
}

function modifiedCopy(source: string, marker: string): string {
    const lines = source.split("\n");
    const lineCount = lines.at(-1) === "" ? lines.length - 1 : lines.length;
    const editCount = Math.max(1, Math.ceil(lineCount * 0.02));
    const start = Math.floor(lineCount * 0.37);
    for (let offset = 0; offset < editCount; offset++) {
        const index = Math.min(start + offset, lineCount - 1);
        lines[index] = `${lines[index]} // measured ${marker} edit ${offset}`;
    }
    return lines.join("\n");
}

function measuredFixtures(): readonly (readonly [string, string, string])[] {
    return [
        [
            "small",
            readMeasuredFile("src/diff/wordDiff.ts"),
            modifiedCopy(readMeasuredFile("src/diff/wordDiff.ts"), "small"),
        ],
        [
            "typical",
            readMeasuredFile("src/services/diffService.ts"),
            modifiedCopy(readMeasuredFile("src/services/diffService.ts"), "typical"),
        ],
        [
            "large",
            readMeasuredFile("src/views/CommitPanelViewProvider.ts"),
            modifiedCopy(readMeasuredFile("src/views/CommitPanelViewProvider.ts"), "large"),
        ],
    ];
}

describe("measured diff viewer budgets", () => {
    it("keeps small, typical, and large measured tiers within the host targets", () => {
        for (const [name, left, right] of measuredFixtures()) {
            const startedAt = performance.now();
            const computed = computeDiffSegments(left, right);
            const elapsedMs = performance.now() - startedAt;
            const payload = {
                path: "src/measurement.ts",
                leftLabel: "left",
                rightLabel: "right",
                languageId: "typescript",
                ...computed,
                ignoreWhitespace: false,
            };
            expect(
                exceedsDiffBudget(
                    {
                        bytes: Buffer.from(left),
                        lineCount: countLines(Buffer.from(left)),
                        text: left,
                    },
                    {
                        bytes: Buffer.from(right),
                        lineCount: countLines(Buffer.from(right)),
                        text: right,
                    },
                ),
                name,
            ).toBe(false);
            if (timingBudgetsApply) {
                expect(elapsedMs, `${name} compute`).toBeLessThan(MAX_DIFF_COMPUTE_MS);
            }
            expect(
                Buffer.byteLength(JSON.stringify(payload), "utf8"),
                `${name} payload bytes`,
            ).toBeLessThan(MAX_DIFF_PAYLOAD_BYTES);
        }
    });

    it("uses the production line counter for newline-terminated content", () => {
        const content = Buffer.from("one\ntwo\n", "utf8");

        expect(countLines(content)).toBe(2);
        expect(content.toString("utf8").split("\n").length).toBe(3);
    });

    it("rejects the pathological corpus before the viewer panel computes", () => {
        const manyLines = buildLines(3_500, "many-left");
        const longLines = buildLines(1_200, "long-left", 2_048);

        const manyRight = buildLines(3_500, "many-right");
        const longRight = buildLines(1_200, "long-right", 2_048);

        expect(
            exceedsDiffBudget(
                { bytes: Buffer.from("line"), lineCount: MAX_DIFF_LINES + 1, text: "line" },
                { bytes: Buffer.from("line"), lineCount: 1, text: "line" },
            ),
        ).toBe(true);
        expect(
            exceedsDiffBudget(
                { bytes: Buffer.from(manyLines), lineCount: 3_500, text: manyLines },
                { bytes: Buffer.from(manyRight), lineCount: 3_500, text: manyRight },
            ),
        ).toBe(true);
        expect(
            exceedsDiffBudget(
                { bytes: Buffer.from(longLines), lineCount: 1_200, text: longLines },
                { bytes: Buffer.from(longRight), lineCount: 1_200, text: longRight },
            ),
        ).toBe(true);
    });

    /**
     * The per-side caps bound each side independently, so a pair can carry 2 x `MAX_DIFF_BYTES`
     * = 420,188 bytes into a 439,048-byte payload budget with nothing left for escaping. This
     * pair is what that admits with entirely ordinary content: one minified line per side, under
     * every byte, line, and DP-cell cap, serializing to 493,536 bytes -- 1.12x the budget.
     *
     * Asserted through the real serializer rather than against a recorded number, so the case
     * still measures the gate if the payload shape changes.
     */
    it("rejects a pair whose serialized payload exceeds the budget under every other cap", () => {
        const minified = (salt: string): string => {
            const unit = `function ${salt}(a,b){return{"k":a,"v":b,"s":"x"};};`;
            let out = "";
            while (Buffer.byteLength(out, "utf8") < MAX_DIFF_BYTES - 10) out += unit;
            return out.slice(0, MAX_DIFF_BYTES - 10);
        };
        const left = minified("l");
        const right = minified("r");
        const leftBytes = Buffer.from(left, "utf8");
        const rightBytes = Buffer.from(right, "utf8");

        // Every pre-existing cap admits this pair; only the payload budget can reject it.
        expect(leftBytes.byteLength, "left bytes").toBeLessThanOrEqual(MAX_DIFF_BYTES);
        expect(rightBytes.byteLength, "right bytes").toBeLessThanOrEqual(MAX_DIFF_BYTES);
        expect(countLines(leftBytes), "left lines").toBeLessThanOrEqual(MAX_DIFF_LINES);
        expect(countLines(rightBytes), "right lines").toBeLessThanOrEqual(MAX_DIFF_LINES);
        expect(countLines(leftBytes) * countLines(rightBytes), "DP cells").toBeLessThanOrEqual(
            MAX_DIFF_DP_CELLS,
        );

        const payload = {
            path: "vendor/bundle.min.js",
            leftLabel: "left",
            rightLabel: "right",
            languageId: "javascript",
            ...computeDiffSegments(left, right),
            ignoreWhitespace: false,
        };
        expect(
            Buffer.byteLength(JSON.stringify(payload), "utf8"),
            "the pair must genuinely exceed the payload budget, or this asserts nothing",
        ).toBeGreaterThan(MAX_DIFF_PAYLOAD_BYTES);

        expect(
            exceedsDiffBudget(
                { bytes: leftBytes, lineCount: countLines(leftBytes), text: left },
                { bytes: rightBytes, lineCount: countLines(rightBytes), text: right },
            ),
            "a pair that serializes past the payload budget must not reach the viewer",
        ).toBe(true);
    });
});
