/**
 * Spec-derived tests for the Phase 2c-v-d shelf-conflict-editor / shelf-conflicted recorder.
 *
 * The recorder owns a read-only production shelf session and an internally-created webview panel.
 * These tests pin the one-message load path, the panel reuse guard, the capture-sink guard, the
 * complete panel-options builder, the scenario-carried shelf storage root, and every cleanup seam.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
    createCommitInfoVscodeDouble,
    createFakeExtensionUri,
} from "../../../visual/recorder/commitInfoVscodeDouble";

vi.mock("vscode", () => createCommitInfoVscodeDouble());

import { setE2eControlChannelActive } from "../../../../src/e2e/activationState";
import { GitExecutor } from "../../../../src/git/executor";
import { RepositoryMutationCoordinator } from "../../../../src/git/mutationCoordinator";
import { RepositoryLock } from "../../../../src/git/repositoryLock";
import { RepositoryMutationGate } from "../../../../src/git/repositoryMutationGate";
import * as webviewCapture from "../../../../src/e2e/webviewCapture";
import { ShelfConflictEditorPanel } from "../../../../src/views/ShelfConflictEditorPanel";
import { resolveShelfPaths } from "../../../../src/shelf/paths";
import { ShelfStore } from "../../../../src/shelf/store";
import { ShelfService } from "../../../../src/services/shelfService";
import {
    buildShelfConflictEditorPanelOptions,
    recordShelfConflictEditorWebviewFixture,
    selectShelfConflictEditorMessages,
    SHELF_CONFLICT_EDITOR_CONFLICTED_SCENARIO,
    SHELF_CONFLICT_EDITOR_VOLATILE_FIELDS,
} from "../../../visual/recorder/recordShelfConflictEditorWebviewFixture";
import { parseWebviewFixture } from "../../../visual/recorder/validateWebviewFixture";
import { serializeWebviewFixture } from "../../../visual/recorder/webviewFixtureFile";
import type { WebviewFixture } from "../../../visual/recorder/webviewFixtureTypes";
import { WEBVIEW_FIXTURE_RECORDERS } from "../../../visual/recorder/webviewFixtureRegistry";
import { toGitEnvironment } from "../../../visual/recorder/recordingGitEnvironment";
import {
    getCreatedWebviewPanels,
    resetCreatedWebviewPanelsForTests,
} from "../../../visual/recorder/webviewPanelDouble";
import {
    createFakeWorkspaceConfiguration,
    resetFakeWorkspaceConfigurationForTests,
    setFakeWorkspaceConfiguration,
} from "../../../visual/recorder/workspaceConfigurationDouble";
import { REPOSITORY_SCENARIOS, type ScenarioWorkspace } from "../../../fixtures/repo/scenarios";
import { createScratchWorkspaces } from "../../fixtures/scratchWorkspaces";

const execFileAsync = promisify(execFile);

const SHELF_CONFLICTED_SCENARIO = REPOSITORY_SCENARIOS.find(
    (scenario) => scenario.id === SHELF_CONFLICT_EDITOR_CONFLICTED_SCENARIO,
);
if (!SHELF_CONFLICTED_SCENARIO) {
    throw new Error(
        'recordShelfConflictEditorWebviewFixture.test.ts: no "shelf-conflicted" scenario is registered.',
    );
}

const CLEAN_SCENARIO = REPOSITORY_SCENARIOS.find((scenario) => scenario.id === "clean");
if (!CLEAN_SCENARIO) {
    throw new Error(
        'recordShelfConflictEditorWebviewFixture.test.ts: no "clean" scenario is registered.',
    );
}

function requireShelfStorageRoot(workspace: ScenarioWorkspace): string {
    if (!workspace.shelfStorageRoot) {
        throw new Error('The "shelf-conflicted" workspace has no shelfStorageRoot.');
    }
    return workspace.shelfStorageRoot;
}

function requireTemplate(workspace: ScenarioWorkspace) {
    if (!workspace.template) {
        throw new Error('The "shelf-conflicted" scenario workspace unexpectedly has no template.');
    }
    return workspace.template;
}

async function shelfServiceFor(workspace: ScenarioWorkspace): Promise<{
    readonly store: ShelfStore;
    readonly service: ShelfService;
}> {
    const shelfPaths = await resolveShelfPaths({
        repositoryRoot: workspace.root,
        globalStoragePath: requireShelfStorageRoot(workspace),
    });
    const store = new ShelfStore(shelfPaths);
    const executor = new GitExecutor(workspace.root, undefined, toGitEnvironment(workspace.env));
    const gate = new RepositoryMutationGate(
        new RepositoryMutationCoordinator(),
        new RepositoryLock(),
    );
    return {
        store,
        service: new ShelfService({
            repositoryRoot: workspace.root,
            executor,
            store,
            gate,
        }),
    };
}

async function conflictIds(workspace: ScenarioWorkspace): Promise<{
    readonly shelfId: string;
    readonly changeId: string;
}> {
    const { store } = await shelfServiceFor(workspace);
    const { shelfIds } = await store.listShelves();
    if (shelfIds.length !== 1) throw new Error(`Expected one shelf, found ${shelfIds.length}.`);
    const manifest = await store.readCurrentShelfManifest(shelfIds[0]);
    const entry = manifest.files.find(
        (candidate) => candidate.worktreeBlock?.path === "mutable.txt",
    );
    if (!entry) throw new Error("Expected mutable.txt in the shelf manifest.");
    return { shelfId: shelfIds[0], changeId: entry.changeId };
}

function recorderOptions(workspace: ScenarioWorkspace) {
    const template = requireTemplate(workspace);
    return {
        repoRoot: workspace.root,
        shelfStorageRoot: requireShelfStorageRoot(workspace),
        roots: { root: workspace.root, originRoot: template.originRoot, profileDir: "" },
        env: workspace.env,
    };
}

function messageType(message: unknown): unknown {
    if (typeof message !== "object" || message === null) return undefined;
    return (message as { type?: unknown }).type;
}

function conflictData(fixture: WebviewFixture): Record<string, unknown> {
    const captured = fixture.messages.find(
        (entry) => messageType(entry.message) === "setConflictData",
    );
    if (!captured || typeof captured.message !== "object" || captured.message === null) {
        throw new Error("Fixture has no setConflictData message.");
    }
    const data = (captured.message as { data?: unknown }).data;
    if (typeof data !== "object" || data === null) throw new Error("setConflictData has no data.");
    return data as Record<string, unknown>;
}

async function gitStatus(workspace: ScenarioWorkspace): Promise<string> {
    const result = await execFileAsync("git", ["status", "--porcelain"], {
        cwd: workspace.root,
        env: workspace.env,
        encoding: "buffer",
    });
    return result.stdout.toString("utf8").trim();
}

describe("shelf-conflict-editor webview recorder", () => {
    let parentDir: string;
    let workspaceA: ScenarioWorkspace;
    let workspaceB: ScenarioWorkspace;

    // Scratch-path bookkeeping and the settle-before-propagating seed live in one shared helper --
    // see `scratchWorkspaces.ts` for the two directory leaks the obvious shapes here both cause.
    const scratch = createScratchWorkspaces();

    beforeAll(async () => {
        parentDir = await mkdtemp(
            path.join(tmpdir(), "intelligit-webview-recorder-shelf-conflict-test-"),
        );
        scratch.register(parentDir);
        [workspaceA, workspaceB] = await scratch.seedPair(
            () => SHELF_CONFLICTED_SCENARIO.prepare(path.join(parentDir, "root-a")),
            () => SHELF_CONFLICTED_SCENARIO.prepare(path.join(parentDir, "root-b")),
        );
    }, 60_000);

    afterAll(async () => {
        await scratch.removeAll();
    });

    beforeEach(() => setE2eControlChannelActive(true));

    afterEach(() => {
        setE2eControlChannelActive(false);
        resetCreatedWebviewPanelsForTests();
        webviewCapture.resetE2eWebviewCaptureSinkForTests();
        resetFakeWorkspaceConfigurationForTests();
        vi.restoreAllMocks();
    });

    it("parses and captures exactly one shelf conflict payload without a ready handshake", async () => {
        const fixture = await recordShelfConflictEditorWebviewFixture(recorderOptions(workspaceA));
        const reparsed = parseWebviewFixture(JSON.parse(serializeWebviewFixture(fixture)));

        expect(reparsed).toEqual(fixture);
        expect(fixture.contextId).toBe("shelf-conflict-editor");
        expect(fixture.scenario).toBe(SHELF_CONFLICT_EDITOR_CONFLICTED_SCENARIO);
        expect(fixture.messages).toHaveLength(1);
        expect(messageType(fixture.messages[0].message)).toBe("setConflictData");
        expect(conflictData(fixture)).toMatchObject({
            filePath: "mutable.txt",
            oursLabel: "Local",
            theirsLabel: "Shelved",
            sessionKind: "shelf",
        });
    });

    it("produces byte-identical fixtures from two independent shelf-conflicted workspaces", async () => {
        const fixtureA = await recordShelfConflictEditorWebviewFixture(recorderOptions(workspaceA));
        const fixtureB = await recordShelfConflictEditorWebviewFixture(recorderOptions(workspaceB));

        expect(serializeWebviewFixture(fixtureA)).toBe(serializeWebviewFixture(fixtureB));
    });

    it("does not mutate the prepared workspace", async () => {
        const beforeContent = await readFile(path.join(workspaceA.root, "mutable.txt"), "utf8");
        const beforeStatus = await gitStatus(workspaceA);

        await recordShelfConflictEditorWebviewFixture(recorderOptions(workspaceA));

        expect(await readFile(path.join(workspaceA.root, "mutable.txt"), "utf8")).toBe(
            beforeContent,
        );
        expect(await gitStatus(workspaceA)).toBe(beforeStatus);
    });

    it("pins the no-volatile-field finding and the pure shelf payload", async () => {
        expect(SHELF_CONFLICT_EDITOR_VOLATILE_FIELDS).toEqual([]);

        const fixture = await recordShelfConflictEditorWebviewFixture(recorderOptions(workspaceA));
        const data = conflictData(fixture);
        expect(data).not.toHaveProperty("shelfId");
        expect(data).not.toHaveProperty("changeId");
        expect(data).not.toHaveProperty("worktreeFingerprint");
        expect(data).not.toHaveProperty("shelfGeneration");
    });

    it("is byte-identical with a deliberately non-default workspace configuration", async () => {
        const options = recorderOptions(workspaceA);
        const baseline = await recordShelfConflictEditorWebviewFixture(options);

        setFakeWorkspaceConfiguration({
            "editor.hover.delay": 999,
            "intelligit.icons": "color",
            "intelligit.tooltips.enabled": false,
            "intelligit.commitWindowPosition": "right",
            "workbench.sideBar.location": "right",
        });
        const configured = await recordShelfConflictEditorWebviewFixture(options);

        expect(serializeWebviewFixture(configured)).toBe(serializeWebviewFixture(baseline));
    });

    it("passes exact complete values through buildShelfConflictEditorPanelOptions", async () => {
        const { service } = await shelfServiceFor(workspaceA);
        const ids = await conflictIds(workspaceA);
        const extensionUri = createFakeExtensionUri();
        const options = buildShelfConflictEditorPanelOptions({
            extensionUri,
            repositoryRoot: workspaceA.root,
            shelfService: service,
            shelfId: ids.shelfId,
            changeId: ids.changeId,
        });

        expect(options).toEqual(
            expect.objectContaining({
                extensionUri,
                repositoryRoot: workspaceA.root,
                shelfService: service,
                shelfId: ids.shelfId,
                changeId: ids.changeId,
            }),
        );
        await expect(options.onApplied()).rejects.toThrow(/must never apply a resolution/i);
    });

    it("filters only shelf-conflict-editor messages at its own layer", () => {
        const shelf = {
            contextId: "shelf-conflict-editor" as const,
            message: { type: "setConflictData" },
        };
        const foreign = {
            contextId: "merge-editor" as const,
            message: { type: "setConflictData" },
        };

        expect(selectShelfConflictEditorMessages([foreign, shelf, foreign])).toEqual([shelf]);
        expect(selectShelfConflictEditorMessages([foreign])).toEqual([]);
    });

    it("rejects recording with an inactive E2E control channel", async () => {
        setE2eControlChannelActive(false);

        await expect(
            recordShelfConflictEditorWebviewFixture(recorderOptions(workspaceA)),
        ).rejects.toThrow(/E2E control channel/i);
    });

    it("names the panel-count invariant when the same open call reuses a static panel", async () => {
        const { service } = await shelfServiceFor(workspaceA);
        const ids = await conflictIds(workspaceA);
        const panelOptions = buildShelfConflictEditorPanelOptions({
            extensionUri: createFakeExtensionUri(),
            repositoryRoot: workspaceA.root,
            shelfService: service,
            shelfId: ids.shelfId,
            changeId: ids.changeId,
        });

        await ShelfConflictEditorPanel.open(panelOptions);
        const [leaked] = getCreatedWebviewPanels();
        expect(leaked).toBeDefined();
        await ShelfConflictEditorPanel.open(panelOptions);

        try {
            await expect(
                recordShelfConflictEditorWebviewFixture(recorderOptions(workspaceA)),
            ).rejects.toThrow(/exactly one new webview panel.*reuse branch/i);
        } finally {
            leaked.dispose();
        }
    });

    it("names the captured-message invariant when the single load message is hidden", async () => {
        vi.spyOn(webviewCapture, "getE2eWebviewCaptureSink").mockReturnValue({
            getMessages: () => [],
        } as NonNullable<ReturnType<typeof webviewCapture.getE2eWebviewCaptureSink>>);

        await expect(
            recordShelfConflictEditorWebviewFixture(recorderOptions(workspaceA)),
        ).rejects.toThrow(/expected exactly one captured shelf-conflict-editor message/i);
    });

    it("names the capture-sink invariant when no sink is available", async () => {
        vi.spyOn(webviewCapture, "getE2eWebviewCaptureSink").mockReturnValue(undefined);

        await expect(
            recordShelfConflictEditorWebviewFixture(recorderOptions(workspaceA)),
        ).rejects.toThrow(/no webview capture sink was allocated/i);
    });

    it("fails if production reaches onApplied during recording", async () => {
        const open = vi
            .spyOn(ShelfConflictEditorPanel, "open")
            .mockImplementation(async (options) => options.onApplied());

        try {
            await expect(
                recordShelfConflictEditorWebviewFixture(recorderOptions(workspaceA)),
            ).rejects.toThrow(/must never apply a resolution/i);
        } finally {
            open.mockRestore();
        }
    });

    it("actually routes Git reads through the supplied sanitized environment", async () => {
        const brokenConfig = path.join(parentDir, "broken.gitconfig");
        await writeFile(brokenConfig, "[[[ this is not valid git config\n", "utf8");
        const options = recorderOptions(workspaceA);

        await expect(
            recordShelfConflictEditorWebviewFixture({
                ...options,
                env: { ...options.env, GIT_CONFIG_GLOBAL: brokenConfig },
            }),
        ).rejects.toThrow(/bad config|fatal:/i);
    });

    /**
     * THE CONSTRUCTION SEAM'S ORACLE, asserted on what `open()` RECEIVES rather than on what the
     * builder returns.
     *
     * `buildShelfConflictEditorPanelOptions` has its own value test above, but a builder proves what
     * it RETURNS, not what production is handed -- Phase 2c-v-c shipped exactly that gap, and
     * adversarial review walked straight through it by replacing the argument at the call site with
     * an equivalent-looking literal. So this intercepts the real call and pins EVERY key by value:
     * the exact key set (an added or dropped option is red), the exact shelf and change ids read
     * independently from the scenario's own store (a literal that invents or blanks either is red),
     * a real `ShelfService` instance (a stub or `undefined` is red), and -- the one that matters
     * most -- that `onApplied` actually rejects, so a call site that swaps the throwing double for a
     * silent no-op cannot quietly make the recorder able to mutate the gate's shared workspace.
     *
     * Deliberately NOT asserted by reading this recorder's own source text: a regex over the call
     * site would pass for a builder returning semantically wrong values and fail for a rename or a
     * reformat, which is a worse oracle than the behavior itself.
     */
    it("hands ShelfConflictEditorPanel.open the complete, exact options tuple", async () => {
        const originalOpen = ShelfConflictEditorPanel.open.bind(ShelfConflictEditorPanel);
        const open = vi
            .spyOn(ShelfConflictEditorPanel, "open")
            .mockImplementation((options) => originalOpen(options));
        const expected = await conflictIds(workspaceA);

        try {
            await recordShelfConflictEditorWebviewFixture(recorderOptions(workspaceA));
            const received = open.mock.calls[0]?.[0];
            expect(received).toBeDefined();
            expect(Object.keys(received!).sort()).toEqual([
                "changeId",
                "extensionUri",
                "onApplied",
                "repositoryRoot",
                "shelfId",
                "shelfService",
            ]);
            expect(received!.repositoryRoot).toBe(workspaceA.root);
            expect(received!.shelfId).toBe(expected.shelfId);
            expect(received!.changeId).toBe(expected.changeId);
            expect(received!.shelfService).toBeInstanceOf(ShelfService);
            // `fsPath`, not the whole Uri: the double carries method members, so `toEqual` would
            // compare fresh function references and fail for two identical Uris.
            expect(received!.extensionUri.fsPath).toBe(createFakeExtensionUri().fsPath);
            await expect(received!.onApplied()).rejects.toThrow(/must never apply a resolution/i);
        } finally {
            open.mockRestore();
        }
    });

    it("finally clears the panel construction registry", async () => {
        await recordShelfConflictEditorWebviewFixture(recorderOptions(workspaceA));

        expect(getCreatedWebviewPanels()).toEqual([]);
    });

    it("finally clears the capture sink", async () => {
        await recordShelfConflictEditorWebviewFixture(recorderOptions(workspaceA));

        expect(webviewCapture.getE2eWebviewCaptureSink()).toBeUndefined();
    });

    it("registry contains the eighth shelf-conflict-editor recording", () => {
        const entry = WEBVIEW_FIXTURE_RECORDERS.find(
            (candidate) => candidate.contextId === "shelf-conflict-editor",
        );

        expect(entry).toBeDefined();
        expect(entry?.scenario).toBe(SHELF_CONFLICT_EDITOR_CONFLICTED_SCENARIO);
    });

    it("rejects a clean workspace instead of recording it as shelf-conflicted", async () => {
        const cleanDestination = path.join(parentDir, "clean");
        const cleanWorkspace = await CLEAN_SCENARIO.prepare(cleanDestination);
        try {
            await expect(
                recordShelfConflictEditorWebviewFixture({
                    repoRoot: cleanWorkspace.root,
                    shelfStorageRoot: path.join(cleanDestination, "shelf-storage"),
                    roots: {
                        root: cleanWorkspace.root,
                        originRoot: cleanWorkspace.template!.originRoot,
                        profileDir: "",
                    },
                    env: cleanWorkspace.env,
                }),
            ).rejects.toThrow(/shelf|manifest|exactly one/i);
        } finally {
            await Promise.all([
                rm(cleanWorkspace.home, { recursive: true, force: true }),
                rm(cleanDestination, { recursive: true, force: true }),
            ]);
        }
    });
});
