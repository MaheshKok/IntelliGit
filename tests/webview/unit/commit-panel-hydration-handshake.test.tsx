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
    return readyMessages().length;
}

/** Every hydration request the app has posted, in order. */
function readyMessages(): { type: string; attempt?: number }[] {
    return postMessage.mock.calls
        .map(([msg]) => msg as { type: string; attempt?: number })
        .filter((msg) => msg?.type === "ready");
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

    /**
     * This replaces a test that asserted the opposite -- that retrying stops once a fixed budget is
     * spent. That budget was the defect, not a safeguard. A panel that stops asking has no route
     * back to content: `onDidChangeVisibility` re-posts the working-tree snapshot but never the
     * repository list, and the reducer deliberately refuses to set `hydrated` from a snapshot, so
     * the ONLY producer of a hydrated panel is an answer to `ready`. Giving up therefore converted
     * any single dropped message into a permanently blank pane, which is how it reached CI: run
     * 31964819068 timed out against a webview that had mounted React, rendered its placeholder, and
     * stopped asking fifteen seconds earlier while the host sat alive and fully populated beside it.
     *
     * The budget existed for a real reason -- each re-ask cost the host a full Git refresh -- so the
     * cost is what changed. `attempt` lets the host answer a re-ask from what it already holds
     * (asserted host-side in `tests/unit/views/CommitPanelViewProvider.test.ts`), which makes a slow
     * heartbeat affordable and removes the only argument for ever stopping.
     */
    it("keeps asking after the initial burst rather than giving up on the host", async () => {
        const { root, host } = await mountHarness();
        try {
            await advance(60_000);
            const settled = readyCount();
            await advance(600_000);
            expect(
                readyCount(),
                "an unhydrated panel must never stop asking; stopping is what makes a blank " +
                    "panel permanent, and the host has no other way to reach it",
            ).toBeGreaterThan(settled);
        } finally {
            await act(async () => root.unmount());
            host.remove();
        }
    });

    /**
     * Two windows of the SAME length, counting retries against retries. The mount announcement is
     * subtracted deliberately: it is not a retry, and leaving it in the first window's total makes
     * the comparison pass for an implementation with no backoff at all -- 15 retries in the second
     * window still reads as "fewer than 16" in the first. Verified by mutation: dropping the
     * backoff to a flat interval left this test green until the announcement came out of the count.
     */
    it("keeps the heartbeat slower than the opening burst", async () => {
        const { root, host } = await mountHarness();
        try {
            await advance(15_000);
            const burstRetries = readyCount() - 1;
            await advance(15_000);
            const heartbeatRetries = readyCount() - 1 - burstRetries;
            expect(
                heartbeatRetries,
                "a panel nobody has answered in fifteen seconds is waiting on something slow; " +
                    "asking at the opening rate forever is a busy-wait, not a recovery",
            ).toBeLessThan(burstRetries);
            expect(heartbeatRetries, "the heartbeat must still be a heartbeat").toBeGreaterThan(0);
        } finally {
            await act(async () => root.unmount());
            host.remove();
        }
    });

    it("numbers each attempt so the host can tell a re-ask from a fresh panel", async () => {
        const { root, host } = await mountHarness();
        try {
            await advance(5_000);
            const attempts = readyMessages().map((msg) => msg.attempt);
            expect(
                attempts[0],
                "a freshly mounted panel is attempt 1; the host owes it the full startup read",
            ).toBe(1);
            expect(
                attempts.slice(1),
                "every re-ask must be numbered above 1, or the host cannot answer it cheaply " +
                    "and the unbounded retry above becomes a refresh stampede",
            ).not.toContain(1);
            expect(
                [...attempts].sort((a, b) => (a ?? 0) - (b ?? 0)),
                "attempts must ascend so the host reads them as one panel re-asking",
            ).toEqual(attempts);
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
