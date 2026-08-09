import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createCommitInfoVscodeDouble } from "../../../visual/recorder/commitInfoVscodeDouble";

// The recorder double's `l10n.t` is identity, and identity makes `vscode.l10n.t("Graph")` and a
// bare "Graph" produce the same captured title. That is precisely how a production edit dropping
// `l10n.t` slips past a title comparison -- the defect class fixed in `ShelfConflictEditorPanel`.
// This spy keeps the identity return (so no recorded fixture changes) while recording WHICH strings
// actually passed through localization, which is what makes `titleDescriptor.kind` falsifiable.
const localizeSpy = vi.hoisted(() => vi.fn((message: string) => message));

// The recorder modules run the real providers against the existing throwing vscode double. This
// mock is hoisted before any provider import, so the production shell module can be wrapped without
// replacing the host implementation or changing its HTML behavior. The proxy overrides only `l10n`
// and delegates everything else, preserving the double's throw-on-unimplemented-member guard.
vi.mock("vscode", () => {
    const double = createCommitInfoVscodeDouble();
    const recordingL10n = { t: localizeSpy } as unknown as typeof double.l10n;
    return new Proxy(double, {
        get: (target, prop, receiver) =>
            prop === "l10n" ? recordingL10n : Reflect.get(target, prop, receiver),
    });
});

vi.mock("../../../../src/views/webviewHtml", async () => {
    const actual = await vi.importActual<typeof import("../../../../src/views/webviewHtml")>(
        "../../../../src/views/webviewHtml",
    );
    return {
        ...actual,
        buildWebviewShellHtml: vi.fn(actual.buildWebviewShellHtml),
    };
});

import { WEBVIEW_CONTEXT_IDS } from "../../../../src/e2e/webviewCapture";
import { setE2eControlChannelActive } from "../../../../src/e2e/activationState";
import { REPOSITORY_SCENARIOS, type ScenarioWorkspace } from "../../../fixtures/repo/scenarios";
import { WEBVIEW_FIXTURE_RECORDERS } from "../../../visual/recorder/webviewFixtureRegistry";
import {
    assertSharedBundleEquivalence,
    hostContextFor,
    SHARED_BUNDLE_EQUIVALENCE,
    WEBVIEW_HOST_CONTEXTS,
    type HostContextTitleDescriptor,
} from "../../../visual/harness/hostContexts";

import * as webviewHtml from "../../../../src/views/webviewHtml";

const DEFAULT_BACKGROUND_VAR = "var(--vscode-editor-background)";

type CapturedShellOptions = Parameters<typeof webviewHtml.buildWebviewShellHtml>[0];

function capturedFields(options: CapturedShellOptions) {
    return {
        scriptFile: options.scriptFile,
        styleFiles: options.styleFiles ?? [],
        title: options.title,
        declaredBackgroundVar: Object.prototype.hasOwnProperty.call(options, "backgroundVar")
            ? options.backgroundVar
            : undefined,
        resolvedBackgroundVar: options.backgroundVar ?? DEFAULT_BACKGROUND_VAR,
    };
}

/**
 * The title STRING the shell should receive. Dynamic localized titles retain their English catalog
 * key, including `{file}`, because the double returns the `l10n.t` argument unchanged rather than a
 * scenario-specific rendered value. Whether that string was localized at all is a separate
 * assertion -- this one alone cannot tell the two descriptor kinds apart.
 */
function titleStringFor(descriptor: HostContextTitleDescriptor): string {
    return descriptor.kind === "literal" ? descriptor.value : descriptor.key;
}

describe("resolved webview host-context table", () => {
    it("registers exactly one row per webview context id", () => {
        // Set equality plus length is load-bearing: a bare count permits one missing context plus
        // one duplicate, which is the silent false-green defect this table is intended to prevent.
        expect(new Set(WEBVIEW_HOST_CONTEXTS.map((context) => context.contextId))).toEqual(
            new Set(WEBVIEW_CONTEXT_IDS),
        );
        expect(WEBVIEW_HOST_CONTEXTS).toHaveLength(WEBVIEW_CONTEXT_IDS.length);
    });

    it("accepts the production table and its declared divergences", () => {
        expect(() =>
            assertSharedBundleEquivalence(WEBVIEW_HOST_CONTEXTS, SHARED_BUNDLE_EQUIVALENCE),
        ).not.toThrow();
    });

    it("can fail: an undeclared divergence inside a shared bundle reaches the throw", () => {
        const diverged = WEBVIEW_HOST_CONTEXTS.map((context) =>
            context.contextId === "shelf-conflict-editor"
                ? { ...context, styleFiles: [] }
                : context,
        );

        expect(() => assertSharedBundleEquivalence(diverged, SHARED_BUNDLE_EQUIVALENCE)).toThrow(
            /"styleFiles" values differ/,
        );
    });

    it("can fail: a shared bundle with no equivalence entry reaches the throw", () => {
        expect(() => assertSharedBundleEquivalence(WEBVIEW_HOST_CONTEXTS, [])).toThrow(
            /no shared-bundle equivalence entry/,
        );
    });

    it("can fail: an equivalence entry for an unshared bundle reaches the throw", () => {
        expect(() =>
            assertSharedBundleEquivalence(WEBVIEW_HOST_CONTEXTS, [
                ...SHARED_BUNDLE_EQUIVALENCE,
                {
                    scriptFile: "webview-commitpanel.js",
                    contextIds: ["commit-panel"],
                    allowedDivergences: [],
                },
            ]),
        ).toThrow(/only one\s+host context uses it/);
    });

    it("can fail: an unknown context lookup reaches its throwing guard", () => {
        expect(() =>
            hostContextFor("not-a-real-context" as (typeof WEBVIEW_CONTEXT_IDS)[number]),
        ).toThrow(/No resolved host context is registered/);
    });
});

