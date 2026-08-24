// Spec-derived tests for the webview capture boundary (PLAN.md Phase 3 step 15's 9 resolved
// host contexts, and step 16's exact-set-equality drift guard). Every test here is written to
// be able to fail: the tee/delivery/return-value tests exercise `wrapWebviewForCapture` against
// a fake `vscode.Webview` double that can independently report both what it received and what
// it returned, the gate test asserts identity equality (not just deep equality) so a wrapper
// that always allocates a new object cannot pass it by accident, and the completeness test reads
// the real production wiring files from disk so deleting or duplicating a wiring site changes
// its input rather than a hand-copied fixture.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type * as vscode from "vscode";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setE2eControlChannelActive } from "../../../src/e2e/activationState";
import {
    captureWebview,
    captureWebviewViewProvider,
    getE2eWebviewCaptureSink,
    resetE2eWebviewCaptureSinkForTests,
    resetWebviewWrapperNumberingForTests,
    WEBVIEW_CONTEXT_IDS,
    WebviewCaptureSink,
    wrapWebviewForCapture,
    type WebviewContextId,
} from "../../../src/e2e/webviewCapture";

const REPO_ROOT = join(__dirname, "..", "..", "..");

interface FakeWebview {
    webview: vscode.Webview;
    delivered: unknown[];
    setPostMessageResult(result: Thenable<boolean>): void;
    /**
     * Delivers `message` to whatever listener the code under test subscribed, and returns that
     * listener's own return value. The real host is the only producer of inbound messages, so this
     * stands in for it -- a wrapper that swallowed the listener, or its result, fails here.
     */
    receive(message: unknown): unknown;
    /** The `disposables` array the subscriber passed, if any. VS Code appends the subscription to
     * it, so a wrapper that drops it leaks the listener past its owner's disposal. */
    subscribedDisposables(): vscode.Disposable[] | undefined;
}

/** A controllable double for `vscode.Webview` that records what it actually received. */
function makeFakeWebview(): FakeWebview {
    let nextResult: Thenable<boolean> = Promise.resolve(true);
    let listener: ((message: unknown) => unknown) | undefined;
    let disposablesPassed: vscode.Disposable[] | undefined;
    const delivered: unknown[] = [];
    const webview = {
        options: {},
        html: "",
        cspSource: "vscode-webview://fake",
        onDidReceiveMessage: (
            handler: (message: unknown) => unknown,
            _thisArgs?: unknown,
            disposables?: vscode.Disposable[],
        ) => {
            listener = handler;
            disposablesPassed = disposables;
            return { dispose: () => undefined };
        },
        asWebviewUri: (uri: vscode.Uri) => uri,
        postMessage: (message: unknown) => {
            delivered.push(message);
            return nextResult;
        },
    } as unknown as vscode.Webview;

    return {
        webview,
        delivered,
        setPostMessageResult(result: Thenable<boolean>) {
            nextResult = result;
        },
        receive(message: unknown): unknown {
            if (!listener) {
                throw new Error(
                    "makeFakeWebview.receive: nothing has subscribed to onDidReceiveMessage yet.",
                );
            }
            return listener(message);
        },
        subscribedDisposables: () => disposablesPassed,
    };
}

beforeEach(() => {
    resetE2eWebviewCaptureSinkForTests();
    setE2eControlChannelActive(false);
});

afterEach(() => {
    resetE2eWebviewCaptureSinkForTests();
    setE2eControlChannelActive(false);
});

/**
 * The host's half of the hydration handshake trace.
 *
 * The webview counts its own asks (`src/webviews/react/shared/hydrationDiagnostics.ts`), and its
 * first CI reading was `asks:18 received:0` -- eighteen requests, no answer. That number cannot say
 * WHY: a host that never received the ask and a host that received it and answered a view nobody is
 * looking at leave the identical record behind. These lines are the other half, and the flow
 * suite's timeout dump reads them out of the page console.
 *
 * Traced by type only, and only the two types the handshake turns on. Both bounds are asserted
 * rather than described: a payload in the line would put repository contents in a CI artifact, and
 * a line per message would push the handshake out of the dump's bounded trail.
 */
