/**
 * Spec-derived tests for the Phase 2c-v-b merge-editor / conflicted webview recorder.
 *
 * The recording tests use two independently prepared conflicted workspaces and share the
 * process-wide capture sink, fake configuration store, and MergeEditorPanel static registry. Each
 * test therefore resets those seams after it, while the recorder itself also owns reset-before-use
 * and finally cleanup so a failed recording cannot poison the next one.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
    createCommitInfoVscodeDouble,
    createFakeExtensionUri,
} from "../../../visual/recorder/commitInfoVscodeDouble";

vi.mock("vscode", () => createCommitInfoVscodeDouble());

import { setE2eControlChannelActive } from "../../../../src/e2e/activationState";
import { MergeEditorPanel } from "../../../../src/views/MergeEditorPanel";
import { GitExecutor } from "../../../../src/git/executor";
import { GitOps } from "../../../../src/git/operations";
import { REPOSITORY_SCENARIOS, type ScenarioWorkspace } from "../../../fixtures/repo/scenarios";
import {
    buildMergeEditorPanelOptions,
    buildMergeEditorWorkspaceConfiguration,
    MERGE_EDITOR_CONFLICTED_SCENARIO,
    recordMergeEditorWebviewFixture,
} from "../../../visual/recorder/recordMergeEditorWebviewFixture";
import { toGitEnvironment } from "../../../visual/recorder/recordingGitEnvironment";
import { parseWebviewFixture } from "../../../visual/recorder/validateWebviewFixture";
import { serializeWebviewFixture } from "../../../visual/recorder/webviewFixtureFile";
import type { WebviewFixture } from "../../../visual/recorder/webviewFixtureTypes";
import { resetE2eWebviewCaptureSinkForTests } from "../../../../src/e2e/webviewCapture";
import {
    getCreatedWebviewPanels,
    resetCreatedWebviewPanelsForTests,
} from "../../../visual/recorder/webviewPanelDouble";
import {
    createFakeWorkspaceConfiguration,
    resetFakeWorkspaceConfigurationForTests,
    setFakeWorkspaceConfiguration,
} from "../../../visual/recorder/workspaceConfigurationDouble";
import { createScratchWorkspaces } from "../../fixtures/scratchWorkspaces";
import { removeScratchDirectories } from "../../../helpers/scratchDirectories";
import { withWindowsHeadroom } from "../../../setup/platformTimeouts";

const CONFLICTED_SCENARIO = REPOSITORY_SCENARIOS.find((scenario) => scenario.id === "conflicted");
if (!CONFLICTED_SCENARIO) {
    throw new Error(
        'recordMergeEditorWebviewFixture.test.ts: no "conflicted" scenario is registered.',
    );
}

function requireTemplate(workspace: ScenarioWorkspace) {
    if (!workspace.template) {
        throw new Error('The "conflicted" scenario workspace unexpectedly has no template.');
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

interface ConflictPayload {
    readonly filePath?: unknown;
    readonly segments?: unknown;
    readonly editorFontSize?: unknown;
}

function messageType(message: unknown): unknown {
    if (typeof message !== "object" || message === null) return undefined;
    return (message as { type?: unknown }).type;
}

function conflictPayload(fixture: WebviewFixture): ConflictPayload {
    const captured = fixture.messages.find(
        (entry) => messageType(entry.message) === "setConflictData",
    );
    if (!captured || typeof captured.message !== "object" || captured.message === null) {
        throw new Error(
            "conflictPayload: the fixture carries no setConflictData message, so the recording " +
                "did not reach MergeEditorPanel's conflicted data path.",
        );
    }
    const data = (captured.message as { data?: unknown }).data;
    if (typeof data !== "object" || data === null) {
        throw new Error("conflictPayload: setConflictData has no object data payload.");
    }
    return data as ConflictPayload;
}

describe("merge-editor webview recorder", () => {
    let parentDir: string;
    let workspaceA: ScenarioWorkspace;
    let workspaceB: ScenarioWorkspace;

    // Scratch-path bookkeeping and the settle-before-propagating seed live in one shared helper --
    // see `scratchWorkspaces.ts` for the two directory leaks the obvious shapes here both cause.
    const scratch = createScratchWorkspaces();

    beforeAll(async () => {
        parentDir = await mkdtemp(
            path.join(tmpdir(), "intelligit-webview-recorder-merge-editor-test-"),
        );
        scratch.register(parentDir);
        [workspaceA, workspaceB] = await scratch.seedPair(
            () => CONFLICTED_SCENARIO.prepare(path.join(parentDir, "root-a")),
            () => CONFLICTED_SCENARIO.prepare(path.join(parentDir, "root-b")),
        );
    }, withWindowsHeadroom(60_000));

    afterAll(async () => {
        await scratch.removeAll();
    });

    beforeEach(() => {
        setE2eControlChannelActive(true);
    });

    afterEach(() => {
        setE2eControlChannelActive(false);
        resetE2eWebviewCaptureSinkForTests();
        resetCreatedWebviewPanelsForTests();
        resetFakeWorkspaceConfigurationForTests();
    });

    it("parses", async () => {
        const fixture = await recordMergeEditorWebviewFixture(optionsFor(workspaceA));

        const reparsed = parseWebviewFixture(JSON.parse(serializeWebviewFixture(fixture)));

        expect(reparsed.contextId).toBe("merge-editor");
        expect(reparsed.scenario).toBe(MERGE_EDITOR_CONFLICTED_SCENARIO);
        expect(reparsed).toEqual(fixture);
    });

    it("produces byte-identical fixtures from two independently prepared conflicted workspaces", async () => {
        const fixtureA = await recordMergeEditorWebviewFixture(optionsFor(workspaceA));
        const fixtureB = await recordMergeEditorWebviewFixture(optionsFor(workspaceB));

        expect(serializeWebviewFixture(fixtureA)).toBe(serializeWebviewFixture(fixtureB));
    });

    it("captures a real setConflictData payload from the conflicted stage data", async () => {
        const fixture = await recordMergeEditorWebviewFixture(optionsFor(workspaceA));
        const payload = conflictPayload(fixture);

        expect(fixture.messages.length).toBeGreaterThan(0);
        expect(payload.filePath).toEqual(expect.any(String));
        expect((payload.filePath as string).length).toBeGreaterThan(0);
        expect(Array.isArray(payload.segments)).toBe(true);
        expect((payload.segments as unknown[]).length).toBeGreaterThan(0);
    });

    it("records no loadError message", async () => {
        const fixture = await recordMergeEditorWebviewFixture(optionsFor(workspaceA));

        expect(fixture.messages.length).toBeGreaterThan(0);
        expect(fixture.messages.some((entry) => messageType(entry.message) === "loadError")).toBe(
            false,
        );
    });

    // Without the configuration double, readEditorFontSize catches the double's throw, returns
    // undefined, and JSON.stringify drops the key — a fixture that looks correct while silently
    // omitting a rendering-critical field.
    it("pins editorFontSize instead of inheriting it", async () => {
        expect(buildMergeEditorWorkspaceConfiguration()).toEqual({ "editor.fontSize": 14 });

        const fixture = await recordMergeEditorWebviewFixture(optionsFor(workspaceA));

        expect(conflictPayload(fixture).editorFontSize).toBe(14);
    });

    it("applies the caller's declared roots to the captured payload", async () => {
        const base = optionsFor(workspaceA);
        const baseline = await recordMergeEditorWebviewFixture(base);
        const needle = conflictPayload(baseline).filePath;
        if (typeof needle !== "string" || needle.length === 0) {
            throw new Error(
                "The baseline merge-editor payload has no filePath canonicalization needle.",
            );
        }

        const fixture = await recordMergeEditorWebviewFixture({
            ...base,
            roots: { ...base.roots, root: needle },
        });
        const bytes = serializeWebviewFixture(fixture);

        expect(bytes).toContain("<ROOT>");
        expect(bytes).not.toContain(needle);
    });

    it("actually runs Git under the environment it was handed", async () => {
        const brokenConfig = path.join(parentDir, "broken.gitconfig");
        await writeFile(brokenConfig, "[[[ this is not valid git config\n", "utf8");

        const base = optionsFor(workspaceA);
        await expect(
            recordMergeEditorWebviewFixture({
                ...base,
                env: { ...base.env, GIT_CONFIG_GLOBAL: brokenConfig },
            }),
        ).rejects.toThrow(/bad config|fatal:/i);
        expect(() => createFakeWorkspaceConfiguration("editor")).toThrow(
            /no fake workspace configuration is installed/i,
        );

        const control = await recordMergeEditorWebviewFixture(base);
        expect(control.messages.length).toBeGreaterThan(0);
    });

    it("resets the configuration store after a successful recording", async () => {
        await recordMergeEditorWebviewFixture(optionsFor(workspaceA));

        expect(() => createFakeWorkspaceConfiguration("editor")).toThrow(
            /no fake workspace configuration is installed/i,
        );
    });

    it("disposal clears MergeEditorPanel's static registry", async () => {
        setFakeWorkspaceConfiguration(buildMergeEditorWorkspaceConfiguration());

        try {
            await MergeEditorPanel.open(
                buildMergeEditorPanelOptions({
                    extensionUri: createFakeExtensionUri(),
                    gitOps: new GitOps(new GitExecutor("repo-root")),
                    repoRoot: "repo-root",
                    filePath: "conflict.txt",
                }),
            );

            expect(MergeEditorPanel.isOpen()).toBe(true);
            const panels = getCreatedWebviewPanels();
            expect(panels).toHaveLength(1);
            panels[0].dispose();
            expect(MergeEditorPanel.isOpen()).toBe(false);
        } finally {
            resetCreatedWebviewPanelsForTests();
            resetE2eWebviewCaptureSinkForTests();
            resetFakeWorkspaceConfigurationForTests();
        }
    });

    it("rejects a clean workspace without exactly one conflicted file", async () => {
        const cleanScenario = REPOSITORY_SCENARIOS.find((scenario) => scenario.id === "clean");
        if (!cleanScenario) {
            throw new Error(
                'recordMergeEditorWebviewFixture.test.ts: no "clean" scenario is registered.',
            );
        }

        const cleanDestination = path.join(parentDir, "clean");
        const cleanWorkspace = await cleanScenario.prepare(cleanDestination);
        try {
            await expect(
                recordMergeEditorWebviewFixture(optionsFor(cleanWorkspace)),
            ).rejects.toThrow(/exactly one conflicted file/);
        } finally {
            await Promise.all([
                removeScratchDirectories(cleanWorkspace.home),
                removeScratchDirectories(cleanDestination),
            ]);
        }
    });

    /**
     * THE PANEL-COUNT GUARD'S ORACLE. That guard's message asserts a specific causal story --
     * `open()` took the reuse branch (`MergeEditorPanel.ts:127-133`) because an earlier recording
     * left an entry in the static `panels` Map. Nothing else can prove that story, because the
     * recorder's own reset-before-use clears the panel DOUBLE's bookkeeping and cannot touch
     * production's static Map. So seed that Map directly under the same key the recording derives
     * from git status -- the Map is keyed by repo-relative path ALONE (`MergeEditorPanel.ts:125`),
     * not by repository root -- and give the leaked panel the same workspace, so its reuse branch
     * SUCCEEDS and the guard is the only thing standing between a stale panel and a recorded
     * fixture. Deleting the guard degrades this to `createdPanels[0]` being undefined and an
     * unexplained TypeError, which the message matcher below rejects.
     *
     * The leaked panel is disposed here rather than by the recorder: the recorder's `finally`
     * iterates `getCreatedWebviewPanels()`, which its own reset already emptied.
     */
    it("refuses to record when a leaked static panel entry makes open() reuse it", async () => {
        const options = optionsFor(workspaceA);
        setFakeWorkspaceConfiguration(buildMergeEditorWorkspaceConfiguration());
        await MergeEditorPanel.open(
            buildMergeEditorPanelOptions({
                extensionUri: createFakeExtensionUri(),
                gitOps: new GitOps(
                    new GitExecutor(options.repoRoot, undefined, toGitEnvironment(options.env)),
                ),
                repoRoot: options.repoRoot,
                filePath: "conflict.txt",
            }),
        );
        const [leaked] = getCreatedWebviewPanels();
        expect(leaked).toBeDefined();

        try {
            await expect(recordMergeEditorWebviewFixture(options)).rejects.toThrow(
                /exactly one new webview panel/,
            );
        } finally {
            leaked.dispose();
        }

        expect(MergeEditorPanel.isOpen()).toBe(false);
    });

    it("fails loudly instead of silently recording nothing when the E2E gate is inactive", async () => {
        setE2eControlChannelActive(false);

        await expect(recordMergeEditorWebviewFixture(optionsFor(workspaceA))).rejects.toThrow(
            /E2E control channel/i,
        );
    });

    /**
     * THE STATIC-REGISTRY ORACLE. Removing the for (const listener of [...disposeListeners])
     * listener() loop in webviewPanelDouble.ts:150-151, or removing disposeListeners.push(callback)
     * in its onDidDispose implementation, leaves MergeEditorPanel's static panels Map populated.
     * The second recording then takes the reuse branch and this test fails instead of silently
     * returning data from the stale panel.
     */
    it("clears the static registry after recording", async () => {
        const fixtureA = await recordMergeEditorWebviewFixture(optionsFor(workspaceA));
        expect(MergeEditorPanel.isOpen()).toBe(false);

        const fixtureB = await recordMergeEditorWebviewFixture(optionsFor(workspaceB));

        expect(fixtureB.messages.length).toBeGreaterThan(0);
        expect(serializeWebviewFixture(fixtureB)).toBe(serializeWebviewFixture(fixtureA));
    });

    describe("buildMergeEditorPanelOptions", () => {
        it("preserves the caller's panel values and captures the repository-root closure", async () => {
            const extensionUri = createFakeExtensionUri();
            const gitOps = new GitOps(new GitExecutor("repo-root"));
            const options = buildMergeEditorPanelOptions({
                extensionUri,
                gitOps,
                repoRoot: "repo-root",
                filePath: "conflict.txt",
            });

            expect(options.filePath).toBe("conflict.txt");
            expect(options.extensionUri).toBe(extensionUri);
            expect(options.getRepoRoot()).toBe("repo-root");
            await expect(options.onConflictStateChanged()).rejects.toThrow(
                /mergeEditorCallbacks\.onConflictStateChanged/,
            );
        });
    });

    // Registry-set coverage moved to the newest recorder phase's unit test.
});

