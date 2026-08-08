// Covers the glue between the host-side E2E gate and a real production webview:
// `buildWebviewShellHtml`'s E2E bootstrap branch. That branch had no test at all, which is
// why a view-id collision between the two panel classes sharing `webview-mergeeditor.js`
// survived review -- there was no oracle for this path, not merely a weak one.
//
// PLAN.md Phase 1 step 10: the webview leg is runtime-gated on `window.intelligitE2E`, never
// build-gated, and an unaddressable view must be a hard failure rather than a silent wrong
// answer. A colliding view id defeats the second half: `E2eWebviewRegistry.register` replaces
// the previous entry, so a request would be answered by whichever instance registered last.

import { beforeEach, describe, expect, it, vi } from "vitest";

const ACTIVATION_STATE_MODULE = "../../../src/e2e/activationState";
const WEBVIEW_HTML_MODULE = "../../../src/views/webviewHtml";

/** Mocks `vscode` with the minimum surface `buildWebviewShellHtml` touches. */
function mockVsCode(): void {
    vi.doMock("vscode", () => ({
        env: { language: "en" },
        Uri: {
            joinPath: (_base: { path?: string }, ...parts: string[]): { path: string } => ({
                path: `/${parts.join("/")}`,
            }),
        },
        workspace: { getConfiguration: () => ({ get: () => undefined }) },
    }));
}

/**
 * Mocks the control-channel activation state, returning the `register` spy so a test can
 * assert exactly which view ids were registered.
 */
function mockActivationState(active: boolean): ReturnType<typeof vi.fn> {
    const register = vi.fn();
    vi.doMock(ACTIVATION_STATE_MODULE, () => ({
        isE2eControlChannelActive: () => active,
        getE2eWebviewRegistry: () => (active ? { register } : undefined),
    }));
    return register;
}

type ShellOptions = Parameters<
    typeof import("../../../src/views/webviewHtml").buildWebviewShellHtml
>[0];

/** Builds shell HTML with a stub webview, forwarding any per-test overrides. */
async function buildHtml(overrides: Partial<ShellOptions> = {}): Promise<string> {
    const { buildWebviewShellHtml } = await import(WEBVIEW_HTML_MODULE);
    const extensionUri = { path: "/ext" } as unknown as ShellOptions["extensionUri"];
    const webview = {
        cspSource: "vscode-resource:",
        asWebviewUri: (uri: { path: string }) => `webview://${uri.path}`,
    } as unknown as ShellOptions["webview"];

    return buildWebviewShellHtml({
        extensionUri,
        webview,
        scriptFile: "webview-commitpanel.js",
        title: "Commit Panel",
        ...overrides,
    });
}

describe("buildWebviewShellHtml E2E bootstrap", () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
    });

    it("injects nothing and registers nothing when the control channel is inactive", async () => {
        mockVsCode();
        const register = mockActivationState(false);

        const html = await buildHtml();

        expect(html).not.toContain("intelligitE2E");
        expect(register).not.toHaveBeenCalled();
    });

    it("injects the runtime flag and registers the view when the channel is active", async () => {
        mockVsCode();
        const register = mockActivationState(true);

        const html = await buildHtml();

        expect(html).toContain("window.intelligitE2E = true;");
        expect(register).toHaveBeenCalledTimes(1);
        expect(register.mock.calls[0]?.[0]).toBe("webview-commitpanel");
    });

    it("derives the default view id from the script file, dropping directories and extension", async () => {
        mockVsCode();
        const register = mockActivationState(true);

        await buildHtml({ scriptFile: "nested/dir/webview-undocked.js" });

        expect(register.mock.calls[0]?.[0]).toBe("webview-undocked");
    });

    it("prefers an explicit e2eViewId over the script-derived default", async () => {
        mockVsCode();
        const register = mockActivationState(true);

        await buildHtml({ scriptFile: "webview-mergeeditor.js", e2eViewId: "merge-editor src/a.ts" });

        expect(register.mock.calls[0]?.[0]).toBe("merge-editor src/a.ts");
    });

    // The regression this file exists for. `MergeEditorPanel` and `ShelfConflictEditorPanel`
    // both render `webview-mergeeditor.js` and both keep a static Map of live panels, so
    // several instances are open at once. Without distinct ids they all collapse onto one
    // registry key and the last registration silently wins.
    it("keeps concurrent instances of one shared bundle on distinct registry keys", async () => {
        mockVsCode();
        const register = mockActivationState(true);

        await buildHtml({
            scriptFile: "webview-mergeeditor.js",
            e2eViewId: "merge-editor src/first.ts",
        });
        await buildHtml({
            scriptFile: "webview-mergeeditor.js",
            e2eViewId: "merge-editor src/second.ts",
        });
        await buildHtml({
            scriptFile: "webview-mergeeditor.js",
            e2eViewId: "shelf-conflict-editor /repo\u0000shelf-1\u0000change-1",
        });

        const registeredIds = register.mock.calls.map((call) => call[0]);
        expect(registeredIds).toHaveLength(3);
        expect(new Set(registeredIds).size).toBe(3);
    });

    // Characterizes *why* the explicit id is mandatory: omitting it makes the three cases
    // above indistinguishable. If this ever stops colliding, the override is no longer needed.
    it("collides when a shared bundle omits the explicit id", async () => {
        mockVsCode();
        const register = mockActivationState(true);

        await buildHtml({ scriptFile: "webview-mergeeditor.js" });
        await buildHtml({ scriptFile: "webview-mergeeditor.js" });

        const registeredIds = register.mock.calls.map((call) => call[0]);
        expect(registeredIds).toEqual(["webview-mergeeditor", "webview-mergeeditor"]);
    });
});
