import { JSDOM } from "jsdom";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createCommitInfoVscodeDouble } from "../../../visual/recorder/commitInfoVscodeDouble";
import type { HostFixture } from "../../../e2e/hostFixtures/types";
import darkModern from "../../../visual/fixtures/host/dark-modern.json";
import {
    renderHarnessDocument,
    type HarnessWebviewSettings,
} from "../../../visual/harness/renderHarnessDocument";
import type { WebviewI18nPayload } from "../../../../src/webviews/i18n";

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
import { removeScratchDirectories } from "../../../helpers/scratchDirectories";

const DEFAULT_BACKGROUND_VAR = "var(--vscode-editor-background)";
const DARK_MODERN = darkModern as HostFixture;

type CapturedShellOptions = Parameters<typeof webviewHtml.buildWebviewShellHtml>[0];

interface NormalizedShellAsset {
    readonly kind: "stylesheet" | "script";
    readonly url: string;
}

interface NormalizedShell {
    readonly bootstrapGlobals: Readonly<Record<string, unknown>>;
    readonly rootElements: readonly string[];
    readonly lang: string | null;
    readonly inlineStyle: string | null;
    readonly backgroundVariable: string | undefined;
    readonly assets: readonly NormalizedShellAsset[];
}

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

/** Extracts every `window.intelligit*` assignment from the inline bootstrap scripts. */
function bootstrapGlobals(document: Document): Readonly<Record<string, unknown>> {
    const globals: Record<string, unknown> = {};
    const assignmentPattern =
        /window\.(intelligit[A-Za-z0-9_]+)\s*=\s*([\s\S]*?);(?=\s*(?:window\.|$))/g;

    for (const script of document.querySelectorAll("script")) {
        for (const match of script.textContent?.matchAll(assignmentPattern) ?? []) {
            const [, name, serialized] = match;
            if (name === undefined || serialized === undefined) continue;
            globals[name] = JSON.parse(serialized);
        }
    }

    return globals;
}

/**
 * Removes only the host-specific prefix from an asset URL.
 *
 * Production uses `webview.asWebviewUri`, while the harness uses a plain browser base URL. This
 * intentionally stops comparing the scheme/origin/prefix, so a base-URL change alone can slip
 * through; the asset filename, kind, order, and multiplicity remain exact.
 */
function normalizeAssetUrl(url: string): string {
    const distMarker = "/dist/";
    const markerIndex = url.indexOf(distMarker);
    return markerIndex === -1 ? url : url.slice(markerIndex + distMarker.length);
}

/**
 * Captures the shell contract without comparing the construction-only CSP and nonce markup.
 *
 * VS Code's production shell must carry a CSP meta element and nonce attributes, while the plain
 * browser harness deliberately has neither. Omitting those fields means CSP policy changes and
 * nonce placement are outside this guard; parsing through JSDOM also treats equivalent entity
 * escaping and attribute quoting as equal, so raw-source serialization changes are outside it.
 * Every requested visual shell aspect is retained.
 */
function normalizedShell(html: string): NormalizedShell {
    const dom = new JSDOM(html, { runScripts: "outside-only" });
    try {
        const document = dom.window.document;
        const inlineStyle = document.querySelector("style")?.textContent ?? null;
        const backgroundVariable = inlineStyle?.match(/background:\s*([^;]+);/)?.[1]?.trim();
        const assets: NormalizedShellAsset[] = [];

        for (const element of document.querySelectorAll('link[rel="stylesheet"], script[src]')) {
            if (element.tagName.toLowerCase() === "link") {
                const href = element.getAttribute("href");
                if (href !== null) {
                    assets.push({ kind: "stylesheet", url: normalizeAssetUrl(href) });
                }
                continue;
            }

            const src = element.getAttribute("src");
            if (src !== null) assets.push({ kind: "script", url: normalizeAssetUrl(src) });
        }

        return {
            bootstrapGlobals: bootstrapGlobals(document),
            rootElements: [...document.querySelectorAll("#root")].map(
                (element) => element.outerHTML,
            ),
            lang: document.documentElement.getAttribute("lang"),
            inlineStyle,
            backgroundVariable,
            assets,
        };
    } finally {
        dom.window.close();
    }
}

