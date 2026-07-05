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
        expect(
            document.querySelector('[data-conflict-id="0"]')?.querySelectorAll(".action-btn"),
        ).toHaveLength(4);

        clickButton("Conflicts");
        clickButton("Abort Merge");
        clickButton("Accept left block");
        await flush();
        expect(document.body.textContent).toContain("0 unresolved");
        const hunk = document.querySelector('[data-conflict-id="0"]');
        expect(hunk?.querySelector(".conflict-actions-left")).toBeNull();
        expect(hunk?.querySelectorAll(".conflict-actions-right .action-btn")).toHaveLength(2);
        expect(hunk?.querySelector(".conflict-ours")?.className).toContain("accepted-pane");
        expect(hunk?.querySelector(".conflict-result")?.className).toContain("accepted-pane");
        expect(hunk?.querySelector(".conflict-theirs")?.className).not.toContain("accepted-pane");
        clickButton("Apply (1/1)");

        expect(vscode.postMessage).toHaveBeenCalledWith({ type: "openConflictSession" });
        expect(vscode.postMessage).toHaveBeenCalledWith({ type: "abortMerge" });
        expect(vscode.postMessage).toHaveBeenCalledWith({
            type: "applyResolution",
            content: "shared();\nours();\n",
        });
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
        const hunk = document.querySelector('[data-conflict-id="0"]');
        expect(hunk?.querySelector(".conflict-actions-right")).toBeNull();
        expect(hunk?.querySelectorAll(".conflict-actions-left .action-btn")).toHaveLength(2);
        expect(hunk?.querySelector(".conflict-theirs")?.className).toContain("accepted-pane");
        expect(hunk?.querySelector(".conflict-result")?.className).toContain("accepted-pane");
        expect(hunk?.querySelector(".conflict-ours")?.className).not.toContain("accepted-pane");

        clickButton("Apply (1/1)");
        expect(vscode.postMessage).toHaveBeenCalledWith({
            type: "applyResolution",
            content: "theirs();\n",
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

    it("keeps hunk pane content contiguous while leaving filler rows unpainted", async () => {
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

        // PyCharm-style layout: each pane renders its own lines contiguously
        // from the hunk top; the shorter side pads with plain filler rows at
        // the bottom. Lines are never scattered mid-hunk to line up with the
        // opposite pane, and padding rows must not inherit changed-line color.
        expect(oursRows).toHaveLength(3);
        expect(theirsRows).toHaveLength(3);
        expect(oursRows[0].textContent).toContain("added_a();");
        expect(oursRows[1].textContent).toContain("shared();");
        expect(oursRows[2].textContent?.trim()).toBe("");
        expect(theirsRows[0].textContent).toContain("shared();");
        expect(theirsRows[1].textContent).toContain("added_b();");
        expect(theirsRows[2].textContent).toContain("tail();");
        expect(oursRows[0].className).toContain("real-code-line");
        expect(oursRows[1].className).toContain("real-code-line");
        expect(oursRows[2].className).toContain("padding-code-line");
        expect(theirsRows.every((row) => row.className.includes("real-code-line"))).toBe(true);

        // Line numbers stay at pane intersections: left pane numbers render on
        // the right edge, while right pane numbers render on the left edge.
        const oursNumberRows = Array.from(
            document.querySelectorAll(".conflict-ours .line-number-row"),
        );
        const theirsNumberRows = Array.from(
            document.querySelectorAll(".conflict-theirs .line-number-row"),
        );
        const oursNumbers = Array.from(
            document.querySelectorAll(".conflict-ours .line-number-primary"),
        ).map((el) => el.textContent?.trim());
        expect(oursNumbers).toEqual(["1", "2", ""]);
        const theirsNumbers = Array.from(
            document.querySelectorAll(".conflict-theirs .line-number-primary"),
        ).map((el) => el.textContent?.trim());
        expect(theirsNumbers).toEqual(["1", "2", "3"]);
        expect(document.querySelectorAll(".line-number-secondary")).toHaveLength(0);
        expect(oursNumberRows).toHaveLength(3);
        expect(
            document.querySelector(".conflict-ours")?.className.includes("line-numbers-right"),
        ).toBe(true);
        expect(theirsNumberRows.every((row) => row.className.includes("real-line-row"))).toBe(true);
    });

    it("uses one shared horizontal scroll container for merge rows", async () => {
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
        const scrollWidth = document.querySelector<HTMLElement>(".merge-scroll-width");
        const bottomScroll = document.querySelector<HTMLElement>(".merge-horizontal-scroll");

        expect(scrollWidth?.parentElement).toBe(mergeContent);
        expect(scrollWidth?.querySelectorAll(":scope > .segment")).toHaveLength(1);
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

    it("renders theme-colored syntax tokens in all three panes", async () => {
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
                    { type: "common", lines: ['const greeting = "hi"; // welcome 42'] },
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
        await flush();

        // The common line renders in left, result, and right panes; each pane
        // must classify the keyword, string, comment, and number tokens.
        const keywordSpans = Array.from(document.querySelectorAll(".tok-keyword"));
        expect(keywordSpans.filter((el) => el.textContent === "const").length).toBe(3);

        const stringSpans = Array.from(document.querySelectorAll(".tok-string"));
        expect(stringSpans.filter((el) => el.textContent === '"hi"').length).toBe(3);

        // Trailing comments after code are highlighted, and the number inside
        // the comment stays part of the comment token.
        const commentSpans = Array.from(document.querySelectorAll(".tok-comment"));
        expect(commentSpans.filter((el) => el.textContent === "// welcome 42").length).toBe(3);

        // Conflict pane lines are highlighted too (keyword + number per pane).
        const conflictPanes = document.querySelectorAll('[data-conflict-id="0"] .code-block');
        for (const pane of Array.from(conflictPanes)) {
            expect(pane.querySelector(".tok-keyword")?.textContent).toBe("return");
            expect(pane.querySelector(".tok-number")).not.toBeNull();
        }
    });
});