describe("wrapWebviewForCapture: handshake trace", () => {
    // Wrapper numbering is process-wide, so without this the ids in these assertions would depend
    // on how many wrappers earlier tests happened to build -- and on the order vitest ran them in.
    beforeEach(() => {
        resetWebviewWrapperNumberingForTests();
    });

    /** Every `console.error` argument list emitted while `run` executed. */
    function tracedLines(run: () => void): string[] {
        const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        try {
            run();
            return spy.mock.calls.map((call) => call.map(String).join(" "));
        } finally {
            spy.mockRestore();
        }
    }

    it("traces the ask without altering what the listener sees or returns", () => {
        const fake = makeFakeWebview();
        const wrapped = wrapWebviewForCapture(
            fake.webview,
            "commit-panel",
            new WebviewCaptureSink(),
        );
        const seen: unknown[] = [];
        const ask = { type: "ready", attempt: 18 };
        const ownDisposables: vscode.Disposable[] = [];

        let returned: unknown;
        const lines = tracedLines(() => {
            wrapped.onDidReceiveMessage(
                (message: unknown) => {
                    seen.push(message);
                    return "listener-result";
                },
                undefined,
                ownDisposables,
            );
            returned = fake.receive(ask);
        });

        expect(seen, "the listener must receive the host's message itself, untouched").toEqual([
            ask,
        ]);
        expect(
            returned,
            "the listener's return value must reach the host -- this is a tap on the wire, not a " +
                "filter on it",
        ).toBe("listener-result");
        expect(
            fake.subscribedDisposables(),
            "the subscriber's own disposables array must still be the one VS Code appends to, or " +
                "the listener outlives whoever owned it",
        ).toBe(ownDisposables);
        expect(lines, "the ask must be traced, naming context, instance and direction").toEqual([
            "[intelligit-e2e] handshake commit-panel#1 in ready",
        ]);
    });

    it("traces the host's answer and stays quiet about every other message", () => {
        const fake = makeFakeWebview();
        const wrapped = wrapWebviewForCapture(
            fake.webview,
            "commit-panel",
            new WebviewCaptureSink(),
        );

        const lines = tracedLines(() => {
            wrapped.onDidReceiveMessage(() => undefined);
            void wrapped.postMessage({ type: "setRepositories", repositories: [] });
            void wrapped.postMessage({ type: "update", files: [] });
            fake.receive({ type: "refresh" });
            fake.receive("not-a-message");
            fake.receive(null);
        });

        expect(
            lines,
            "only the two handshake types may be traced: a line per message would evict the " +
                "handshake from the dump's bounded console trail",
        ).toEqual(["[intelligit-e2e] handshake commit-panel#1 out setRepositories"]);
    });

    /**
     * The field the 2026-08-23 Insiders failure needed and did not have.
     *
     * That dump traced `in ready` and `out setRepositories` repeatedly while the panel reported
     * `asks:18 received:0` and `postWebviewMessage` logged no delivery failure -- so the host
     * receives the ask, calls `postMessage`, and the answer still never lands. The one remaining
     * question is whether the answer went to the webview that asked, and the old line could not
     * say: both legs of every view printed the bare `commit-panel`.
     *
     * Asserted from the log lines rather than from the counter, because the log is the only thing
     * CI ever sees. A wrapper numbering per message, or reusing one number across wraps, passes
     * every other test in this file and leaves the next failure exactly as mute as the last one.
     */
    it("gives each wrapped webview its own number, shared by both legs of its handshake", () => {
        const first = makeFakeWebview();
        const second = makeFakeWebview();
        const sink = new WebviewCaptureSink();
        const wrappedFirst = wrapWebviewForCapture(first.webview, "commit-panel", sink);
        const wrappedSecond = wrapWebviewForCapture(second.webview, "commit-panel", sink);

        const lines = tracedLines(() => {
            wrappedFirst.onDidReceiveMessage(() => undefined);
            wrappedSecond.onDidReceiveMessage(() => undefined);
            // The shape the bug would print: one view asks, the OTHER is answered.
            first.receive({ type: "ready", attempt: 18 });
            void wrappedSecond.postMessage({ type: "setRepositories", repositories: [] });
            // ...and the shape a healthy handshake prints, from a single view.
            second.receive({ type: "ready", attempt: 1 });
        });

        expect(
            lines,
            "each wrapped webview must carry its own number and keep it across both directions: " +
                "identical numbers on a matched ask/answer pair acquit the record-versus-sender " +
                "split in postToWebview, and differing ones convict it -- a trace that cannot " +
                "tell those apart is why four investigations ended without an answer",
        ).toEqual([
            "[intelligit-e2e] handshake commit-panel#1 in ready",
            "[intelligit-e2e] handshake commit-panel#2 out setRepositories",
            "[intelligit-e2e] handshake commit-panel#2 in ready",
        ]);
    });

    it("never puts a payload in the trace", () => {
        const fake = makeFakeWebview();
        const wrapped = wrapWebviewForCapture(
            fake.webview,
            "commit-panel",
            new WebviewCaptureSink(),
        );

        const lines = tracedLines(() => {
            wrapped.onDidReceiveMessage(() => undefined);
            void wrapped.postMessage({
                type: "setRepositories",
                repositories: [{ root: "/home/someone/secret-client-work" }],
            });
        });

        expect(
            lines.join("\n"),
            "a captured message carries real repository data and this line lands in a CI artifact",
        ).not.toContain("secret-client-work");
    });
});

