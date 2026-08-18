// Spec-derived tests for the webview-side leg of the E2E control channel (PLAN.md Phase 1
// step 10): "gated at runtime on a window.intelligitE2E flag that the shell injects only
// when the host gates above are satisfied. Runtime-gated, not build-gated." The suite runs
// in the default node environment (matching this repo's existing webview-unit convention in
// settings.test.ts) and stubs `window` directly rather than using jsdom.

import { afterEach, describe, expect, it, vi } from "vitest";
import { installE2eStateBridge } from "../../../src/webviews/react/shared/e2eStateBridge";
import type { VsCodeApi } from "../../../src/webviews/react/shared/vscodeApi";

type MessageListener = (event: { data: unknown }) => void;

interface StubbedWindow {
    listeners: MessageListener[];
    dispatched: { type: string; detail: unknown }[];
}

/** Stubs the global `window` with a controllable `addEventListener`/`dispatchEvent`. */
function stubWindow(intelligitE2E: unknown): StubbedWindow {
    const stub: StubbedWindow = { listeners: [], dispatched: [] };
    vi.stubGlobal("window", {
        intelligitE2E,
        addEventListener: (type: string, listener: MessageListener) => {
            if (type === "message") {
                stub.listeners.push(listener);
            }
        },
        dispatchEvent: (event: CustomEvent) => {
            stub.dispatched.push({ type: event.type, detail: event.detail as unknown });
            return true;
        },
    });
    return stub;
}

