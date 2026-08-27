// @vitest-environment jsdom

import { act } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { flush } from "../../helpers/reactDomTestUtils";
import { installWebviewI18n } from "../../helpers/webviewI18nTestUtils";
import { buildEditableDiffPerformanceFixture } from "../../helpers/editableDiffPerformanceFixture";

const layoutCalls = vi.hoisted(() => vi.fn());

vi.mock("../../../src/webviews/react/diff-core/mergeScrollLayout", async (importOriginal) => {
    const actual =
        await importOriginal<typeof import("../../../src/webviews/react/diff-core/mergeScrollLayout")>();
    return {
        ...actual,
        buildVerticalLayout: (...args: Parameters<typeof actual.buildVerticalLayout>) => {
            layoutCalls(args[0]);
            return actual.buildVerticalLayout(...args);
        },
    };
});

interface MockVsCodeApi {
    postMessage: ReturnType<typeof vi.fn>;
    getState: () => unknown;
    setState: ReturnType<typeof vi.fn>;
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

/** Updates the controlled textarea through the same input event as a user edit. */
function setDraftText(textarea: HTMLTextAreaElement, next: string): void {
    const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
    )?.set;
    act(() => {
        valueSetter?.call(textarea, next);
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
}

function editMessages(vscode: MockVsCodeApi): unknown[] {
    return vscode.postMessage.mock.calls
        .map((call) => call[0] as { type?: string })
        .filter((message) => message.type === "editText");
}

beforeAll(() => {
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
        value: true,
        configurable: true,
    });
});

afterEach(async () => {
    // Unmount before detaching and resetting modules so the App's host-message listener cannot
    // retain a large rendered tree or answer a later test's payload.
    const app = await import("../../../src/webviews/react/diff-viewer/DiffViewerApp");
    await act(async () => {
        app.root?.unmount();
    });
    document.body.replaceChildren();
    vi.clearAllMocks();
    vi.useRealTimers();
    vi.resetModules();
});

describe("editable diff performance", () => {
    it("keeps same-geometry typing out of the whole-view layout", async () => {
        const vscode = installVsCodeMock();
        const fixture = buildEditableDiffPerformanceFixture();
        createRootHost();
        vi.useFakeTimers();

        await act(async () => {
            await import("../../../src/webviews/react/diff-viewer/DiffViewerApp");
        });
        await flush();
        dispatchHostMessage({ type: "setDiffData", data: fixture.data });
        await flush();

        const changedBlock = document.querySelector<HTMLElement>(
            ".diff-pane-right .diff-editable-block.diff-segment-changed",
        );
        expect(changedBlock, "large fixture must expose a changed right-side block").not.toBeNull();
        act(() => {
            changedBlock?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
        });
        const textarea = document.querySelector<HTMLTextAreaElement>(
            "[data-testid='diff-pane-right-editable']",
        );
        expect(textarea).not.toBeNull();
        const editable = textarea as HTMLTextAreaElement;
        const beforeInputLayoutCalls = layoutCalls.mock.calls.length;
        const nextText = editable.value + "!";

        setDraftText(editable, nextText);

        expect(editable.value).toBe(nextText);
        expect(editMessages(vscode)).toHaveLength(0);
        await flush();
        expect(layoutCalls.mock.calls.length).toBe(
            beforeInputLayoutCalls,
        );

        act(() => {
            vi.advanceTimersByTime(999);
        });
        expect(editMessages(vscode)).toHaveLength(0);

        act(() => {
            vi.advanceTimersByTime(1);
        });
        expect(editMessages(vscode)).toHaveLength(1);
    });
});
