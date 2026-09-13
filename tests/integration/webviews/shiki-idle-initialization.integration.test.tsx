// @vitest-environment jsdom

import React, { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { flush, initReactDomTestEnvironment, mount } from "../../helpers/reactDomTestUtils";
import { installWebviewI18n } from "../../helpers/webviewI18nTestUtils";

/** Models a browser that runs no voluntary idle work but honors an explicit timeout. */
function installStarvedIdleScheduler(): void {
    let nextId = 1;
    const timers = new Map<number, number>();
    vi.stubGlobal(
        "requestIdleCallback",
        vi.fn((callback: IdleRequestCallback, options?: IdleRequestOptions) => {
            const id = nextId++;
            if (options?.timeout !== undefined) {
                timers.set(
                    id,
                    window.setTimeout(() => {
                        timers.delete(id);
                        callback({ didTimeout: true, timeRemaining: () => 0 });
                    }, options.timeout),
                );
            }
            return id;
        }),
    );
    vi.stubGlobal(
        "cancelIdleCallback",
        vi.fn((id: number) => {
            const timer = timers.get(id);
            if (timer !== undefined) window.clearTimeout(timer);
            timers.delete(id);
        }),
    );
}

/** Installs the host bridge required to mount either webview in isolation. */
function installVsCodeMock(): void {
    Object.defineProperty(globalThis, "acquireVsCodeApi", {
        configurable: true,
        value: vi.fn(() => ({
            postMessage: vi.fn(),
            getState: vi.fn(() => ({})),
            setState: vi.fn(),
        })),
    });
    installWebviewI18n();
}

/** Delivers a production-shaped host message through the webview listener. */
function dispatchHostMessage(data: unknown): void {
    act(() => window.dispatchEvent(new MessageEvent("message", { data })));
}

/** Advances the fake clock through the required idle deadline and flushes React work. */
async function advancePastIdleTimeout(): Promise<void> {
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    await flush();
}

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetModules();
});

// Registers its unmount hook after the global cleanup above, so React disposes pending idle work
// before the requestIdleCallback doubles are removed.
initReactDomTestEnvironment();

describe("required Shiki initialization", () => {
    it("colors the diff viewer when voluntary idle work never runs", async () => {
        vi.useFakeTimers();
        installStarvedIdleScheduler();
        installVsCodeMock();
        const { App } = await import("../../../src/webviews/react/diff-viewer/DiffViewerApp");
        mount(<App />);
        await flush();

        dispatchHostMessage({
            type: "setDiffData",
            data: {
                path: "src/example.ts",
                leftLabel: "HEAD",
                rightLabel: "Working tree",
                languageId: "typescript",
                left: { eol: "lf", terminalNewline: true },
                right: { eol: "lf", terminalNewline: true },
                newlineDifference: false,
                ignoreWhitespace: false,
                segments: [
                    {
                        type: "common",
                        left: ['const greeting = "hello";'],
                        right: ['const greeting = "hello";'],
                    },
                ],
            },
        });
        await flush();
        expect(document.querySelectorAll('.code-lines span[style*="color"]')).toHaveLength(0);

        await advancePastIdleTimeout();

        expect(
            document.querySelectorAll('.code-lines span[style*="color"]').length,
        ).toBeGreaterThan(0);
    });

    it("colors the merge editor when voluntary idle work never runs", async () => {
        vi.useFakeTimers();
        installStarvedIdleScheduler();
        installVsCodeMock();
        const { App } = await import("../../../src/webviews/react/merge-editor/MergeEditorApp");
        mount(<App />);
        await flush();

        dispatchHostMessage({
            type: "setConflictData",
            data: {
                filePath: "src/conflict.ts",
                oursLabel: "main",
                theirsLabel: "feature",
                eol: "\n",
                hasTrailingNewline: true,
                segments: [
                    { type: "common", lines: ['const greeting = "hello";'] },
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
        expect(document.querySelectorAll('.code-lines span[style*="color"]')).toHaveLength(0);

        await advancePastIdleTimeout();

        expect(
            document.querySelectorAll('.code-lines span[style*="color"]').length,
        ).toBeGreaterThan(0);
    });
});