function makeFakeApi(initialState: unknown = undefined): {
    api: VsCodeApi<unknown, unknown>;
    posted: Record<string, unknown>[];
    getSetStateCalls: () => unknown[];
} {
    let state = initialState;
    const setStateCalls: unknown[] = [];
    const posted: Record<string, unknown>[] = [];
    const api: VsCodeApi<unknown, unknown> = {
        postMessage: (message: unknown) => {
            posted.push(message as Record<string, unknown>);
        },
        getState: () => state,
        setState: (next: unknown) => {
            state = next;
            setStateCalls.push(next);
        },
    };
    return { api, posted, getSetStateCalls: () => setStateCalls };
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("installE2eStateBridge: gating", () => {
    it("installs no listener when window.intelligitE2E is undefined", () => {
        const stub = stubWindow(undefined);
        const { api } = makeFakeApi();
        installE2eStateBridge(api);
        expect(stub.listeners).toHaveLength(0);
    });

    it("installs no listener when window.intelligitE2E is false", () => {
        const stub = stubWindow(false);
        const { api } = makeFakeApi();
        installE2eStateBridge(api);
        expect(stub.listeners).toHaveLength(0);
    });

    it('installs no listener for a truthy non-boolean-true value (e.g. the string "true")', () => {
        // Only the literal boolean true satisfies the gate -- matches the host-side gate's
        // own "only the literal string satisfies it" discipline for INTELLIGIT_E2E.
        const stub = stubWindow("true");
        const { api } = makeFakeApi();
        installE2eStateBridge(api);
        expect(stub.listeners).toHaveLength(0);
    });

    it("installs a listener when window.intelligitE2E is true", () => {
        const stub = stubWindow(true);
        const { api } = makeFakeApi();
        installE2eStateBridge(api);
        expect(stub.listeners).toHaveLength(1);
    });
});

describe("installE2eStateBridge: message filtering", () => {
    it("ignores a message with no source field", () => {
        const stub = stubWindow(true);
        const { api, posted } = makeFakeApi({});
        installE2eStateBridge(api);
        stub.listeners[0]?.({ data: { callId: "c1", operation: "snapshot", key: "groupByDir" } });
        expect(posted).toHaveLength(0);
    });

    it("ignores a message from an unrelated protocol", () => {
        const stub = stubWindow(true);
        const { api, posted } = makeFakeApi({});
        installE2eStateBridge(api);
        stub.listeners[0]?.({
            data: {
                source: "someOtherProtocol",
                callId: "c1",
                operation: "snapshot",
                key: "groupByDir",
            },
        });
        expect(posted).toHaveLength(0);
    });

    it("ignores a message with an invalid operation", () => {
        const stub = stubWindow(true);
        const { api, posted } = makeFakeApi({});
        installE2eStateBridge(api);
        stub.listeners[0]?.({
            data: {
                source: "intelligitE2E",
                callId: "c1",
                operation: "destroy",
                key: "groupByDir",
            },
        });
        expect(posted).toHaveLength(0);
    });
});

describe("installE2eStateBridge: allowlist rejection", () => {
    it("replies ok:false for an unlisted key without reading or writing state", () => {
        const stub = stubWindow(true);
        const { api, posted, getSetStateCalls } = makeFakeApi({ groupByDir: true });
        installE2eStateBridge(api);

        stub.listeners[0]?.({
            data: {
                source: "intelligitE2E",
                callId: "c1",
                operation: "snapshot",
                key: "notAllowlisted",
            },
        });

        expect(posted).toEqual([
            {
                source: "intelligitE2E",
                callId: "c1",
                ok: false,
                error: expect.stringContaining("not allowlisted"),
            },
        ]);
        expect(getSetStateCalls()).toHaveLength(0);
    });
});

describe("installE2eStateBridge: snapshot", () => {
    it("replies with the persisted value for an allowlisted key", () => {
        const stub = stubWindow(true);
        const { api, posted } = makeFakeApi({ groupByDir: true, checked: ["a.ts"] });
        installE2eStateBridge(api);

        stub.listeners[0]?.({
            data: { source: "intelligitE2E", callId: "c1", operation: "snapshot", key: "checked" },
        });

        expect(posted).toEqual([
            { source: "intelligitE2E", callId: "c1", ok: true, value: ["a.ts"] },
        ]);
    });

    it("replies with null when the key is absent from persisted state", () => {
        const stub = stubWindow(true);
        const { api, posted } = makeFakeApi({});
        installE2eStateBridge(api);

        stub.listeners[0]?.({
            data: {
                source: "intelligitE2E",
                callId: "c1",
                operation: "snapshot",
                key: "groupByDir",
            },
        });

        expect(posted).toEqual([{ source: "intelligitE2E", callId: "c1", ok: true, value: null }]);
    });

    it("replies with null (not a crash) when getState() returns undefined", () => {
        const stub = stubWindow(true);
        const { api, posted } = makeFakeApi(undefined);
        installE2eStateBridge(api);

        stub.listeners[0]?.({
            data: {
                source: "intelligitE2E",
                callId: "c1",
                operation: "snapshot",
                key: "groupByDir",
            },
        });

        expect(posted).toEqual([{ source: "intelligitE2E", callId: "c1", ok: true, value: null }]);
    });
});

describe("installE2eStateBridge: seed", () => {
    it("merges the value into persisted state, signals a remount, and acknowledges", () => {
        const stub = stubWindow(true);
        const { api, posted, getSetStateCalls } = makeFakeApi({ existingKey: "kept" });
        installE2eStateBridge(api);

        stub.listeners[0]?.({
            data: {
                source: "intelligitE2E",
                callId: "c1",
                operation: "seed",
                key: "groupByDir",
                value: true,
            },
        });

        expect(getSetStateCalls()).toEqual([{ existingKey: "kept", groupByDir: true }]);
        expect(stub.dispatched).toEqual([
            { type: "intelligit:e2e-seed", detail: { key: "groupByDir", value: true } },
        ]);
        expect(posted).toEqual([{ source: "intelligitE2E", callId: "c1", ok: true, value: null }]);
    });
});

describe("installE2eStateBridge: reset", () => {
    it("removes the key from persisted state, signals a remount, and acknowledges", () => {
        const stub = stubWindow(true);
        const { api, posted, getSetStateCalls } = makeFakeApi({
            groupByDir: true,
            checked: ["a.ts"],
        });
        installE2eStateBridge(api);

        stub.listeners[0]?.({
            data: { source: "intelligitE2E", callId: "c1", operation: "reset", key: "groupByDir" },
        });

        expect(getSetStateCalls()).toEqual([{ checked: ["a.ts"] }]);
        expect(stub.dispatched).toEqual([
            { type: "intelligit:e2e-seed", detail: { key: "groupByDir", value: undefined } },
        ]);
        expect(posted).toEqual([{ source: "intelligitE2E", callId: "c1", ok: true, value: null }]);
    });

    it("does not mutate the object returned by a prior getState() call (immutability)", () => {
        const stub = stubWindow(true);
        const originalState = { groupByDir: true, checked: ["a.ts"] };
        const { api } = makeFakeApi(originalState);
        installE2eStateBridge(api);

        stub.listeners[0]?.({
            data: { source: "intelligitE2E", callId: "c1", operation: "reset", key: "groupByDir" },
        });

        expect(originalState).toEqual({ groupByDir: true, checked: ["a.ts"] });
    });
});
