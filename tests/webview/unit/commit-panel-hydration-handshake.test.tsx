// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useExtensionMessages } from "../../../src/webviews/react/commit-panel/hooks/useExtensionMessages";

const postMessage = vi.fn();

vi.mock("../../../src/webviews/react/commit-panel/hooks/useVsCodeApi", () => ({
    getVsCodeApi: () => ({ postMessage }),
}));

function Harness(): null {
    useExtensionMessages();
    return null;
}

beforeAll(() => {
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
        value: true,
        configurable: true,
    });
});

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
    postMessage.mockReset();
    document.body.innerHTML = "";
});

/** How many times the app has asked the host to hydrate it. */
function readyCount(): number {
    return postMessage.mock.calls.filter(([msg]) => msg?.type === "ready").length;
}

async function mountHarness(): Promise<{ root: Root; host: HTMLDivElement }> {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
        root.render(<Harness />);
    });
    return { root, host };
}

async function advance(ms: number): Promise<void> {
    await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
    });
}

/** The host's answer to `ready`: `postRepositoryListHydration` posts this unconditionally, so it
 * arrives even for a workspace with no repositories at all. */
function sendRepositoryList(repositories: unknown[]): void {
    window.dispatchEvent(
        new MessageEvent("message", {
            data: { type: "setRepositories", repositories, activeRepositoryRoot: null },
        }),
    );
}

/**
 * The hydration handshake is the panel's only route to content, and it used to be one-shot: the app
 * posted `ready` exactly once and the host answered exactly once. Nothing in that exchange is
 * acknowledged -- VS Code's `postMessage` resolves `false` when a webview is not live, and its own
 * contract says a `true` does NOT mean the message was received -- so a single dropped message in
 * either direction left the panel permanently blank, rendering no repositories, no empty state, and
 * no error. It reached CI as an intermittently blank commit panel whose document had mounted React
 * and been given nothing to show.
 *
 * These tests are written against the recovery behavior rather than the timer that implements it:
 * asking again, stopping when answered, and stopping when the budget runs out. The middle one is
 * what keeps the fix honest -- an implementation that simply re-posts `ready` forever satisfies the
 * first test alone, while hammering the host with a full repository refresh every tick.
 */
describe("commit-panel hydration handshake", () => {
    it("asks the host again when the first request goes unanswered", async () => {
        const { root, host } = await mountHarness();
        try {
            expect(readyCount(), "mounting must request hydration once").toBe(1);
            await advance(5_000);
            expect(
                readyCount(),
                "an unanswered hydration request must be retried, not abandoned",
            ).toBeGreaterThan(1);
        } finally {
            await act(async () => root.unmount());
            host.remove();
        }
    });

    it("stops asking once the host answers, even with no repositories", async () => {
        const { root, host } = await mountHarness();
        try {
            await act(async () => sendRepositoryList([]));
            await advance(60_000);
            expect(
                readyCount(),
                "an answered handshake must never re-ask; each retry costs the host a full refresh",
            ).toBe(1);
        } finally {
            await act(async () => root.unmount());
            host.remove();
        }
    });

    it("gives up retrying once the recovery budget is spent", async () => {
        const { root, host } = await mountHarness();
        try {
            await advance(60_000);
            const settled = readyCount();
            await advance(600_000);
            expect(
                readyCount(),
                "retrying must be bounded in time; a host that never answers is not coming back",
            ).toBe(settled);
        } finally {
            await act(async () => root.unmount());
            host.remove();
        }
    });

    it("stops retrying when the panel is torn down", async () => {
        const { root, host } = await mountHarness();
        await act(async () => root.unmount());
        host.remove();
        const afterUnmount = readyCount();
        await advance(60_000);
        expect(
            readyCount(),
            "a disposed webview must not keep posting to a host that no longer has a view",
        ).toBe(afterUnmount);
    });
});