describe("wrapWebviewForCapture: tee", () => {
    it("records every postMessage in call order, tagged with the right context id", () => {
        const fake = makeFakeWebview();
        const sink = new WebviewCaptureSink();
        const wrapped = wrapWebviewForCapture(fake.webview, "commit-panel", sink);

        wrapped.postMessage({ type: "first" });
        wrapped.postMessage({ type: "second" });
        wrapped.postMessage({ type: "third" });

        expect(sink.getMessages()).toEqual([
            { contextId: "commit-panel", message: { type: "first" } },
            { contextId: "commit-panel", message: { type: "second" } },
            { contextId: "commit-panel", message: { type: "third" } },
        ]);
    });
});

describe("wrapWebviewForCapture: delivery is preserved", () => {
    it("still delivers every message to the real webview -- recording alone is not enough", () => {
        const fake = makeFakeWebview();
        const sink = new WebviewCaptureSink();
        const wrapped = wrapWebviewForCapture(fake.webview, "commit-info", sink);

        wrapped.postMessage({ type: "hello" });
        wrapped.postMessage({ type: "world" });

        // Both halves are asserted: a wrapper that records but swallows delivery would pass the
        // tee test above while failing this one.
        expect(fake.delivered).toEqual([{ type: "hello" }, { type: "world" }]);
        expect(sink.getMessages().map((m) => m.message)).toEqual([
            { type: "hello" },
            { type: "world" },
        ]);
    });
});

describe("wrapWebviewForCapture: return-value fidelity", () => {
    it("passes through the real webview's exact Thenable, not a re-wrapped one", async () => {
        const fake = makeFakeWebview();
        const sink = new WebviewCaptureSink();
        const wrapped = wrapWebviewForCapture(fake.webview, "commit-info", sink);

        const realPromise = Promise.resolve(false);
        fake.setPostMessageResult(realPromise);

        const returned = wrapped.postMessage({ type: "x" });
        expect(returned).toBe(realPromise);
        await expect(returned).resolves.toBe(false);
    });

    it("passes through a rejection unchanged", async () => {
        const fake = makeFakeWebview();
        const sink = new WebviewCaptureSink();
        const wrapped = wrapWebviewForCapture(fake.webview, "commit-info", sink);

        const rejection = Promise.reject(new Error("delivery failed"));
        rejection.catch(() => undefined); // Prevent an unrelated unhandled-rejection warning.
        fake.setPostMessageResult(rejection);

        await expect(wrapped.postMessage({ type: "x" })).rejects.toThrow("delivery failed");
    });
});

