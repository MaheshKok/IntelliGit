// @vitest-environment jsdom

// Large-document rendering flow test for the merge editor webview.
// Renders a 1,000-line document with 50 true conflicts, then verifies that
// resolving hunks and applying still work end-to-end and that the initial
// render plus a single resolution stay within generous time bounds. This
// guards the memoization layer: an accidental O(segments^2) re-render or a
// broken memo comparator shows up here as either wrong content or a timeout.

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { act } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { flush } from "../../helpers/reactDomTestUtils";
import { installWebviewI18n } from "../../helpers/webviewI18nTestUtils";
import { computeDiffSegments } from "../../../src/diff/diffSegments";
import { MAX_DIFF_RENDER_GROWTH, exceedsRenderGrowth } from "../../../src/diff/diffBudgets";
import type { DiffViewerData } from "../../../src/webviews/protocol/diffViewerTypes";

interface MockVsCodeApi {
    postMessage: ReturnType<typeof vi.fn>;
    getState: () => unknown;
    setState: (state: unknown) => void;
}

function createRootHost(): HTMLDivElement {
    const root = document.createElement("div");
    root.id = "root";
    document.body.appendChild(root);
    return root;
}

function installVsCodeMock(): MockVsCodeApi {
    const api: MockVsCodeApi = {
        postMessage: vi.fn(),
        getState: vi.fn(() => ({})),
        setState: vi.fn(),
    };
    Object.defineProperty(globalThis, "acquireVsCodeApi", {
        configurable: true,
        value: vi.fn(() => api),
    });
    installWebviewI18n();
    return api;
}

function dispatchHostMessage(data: unknown): void {
    act(() => {
        window.dispatchEvent(new MessageEvent("message", { data }));
    });
}

const CONFLICT_COUNT = 50;
const COMMON_LINES_PER_GAP = 19;

interface SyntheticData {
    segments: unknown[];
    expectedTheirsContent: string;
}

/**
 * Builds a ~1,000-line merge document alternating 19-line common gaps with 50
 * single-line true conflicts, and the expected file content when every
 * conflict resolves to the theirs side.
 */
function buildLargeConflictData(): SyntheticData {
    const segments: unknown[] = [];
    const expectedLines: string[] = [];
    for (let i = 0; i < CONFLICT_COUNT; i++) {
        const commonLines = Array.from(
            { length: COMMON_LINES_PER_GAP },
            (_, j) => `common_${i}_${j}();`,
        );
        segments.push({ type: "common", lines: commonLines });
        expectedLines.push(...commonLines);
        segments.push({
            type: "conflict",
            id: i,
            changeKind: "conflict",
            oursLines: [`ours_${i}();`],
            theirsLines: [`theirs_${i}();`],
            baseLines: [`base_${i}();`],
        });
        expectedLines.push(`theirs_${i}();`);
    }
    return {
        segments,
        expectedTheirsContent: expectedLines.join("\n") + "\n",
    };
}

function readMeasuredFile(relativePath: string): string {
    return readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
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

function buildViewerData(sourceFile: string, name: string): DiffViewerData {
    const left = readMeasuredFile(sourceFile);
    const right = modifiedCopy(left, name);
    return {
        path: sourceFile,
        leftLabel: "left",
        rightLabel: "right",
        languageId: "typescript",
        ...computeDiffSegments(left, right),
        ignoreWhitespace: false,
    };
}

beforeAll(() => {
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
        value: true,
        configurable: true,
    });
    Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
    document.body.replaceChildren();
    vi.clearAllMocks();
    vi.resetModules();
});

