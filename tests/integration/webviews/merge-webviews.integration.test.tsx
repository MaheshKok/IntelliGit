// @vitest-environment jsdom

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

function clickButton(label: string): void {
    const button = Array.from(document.querySelectorAll("button")).find(
        (candidate) =>
            candidate.textContent?.trim() === label ||
            candidate.getAttribute("aria-label") === label ||
            candidate.getAttribute("title") === label,
    );
    if (!button) throw new Error(`Expected button labeled ${label}`);
    act(() => {
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
}

function findButton(label: string): HTMLButtonElement {
    const button = Array.from(document.querySelectorAll("button")).find(
        (candidate) =>
            candidate.textContent?.trim() === label ||
            candidate.getAttribute("aria-label") === label ||
            candidate.getAttribute("title") === label,
    );
    if (!button) throw new Error(`Expected button labeled ${label}`);
    return button;
}

function pressKey(key: string, init: KeyboardEventInit = {}): void {
    act(() => {
        window.dispatchEvent(
            new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }),
        );
    });
}

/**
 * Advances past a macrotask so the deferred Shiki init (requestIdleCallback with
 * a setTimeout fallback) runs; jsdom lacks requestIdleCallback, so the fallback
 * timer fires here. The microtask-only `flush()` cannot observe it.
 */
async function flushShikiInit(): Promise<void> {
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

/**
 * Waits out jsdom's ~16ms requestAnimationFrame timer so the merge scroll
 * driver's scheduled frame runs and connector path `d` attributes are set.
 * The microtask-only `flush()` never reaches macrotask-backed rAF callbacks.
 */
async function flushAnimationFrame(): Promise<void> {
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
    });
}

