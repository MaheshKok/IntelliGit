// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
    recordHostMessage,
    recordHydrationAsk,
} from "../../../src/webviews/react/shared/hydrationDiagnostics";

/** The global under test, read by `tests/e2e/pageObjects/intelliGitView.ts`'s timeout dump. */
const GLOBAL_KEY = "intelligitHydrationDiagnostics";

function readDiagnostics(): unknown {
    return (window as unknown as Record<string, unknown>)[GLOBAL_KEY];
}

afterEach(() => {
    // Unstubbed first: the no-window case replaces `window` with `undefined`, and cleanup that
    // reached for its properties would fail in the very test that proves the guard works.
    vi.unstubAllGlobals();
    delete (window as unknown as Record<string, unknown>)[GLOBAL_KEY];
    delete (window as unknown as Record<string, unknown>).intelligitE2E;
});

describe("hydration diagnostics", () => {
    it("allocates nothing when the E2E gate is off", () => {
        recordHydrationAsk();
        recordHostMessage({ type: "setRepositories" });

        expect(
            readDiagnostics(),
            "a production webview must not grow a diagnostic global just because the hook called " +
                "a recorder -- the gate-off path is the one every user runs, and `undefined` here " +
                "is the only evidence that nothing was allocated",
        ).toBeUndefined();
    });

    it("counts asks and host messages once the gate is on", () => {
        window.intelligitE2E = true;

        recordHydrationAsk();
        recordHydrationAsk();
        recordHostMessage({ type: "setRepositories" });

        expect(readDiagnostics()).toEqual({
            asks: 2,
            hostMessages: 1,
            lastHostMessageType: "setRepositories",
        });
    });

    it("counts a host message the reducer could never parse", () => {
        window.intelligitE2E = true;

        recordHostMessage("not-a-message");
        recordHostMessage(null);
        recordHostMessage({ type: 7 });

        expect(
            readDiagnostics(),
            "the fork this instrument exists to split is `the host never answered` versus `the " +
                "host answered and the webview ignored it`, so a payload no case matches is " +
                "exactly the evidence that must still be counted",
        ).toEqual({ asks: 0, hostMessages: 3, lastHostMessageType: null });
    });

    it("reports the most recent host message type, not the first", () => {
        window.intelligitE2E = true;

        recordHostMessage({ type: "setRepositories" });
        recordHostMessage({ type: "update" });

        expect(readDiagnostics()).toMatchObject({ lastHostMessageType: "update" });
    });

    it("does not throw outside a browser document", () => {
        vi.stubGlobal("window", undefined);

        expect(() => {
            recordHydrationAsk();
            recordHostMessage({ type: "setRepositories" });
        }, "`getVsCodeApi` is exercised from plain Node unit tests, so a recorder that assumed a window would turn every one of them red").not.toThrow();
    });
});