describe("resolved host-context production oracle", () => {
    let parentDir: string;
    const workspaces = new Map<string, ScenarioWorkspace>();

    beforeAll(async () => {
        parentDir = await mkdtemp(path.join(tmpdir(), "intelligit-host-context-oracle-"));
        const scenarioIds = [...new Set(WEBVIEW_FIXTURE_RECORDERS.map((entry) => entry.scenario))];

        await Promise.all(
            scenarioIds.map(async (scenarioId) => {
                const scenario = REPOSITORY_SCENARIOS.find(
                    (candidate) => candidate.id === scenarioId,
                );
                if (!scenario) {
                    throw new Error(`No repository scenario registered for "${scenarioId}".`);
                }
                workspaces.set(
                    scenarioId,
                    await scenario.prepare(path.join(parentDir, scenarioId)),
                );
            }),
        );
    }, 120_000);

    afterAll(async () => {
        await Promise.all(
            [...workspaces.values()].map((workspace) =>
                rm(workspace.home, { recursive: true, force: true }),
            ),
        );
        await rm(parentDir, { recursive: true, force: true });
    });

    beforeEach(() => {
        setE2eControlChannelActive(true);
        vi.mocked(webviewHtml.buildWebviewShellHtml).mockClear();
        localizeSpy.mockClear();
    });

    afterEach(() => {
        setE2eControlChannelActive(false);
        vi.mocked(webviewHtml.buildWebviewShellHtml).mockClear();
        localizeSpy.mockClear();
    });

    it("records one recorder per webview context id", () => {
        expect(WEBVIEW_FIXTURE_RECORDERS).toHaveLength(WEBVIEW_CONTEXT_IDS.length);
    });

    // One test per context rather than one loop over all eight: in a loop the first failing context
    // masks every later one, so a single mutation would report as a single defect no matter how
    // many rows it actually broke.
    it.each([...WEBVIEW_FIXTURE_RECORDERS])(
        "$contextId: production reaches the shell with the recorded options",
        async (recorder) => {
            const workspace = workspaces.get(recorder.scenario);
            if (!workspace) {
                throw new Error(
                    `No prepared workspace for ${recorder.contextId}/${recorder.scenario}.`,
                );
            }

            await recorder.record(workspace);

            const calls = vi.mocked(webviewHtml.buildWebviewShellHtml).mock.calls;

            // This is the LBU guard: a recorder that produces messages without resolving the
            // production shell must fail here, rather than silently dropping its table row into a
            // source-text or fixture-content oracle.
            expect(calls, `${recorder.contextId} recorder shell reachability`).toHaveLength(1);

            const captured = capturedFields(calls[0][0]);
            const expected = hostContextFor(recorder.contextId);

            expect(captured).toEqual({
                scriptFile: expected.scriptFile,
                styleFiles: expected.styleFiles,
                title: titleStringFor(expected.titleDescriptor),
                declaredBackgroundVar: expected.declaredBackgroundVar,
                resolvedBackgroundVar: expected.resolvedBackgroundVar,
            });

            // The captured title string alone cannot distinguish a localized title from a literal
            // one under an identity `l10n.t`. Asserting that the string DID (or did not) pass
            // through localization is what makes `titleDescriptor.kind` falsifiable -- and what
            // makes a production edit that drops `vscode.l10n.t` fail here instead of passing.
            const titleWasLocalized = localizeSpy.mock.calls.some(
                ([message]) => message === captured.title,
            );

            expect(titleWasLocalized, `${recorder.contextId} title localization`).toBe(
                expected.titleDescriptor.kind === "localized",
            );
        },
    );
});
