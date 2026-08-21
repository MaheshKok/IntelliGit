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
import { computeDiffSegments } from "../../../src/diff/diffSegments";
import { countLines } from "../../../src/diff/sideLoader";
import {
    exceedsDiffBudget,
    MAX_DIFF_COMPUTE_MS,
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
                    { bytes: Buffer.from(left), lineCount: countLines(Buffer.from(left)) },
                    { bytes: Buffer.from(right), lineCount: countLines(Buffer.from(right)) },
                ),
                name,
            ).toBe(false);
            expect(elapsedMs, `${name} compute`).toBeLessThan(MAX_DIFF_COMPUTE_MS);
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

        expect(
            exceedsDiffBudget(
                { bytes: Buffer.from("line"), lineCount: MAX_DIFF_LINES + 1 },
                { bytes: Buffer.from("line"), lineCount: 1 },
            ),
        ).toBe(true);
        expect(
            exceedsDiffBudget(
                { bytes: Buffer.from(manyLines), lineCount: 3_500 },
                { bytes: Buffer.from(buildLines(3_500, "many-right")), lineCount: 3_500 },
            ),
        ).toBe(true);
        expect(
            exceedsDiffBudget(
                { bytes: Buffer.from(longLines), lineCount: 1_200 },
                { bytes: Buffer.from(buildLines(1_200, "long-right", 2_048)), lineCount: 1_200 },
            ),
        ).toBe(true);
    });
});
