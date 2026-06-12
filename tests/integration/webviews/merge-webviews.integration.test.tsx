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
        (candidate) => candidate.textContent?.trim() === label,
    );
    if (!button) throw new Error(`Expected button labeled ${label}`);
    act(() => {
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
}

function findButton(label: string): HTMLButtonElement {
    const button = Array.from(document.querySelectorAll("button")).find(
        (candidate) => candidate.textContent?.trim() === label,
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

        clickButton("Accept All Yours");
        await flush();
        clickButton("Apply (1/1)");

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

        // The manual edit resolves the conflict and shows the Edited status.
        expect(document.body.textContent).toContain("Edited");
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
        expect(document.body.textContent).toContain("Edited");

        // Choosing a side afterwards replaces the manual edit.
        clickButton("Right");
        await flush();
        expect(document.body.textContent).not.toContain("Edited");

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

        // "Both" is meaningless for a one-sided change and must be ignored.
        expect(document.body.textContent).toContain("Left-only change");
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
});
