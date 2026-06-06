// @vitest-environment jsdom

import { act } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { flush } from "./utils/reactDomTestUtils";
import { installWebviewI18n } from "./utils/webviewI18nTestUtils";

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
            await import("../../src/webviews/react/merge-conflicts-session/MergeConflictSessionApp");
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
            await import("../../src/webviews/react/merge-editor/MergeEditorApp");
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
});
