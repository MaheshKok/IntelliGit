/**
 * Spec-derived tests for the Phase 2c-v-c `undocked` / `mid-rebase` recorder.
 *
 * The two-workspace assertion is the recorder's determinism oracle; the exact policy tests cover
 * decisions that cannot be inferred from bytes, and the cleanup/double tests make the process-wide
 * seams and the internally-created panel observable by named tests.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createCommitInfoVscodeDouble } from "../../../visual/recorder/commitInfoVscodeDouble";

vi.mock("vscode", () => createCommitInfoVscodeDouble());

import { setE2eControlChannelActive } from "../../../../src/e2e/activationState";
import { UndockedViewProvider } from "../../../../src/views/UndockedViewProvider";
import * as webviewCapture from "../../../../src/e2e/webviewCapture";
import {
    getE2eWebviewCaptureSink,
    resetE2eWebviewCaptureSinkForTests,
} from "../../../../src/e2e/webviewCapture";
import { REPOSITORY_SCENARIOS, type ScenarioWorkspace } from "../../../fixtures/repo/scenarios";
import { GitExecutor } from "../../../../src/git/executor";
import { GitOps } from "../../../../src/git/operations";
import {
    buildUndockedProviderConstructorArguments,
    buildUndockedProviderConstructorOptions,
    buildUndockedWorkspaceConfiguration,
    recordUndockedWebviewFixture,
    selectUndockedMessages,
    UNDOCKED_MID_REBASE_SCENARIO,
    UNDOCKED_MID_REBASE_VOLATILE_FIELDS,
} from "../../../visual/recorder/recordUndockedWebviewFixture";
import { parseWebviewFixture } from "../../../visual/recorder/validateWebviewFixture";
import { serializeWebviewFixture } from "../../../visual/recorder/webviewFixtureFile";
import type { WebviewFixture } from "../../../visual/recorder/webviewFixtureTypes";
import { WEBVIEW_FIXTURE_RECORDERS } from "../../../visual/recorder/webviewFixtureRegistry";
import {
    createFakeWebviewPanel,
    getCreatedWebviewPanels,
} from "../../../visual/recorder/webviewPanelDouble";
import {
    createFakeWorkspaceConfiguration,
    resetFakeWorkspaceConfigurationForTests,
} from "../../../visual/recorder/workspaceConfigurationDouble";
import { createScratchWorkspaces } from "../../fixtures/scratchWorkspaces";

const MID_REBASE_SCENARIO = REPOSITORY_SCENARIOS.find(
    (scenario) => scenario.id === UNDOCKED_MID_REBASE_SCENARIO,
);
if (!MID_REBASE_SCENARIO) {
    throw new Error(
        'recordUndockedWebviewFixture.test.ts: no "mid-rebase" scenario is registered.',
    );
}

const CLEAN_SCENARIO = REPOSITORY_SCENARIOS.find((scenario) => scenario.id === "clean");
if (!CLEAN_SCENARIO) {
    throw new Error('recordUndockedWebviewFixture.test.ts: no "clean" scenario is registered.');
}

function requireTemplate(workspace: ScenarioWorkspace) {
    if (!workspace.template) {
        throw new Error('The "mid-rebase" scenario workspace unexpectedly has no template.');
    }
    return workspace.template;
}

function optionsFor(workspace: ScenarioWorkspace) {
    const template = requireTemplate(workspace);
    return {
        repoRoot: workspace.root,
        roots: { root: workspace.root, originRoot: template.originRoot, profileDir: "" },
        env: workspace.env,
    };
}

function messageType(message: unknown): unknown {
    if (typeof message !== "object" || message === null) return undefined;
    return (message as { type?: unknown }).type;
}

function messageData(fixture: WebviewFixture, type: string): Record<string, unknown> {
    const captured = fixture.messages.find((entry) => messageType(entry.message) === type);
    if (!captured || typeof captured.message !== "object" || captured.message === null) {
        throw new Error(`messageData: fixture has no ${type} message.`);
    }
    if (typeof captured.message !== "object" || captured.message === null) {
        throw new Error(`messageData: ${type} message has no object payload.`);
    }
    return captured.message as Record<string, unknown>;
}

describe("undocked webview recorder", () => {
    let parentDir: string;
    let workspaceA: ScenarioWorkspace;
    let workspaceB: ScenarioWorkspace;

    // Scratch-path bookkeeping and the settle-before-propagating seed live in one shared helper --
    // see `scratchWorkspaces.ts` for the two directory leaks the obvious shapes here both cause.
    const scratch = createScratchWorkspaces();

    beforeAll(async () => {
        parentDir = await mkdtemp(
            path.join(tmpdir(), "intelligit-webview-recorder-undocked-test-"),
        );
        scratch.register(parentDir);
        [workspaceA, workspaceB] = await scratch.seedPair(
            () => MID_REBASE_SCENARIO.prepare(path.join(parentDir, "root-a")),
            () => MID_REBASE_SCENARIO.prepare(path.join(parentDir, "root-b")),
        );
    }, 60_000);

    afterAll(async () => {
        await scratch.removeAll();
    });

    beforeEach(() => {
        setE2eControlChannelActive(true);
    });

    afterEach(() => {
        setE2eControlChannelActive(false);
        resetE2eWebviewCaptureSinkForTests();
        resetFakeWorkspaceConfigurationForTests();
    });

    it("parses and reaches the ready fan-out", async () => {
        const fixture = await recordUndockedWebviewFixture(optionsFor(workspaceA));
        const reparsed = parseWebviewFixture(JSON.parse(serializeWebviewFixture(fixture)));
        const types = fixture.messages.map((entry) => messageType(entry.message));

        expect(reparsed).toEqual(fixture);
        expect(fixture.contextId).toEqual("undocked");
        expect(fixture.scenario).toEqual(UNDOCKED_MID_REBASE_SCENARIO);
        expect(fixture.messages.length).toBeGreaterThan(0);
        expect(types).toContain("setBranches");
        expect(types).toContain("loadCommits");
        expect(types).toContain("update");
        expect(types).not.toContain("loadError");
    });

    it("produces byte-identical fixtures from two independently prepared mid-rebase workspaces", async () => {
        const fixtureA = await recordUndockedWebviewFixture(optionsFor(workspaceA));
        const fixtureB = await recordUndockedWebviewFixture(optionsFor(workspaceB));

        expect(serializeWebviewFixture(fixtureA)).toBe(serializeWebviewFixture(fixtureB));
    });

    it("pins the exact commit-window configuration used by the ready path", async () => {
        expect(buildUndockedWorkspaceConfiguration()).toEqual({
            "intelligit.clearLastCommit": true,
            "intelligit.commitWindowPosition": "auto",
            "workbench.sideBar.location": "right",
        });

        const fixture = await recordUndockedWebviewFixture(optionsFor(workspaceA));

        expect(messageData(fixture, "settings")).toEqual({
            type: "settings",
            commitWindowPosition: "right",
        });
    });

    it("extracts the exact disabled commit-check policy", () => {
        const constructorOptions = buildUndockedProviderConstructorOptions({
            repoRoot: "repo-root",
        });

        // These exact values keep a recording off the network and away from the credential store:
        // [] prevents construction of the production default providers, and enabled:false makes
        // the coordinator return its disabled snapshot before any provider lookup.
        expect(constructorOptions.options.commitChecksProviders).toEqual([]);
        expect(constructorOptions.commitChecksSettings.enabled).toEqual(false);
        expect(constructorOptions.commitChecksSettings).toEqual({
            enabled: false,
            providers: {
                github: false,
                gitlab: false,
                "bitbucket-cloud": false,
                "bitbucket-server": false,
            },
        });
        expect(constructorOptions.workspaceState).toBeUndefined();
        expect(constructorOptions.interactiveRebaseStorageRoot).toBeUndefined();
        expect(constructorOptions.options.selectedRepositoryRoot).toEqual("repo-root");
    });

    /**
     * The policy test above proves what the BUILDER returns. It cannot prove what the CONSTRUCTOR
     * receives, and adversarial review walked straight through that gap: replacing the construction
     * site's `constructorOptions.options` with an inline literal missing `commitChecksProviders: []`
     * left all 132 tests green, because that barrier alone changes no recorded byte. This test pins
     * the whole positional tuple the recorder spreads, so there is no un-oracled argument left at
     * the call site -- the equivalent mutation now has to edit a function this asserts by value.
     */
    it("pins the exact constructor argument tuple the recorder spreads", () => {
        const gitOps = new GitOps(new GitExecutor("repo-root"));
        const args = buildUndockedProviderConstructorArguments({ repoRoot: "repo-root", gitOps });

        expect(args).toHaveLength(9);
        expect(args[1]).toBe(gitOps);
        expect(args[4]).toBeUndefined(); // workspaceState: no host persistence during a recording
        expect(args[5]).toEqual({}); // hostMap
        expect(args[6]).toEqual(
            buildUndockedProviderConstructorOptions({ repoRoot: "repo-root" }).commitChecksSettings,
        );
        expect(args[7]).toEqual({
            selectedRepositoryRoot: "repo-root",
            commitChecksProviders: [],
        });
        expect(args[8]).toBeUndefined(); // interactiveRebaseStorageRoot
    });

    it("builds a credential store whose backing secret storage is inert", async () => {
        const args = buildUndockedProviderConstructorArguments({
            repoRoot: "repo-root",
            gitOps: new GitOps(new GitExecutor("repo-root")),
        });

        // Reaching real secret storage during a recording is a failure, not a path. The store is a
        // real CredentialStore over a throwingDouble, so the rejection names the seam. Asserting
        // all three members matters: a future recorder that swaps the double for a permissive
        // stub would keep `get` "working" and silently gain write access to the host keychain.
        const credentialStore = args[3];
        await expect(credentialStore.get("github.com")).rejects.toThrow(/secretStorage/i);
        await expect(credentialStore.set("github.com", "token")).rejects.toThrow(/secretStorage/i);
        await expect(credentialStore.delete("github.com")).rejects.toThrow(/secretStorage/i);
    });

    it("keeps only this context's messages, dropping every foreign-context entry", () => {
        const undockedMessage = { contextId: "undocked" as const, message: { type: "settings" } };
        const foreign = { contextId: "commit-info" as const, message: { type: "setCommit" } };

        expect(selectUndockedMessages([foreign, undockedMessage, foreign])).toEqual([
            undockedMessage,
        ]);
        expect(selectUndockedMessages([foreign])).toEqual([]);
    });

    it("asserts the exact scenario and volatile-field declaration", () => {
        expect(UNDOCKED_MID_REBASE_SCENARIO).toEqual("mid-rebase");
        expect(UNDOCKED_MID_REBASE_VOLATILE_FIELDS).toEqual([]);
    });

    it("rejects a clean workspace instead of recording it as mid-rebase", async () => {
        const cleanDestination = path.join(parentDir, "clean");
        const cleanWorkspace = await CLEAN_SCENARIO.prepare(cleanDestination);
        try {
            const template = cleanWorkspace.template;
            if (!template) throw new Error("The clean scenario unexpectedly has no template.");
            await expect(
                recordUndockedWebviewFixture({
                    repoRoot: cleanWorkspace.root,
                    roots: {
                        root: cleanWorkspace.root,
                        originRoot: template.originRoot,
                        profileDir: "",
                    },
                    env: cleanWorkspace.env,
                }),
            ).rejects.toThrow(/expected the mid-rebase scenario to have an active rebase/);
        } finally {
            await Promise.all([
                rm(cleanWorkspace.home, { recursive: true, force: true }),
                rm(cleanDestination, { recursive: true, force: true }),
            ]);
        }
    });

    it("fails loudly when the E2E gate is inactive", async () => {
        setE2eControlChannelActive(false);

        await expect(recordUndockedWebviewFixture(optionsFor(workspaceA))).rejects.toThrow(
            /E2E control channel/i,
        );
    });

    it("names the panel-count invariant when open creates no panel", async () => {
        const open = vi.spyOn(UndockedViewProvider.prototype, "open").mockImplementation(() => {});
        try {
            await expect(recordUndockedWebviewFixture(optionsFor(workspaceA))).rejects.toThrow(
                /expected UndockedViewProvider\.open\(\) to create exactly one new webview panel/i,
            );
        } finally {
            open.mockRestore();
        }
    });

    it("names the capture-sink invariant when the sink is unavailable", async () => {
        const sink = vi
            .spyOn(webviewCapture, "getE2eWebviewCaptureSink")
            .mockReturnValue(undefined);
        try {
            await expect(recordUndockedWebviewFixture(optionsFor(workspaceA))).rejects.toThrow(
                /no webview capture sink was allocated/i,
            );
        } finally {
            sink.mockRestore();
        }
    });

    it("names the captured-message invariant when the required handshake produces no messages", async () => {
        const emptySink = { getMessages: () => [] } as NonNullable<
            ReturnType<typeof getE2eWebviewCaptureSink>
        >;
        const sink = vi
            .spyOn(webviewCapture, "getE2eWebviewCaptureSink")
            .mockReturnValue(emptySink);
        try {
            await expect(recordUndockedWebviewFixture(optionsFor(workspaceA))).rejects.toThrow(
                /undocked capture sink received no messages after the required ready handshake/i,
            );
        } finally {
            sink.mockRestore();
        }
    });

    it("finally clears the panel construction registry", async () => {
        await recordUndockedWebviewFixture(optionsFor(workspaceA));

        expect(getCreatedWebviewPanels()).toEqual([]);
    });

    it("finally clears the capture sink", async () => {
        await recordUndockedWebviewFixture(optionsFor(workspaceA));

        expect(getE2eWebviewCaptureSink()).toBeUndefined();
    });

    it("finally clears the workspace configuration store", async () => {
        await recordUndockedWebviewFixture(optionsFor(workspaceA));

        expect(() => createFakeWorkspaceConfiguration("intelligit")).toThrow(
            /no fake workspace configuration is installed/i,
        );
    });

    it("cleans every seam when a recording rejects", async () => {
        const base = optionsFor(workspaceA);
        const brokenConfig = path.join(parentDir, "broken.gitconfig");
        await writeFile(brokenConfig, "[[[ this is not valid git config\n", "utf8");
        await expect(
            recordUndockedWebviewFixture({
                ...base,
                env: { ...base.env, GIT_CONFIG_GLOBAL: brokenConfig },
            }),
        ).rejects.toThrow();

        expect(getE2eWebviewCaptureSink()).toBeUndefined();
        expect(getCreatedWebviewPanels()).toEqual([]);
        expect(() => createFakeWorkspaceConfiguration("intelligit")).toThrow(
            /no fake workspace configuration is installed/i,
        );
    });
});

