// Spec-derived tests for the webview capture boundary (PLAN.md Phase 3 step 15's 8 resolved
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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setE2eControlChannelActive } from "../../../src/e2e/activationState";
import {
    captureWebview,
    captureWebviewViewProvider,
    getE2eWebviewCaptureSink,
    resetE2eWebviewCaptureSinkForTests,
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
}

/** A controllable double for `vscode.Webview` that records what it actually received. */
function makeFakeWebview(): FakeWebview {
    let nextResult: Thenable<boolean> = Promise.resolve(true);
    const delivered: unknown[] = [];
    const webview = {
        options: {},
        html: "",
        cspSource: "vscode-webview://fake",
        onDidReceiveMessage: () => ({ dispose: () => undefined }),
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
        expect(ids).toHaveLength(8);
        expect(new Set(ids).size).toBe(8);
    });
});