describe("captureWebview: gate off is a complete no-op", () => {
    it("hands back the identical object and allocates no sink", () => {
        setE2eControlChannelActive(false);
        const fake = makeFakeWebview();
        const target = { webview: fake.webview, viewType: "intelligit.test" };

        const result = captureWebview(target, "undocked");

        expect(result).toBe(target); // Identity, not deep equality.
        expect(getE2eWebviewCaptureSink()).toBeUndefined();

        result.webview.postMessage({ type: "should-not-be-recorded" });
        expect(getE2eWebviewCaptureSink()).toBeUndefined();
        expect(fake.delivered).toEqual([{ type: "should-not-be-recorded" }]);
    });
});

describe("captureWebview: gate on wraps and records into the shared sink", () => {
    it("wraps the boundary object's webview field and forwards other properties/methods", () => {
        setE2eControlChannelActive(true);
        const fake = makeFakeWebview();
        let revealed = false;
        const target = {
            webview: fake.webview,
            viewType: "intelligit.test",
            reveal(): void {
                revealed = true;
            },
        };

        const result = captureWebview(target, "undocked");

        expect(result).not.toBe(target);
        expect(result.viewType).toBe("intelligit.test");
        result.reveal();
        expect(revealed).toBe(true);

        result.webview.postMessage({ type: "seen" });
        expect(fake.delivered).toEqual([{ type: "seen" }]);
        expect(getE2eWebviewCaptureSink()?.getMessages()).toEqual([
            { contextId: "undocked", message: { type: "seen" } },
        ]);
    });

    it("forwards a mutable property write to the real underlying object", () => {
        setE2eControlChannelActive(true);
        const fake = makeFakeWebview();
        const target: { webview: vscode.Webview; title: string } = {
            webview: fake.webview,
            title: "original",
        };

        const result = captureWebview(target, "merge-editor");
        result.title = "renamed";

        expect(target.title).toBe("renamed");
    });
});

// These exercise `captureWebviewViewProvider`, the function production actually calls, rather
// than any decorator behind it. Testing the decorator directly would leave the gate-on branch of
// the production entry point uncovered, which is exactly where the transparency defect below
// lived: a wrapper can satisfy every `resolveWebviewView` assertion while silently dropping
// every other member of the provider it stands in for.
describe("captureWebviewViewProvider: gate off => no-op", () => {
    it("returns the real provider instance, identity-equal, and records nothing", () => {
        setE2eControlChannelActive(false);
        const fake = makeFakeWebview();
        const webviewView = { webview: fake.webview, viewType: "intelligit.test" };
        let received: unknown;
        const inner: vscode.WebviewViewProvider = {
            resolveWebviewView: (view) => {
                received = view;
            },
        };

        const wired = captureWebviewViewProvider(inner, "commit-info");
        wired.resolveWebviewView(
            webviewView as unknown as vscode.WebviewView,
            {} as vscode.WebviewViewResolveContext,
            {} as vscode.CancellationToken,
        );

        expect(wired).toBe(inner);
        expect(received).toBe(webviewView);
        expect(getE2eWebviewCaptureSink()).toBeUndefined();
    });
});

describe("captureWebviewViewProvider: gate on", () => {
    it("tags messages posted by the inner provider with the wired context id", () => {
        setE2eControlChannelActive(true);
        const fake = makeFakeWebview();
        const webviewView = { webview: fake.webview, viewType: "intelligit.test" };
        const inner: vscode.WebviewViewProvider = {
            resolveWebviewView: (view) => {
                view.webview.postMessage({ type: "from-inner-provider" });
            },
        };

        const wired = captureWebviewViewProvider(inner, "commit-graph-card");
        wired.resolveWebviewView(
            webviewView as unknown as vscode.WebviewView,
            {} as vscode.WebviewViewResolveContext,
            {} as vscode.CancellationToken,
        );

        expect(fake.delivered).toEqual([{ type: "from-inner-provider" }]);
        expect(getE2eWebviewCaptureSink()?.getMessages()).toEqual([
            { contextId: "commit-graph-card", message: { type: "from-inner-provider" } },
        ]);
    });

    // Regression: the real providers carry members far beyond the `WebviewViewProvider`
    // interface, and `view-providers.integration.test.ts` calls `dispose()` on the REGISTERED
    // provider. A wrapper implementing `resolveWebviewView` alone passes every other test in
    // this file and still throws `TypeError: dispose is not a function` the moment the gate is
    // on -- i.e. it breaks only in E2E runs, the one mode this module exists to serve. Calling
    // through `this.viewType` inside `dispose` also pins the binding: an unbound forward would
    // lose `this` and record `undefined`.
    it("forwards every member the concrete provider carries beyond resolveWebviewView", () => {
        setE2eControlChannelActive(true);
        const disposed: string[] = [];
        class ConcreteProvider {
            readonly viewType = "intelligit.concrete";
            resolveWebviewView(): void {}
            dispose(): void {
                disposed.push(this.viewType);
            }
        }
        const inner = new ConcreteProvider();

        const wired = captureWebviewViewProvider(inner, "commit-panel");
        wired.dispose();

        expect(disposed).toEqual(["intelligit.concrete"]);
        expect(wired.viewType).toBe("intelligit.concrete");
    });
});

