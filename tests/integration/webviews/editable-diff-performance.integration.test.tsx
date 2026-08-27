// @vitest-environment jsdom

import { act } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { flush } from "../../helpers/reactDomTestUtils";
import { installWebviewI18n } from "../../helpers/webviewI18nTestUtils";
import { buildEditableDiffPerformanceFixture } from "../../helpers/editableDiffPerformanceFixture";

const layoutCalls = vi.hoisted(() => vi.fn());

vi.mock("../../../src/webviews/react/diff-core/mergeScrollLayout", async (importOriginal) => {
    const actual =
        await importOriginal<
            typeof import("../../../src/webviews/react/diff-core/mergeScrollLayout")
        >();
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

/** Mounts the large editable fixture and opens its first changed right-side block. */
async function openPerformanceDraft(): Promise<{
    fixture: ReturnType<typeof buildEditableDiffPerformanceFixture>;
    root: HTMLElement;
    textarea: HTMLTextAreaElement;
}> {
    const fixture = buildEditableDiffPerformanceFixture();
    createRootHost();
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
    const root = document.querySelector<HTMLElement>("[data-testid='diff-viewer-root']");
    expect(root).not.toBeNull();
    return {
        fixture,
        root: root as HTMLElement,
        textarea: textarea as HTMLTextAreaElement,
    };
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
        expect(layoutCalls.mock.calls.length).toBe(beforeInputLayoutCalls);

        act(() => {
            vi.advanceTimersByTime(999);
        });
        expect(editMessages(vscode)).toHaveLength(0);

        act(() => {
            vi.advanceTimersByTime(1);
        });
        expect(editMessages(vscode)).toHaveLength(1);
    });

    it("rebuilds layout when the active draft gains a row", async () => {
        installVsCodeMock();
        vi.useFakeTimers();
        const { textarea } = await openPerformanceDraft();
        const beforeInputLayoutCalls = layoutCalls.mock.calls.length;

        setDraftText(textarea, `${textarea.value}\nnew draft row`);
        await flush();

        expect(textarea.rows).toBe(2);
        expect(layoutCalls.mock.calls.length).toBe(beforeInputLayoutCalls + 1);
    });

    it("expands the shared horizontal extent when the draft crosses the base width", async () => {
        installVsCodeMock();
        vi.useFakeTimers();
        const { fixture, root, textarea } = await openPerformanceDraft();
        let baseMaxLineLength = 1;
        for (const segment of fixture.data.segments) {
            for (const line of [...segment.left, ...segment.right]) {
                baseMaxLineLength = Math.max(baseMaxLineLength, line.length);
            }
        }
        const beforeInputLayoutCalls = layoutCalls.mock.calls.length;
        const beforeWidth = root.style.getPropertyValue("--diff-line-min-width");
        const nextMaxLineLength = baseMaxLineLength + 1;

        setDraftText(textarea, "x".repeat(nextMaxLineLength));
        await flush();

        expect(root.style.getPropertyValue("--diff-line-min-width")).toBe(
            `calc(${nextMaxLineLength}ch + 18px)`,
        );
        expect(beforeWidth).toBe(`calc(${baseMaxLineLength}ch + 18px)`);
        expect(layoutCalls.mock.calls.length).toBe(beforeInputLayoutCalls + 1);
    });
});