/** Conflict payload with two true conflicts separated by common code. */
function twoConflictData(): unknown {
    return {
        filePath: "src/conflict.ts",
        oursLabel: "main",
        theirsLabel: "feature/incoming",
        eol: "\n",
        hasTrailingNewline: true,
        segments: [
            { type: "common", lines: ["head();"] },
            {
                type: "conflict",
                id: 0,
                changeKind: "conflict",
                oursLines: ["a_ours();"],
                theirsLines: ["a_theirs();"],
                baseLines: ["a_base();"],
            },
            { type: "common", lines: ["mid();"] },
            {
                type: "conflict",
                id: 1,
                changeKind: "conflict",
                oursLines: ["b_ours();"],
                theirsLines: ["b_theirs();"],
                baseLines: ["b_base();"],
            },
        ],
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

describe("MergeConflictSessionApp", () => {
    it("renders conflict files and posts selected-file actions", async () => {
        const vscode = installVsCodeMock();
        createRootHost();

        await act(async () => {
            await import("../../../src/webviews/react/merge-conflicts-session/MergeConflictSessionApp");
        });
        await flush();

        expect(vscode.postMessage).toHaveBeenCalledWith({ type: "ready" });

        dispatchHostMessage({
            type: "setSessionData",
            data: {
                sourceBranch: "feature/incoming",
                targetBranch: "main",
                files: [
                    {
                        path: "src/conflict.ts",
                        code: "UU",
                        ours: "Modified",
                        theirs: "Modified",
                    },
                    {
                        path: "docs/readme.md",
                        code: "AA",
                        ours: "Added",
                        theirs: "Added",
                    },
                ],
            },
        });
        await flush();

        expect(document.body.textContent).toContain("feature/incoming");
        expect(document.body.textContent).toContain("conflict.ts");
        expect(document.body.textContent).toContain("src");

        const conflictRow = Array.from(document.querySelectorAll("tr.row")).find((row) =>
            row.textContent?.includes("conflict.ts"),
        );
        if (!conflictRow) throw new Error("Expected the conflict file row");
        vscode.postMessage.mockClear();
        act(() => {
            conflictRow.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        await flush();
        expect(vscode.postMessage).toHaveBeenCalledWith({
            type: "openMerge",
            filePath: "src/conflict.ts",
        });

        clickButton("Accept Yours");
        clickButton("Accept Theirs");
        clickButton("Merge...");
        clickButton("Refresh");
        clickButton("Abort Merge");
        clickButton("Close");

        expect(vscode.postMessage).toHaveBeenCalledWith({
            type: "acceptYours",
            filePath: "src/conflict.ts",
        });
        expect(vscode.postMessage).toHaveBeenCalledWith({
            type: "acceptTheirs",
            filePath: "src/conflict.ts",
        });
        expect(vscode.postMessage).toHaveBeenCalledWith({
            type: "openMerge",
            filePath: "src/conflict.ts",
        });
        expect(vscode.postMessage).toHaveBeenCalledWith({ type: "refresh" });
        expect(vscode.postMessage).toHaveBeenCalledWith({ type: "abortMerge" });
        expect(vscode.postMessage).toHaveBeenCalledWith({ type: "close" });
    });
});

describe("MergeEditorApp", () => {
    it("resolves a conflict and applies the resulting content", async () => {
        const vscode = installVsCodeMock();
        createRootHost();

        await act(async () => {
            await import("../../../src/webviews/react/merge-editor/MergeEditorApp");
        });
        await flush();

        expect(vscode.postMessage).toHaveBeenCalledWith({ type: "ready" });

        dispatchHostMessage({
            type: "setConflictData",
            data: {
                filePath: "src/conflict.ts",
                oursLabel: "main",
                theirsLabel: "feature/incoming",
                eol: "\n",
                hasTrailingNewline: true,
                segments: [
                    {
                        type: "common",
                        lines: ["shared();"],
                    },
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

        expect(document.body.textContent).toContain("src/conflict.ts");
        expect(document.body.textContent).toContain("1 unresolved");
        expect(document.querySelectorAll('[data-conflict-id="0"] .action-btn')).toHaveLength(4);

        clickButton("Conflicts");
        clickButton("Abort Merge");
        clickButton("Accept left block");
        await flush();
        expect(document.body.textContent).toContain("0 unresolved");
        expect(document.querySelector('[data-conflict-id="0"] .conflict-actions-left')).toBeNull();
        expect(
            document.querySelectorAll('[data-conflict-id="0"] .conflict-actions-right .action-btn'),
        ).toHaveLength(2);
        expect(
            document.querySelector('[data-conflict-id="0"] .conflict-ours')?.className,
        ).toContain("accepted-pane");
        expect(
            document.querySelector('[data-conflict-id="0"] .conflict-result')?.className,
        ).not.toContain("accepted-pane");
        expect(
            document.querySelector('[data-conflict-id="0"] .conflict-result')?.className,
        ).toContain("unresolved");
        expect(
            document.querySelector('[data-conflict-id="0"] .result-insertion-marker.marker-bottom'),
        ).not.toBeNull();
        expect(
            document.querySelector(
                '[data-conflict-id="0"] .source-insertion-marker.marker-left.marker-bottom',
            ),
        ).not.toBeNull();
        expect(
            document.querySelector('[data-conflict-id="0"] .source-insertion-marker.marker-right'),
        ).toBeNull();
        // The accepted left side keeps its conflict color but flips to the
        // dotted resolved contour; the right suggestion stays a filled band.
        // (Path `d` shapes are asserted in the insert-conflict test whose hunk
        // sits at y=0 — this hunk is culled under jsdom's zero-height viewport.)
        const connectors = document.querySelectorAll<SVGPathElement>(".merge-connector");
        expect(connectors).toHaveLength(2);
        expect(connectors[0].getAttribute("class")).toContain("change-conflict");
        expect(connectors[0].getAttribute("class")).toContain("connector-resolved");
        expect(connectors[1].getAttribute("class")).toContain("change-conflict");
        expect(connectors[1].getAttribute("class")).not.toContain("connector-resolved");
        expect(
            document.querySelector('[data-conflict-id="0"] .conflict-theirs')?.className,
        ).not.toContain("accepted-pane");
        clickButton("Apply (1/1)");

        expect(vscode.postMessage).toHaveBeenCalledWith({ type: "openConflictSession" });
        expect(vscode.postMessage).toHaveBeenCalledWith({ type: "abortMerge" });
        expect(vscode.postMessage).toHaveBeenCalledWith({
            type: "applyResolution",
            content: "shared();\nours();\n",
        });
    });

    it("shows a thin result insertion marker for pending insert conflicts", async () => {
        installVsCodeMock();
        createRootHost();

        await act(async () => {
            await import("../../../src/webviews/react/merge-editor/MergeEditorApp");
        });
        await flush();

        dispatchHostMessage({
            type: "setConflictData",
            data: {
                filePath: "src/conflict.ts",
                oursLabel: "main",
                theirsLabel: "feature/incoming",
                eol: "\n",
                hasTrailingNewline: true,
                segments: [
                    {
                        type: "conflict",
                        id: 0,
                        changeKind: "conflict",
                        oursLines: ['import * as yaml from "yaml";'],
                        theirsLines: ['import * as toml from "toml";'],
                        baseLines: [],
                    },
                ],
            },
        });
        await flush();

        expect(document.querySelector(".result-insertion-marker.marker-top")).not.toBeNull();
        await flushAnimationFrame();
        const pendingConnectors = document.querySelectorAll<SVGPathElement>(".merge-connector");
        expect(pendingConnectors).toHaveLength(2);
        expect(
            Array.from(pendingConnectors).every((connector) =>
                connector.getAttribute("d")?.trim().endsWith("Z"),
            ),
        ).toBe(true);
        expect(
            Array.from(pendingConnectors).some((connector) =>
                connector.classList.contains("merge-connector-line"),
            ),
        ).toBe(false);

        clickButton("Accept left block");
        await flush();

        expect(document.querySelector(".result-insertion-marker.marker-top")).toBeNull();
        expect(document.querySelector(".result-insertion-marker.marker-bottom")).not.toBeNull();
        expect(
            document.querySelector(".source-insertion-marker.marker-left.marker-bottom"),
        ).not.toBeNull();
        expect(document.querySelector(".source-insertion-marker.marker-right")).toBeNull();
        // This hunk sits at y=0, so the frame actually draws it: the accepted
        // left side must switch to the open dotted contour (subpaths, no Z)
        // while the pending right side keeps the closed filled band.
        await flushAnimationFrame();
        const connectors = document.querySelectorAll<SVGPathElement>(".merge-connector");
        expect(connectors).toHaveLength(2);
        expect(connectors[0].getAttribute("class")).toContain("change-conflict");
        expect(connectors[0].getAttribute("class")).toContain("connector-resolved");
        expect(connectors[0].getAttribute("d")?.trim().endsWith("Z")).toBe(false);
        expect(connectors[1].getAttribute("class")).toContain("change-conflict");
        expect(connectors[1].getAttribute("class")).not.toContain("connector-resolved");
        expect(connectors[1].getAttribute("d")?.trim().endsWith("Z")).toBe(true);
    });

    it("attaches the viewport ResizeObserver to the scroller once conflict data mounts it", async () => {
        // The scroller only exists after data arrives (the loading branch renders
        // no .merge-content), so viewport tracking must attach at that point —
        // otherwise panel resizes leave viewport height and gutter x-ranges stale
        // and ribbons get culled against a dead viewport.
        const observed: Element[] = [];
        class RecordingResizeObserver {
            observe(target: Element): void {
                observed.push(target);
            }
            unobserve(): void {}
            disconnect(): void {}
        }
        Object.defineProperty(globalThis, "ResizeObserver", {
            configurable: true,
            value: RecordingResizeObserver,
        });
        try {
            installVsCodeMock();
            createRootHost();

            await act(async () => {
                await import("../../../src/webviews/react/merge-editor/MergeEditorApp");
            });
            await flush();
            expect(observed).toHaveLength(0);

            dispatchHostMessage({ type: "setConflictData", data: twoConflictData() });
            await flush();

            const content = document.querySelector(".merge-content");
            expect(content).not.toBeNull();
            expect(observed).toContain(content);
        } finally {
            delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
        }
    });

    it("edits the result pane manually and applies the edited content", async () => {
        const vscode = installVsCodeMock();
        createRootHost();

        await act(async () => {
            await import("../../../src/webviews/react/merge-editor/MergeEditorApp");
        });
        await flush();

        dispatchHostMessage({
            type: "setConflictData",
            data: {
                filePath: "src/conflict.ts",
                oursLabel: "main",
                theirsLabel: "feature/incoming",
                eol: "\n",
                hasTrailingNewline: true,
                segments: [
                    { type: "common", lines: ["shared();"] },
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
        expect(document.body.textContent).toContain("1 unresolved");

        // Enter edit mode by double-clicking the editable result block.
        const editable = document.querySelector(".result-editable");
        if (!editable) throw new Error("Expected an editable result block");
        act(() => {
            editable.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
        });
        await flush();

        const textarea = document.querySelector<HTMLTextAreaElement>(".result-edit-textarea");
        if (!textarea) throw new Error("Expected the result edit textarea to appear");
        expect(textarea.value).toBe("base();");

        // Type a manual fix-up, then blur to commit the edit.
        const valueSetter = Object.getOwnPropertyDescriptor(
            HTMLTextAreaElement.prototype,
            "value",
        )?.set;
        act(() => {
            valueSetter?.call(textarea, "merged_by_hand();");
            textarea.dispatchEvent(new Event("input", { bubbles: true }));
        });
        act(() => {
            textarea.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
        });
        await flush();

        // The manual edit resolves the conflict and marks the result block edited.
        expect(document.querySelector(".conflict-result.edited")).not.toBeNull();
        expect(document.body.textContent).toContain("0 unresolved");

        clickButton("Apply (1/1)");
        expect(vscode.postMessage).toHaveBeenCalledWith({
            type: "applyResolution",
            content: "shared();\nmerged_by_hand();\n",
        });
    });

    it("cancels an in-progress edit with Escape without resolving the hunk", async () => {
        const vscode = installVsCodeMock();
        createRootHost();

        await act(async () => {
            await import("../../../src/webviews/react/merge-editor/MergeEditorApp");
        });
        await flush();

        dispatchHostMessage({
            type: "setConflictData",
            data: {
                filePath: "src/conflict.ts",
                oursLabel: "main",
                theirsLabel: "feature/incoming",
                eol: "\n",
                hasTrailingNewline: true,
                segments: [
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

        const editable = document.querySelector(".result-editable");
        if (!editable) throw new Error("Expected an editable result block");
        act(() => {
            editable.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
        });
        await flush();

        const textarea = document.querySelector<HTMLTextAreaElement>(".result-edit-textarea");
        if (!textarea) throw new Error("Expected the result edit textarea to appear");
        const valueSetter = Object.getOwnPropertyDescriptor(
            HTMLTextAreaElement.prototype,
            "value",
        )?.set;
        act(() => {
            valueSetter?.call(textarea, "discarded();");
            textarea.dispatchEvent(new Event("input", { bubbles: true }));
        });
        act(() => {
            textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        });
        await flush();

        // The draft was discarded: hunk stays unresolved and Apply stays disabled.
        expect(document.querySelector(".result-edit-textarea")).toBeNull();
        expect(document.body.textContent).toContain("1 unresolved");
        expect(document.body.textContent).not.toContain("discarded();");
        expect(vscode.postMessage).not.toHaveBeenCalledWith(
            expect.objectContaining({ type: "applyResolution" }),
        );
    });

    it("clears a manual edit when a side resolution is chosen afterwards", async () => {
        const vscode = installVsCodeMock();
        createRootHost();

        await act(async () => {
            await import("../../../src/webviews/react/merge-editor/MergeEditorApp");
        });
        await flush();

        dispatchHostMessage({
            type: "setConflictData",
            data: {
                filePath: "src/conflict.ts",
                oursLabel: "main",
                theirsLabel: "feature/incoming",
                eol: "\n",
                hasTrailingNewline: true,
                segments: [
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

        const editable = document.querySelector(".result-editable");
        if (!editable) throw new Error("Expected an editable result block");
        act(() => {
            editable.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
        });
        await flush();

        const textarea = document.querySelector<HTMLTextAreaElement>(".result-edit-textarea");
        if (!textarea) throw new Error("Expected the result edit textarea to appear");
        const valueSetter = Object.getOwnPropertyDescriptor(
            HTMLTextAreaElement.prototype,
            "value",
        )?.set;
        act(() => {
            valueSetter?.call(textarea, "temporary();");
            textarea.dispatchEvent(new Event("input", { bubbles: true }));
        });
        act(() => {
            textarea.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
        });
        await flush();
        expect(document.querySelector(".conflict-result.edited")).not.toBeNull();

        // Choosing a side afterwards replaces the manual edit.
        clickButton("Accept right block");
        await flush();
        expect(document.querySelector(".conflict-result.edited")).toBeNull();
        expect(document.querySelector(".conflict-actions-right")).toBeNull();
        expect(document.querySelectorAll(".conflict-actions-left .action-btn")).toHaveLength(2);
        expect(document.querySelector(".conflict-theirs")?.className).toContain("accepted-pane");
        expect(document.querySelector(".conflict-result")?.className).not.toContain(
            "accepted-pane",
        );
        expect(document.querySelector(".conflict-result")?.className).toContain("unresolved");
        expect(document.querySelector(".conflict-ours")?.className).not.toContain("accepted-pane");

        clickButton("Apply (1/1)");
        expect(vscode.postMessage).toHaveBeenCalledWith({
            type: "applyResolution",
            content: "theirs();\n",
        });
    });

    it("stacks both sides ours-first when appending right after accepting left", async () => {
        const vscode = installVsCodeMock();
        createRootHost();

        await act(async () => {
            await import("../../../src/webviews/react/merge-editor/MergeEditorApp");
        });
        await flush();

        dispatchHostMessage({
            type: "setConflictData",
            data: {
                filePath: "src/conflict.ts",
                oursLabel: "main",
                theirsLabel: "feature/incoming",
                eol: "\n",
                hasTrailingNewline: true,
                segments: [
                    { type: "common", lines: ["shared();"] },
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

        // Accept left, then the right button becomes an append that stacks theirs below.
        clickButton("Accept left block");
        await flush();
        clickButton("Append right block below the result");
        await flush();

        // Both sides are now in the result: every side control disappears and
        // both source panes plus the result read as accepted.
        expect(document.body.textContent).toContain("0 unresolved");
        expect(document.querySelector(".conflict-actions-left")).toBeNull();
        expect(document.querySelector(".conflict-actions-right")).toBeNull();
        expect(document.querySelector(".conflict-ours")?.className).toContain("accepted-pane");
        expect(document.querySelector(".conflict-theirs")?.className).toContain("accepted-pane");
        expect(document.querySelector(".conflict-result")?.className).not.toContain(
            "accepted-pane",
        );
        expect(document.querySelector(".result-insertion-marker")).toBeNull();

        clickButton("Apply (1/1)");
        expect(vscode.postMessage).toHaveBeenCalledWith({
            type: "applyResolution",
            content: "shared();\nours();\ntheirs();\n",
        });
    });

    it("stacks both sides theirs-first when appending left after accepting right", async () => {
        const vscode = installVsCodeMock();
        createRootHost();

        await act(async () => {
            await import("../../../src/webviews/react/merge-editor/MergeEditorApp");
        });
        await flush();

        dispatchHostMessage({
            type: "setConflictData",
            data: {
                filePath: "src/conflict.ts",
                oursLabel: "main",
                theirsLabel: "feature/incoming",
                eol: "\n",
                hasTrailingNewline: true,
                segments: [
                    { type: "common", lines: ["shared();"] },
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

        // Accept right first, then append left below it: theirs comes before ours.
        clickButton("Accept right block");
        await flush();
        expect(document.querySelector(".result-insertion-marker.variant-insertion")).not.toBeNull();
        clickButton("Append left block below the result");
        await flush();

        expect(document.body.textContent).toContain("0 unresolved");
        expect(document.querySelector(".conflict-actions-left")).toBeNull();
        expect(document.querySelector(".conflict-actions-right")).toBeNull();
        expect(document.querySelector(".result-insertion-marker")).toBeNull();
        expect(document.querySelector(".conflict-ours")?.className).toContain("accepted-pane");
        expect(document.querySelector(".conflict-theirs")?.className).toContain("accepted-pane");

        clickButton("Apply (1/1)");
        expect(vscode.postMessage).toHaveBeenCalledWith({
            type: "applyResolution",
            content: "shared();\ntheirs();\nours();\n",
        });
    });

    it("shows the append marker at the top after accepting an empty side", async () => {
        installVsCodeMock();
        createRootHost();

        await act(async () => {
            await import("../../../src/webviews/react/merge-editor/MergeEditorApp");
        });
        await flush();

        dispatchHostMessage({
            type: "setConflictData",
            data: {
                filePath: "src/conflict.ts",
                oursLabel: "main",
                theirsLabel: "feature/incoming",
                eol: "\n",
                hasTrailingNewline: true,
                segments: [
                    {
                        type: "conflict",
                        id: 0,
                        changeKind: "conflict",
                        oursLines: [],
                        theirsLines: ["theirs();"],
                        baseLines: ["base();"],
                    },
                ],
            },
        });
        await flush();

        clickButton("Accept left block");
        await flush();

        const marker = document.querySelector<HTMLElement>(
            ".result-insertion-marker.variant-insertion",
        );
        expect(marker).not.toBeNull();
        expect(marker?.className).toContain("marker-top");
    });

    it("discards only the left side on left X and leaves the right suggestion offered", async () => {
        const vscode = installVsCodeMock();
        createRootHost();

        await act(async () => {
            await import("../../../src/webviews/react/merge-editor/MergeEditorApp");
        });
        await flush();

        dispatchHostMessage({
            type: "setConflictData",
            data: {
                filePath: "src/conflict.ts",
                oursLabel: "main",
                theirsLabel: "feature/incoming",
                eol: "\n",
                hasTrailingNewline: true,
                segments: [
                    { type: "common", lines: ["shared();"] },
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

        // Discarding the left side must NOT apply the right side (the old bug):
        // the hunk stays unresolved and the right suggestion is still offered.
        clickButton("Ignore left block");
        await flush();
        expect(document.body.textContent).toContain("1 unresolved");
        expect(document.querySelector(".conflict-actions-left")).toBeNull();
        expect(document.querySelectorAll(".conflict-actions-right .action-btn")).toHaveLength(2);
        expect(document.querySelector(".column-left.conflict-column")?.className).toContain(
            "dismissed",
        );
        expect(document.querySelector(".conflict-theirs")?.className).not.toContain(
            "accepted-pane",
        );
        // The dismissed left side keeps a dotted resolved trace (PyCharm's
        // ignored style); the still-offered right suggestion stays a pending
        // filled connector.
        const pendingConnectors = document.querySelectorAll<SVGPathElement>(".merge-connector");
        expect(pendingConnectors).toHaveLength(2);
        expect(pendingConnectors[0].getAttribute("class")).toContain("connector-resolved");
        expect(pendingConnectors[1].getAttribute("class")).toContain("change-conflict");
        expect(pendingConnectors[1].getAttribute("class")).not.toContain("connector-resolved");

        // The right side only enters the result when the user explicitly accepts it.
        clickButton("Accept right block");
        await flush();
        expect(document.body.textContent).toContain("0 unresolved");
        clickButton("Apply (1/1)");
        expect(vscode.postMessage).toHaveBeenCalledWith({
            type: "applyResolution",
            content: "shared();\ntheirs();\n",
        });
    });

    it("discards the right side after accepting the left, keeping only ours", async () => {
        const vscode = installVsCodeMock();
        createRootHost();

        await act(async () => {
            await import("../../../src/webviews/react/merge-editor/MergeEditorApp");
        });
        await flush();

        dispatchHostMessage({
            type: "setConflictData",
            data: {
                filePath: "src/conflict.ts",
                oursLabel: "main",
                theirsLabel: "feature/incoming",
                eol: "\n",
                hasTrailingNewline: true,
                segments: [
                    { type: "common", lines: ["shared();"] },
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

        // Accept left, then discard the still-offered right side. Previously the
        // right X re-emitted "ours" and did nothing; now it dismisses the right
        // suggestion and hides its controls while the result stays ours-only.
        clickButton("Accept left block");
        await flush();
        clickButton("Ignore right block");
        await flush();

        expect(document.body.textContent).toContain("0 unresolved");
        expect(document.querySelector(".conflict-actions-left")).toBeNull();
        expect(document.querySelector(".conflict-actions-right")).toBeNull();
        expect(document.querySelector(".column-right.conflict-column")?.className).toContain(
            "dismissed",
        );
        expect(document.querySelector(".conflict-ours")?.className).toContain("accepted-pane");
        expect(document.querySelector(".conflict-theirs")?.className).not.toContain(
            "accepted-pane",
        );
        // Both sides are settled (left accepted, right dismissed): each keeps a
        // dotted resolved contour in the conflict color, no pending bands left.
        const connectors = document.querySelectorAll<SVGPathElement>(".merge-connector");
        expect(connectors).toHaveLength(2);
        for (const connector of Array.from(connectors)) {
            expect(connector.getAttribute("class")).toContain("change-conflict");
            expect(connector.getAttribute("class")).toContain("connector-resolved");
        }

        clickButton("Apply (1/1)");
        expect(vscode.postMessage).toHaveBeenCalledWith({
            type: "applyResolution",
            content: "shared();\nours();\n",
        });
    });

    it("drops the block when both sides are discarded", async () => {
        const vscode = installVsCodeMock();
        createRootHost();

        await act(async () => {
            await import("../../../src/webviews/react/merge-editor/MergeEditorApp");
        });
        await flush();

        dispatchHostMessage({
            type: "setConflictData",
            data: {
                filePath: "src/conflict.ts",
                oursLabel: "main",
                theirsLabel: "feature/incoming",
                eol: "\n",
                hasTrailingNewline: true,
                segments: [
                    { type: "common", lines: ["shared();"] },
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

        // Discard both sides: the second discard drops the block entirely.
        clickButton("Ignore left block");
        await flush();
        expect(document.body.textContent).toContain("1 unresolved");
        clickButton("Ignore right block");
        await flush();
        expect(document.body.textContent).toContain("0 unresolved");
        // A fully discarded hunk keeps two dotted traces pointing at the thin
        // insertion line where the block used to be — PyCharm's ignored style —
        // instead of vanishing entirely.
        const discardedConnectors = document.querySelectorAll<SVGPathElement>(".merge-connector");
        expect(discardedConnectors).toHaveLength(2);
        for (const connector of Array.from(discardedConnectors)) {
            expect(connector.getAttribute("class")).toContain("connector-resolved");
        }

        clickButton("Apply (1/1)");
        expect(vscode.postMessage).toHaveBeenCalledWith({
            type: "applyResolution",
            content: "shared();\n",
        });
    });

    it("resolves conflicts with Ctrl+Arrow side shortcuts, auto-advances, and applies with Ctrl+Enter", async () => {
        const vscode = installVsCodeMock();
        createRootHost();

        await act(async () => {
            await import("../../../src/webviews/react/merge-editor/MergeEditorApp");
        });
        await flush();

        dispatchHostMessage({ type: "setConflictData", data: twoConflictData() });
        await flush();
        expect(document.body.textContent).toContain("2 unresolved");

        // The first unresolved conflict is auto-selected, so the shortcut targets it.
        pressKey("ArrowLeft", { ctrlKey: true });
        await flush();
        expect(document.body.textContent).toContain("1 unresolved");
        // IntelliJ-style auto-advance: the next unresolved conflict becomes active.
        expect(document.querySelector('[data-conflict-id="1"]')?.className).toContain("active");

        // Cmd works the same as Ctrl for the side shortcuts.
        pressKey("ArrowRight", { metaKey: true });
        await flush();
        expect(document.body.textContent).toContain("0 unresolved");

        pressKey("Enter", { ctrlKey: true });
        expect(vscode.postMessage).toHaveBeenCalledWith({
            type: "applyResolution",
            content: "head();\na_ours();\nmid();\nb_theirs();\n",
        });
    });

    it("resolves with B for both sides and X to drop the block", async () => {
        const vscode = installVsCodeMock();
        createRootHost();

        await act(async () => {
            await import("../../../src/webviews/react/merge-editor/MergeEditorApp");
        });
        await flush();

        dispatchHostMessage({ type: "setConflictData", data: twoConflictData() });
        await flush();

        pressKey("b");
        await flush();
        expect(document.body.textContent).toContain("1 unresolved");

        pressKey("x");
        await flush();
        expect(document.body.textContent).toContain("0 unresolved");

        clickButton("Apply (2/2)");
        expect(vscode.postMessage).toHaveBeenCalledWith({
            type: "applyResolution",
            content: "head();\na_ours();\na_theirs();\nmid();\n",
        });
    });

    it("ignores resolution shortcuts while typing in the result editor", async () => {
        const vscode = installVsCodeMock();
        createRootHost();

        await act(async () => {
            await import("../../../src/webviews/react/merge-editor/MergeEditorApp");
        });
        await flush();

        dispatchHostMessage({
            type: "setConflictData",
            data: {
                filePath: "src/conflict.ts",
                oursLabel: "main",
                theirsLabel: "feature/incoming",
                eol: "\n",
                hasTrailingNewline: true,
                segments: [
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

        const editable = document.querySelector(".result-editable");
        if (!editable) throw new Error("Expected an editable result block");
        act(() => {
            editable.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
        });
        await flush();

        const textarea = document.querySelector<HTMLTextAreaElement>(".result-edit-textarea");
        if (!textarea) throw new Error("Expected the result edit textarea to appear");
        act(() => {
            textarea.dispatchEvent(
                new KeyboardEvent("keydown", { key: "x", bubbles: true, cancelable: true }),
            );
        });
        await flush();

        // Typing "x" must not drop the hunk: the editor stays open and unresolved.
        expect(document.querySelector(".result-edit-textarea")).not.toBeNull();
        expect(document.body.textContent).toContain("1 unresolved");
        expect(vscode.postMessage).not.toHaveBeenCalledWith(
            expect.objectContaining({ type: "applyResolution" }),
        );
    });

    it("rejects Both on one-sided hunks and reports the auto-resolved count", async () => {
        installVsCodeMock();
        createRootHost();

        await act(async () => {
            await import("../../../src/webviews/react/merge-editor/MergeEditorApp");
        });
        await flush();

        dispatchHostMessage({
            type: "setConflictData",
            data: {
                filePath: "src/conflict.ts",
                oursLabel: "main",
                theirsLabel: "feature/incoming",
                eol: "\n",
                hasTrailingNewline: true,
                segments: [
                    {
                        type: "conflict",
                        id: 0,
                        changeKind: "ours-only",
                        oursLines: ["added();"],
                        theirsLines: ["orig();"],
                        baseLines: ["orig();"],
                    },
                    {
                        type: "conflict",
                        id: 1,
                        changeKind: "conflict",
                        oursLines: ["ours();"],
                        theirsLines: ["theirs();"],
                        baseLines: ["base();"],
                    },
                ],
            },
        });
        await flush();

        // The one-sided hunk surfaces as auto-resolved in the header stats.
        expect(document.body.textContent).toContain("1 auto-resolved");
        expect(findButton("Apply non-conflicting changes").disabled).toBe(false);
        expect(
            document.querySelector('[data-conflict-id="0"] .conflict-result')?.className,
        ).not.toContain("accepted-pane");

        // Select the one-sided hunk, then try to take both sides.
        const oneSided = document.querySelector('[data-conflict-id="0"]');
        if (!oneSided) throw new Error("Expected the one-sided conflict section");
        act(() => {
            oneSided.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        await flush();

        pressKey("b");
        await flush();

        // "Both" is meaningless for a one-sided change and must not render.
        expect(oneSided.querySelector('button[aria-label="Both"]')).toBeNull();
        expect(document.body.textContent).not.toContain("Use both");
    });

    it("disables apply-non-conflicting when every hunk is a true conflict", async () => {
        installVsCodeMock();
        createRootHost();

        await act(async () => {
            await import("../../../src/webviews/react/merge-editor/MergeEditorApp");
        });
        await flush();

        dispatchHostMessage({ type: "setConflictData", data: twoConflictData() });
        await flush();

        expect(findButton("Apply non-conflicting changes").disabled).toBe(true);
        expect(document.body.textContent).not.toContain("auto-resolved");
    });

    it("does not navigate conflicts when P or N carry a command modifier", async () => {
        installVsCodeMock();
        createRootHost();

        await act(async () => {
            await import("../../../src/webviews/react/merge-editor/MergeEditorApp");
        });
        await flush();

        dispatchHostMessage({ type: "setConflictData", data: twoConflictData() });
        await flush();

        // The first unresolved conflict is auto-selected when data loads.
        expect(document.querySelector('[data-conflict-id="0"]')?.className).toContain("active");

        // Ctrl+P / Cmd+N belong to VS Code, not the merge editor.
        pressKey("p", { ctrlKey: true });
        await flush();
        expect(document.querySelector('[data-conflict-id="0"]')?.className).toContain("active");

        pressKey("n", { metaKey: true });
        await flush();
        expect(document.querySelector('[data-conflict-id="0"]')?.className).toContain("active");
        expect(document.querySelector('[data-conflict-id="1"]')?.className).not.toContain("active");

        pressKey("n");
        await flush();
        expect(document.querySelector('[data-conflict-id="1"]')?.className).toContain("active");
    });

    it("renders each hunk pane at its natural height without filler rows", async () => {
        installVsCodeMock();
        createRootHost();

        await act(async () => {
            await import("../../../src/webviews/react/merge-editor/MergeEditorApp");
        });
        await flush();

        dispatchHostMessage({
            type: "setConflictData",
            data: {
                filePath: "src/conflict.ts",
                oursLabel: "main",
                theirsLabel: "feature/incoming",
                eol: "\n",
                hasTrailingNewline: true,
                segments: [
                    {
                        type: "conflict",
                        id: 0,
                        changeKind: "conflict",
                        oursLines: ["added_a();", "shared();"],
                        theirsLines: ["shared();", "added_b();", "tail();"],
                        baseLines: ["shared();"],
                    },
                ],
            },
        });
        await flush();

        const oursRows = Array.from(
            document.querySelectorAll(".conflict-ours .code-lines .code-line"),
        );
        const theirsRows = Array.from(
            document.querySelectorAll(".conflict-theirs .code-lines .code-line"),
        );

        // PyCharm-style layout: each pane renders exactly its own lines,
        // contiguously from the hunk top. The shorter side is NOT padded to
        // match the taller one — the columns flow independently at natural
        // height and the scroll driver keeps them aligned.
        expect(oursRows).toHaveLength(2);
        expect(theirsRows).toHaveLength(3);
        expect(oursRows[0].textContent).toContain("added_a();");
        expect(oursRows[1].textContent).toContain("shared();");
        expect(theirsRows[0].textContent).toContain("shared();");
        expect(theirsRows[1].textContent).toContain("added_b();");
        expect(theirsRows[2].textContent).toContain("tail();");
        // No pane carries filler rows anymore, so nothing is a padding line.
        expect(oursRows.every((row) => row.className.includes("real-code-line"))).toBe(true);
        expect(theirsRows.every((row) => row.className.includes("real-code-line"))).toBe(true);
        expect(document.querySelectorAll(".padding-code-line")).toHaveLength(0);

        // Line numbers stay at pane intersections: left pane numbers render on
        // the right edge, right pane numbers on the left edge; each pane numbers
        // only its own real lines.
        const oursNumberRows = Array.from(
            document.querySelectorAll(".conflict-ours .line-number-row"),
        );
        const theirsNumberRows = Array.from(
            document.querySelectorAll(".conflict-theirs .line-number-row"),
        );
        const oursNumbers = Array.from(
            document.querySelectorAll(".conflict-ours .line-number-primary"),
        ).map((el) => el.textContent?.trim());
        expect(oursNumbers).toEqual(["1", "2"]);
        const theirsNumbers = Array.from(
            document.querySelectorAll(".conflict-theirs .line-number-primary"),
        ).map((el) => el.textContent?.trim());
        expect(theirsNumbers).toEqual(["1", "2", "3"]);
        expect(document.querySelectorAll(".line-number-secondary")).toHaveLength(0);
        expect(oursNumberRows).toHaveLength(2);
        expect(
            document.querySelector(".conflict-ours")?.className.includes("line-numbers-right"),
        ).toBe(true);
        expect(theirsNumberRows.every((row) => row.className.includes("real-line-row"))).toBe(true);
    });

    it("renders three translated columns under a single vertical scroller", async () => {
        installVsCodeMock();
        createRootHost();

        await act(async () => {
            await import("../../../src/webviews/react/merge-editor/MergeEditorApp");
        });
        await flush();

        dispatchHostMessage({
            type: "setConflictData",
            data: {
                filePath: "src/conflict.ts",
                oursLabel: "main",
                theirsLabel: "feature/incoming",
                eol: "\n",
                hasTrailingNewline: true,
                segments: [
                    {
                        type: "conflict",
                        id: 0,
                        changeKind: "conflict",
                        oursLines: [
                            "const oursValue = reallyLongExpression + anotherLongExpression;",
                        ],
                        theirsLines: [
                            "const theirsValue = reallyLongExpression + incomingLongExpression;",
                        ],
                        baseLines: ["const value = reallyLongExpression;"],
                    },
                ],
            },
        });
        await flush();

        const mergeContent = document.querySelector<HTMLElement>(".merge-content");
        const viewport = document.querySelector<HTMLElement>(".merge-viewport");
        const spacer = document.querySelector<HTMLElement>(".merge-vscroll-spacer");
        const bottomScroll = document.querySelector<HTMLElement>(".merge-horizontal-scroll");

        // Single native vertical scroller: the sticky viewport holds the three
        // translated columns and the spacer supplies the scroll length. The
        // horizontal scrollbar stays a sibling in the content shell.
        expect(viewport?.parentElement).toBe(mergeContent);
        expect(spacer?.parentElement).toBe(mergeContent);
        expect(viewport?.querySelectorAll(":scope > .merge-col")).toHaveLength(3);
        expect(mergeContent?.querySelector(":scope > .code-lines")).toBeNull();
        expect(bottomScroll?.parentElement).toBe(document.querySelector(".merge-content-shell"));
    });

    it("treats auto-merged hunks as resolved and applies the merged lines", async () => {
        const vscode = installVsCodeMock();
        createRootHost();

        await act(async () => {
            await import("../../../src/webviews/react/merge-editor/MergeEditorApp");
        });
        await flush();

        dispatchHostMessage({
            type: "setConflictData",
            data: {
                filePath: "src/conflict.ts",
                oursLabel: "main",
                theirsLabel: "feature/incoming",
                eol: "\n",
                hasTrailingNewline: true,
                segments: [
                    { type: "common", lines: ["head();"] },
                    {
                        type: "conflict",
                        id: 0,
                        changeKind: "conflict",
                        oursLines: ["const total = step;"],
                        theirsLines: ["const count = stride;"],
                        baseLines: ["const count = step;"],
                        autoResolvedLines: ["const total = stride;"],
                    },
                ],
            },
        });
        await flush();

        // No human decision is pending: the auto-merge counts as resolved.
        expect(document.body.textContent).toContain("0 unresolved");
        expect(document.body.textContent).toContain("1 auto-resolved");
        expect(document.querySelector('[data-conflict-id="0"]')?.className).toContain(
            "auto-merged",
        );

        // The result block previews the composed merge of both edits.
        const resultBlock = document.querySelector(".conflict-result");
        expect(resultBlock?.textContent).toContain("const total = stride;");

        // Apply is unlocked without any clicks and writes the merged line.
        clickButton("Apply (0/0)");
        expect(vscode.postMessage).toHaveBeenCalledWith({
            type: "applyResolution",
            content: "head();\nconst total = stride;\n",
        });
    });

    it("lets the user override an auto-merge with an explicit side choice", async () => {
        const vscode = installVsCodeMock();
        createRootHost();

        await act(async () => {
            await import("../../../src/webviews/react/merge-editor/MergeEditorApp");
        });
        await flush();

        dispatchHostMessage({
            type: "setConflictData",
            data: {
                filePath: "src/conflict.ts",
                oursLabel: "main",
                theirsLabel: "feature/incoming",
                eol: "\n",
                hasTrailingNewline: true,
                segments: [
                    {
                        type: "conflict",
                        id: 0,
                        changeKind: "conflict",
                        oursLines: ["const total = step;"],
                        theirsLines: ["const count = stride;"],
                        baseLines: ["const count = step;"],
                        autoResolvedLines: ["const total = stride;"],
                    },
                ],
            },
        });
        await flush();

        clickButton("Accept left block");
        await flush();

        // The explicit choice replaces the auto-merge in result and hunk state.
        expect(document.querySelector(".conflict-result")?.textContent).toContain(
            "const total = step;",
        );
        expect(document.querySelector('[data-conflict-id="0"]')?.className).not.toContain(
            "auto-merged",
        );

        clickButton("Apply (0/0)");
        expect(vscode.postMessage).toHaveBeenCalledWith({
            type: "applyResolution",
            content: "const total = step;\n",
        });
    });

    it("renders Shiki theme-colored syntax tokens in all three panes for a bundled language", async () => {
        installVsCodeMock();
        createRootHost();

        await act(async () => {
            await import("../../../src/webviews/react/merge-editor/MergeEditorApp");
        });
        await flush();

        dispatchHostMessage({
            type: "setConflictData",
            data: {
                filePath: "src/conflict.ts",
                oursLabel: "main",
                theirsLabel: "feature/incoming",
                eol: "\n",
                hasTrailingNewline: true,
                segments: [
                    { type: "common", lines: ['const greeting = "hi";'] },
                    {
                        type: "conflict",
                        id: 0,
                        changeKind: "conflict",
                        oursLines: ["return 1;"],
                        theirsLines: ["return 2;"],
                        baseLines: ["return 0;"],
                    },
                ],
            },
        });
        // Shiki initializes asynchronously relative to the first render; run the
        // deferred init timer, then flush its ready state update before asserting.
        await flushShikiInit();
        await flush();

        // Shiki now owns .ts highlighting: no hand-rolled tok-* classes should
        // remain for a bundled language.
        expect(document.querySelectorAll(".tok-keyword").length).toBe(0);
        expect(document.querySelectorAll(".tok-string").length).toBe(0);

        // The common line renders in left, result, and right panes; each pane's
        // "const" span must carry an inline Shiki color.
        const spans = Array.from(document.querySelectorAll(".code-line span"));
        const constSpans = spans.filter((el) => el.textContent === "const");
        expect(constSpans.length).toBe(3);
        for (const span of constSpans) {
            expect((span as HTMLElement).style.color).not.toBe("");
        }

        // String tokens get a different color than keyword tokens under the
        // same theme (grammar-accurate categorization, not a single fallback color).
        const stringSpan = spans.find((el) => el.textContent === '"hi"');
        expect(stringSpan).toBeDefined();
        const stringColor = (stringSpan as HTMLElement).style.color;
        expect(stringColor).not.toBe("");
        expect(stringColor).not.toBe((constSpans[0] as HTMLElement).style.color);

        // Conflict pane lines are colored too.
        const conflictPanes = document.querySelectorAll('[data-conflict-id="0"] .code-block');
        for (const pane of Array.from(conflictPanes)) {
            const returnSpan = Array.from(pane.querySelectorAll("span")).find(
                (el) => el.textContent === "return",
            );
            expect(returnSpan).toBeDefined();
            expect((returnSpan as HTMLElement).style.color).not.toBe("");
        }
    });

    it("falls back to the hand-rolled tokenizer for a file type with no bundled Shiki grammar", async () => {
        installVsCodeMock();
        createRootHost();

        await act(async () => {
            await import("../../../src/webviews/react/merge-editor/MergeEditorApp");
        });
        await flush();

        dispatchHostMessage({
            type: "setConflictData",
            data: {
                filePath: "src/notes.unsupportedext",
                oursLabel: "main",
                theirsLabel: "feature/incoming",
                eol: "\n",
                hasTrailingNewline: true,
                segments: [{ type: "common", lines: ['const greeting = "hi"; // welcome 42'] }],
            },
        });
        await flushShikiInit();
        await flush();

        const keywordSpans = Array.from(document.querySelectorAll(".tok-keyword"));
        expect(keywordSpans.filter((el) => el.textContent === "const").length).toBe(3);

        const stringSpans = Array.from(document.querySelectorAll(".tok-string"));
        expect(stringSpans.filter((el) => el.textContent === '"hi"').length).toBe(3);

        const commentSpans = Array.from(document.querySelectorAll(".tok-comment"));
        expect(commentSpans.filter((el) => el.textContent === "// welcome 42").length).toBe(3);
    });

    it("overlays the word-diff change highlight on top of Shiki-colored spans", async () => {
        installVsCodeMock();
        createRootHost();

        await act(async () => {
            await import("../../../src/webviews/react/merge-editor/MergeEditorApp");
        });
        await flush();

        dispatchHostMessage({
            type: "setConflictData",
            data: {
                filePath: "src/conflict.ts",
                oursLabel: "main",
                theirsLabel: "feature/incoming",
                eol: "\n",
                hasTrailingNewline: true,
                segments: [
                    {
                        type: "conflict",
                        id: 0,
                        changeKind: "conflict",
                        oursLines: ["const total = 100;"],
                        theirsLines: ["const total = 200;"],
                        baseLines: ["const total = 300;"],
                    },
                ],
            },
        });
        await flushShikiInit();
        await flush();

        const wrappers = Array.from(document.querySelectorAll(".word-diff-change"));
        expect(wrappers.length).toBeGreaterThan(0);

        // At least one change wrapper must contain a Shiki-colored inner span,
        // proving the overlay sits on top of (not instead of) grammar coloring.
        const wrapperWithColor = wrappers.find((wrapper) => {
            const inner = wrapper.querySelector("span");
            return inner && (inner as HTMLElement).style.color !== "";
        });
        expect(wrapperWithColor).toBeDefined();

        // The ours pane line must still reconstruct exactly from its spans.
        const oursPane = document.querySelector('[data-conflict-id="0"] .code-block');
        expect(oursPane?.textContent).toContain("const total = 100;");
    });
});