describe("WEBVIEW_CONTEXT_IDS: completeness against the real wiring sites", () => {
    /**
     * Extracts every context-id string literal passed to `captureWebview(...)` or
     * `captureWebviewViewProvider(...)` from a real source file. Reading the file from
     * disk (rather than hand-copying the id list here) is what makes this test able to go red:
     * deleting a wiring site removes an id from the extracted set, and duplicating one leaves
     * the set the same size while still missing whatever the duplicate replaced.
     */
    function extractWiredContextIds(relativePath: string): string[] {
        const source = readFileSync(join(REPO_ROOT, relativePath), "utf8");
        const ids: string[] = [];
        // Matches `captureWebview(rawPanel, "merge-editor")` -- the panel call sites.
        // The negative lookahead excludes `captureWebviewViewProvider(...)`, which has its own
        // pattern below and would otherwise also match this one (`captureWebview` is a prefix
        // of `captureWebviewViewProvider`).
        for (const match of source.matchAll(
            /captureWebview(?!ViewProvider)\([^,]+,\s*"([a-z-]+)"/g,
        )) {
            ids.push(match[1]);
        }
        // Matches `captureWebviewViewProvider(commitInfo, "commit-info")` -- the gated
        // production entry point every view-provider registration site must call. It is the
        // only supported way to wire one: it is what returns the real provider unchanged when
        // the gate is off, so a site that wrapped a provider by any other route would lose
        // identity-equality in production and is deliberately not matched here.
        for (const match of source.matchAll(/captureWebviewViewProvider\([^,]+,\s*"([a-z-]+)"/g)) {
            ids.push(match[1]);
        }
        return ids;
    }

    it("is used at exactly the wiring sites it declares -- exact set equality, not a count", () => {
        const wiringFiles = [
            "src/activation/repositoryMode.ts",
            "src/views/UndockedViewProvider.ts",
            "src/views/MergeEditorPanel.ts",
            "src/views/ShelfConflictEditorPanel.ts",
            "src/views/MergeConflictSessionPanel.ts",
            "src/views/DiffViewerPanel.ts",
        ];

        const wiredIds = wiringFiles.flatMap(extractWiredContextIds);

        // A raw id can legitimately appear at two literal call sites for the same context (this
        // codebase's `SwitchableWebviewViewProvider` branch wires either `.setProvider(...)` or
        // `registerWebviewViewProvider(...)` for the same context, never both at once), so this
        // is deliberately a SET comparison, not a count: `wiredIds.length` is not asserted
        // against `WEBVIEW_CONTEXT_IDS.length` anywhere in this test. A duplicated id used in
        // place of a missing one still leaves the distinct set one short and one wrong, which
        // `toEqual` below catches; a plain count would not (PLAN.md step 16).
        const wiredSet = new Set(wiredIds);
        const declaredSet = new Set<string>(WEBVIEW_CONTEXT_IDS);

        expect(wiredSet).toEqual(declaredSet);
    });
});

describe("WEBVIEW_CONTEXT_IDS: type-level guard", () => {
    it("accepts every declared id as a WebviewContextId", () => {
        const ids: readonly WebviewContextId[] = WEBVIEW_CONTEXT_IDS;
        expect(ids).toHaveLength(9);
        expect(new Set(ids).size).toBe(9);
    });
});