/** Renders the real production shell from the options captured while exercising one host. */
async function renderProductionShell(options: CapturedShellOptions): Promise<string> {
    const actual = await vi.importActual<typeof import("../../../../src/views/webviewHtml")>(
        "../../../../src/views/webviewHtml",
    );
    return actual.buildWebviewShellHtml(options);
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

    // The three cases below are the two-way membership cross-check: an equivalence entry's
    // contextIds must be exactly the set of hosts that actually use its bundle, not merely a set
    // that happens to resolve. A one-way check (declared ids are real) still lets an entry omit a
    // real member, which is the CodeRabbit-flagged gap this closes -- the omitted member never
    // reached the field comparison, so its shell fields could diverge from the rest of the group
    // without ever being caught.

    it("can fail: a host that shares a bundle but is missing from contextIds reaches the throw", () => {
        // Repoint "commit-info" onto the merge-editor bundle so three real hosts share it while the
        // real equivalence entry still names only the original two. "commit-info" is now a real
        // member that assertSharedBundleEquivalence must notice is absent from contextIds.
        const contexts = WEBVIEW_HOST_CONTEXTS.map((context) =>
            context.contextId === "commit-info"
                ? { ...context, scriptFile: "webview-mergeeditor.js" }
                : context,
        );

        expect(() => assertSharedBundleEquivalence(contexts, SHARED_BUNDLE_EQUIVALENCE)).toThrow(
            /"commit-info" shares bundle "webview-mergeeditor\.js" but is missing from/,
        );
    });

    it("can fail: a contextIds entry naming a host that does not use the bundle reaches the throw", () => {
        expect(() =>
            assertSharedBundleEquivalence(WEBVIEW_HOST_CONTEXTS, [
                {
                    scriptFile: "webview-mergeeditor.js",
                    contextIds: ["merge-editor", "shelf-conflict-editor", "commit-info"],
                    allowedDivergences: ["titleDescriptor"],
                },
            ]),
        ).toThrow(/"commit-info" in contextIds, but no host context with that id uses this bundle/);
    });

    it("can fail: a duplicate id inside one entry's contextIds reaches the throw", () => {
        expect(() =>
            assertSharedBundleEquivalence(WEBVIEW_HOST_CONTEXTS, [
                {
                    scriptFile: "webview-mergeeditor.js",
                    contextIds: ["merge-editor", "shelf-conflict-editor", "shelf-conflict-editor"],
                    allowedDivergences: ["titleDescriptor"],
                },
            ]),
        ).toThrow(/"shelf-conflict-editor" in contextIds more than once/);
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
            [...workspaces.values()].map((workspace) => removeScratchDirectories(workspace.home)),
        );
        await removeScratchDirectories(parentDir);
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
        const recorderContextIds = WEBVIEW_FIXTURE_RECORDERS.map((entry) => entry.contextId);
        const recorderContextIdSet = new Set(recorderContextIds);
        const webviewContextIdSet = new Set(WEBVIEW_CONTEXT_IDS);

        expect(
            recorderContextIdSet,
            "recorder context IDs must include every declared webview context",
        ).toEqual(webviewContextIdSet);
        expect(webviewContextIdSet, "every declared webview context must have a recorder").toEqual(
            recorderContextIdSet,
        );
        expect(
            recorderContextIdSet.size,
            "recorder table must not contain duplicate context IDs",
        ).toBe(recorderContextIds.length);
    });

    // One test per context rather than one loop over all eight: in a loop the first failing context
    // masks every later one, so a single mutation would report as a single defect no matter how
    // many rows it actually broke.
    it.each([...WEBVIEW_HOST_CONTEXTS])(
        "$contextId: production reaches the shell with the recorded options",
        async (context) => {
            const recorder = WEBVIEW_FIXTURE_RECORDERS.find(
                (entry) => entry.contextId === context.contextId,
            );
            expect(recorder, `${context.contextId} recorder registration`).toBeDefined();
            if (recorder === undefined) return;

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
            const expected = hostContextFor(context.contextId);

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

            // The recorder exercised the actual production host and captured its shell inputs.
            // Disable only the E2E registration branch before rendering those inputs, because the
            // harness intentionally has no VS Code control-channel global or nonce.
            setE2eControlChannelActive(false);
            const productionShell = normalizedShell(await renderProductionShell(calls[0][0]));
            const productionSettings = productionShell.bootstrapGlobals.intelligitSettings;
            const productionI18n = productionShell.bootstrapGlobals.intelligitI18n;

            expect(
                productionSettings,
                `${context.contextId} production settings bootstrap global`,
            ).toBeDefined();
            expect(
                productionI18n,
                `${context.contextId} production i18n bootstrap global`,
            ).toBeDefined();

            const harnessShell = normalizedShell(
                renderHarnessDocument({
                    context,
                    hostFixture: DARK_MODERN,
                    settings: productionSettings as HarnessWebviewSettings,
                    i18n: productionI18n as WebviewI18nPayload,
                    assetBaseUrl: "/dist",
                }),
            );

            expect(
                harnessShell,
                `${context.contextId} production and harness shell contract`,
            ).toEqual(productionShell);
        },
        120_000,
    );
});