describe("MergeEditorApp large document flow", () => {
    // Compute time and payload size are gated in tests/unit/diff/diffBudgets.test.ts,
    // in the node environment the ceilings were calibrated in. Re-asserting them here
    // would measure the same pure computation under jsdom, which renders nothing and
    // buys no coverage. What jsdom uniquely gates is render time, below.
    it("keeps accepted diff-viewer tiers within the measured render target", async () => {
        installVsCodeMock();
        createRootHost();

        await act(async () => {
            await import("../../../src/webviews/react/diff-viewer/DiffViewerApp");
        });
        await flush();

        const renderMs: Record<string, number> = {};
        const lineCount: Record<string, number> = {};
        for (const { name, sourceFile } of [
            { name: "small", sourceFile: "src/diff/wordDiff.ts" },
            { name: "typical", sourceFile: "src/services/diffService.ts" },
            { name: "large", sourceFile: "src/views/CommitPanelViewProvider.ts" },
        ]) {
            const data = buildViewerData(sourceFile, name);
            const renderStart = performance.now();
            dispatchHostMessage({ type: "setDiffData", data });
            await flush();
            renderMs[name] = performance.now() - renderStart;
            lineCount[name] = readMeasuredFile(sourceFile).split("\n").length;

            expect(document.querySelectorAll(".diff-pane .code-block").length).toBeGreaterThan(0);
        }

        // `MAX_DIFF_RENDER_GROWTH` is derived from these two tiers standing in a 2.12:1 line
        // ratio, so swapping either source silently redefines what the threshold means -- a
        // larger `large` would raise the honest ratio and false-fire, a smaller one would raise
        // the bar a real regression has to clear. Checked here because this is the only place
        // that names the files.
        const lineRatio = lineCount.large / lineCount.typical;
        expect(
            lineRatio,
            `the render growth threshold assumes a 2.12:1 line ratio between the large and ` +
                `typical tiers; these sources now stand at ${lineCount.large}:${lineCount.typical} ` +
                `= ${lineRatio.toFixed(3)}:1, so the threshold no longer means what it was ` +
                `derived to mean`,
        ).toBeCloseTo(2.12, 1);

        // Wall-clock is compared against the same run's smaller tier rather than against a
        // constant, so host speed cancels: under CPU saturation these readings inflate 3.5x
        // together while their ratio moves 2%. The absolute this replaced failed on every
        // saturated run, which is why it had to be suspended on CI and still flaked locally.
        // `diffRenderGrowth.test.ts` holds the two measured populations and the derivation.
        expect(
            exceedsRenderGrowth(renderMs.large, renderMs.typical),
            `render time grew ${(renderMs.large / renderMs.typical).toFixed(2)}x from the ` +
                `typical tier to the large one (${renderMs.typical.toFixed(0)}ms -> ` +
                `${renderMs.large.toFixed(0)}ms) against a ${MAX_DIFF_RENDER_GROWTH}x ceiling. ` +
                `A linear pipeline over these tiers measures 2.12x; a quadratic re-render ` +
                `measured 3.43x when one was injected. This ratio is host-independent, so a ` +
                `slow machine is not an explanation for it`,
        ).toBe(false);
    }, 20_000);

    it("renders 1,000 lines with 50 conflicts and resolves them end-to-end", async () => {
        const vscode = installVsCodeMock();
        createRootHost();

        await act(async () => {
            await import("../../../src/webviews/react/merge-editor/MergeEditorApp");
        });
        await flush();

        const { segments, expectedTheirsContent } = buildLargeConflictData();

        const renderStart = performance.now();
        dispatchHostMessage({
            type: "setConflictData",
            data: {
                filePath: "src/huge.ts",
                oursLabel: "main",
                theirsLabel: "feature",
                eol: "\n",
                hasTrailingNewline: true,
                segments,
            },
        });
        await flush();
        const renderMs = performance.now() - renderStart;

        expect(document.body.textContent).toContain(`${CONFLICT_COUNT} unresolved`);
        // Generous bound for jsdom; a quadratic re-render regression blows
        // far past this while the memoized pipeline stays well under it.
        expect(renderMs).toBeLessThan(15_000);

        // Resolving a single hunk must stay cheap relative to the full render:
        // with working memoization only the affected segment re-renders.
        const acceptAll = Array.from(document.querySelectorAll("button")).find(
            (b) => b.textContent?.trim() === "Accept All Theirs",
        );
        if (!acceptAll) throw new Error("Expected the Accept All Theirs button");
        const resolveStart = performance.now();
        act(() => {
            acceptAll.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        await flush();
        const resolveMs = performance.now() - resolveStart;
        expect(resolveMs).toBeLessThan(10_000);

        expect(document.body.textContent).toContain("0 unresolved");

        const apply = Array.from(document.querySelectorAll("button")).find((b) =>
            b.textContent?.trim().startsWith("Apply ("),
        );
        if (!apply) throw new Error("Expected the Apply button");
        act(() => {
            apply.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });

        expect(vscode.postMessage).toHaveBeenCalledWith({
            type: "applyResolution",
            content: expectedTheirsContent,
        });
    }, 20_000);

    it("keeps per-segment size hints so offscreen virtualization has stable geometry", async () => {
        installVsCodeMock();
        createRootHost();

        await act(async () => {
            await import("../../../src/webviews/react/merge-editor/MergeEditorApp");
        });
        await flush();

        dispatchHostMessage({
            type: "setConflictData",
            data: {
                filePath: "src/sized.ts",
                oursLabel: "main",
                theirsLabel: "feature",
                eol: "\n",
                hasTrailingNewline: true,
                segments: [
                    { type: "common", lines: ["a();", "b();", "c();"] },
                    {
                        type: "conflict",
                        id: 0,
                        changeKind: "conflict",
                        oursLines: ["ours();"],
                        theirsLines: ["theirs();"],
                        baseLines: ["base();"],
                    },
                ],
            },
        });
        await flush();

        const common = document.querySelector<HTMLElement>(".segment-common");
        const conflict = document.querySelector<HTMLElement>(".segment-conflict");
        // 3 common lines * 20px row height.
        expect(common?.style.containIntrinsicSize).toBe("auto 60px");
        // 1 result row * 20px — conflict rules add no height (zero-height inset
        // shadow), so the intrinsic size matches the content box exactly.
        expect(conflict?.style.containIntrinsicSize).toBe("auto 20px");
    });
});
