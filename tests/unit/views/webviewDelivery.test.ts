/**
 * Contract tests for the one place four view providers now send through.
 *
 * The bug this replaced was `this.view?.webview.postMessage(msg)` -- promise dropped -- repeated in
 * `CommitPanelViewProvider`, `CommitGraphViewProvider`, `CommitInfoViewProvider`, and
 * `UndockedViewProvider`. VS Code answers `postMessage` three ways and that line treated all three
 * as success, so a view that never received its hydration was indistinguishable, from the host's
 * side, from one that did. It also left a rejecting `postMessage` as an unhandled rejection in the
 * extension host.
 *
 * These tests are written against the three answers rather than against the implementation: each
 * one names an outcome a real host produces and asserts what a reader of the log can then tell.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { postWebviewMessage } from "../../../src/views/webviewDelivery";

/** Drains the microtask queue so a `then` handler attached inside the call under test has run. */
function flushMicrotasks(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}

describe("postWebviewMessage", () => {
    let restoreConsole: (() => void) | undefined;

    afterEach(() => {
        restoreConsole?.();
        restoreConsole = undefined;
    });

    function captureConsoleErrors(): string[] {
        const lines: string[] = [];
        const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
            lines.push(args.map((arg) => String(arg)).join(" "));
        });
        restoreConsole = () => spy.mockRestore();
        return lines;
    }

    /**
     * VS Code types `postMessage` as `Thenable<boolean>`, which is `then`-only -- there is no
     * `.catch` on it. Tests that hand back a real `Promise` would keep passing an implementation
     * that reached for `.catch`, and that implementation would throw against the real API. So the
     * doubles here are deliberately `then`-only.
     */
    function thenableWebview(settled: PromiseLike<boolean>): {
        postMessage: () => PromiseLike<boolean>;
    } {
        return {
            postMessage: () => ({
                then: <A, B>(
                    onFulfilled?: (value: boolean) => A | PromiseLike<A>,
                    onRejected?: (reason: unknown) => B | PromiseLike<B>,
                ) => settled.then(onFulfilled, onRejected),
            }),
        };
    }

    it("says nothing when the message is delivered", async () => {
        const errors = captureConsoleErrors();

        postWebviewMessage(
            thenableWebview(Promise.resolve(true)),
            { type: "update" },
            "Commit panel",
        );
        await flushMicrotasks();

        expect(
            errors,
            "a delivered message is the ordinary case; logging it would bury the failures this " +
                "helper exists to surface",
        ).toEqual([]);
    });

    it("reports a message the host accepted and did not deliver", async () => {
        const errors = captureConsoleErrors();

        postWebviewMessage(
            thenableWebview(Promise.resolve(false)),
            { type: "setRepositories" },
            "Commit panel",
        );
        await flushMicrotasks();

        const reported = errors.join("\n");
        expect(
            reported,
            "a resolved `false` is the host saying the view never got it -- the type is how a " +
                "reader knows WHICH message was lost",
        ).toContain("setRepositories");
        expect(
            reported,
            "four providers send through this helper, so a report that does not name its source " +
                "cannot be traced back to a view",
        ).toContain("Commit panel");
    });

    it("reports a rejected send together with its reason", async () => {
        const errors = captureConsoleErrors();

        postWebviewMessage(
            thenableWebview(Promise.reject(new Error("Webview is disposed"))),
            { type: "setCommitDetail" },
            "Commit graph",
        );
        await flushMicrotasks();

        const reported = errors.join("\n");
        expect(reported, "the lost message must be identifiable").toContain("setCommitDetail");
        expect(reported, "the sending view must be identifiable").toContain("Commit graph");
        expect(
            reported,
            "reporting that a post failed without the reason leaves the reader exactly where the " +
                "silent version did",
        ).toContain("Webview is disposed");
    });

    /**
     * The rejection arm is not only a log line. Without it the promise rejects with nothing
     * attached, and Node raises `unhandledRejection` in the extension host -- a crash report for
     * what is really a lost message. Listening for the event directly, rather than relying on
     * Vitest failing the run, is what makes this an assertion instead of a formality: it fails on
     * this test's own line, and it fails whether or not the runner happens to police the process.
     */
    it("handles a rejection rather than leaving it to the extension host", async () => {
        captureConsoleErrors();
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown): void => {
            unhandled.push(reason);
        };
        process.on("unhandledRejection", onUnhandled);
        try {
            postWebviewMessage(
                thenableWebview(Promise.reject(new Error("channel closed"))),
                { type: "error" },
                "Undocked panel",
            );
            // Node raises the event a full turn after the microtask queue drains, so one flush is
            // not enough to observe it.
            await flushMicrotasks();
            await flushMicrotasks();
        } finally {
            process.off("unhandledRejection", onUnhandled);
        }

        expect(
            unhandled.map((reason) => String(reason)),
            "an unattended rejection reaches the host as a crash report about a message the user " +
                "never needed to know had a promise behind it",
        ).toEqual([]);
    });

    /**
     * The other way a real `postMessage` fails: throwing on the spot rather than rejecting. Every
     * caller reaches this helper from a plain synchronous statement -- several from disposal and
     * error-handling paths -- so a throw here would replace a lost message with a broken operation,
     * and in a `catch` block would displace the error being reported.
     */
    it("reports rather than throws when postMessage fails synchronously", async () => {
        const errors = captureConsoleErrors();
        const throwingWebview = {
            postMessage: (): Thenable<boolean> => {
                throw new Error("Webview is disposed");
            },
        };

        expect(() =>
            postWebviewMessage(throwingWebview, { type: "update" }, "Commit info"),
        ).not.toThrow();
        await flushMicrotasks();

        const reported = errors.join("\n");
        expect(reported, "the lost message must still be identifiable").toContain("update");
        expect(reported, "the sending view must still be identifiable").toContain("Commit info");
        expect(
            reported,
            "a synchronous failure is as invisible as a rejected one if it is only swallowed",
        ).toContain("Webview is disposed");
    });
});