describe("workspaceConfigurationDouble", () => {
    afterEach(() => {
        resetFakeWorkspaceConfigurationForTests();
    });

    it("throws from create when nothing is installed, naming the member and section", () => {
        resetFakeWorkspaceConfigurationForTests();

        expect(() => createFakeWorkspaceConfiguration("editor")).toThrow(
            /vscode\.workspace\.getConfiguration.*editor/i,
        );
    });

    it("returns the exact value for an installed present key", () => {
        setFakeWorkspaceConfiguration({ "editor.fontSize": 14 });

        expect(createFakeWorkspaceConfiguration("editor").get<number>("fontSize")).toBe(14);
    });

    it("throws for an installed absent key and names the resolved key", () => {
        setFakeWorkspaceConfiguration({ "editor.fontSize": 14 });

        expect(() => createFakeWorkspaceConfiguration("editor").get<number>("lineHeight")).toThrow(
            /editor\.lineHeight/,
        );
    });

    it("resolves sectioned and section-less configuration keys", () => {
        setFakeWorkspaceConfiguration({
            "editor.fontSize": 14,
            "files.autoSave": "off",
        });

        expect(createFakeWorkspaceConfiguration("editor").get<number>("fontSize")).toBe(14);
        expect(createFakeWorkspaceConfiguration().get<string>("files.autoSave")).toBe("off");
    });

    it("reset restores the not-installed state", () => {
        setFakeWorkspaceConfiguration({ "editor.fontSize": 14 });
        resetFakeWorkspaceConfigurationForTests();

        expect(() => createFakeWorkspaceConfiguration("editor")).toThrow(
            /no fake workspace configuration is installed/i,
        );
    });

    it("throws for an unsupported member on the returned configuration object", () => {
        setFakeWorkspaceConfiguration({ "editor.fontSize": 14 });

        const configuration = createFakeWorkspaceConfiguration("editor") as Record<string, unknown>;
        expect(() => configuration.inspect).toThrow(/getConfiguration.*editor.*inspect/i);
    });
});

describe("commitInfoVscodeDouble", () => {
    it("throws when production tries to show an error during a recording", () => {
        const showErrorMessage = createCommitInfoVscodeDouble().window.showErrorMessage;

        expect(() => showErrorMessage("boom")).toThrow(
            /showErrorMessage was called during a recording/,
        );
        expect(() => showErrorMessage("boom")).toThrow(/boom/);
    });
});