describe("undocked recorder doubles", () => {
    it("supports reading and replacing webview.options and provides panel visibility events", () => {
        const panel = createFakeWebviewPanel();
        try {
            expect(panel.webview.options).toEqual({});
            const replacement = { enableScripts: true };
            panel.webview.options = replacement;
            expect(panel.webview.options.enableScripts).toEqual(true);
            expect(panel.visible).toEqual(true);
            expect(typeof panel.onDidChangeViewState(() => {}).dispose).toEqual("function");
        } finally {
            panel.dispose();
        }
    });

    it("returns a real disposable for the active-color-theme event", () => {
        const vscodeDouble = createCommitInfoVscodeDouble();
        const disposable = vscodeDouble.window.onDidChangeActiveColorTheme(() => {});

        expect(typeof disposable.dispose).toEqual("function");
        disposable.dispose();
    });

    it("returns a real disposable for the workspace-configuration event", () => {
        const vscodeDouble = createCommitInfoVscodeDouble();
        const disposable = vscodeDouble.workspace.onDidChangeConfiguration(() => {});

        expect(typeof disposable.dispose).toEqual("function");
        disposable.dispose();
    });

    it("provides the panel column used by UndockedViewProvider.open", () => {
        expect(createCommitInfoVscodeDouble().ViewColumn.One).toEqual(1);
    });
});

describe("undocked recorder registry", () => {
    it("registers exactly the eight recorded contexts through Phase 2c-v-d", () => {
        const contextIds = new Set(WEBVIEW_FIXTURE_RECORDERS.map((entry) => entry.contextId));

        expect(contextIds).toEqual(
            new Set([
                "commit-info",
                "commit-graph-card",
                "commit-graph-compact",
                "commit-panel",
                "merge-conflict-session",
                "merge-editor",
                "shelf-conflict-editor",
                "undocked",
            ]),
        );
    });
});
