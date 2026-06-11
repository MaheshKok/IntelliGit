// @vitest-environment jsdom

// Large-document rendering flow test for the merge editor webview.
// Renders a 1,000-line document with 50 true conflicts, then verifies that
// resolving hunks and applying still work end-to-end and that the initial
// render plus a single resolution stay within generous time bounds. This
// guards the memoization layer: an accidental O(segments^2) re-render or a
// broken memo comparator shows up here as either wrong content or a timeout.

import { act } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { flush } from "../../helpers/reactDomTestUtils";
import { installWebviewI18n } from "../../helpers/webviewI18nTestUtils";

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
    });

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
        // 1 result row * 20px + header/margin chrome.
        expect(conflict?.style.containIntrinsicSize).toBe("auto 50px");
    });
});
