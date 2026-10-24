import { ChangelistStore } from "../../../src/changes/changelistStore";
// End-to-end flow tests for the native merge editor host panel.
// Each test creates a real Git repository with a real merge conflict, opens
// MergeEditorPanel against it, drives the webview message protocol, and
// verifies filesystem and Git index outcomes — not just function returns.

import { execFileSync, spawnSync } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface CapturedPanel {
    dispose(): void;
    html: string;
    messageHandler: ((msg: unknown) => Promise<void>) | null;
    postedMessages: unknown[];
    disposed: boolean;
    revealCalls: number;
}

const mocks = vi.hoisted(() => {
    interface HoistedPanel {
        dispose(): void;
        html: string;
        messageHandler: ((msg: unknown) => Promise<void>) | null;
        postedMessages: unknown[];
        disposed: boolean;
        revealCalls: number;
    }
    return {
        capturedPanels: [] as HoistedPanel[],
        showInformationMessage: vi.fn(async () => undefined),
        showErrorMessage: vi.fn(async () => undefined),
        showWarningMessage: vi.fn(async () => undefined),
        executeCommand: vi.fn(async () => undefined),
        completionDeliveryError: undefined as Error | undefined,
        textDocuments: [] as Array<{ uri: { scheme: string; fsPath: string }; isDirty: boolean }>,
    };
});

vi.mock("vscode", () => {
    const interpolate = (template: string, args?: Record<string, unknown>): string =>
        args
            ? template.replace(/\{([A-Za-z0-9_]+)\}/g, (match, key: string) =>
                  key in args ? String(args[key]) : match,
              )
            : template;

    const makeUri = (fsPath: string) => ({
        fsPath,
        path: fsPath,
        toString: () => `file://${fsPath}`,
    });

    return {
        l10n: { t: interpolate },
        ProgressLocation: { Notification: 15 },
        ViewColumn: { Active: -1 },
        Uri: {
            file: (p: string) => makeUri(p),
            joinPath: (base: { fsPath: string }, ...segments: string[]) =>
                makeUri([base.fsPath, ...segments].join("/")),
        },
        commands: {
            executeCommand: mocks.executeCommand,
        },
        env: { language: "en" },
        workspace: {
            textDocuments: mocks.textDocuments,
            getConfiguration: () => ({ get: () => undefined }),
        },
        window: {
            showInformationMessage: mocks.showInformationMessage,
            showErrorMessage: mocks.showErrorMessage,
            showWarningMessage: mocks.showWarningMessage,
            withProgress: async (
                _options: unknown,
                task: (
                    progress: { report: () => void },
                    token: { isCancellationRequested: boolean },
                ) => Promise<unknown>,
            ) => task({ report: () => undefined }, { isCancellationRequested: false }),
            createWebviewPanel: () => {
                const disposeListeners: Array<() => void> = [];
                const captured = {
                    dispose: () => {
                        captured.disposed = true;
                        for (const listener of disposeListeners) listener();
                    },
                    html: "",
                    messageHandler: null as ((msg: unknown) => Promise<void>) | null,
                    postedMessages: [] as unknown[],
                    disposed: false,
                    revealCalls: 0,
                };
                mocks.capturedPanels.push(captured);
                return {
                    webview: {
                        set html(value: string) {
                            captured.html = value;
                        },
                        get html() {
                            return captured.html;
                        },
                        cspSource: "vscode-resource:",
                        asWebviewUri: (uri: { fsPath: string }) => uri,
                        onDidReceiveMessage: (handler: (msg: unknown) => Promise<void>) => {
                            captured.messageHandler = handler;
                            return { dispose: () => undefined };
                        },
                        postMessage: async (msg: unknown) => {
                            if (
                                (msg as { type?: string }).type === "resolutionApplied" &&
                                mocks.completionDeliveryError
                            )
                                throw mocks.completionDeliveryError;
                            captured.postedMessages.push(msg);
                            return true;
                        },
                    },
                    reveal: () => {
                        captured.revealCalls += 1;
                    },
                    onDidDispose: (listener: () => void) => {
                        disposeListeners.push(listener);
                        return { dispose: () => undefined };
                    },
                    dispose: captured.dispose,
                };
            },
        },
    };
});

vi.mock("../../../src/utils/notifications", () => ({
    runWithNotificationProgress: vi.fn(
        async (_message: string, task: (progress: unknown, token: unknown) => Promise<unknown>) =>
            task({ report: vi.fn() }, { isCancellationRequested: false }),
    ),
    showTimedInformationMessage: mocks.showInformationMessage,
    showTimedWarningMessage: mocks.showWarningMessage,
}));

import { removeScratchDirectories } from "../../helpers/scratchDirectories";
import { GitExecutor } from "../../../src/git/executor";
import { GitOps } from "../../../src/git/operations";
import { areSameRepositoryRoot } from "../../../src/utils/repositoryRoot";
import {
    MergeEditorPanel,
    type MergeEditorPanelOptions,
} from "../../../src/views/MergeEditorPanel";
import { MergeConflictSessionPanel } from "../../../src/views/MergeConflictSessionPanel";
import { DiffViewerPanel } from "../../../src/views/DiffViewerPanel";
import { buildResultContent } from "../../../src/webviews/react/merge-editor/mergeState";
import type { ConflictSegment, MergeEditorData } from "../../../src/mergeEditor/conflictParser";

const EXTENSION_URI = { fsPath: "/ext", path: "/ext", toString: () => "file:///ext" };

let repoRoot: string;

function git(args: string[], options: { allowFailure?: boolean } = {}): string {
    if (options.allowFailure) {
        const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
        return `${result.stdout}${result.stderr}`;
    }
    return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" });
}

async function writeRepoFile(relativePath: string, content: string): Promise<void> {
    await fs.writeFile(path.join(repoRoot, relativePath), content, "utf8");
}

function initRepo(): void {
    git(["init", "-b", "main"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Test"]);
    git(["config", "commit.gpgsign", "false"]);
}

/**
 * Creates a real repository where `main` and `feature` both edit the same line
 * of `shared.ts`, then starts a merge that stops on the conflict.
 */
async function createConflictRepo(files = ["shared.ts"]): Promise<void> {
    initRepo();

    for (const file of files) await writeRepoFile(file, "function shared() {\n    return 1;\n}\n");
    git(["add", "."]);
    git(["commit", "-m", "base"]);

    git(["checkout", "-b", "feature"]);
    for (const file of files) await writeRepoFile(file, "function shared() {\n    return 2;\n}\n");
    git(["commit", "-am", "feature change"]);

    git(["checkout", "main"]);
    for (const file of files) await writeRepoFile(file, "function shared() {\n    return 3;\n}\n");
    git(["commit", "-am", "main change"]);

    git(["merge", "feature"], { allowFailure: true });
}

function makeOptions(
    gitOps: GitOps,
    overrides: Partial<MergeEditorPanelOptions> = {},
): MergeEditorPanelOptions {
    return {
        extensionUri: EXTENSION_URI as never,
        gitOps,
        getRepoRoot: () => repoRoot,
        filePath: "shared.ts",
        onConflictStateChanged: vi.fn(async () => undefined),
        ...overrides,
    };
}

function lastPanel(): CapturedPanel {
    const panel = mocks.capturedPanels[mocks.capturedPanels.length - 1];
    if (!panel) throw new Error("Expected a webview panel to have been created");
    return panel;
}

async function fireMessage(panel: CapturedPanel, msg: unknown): Promise<void> {
    if (!panel.messageHandler) throw new Error("Webview message handler was not registered");
    if (
        typeof msg === "object" &&
        msg !== null &&
        "type" in msg &&
        msg.type === "applyResolution" &&
        !("snapshotId" in msg)
    ) {
        const data = findConflictData(panel);
        msg = { ...msg, snapshotId: data.workbench?.snapshotId };
    }
    await panel.messageHandler(msg);
}

function findConflictData(panel: CapturedPanel): MergeEditorData {
    const message = [...panel.postedMessages]
        .reverse()
        .find(
            (candidate): candidate is { type: string; data: MergeEditorData } =>
                typeof candidate === "object" &&
                candidate !== null &&
                (candidate as { type?: unknown }).type === "setConflictData",
        );
    if (!message) {
        throw new Error(
            `Expected a setConflictData message, got: ${JSON.stringify(panel.postedMessages)}`,
        );
    }
    return message.data;
}

function conflictSegments(data: MergeEditorData): ConflictSegment[] {
    return data.segments.filter((seg): seg is ConflictSegment => seg.type === "conflict");
}

beforeEach(async () => {
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "intelligit-merge-editor-"));
    mocks.capturedPanels.length = 0;
    mocks.textDocuments.length = 0;
    mocks.completionDeliveryError = undefined;
    vi.clearAllMocks();
});

afterEach(async () => {
    // Dispose panels so the static registry cannot leak panels across tests.
    for (const panel of mocks.capturedPanels) {
        if (!panel.disposed && panel.messageHandler) {
            await fireMessage(panel, { type: "close" });
        }
    }
    await removeScratchDirectories(repoRoot);
    vi.restoreAllMocks();
});

describe("MergeEditorPanel end-to-end merge flow", () => {
    it("stages one file and opens the next fresh snapshot without continuing the merge", async () => {
        await createConflictRepo(["shared.ts", "second.ts"]);
        const head = git(["rev-parse", "HEAD"]);
        const operation = git(["rev-parse", "MERGE_HEAD"]);
        const second = await fs.readFile(path.join(repoRoot, "second.ts"));
        const options = makeOptions(new GitOps(new GitExecutor(repoRoot)));
        await MergeEditorPanel.open(options);
        const first = lastPanel();
        await fireMessage(first, { type: "ready" });
        await fireMessage(first, { type: "loadMergeFiles" });
        expect(first.postedMessages).toContainEqual({
            type: "mergeFileQueue",
            files: [
                { path: "second.ts", resolved: false },
                { path: "shared.ts", resolved: false },
            ],
        });
        await fireMessage(first, {
            type: "applyResolution",
            content: "resolved first\n",
            openNext: true,
        });
        const next = lastPanel();
        expect(next).not.toBe(first);
        expect(first.disposed).toBe(true);
        await fireMessage(next, { type: "ready" });
        expect(findConflictData(next).filePath).toBe("second.ts");
        expect(git(["show", ":shared.ts"])).toBe("resolved first\n");
        expect(git(["ls-files", "-u"])).toContain("second.ts");
        expect(git(["ls-files", "-u"])).not.toContain("shared.ts");
        expect(await fs.readFile(path.join(repoRoot, "second.ts"))).toEqual(second);
        expect(git(["rev-parse", "HEAD"])).toBe(head);
        expect(git(["rev-parse", "MERGE_HEAD"])).toBe(operation);
        await fireMessage(next, { type: "loadMergeFiles" });
        expect(next.postedMessages).toContainEqual({
            type: "mergeFileQueue",
            files: [
                { path: "second.ts", resolved: false },
                { path: "shared.ts", resolved: true },
            ],
        });
        const diff = vi.spyOn(DiffViewerPanel, "open").mockResolvedValue(undefined);
        await fireMessage(next, { type: "reviewMergeFile", filePath: "shared.ts" });
        expect(diff).toHaveBeenCalledWith(
            expect.objectContaining({
                path: "shared.ts",
                leftText: "function shared() {\n    return 1;\n}\n",
                rightText: "resolved first\n",
            }),
        );
        expect(diff.mock.calls[0][0]).not.toHaveProperty("editable");
        expect(git(["rev-parse", "HEAD"])).toBe(head);
    });

    it("does not advance or clear the durable draft when staging fails", async () => {
        await createConflictRepo(["shared.ts", "second.ts"]);
        const stages = git(["ls-files", "-u"]);
        let value: unknown;
        const store = {
            get: () => value,
            update: async (_key: string, next: unknown) => {
                value = next;
            },
        };
        await MergeEditorPanel.open(
            makeOptions(new GitOps(new GitExecutor(repoRoot)), {
                draftStore: store as never,
            }),
        );
        const panel = lastPanel();
        await fireMessage(panel, { type: "ready" });
        const draft = {
            snapshotId: findConflictData(panel).workbench!.snapshotId,
            content: "retained result\n",
            hunks: [],
        };
        await fireMessage(panel, { type: "saveMergeDraft", draft, revision: 1 });
        await fs.writeFile(path.join(repoRoot, ".git/index.lock"), "owned by test", { flag: "wx" });
        await fireMessage(panel, {
            type: "applyResolution",
            content: draft.content,
            openNext: true,
        });
        expect(mocks.capturedPanels).toHaveLength(1);
        expect(panel.disposed).toBe(false);
        expect(value).toEqual(draft);
        expect(git(["ls-files", "-u"])).toBe(stages);
        expect(panel.postedMessages).toContainEqual({
            type: "resolutionError",
            message: expect.stringContaining("staging failed"),
        });
    });

    it("compares immutable inputs and the unsaved result without touching files or stages", async () => {
        await createConflictRepo();
        await MergeEditorPanel.open(makeOptions(new GitOps(new GitExecutor(repoRoot))));
        const panel = lastPanel();
        await fireMessage(panel, { type: "ready" });
        const snapshotId = findConflictData(panel).workbench!.snapshotId;
        const before = await fs.readFile(path.join(repoRoot, "shared.ts"));
        const index = git(["ls-files", "-u"]);
        const diff = vi.spyOn(DiffViewerPanel, "open").mockResolvedValue(undefined);
        for (const side of ["ours", "theirs", "result"])
            await fireMessage(panel, {
                type: "compareMergeVersion",
                snapshotId,
                side,
                content: "unsaved result\n",
            });
        expect(diff.mock.calls.map(([options]) => options.rightText)).toEqual([
            "function shared() {\n    return 3;\n}\n",
            "function shared() {\n    return 2;\n}\n",
            "unsaved result\n",
        ]);
        for (const [options] of diff.mock.calls) {
            expect(options.leftText).toBe("function shared() {\n    return 1;\n}\n");
            expect(options).not.toHaveProperty("editable");
        }
        for (const invalid of [
            { snapshotId: "a".repeat(64), side: "result", content: "stale" },
            { snapshotId, side: "base", content: "invalid" },
            { snapshotId, side: "result", content: "\0" },
            { snapshotId, side: "result", content: "界".repeat(700_000) },
        ])
            await fireMessage(panel, { type: "compareMergeVersion", ...invalid });
        expect(diff).toHaveBeenCalledTimes(3);
        expect(await fs.readFile(path.join(repoRoot, "shared.ts"))).toEqual(before);
        expect(git(["ls-files", "-u"])).toBe(index);
    });

    it("accepts only fresh conflict paths from the captured repository queue", async () => {
        await createConflictRepo(["shared.ts", "second.ts"]);
        const executor = new GitExecutor(repoRoot);
        await MergeEditorPanel.open(makeOptions(new GitOps(executor)));
        const first = lastPanel();
        await fireMessage(first, { type: "ready" });
        executor.setRoot(os.tmpdir());
        await fireMessage(first, { type: "openMergeFile", filePath: "unknown.ts" });
        await fireMessage(first, { type: "openMergeFile", filePath: "../outside.ts" });
        expect(mocks.capturedPanels).toHaveLength(1);
        await fireMessage(first, { type: "openMergeFile", filePath: "second.ts" });
        const second = lastPanel();
        await fireMessage(second, { type: "ready" });
        expect(findConflictData(second).filePath).toBe("second.ts");
        expect(first.disposed).toBe(false);
    });

    it("does not include saved results from a completed operation in a new conflict queue", async () => {
        await createConflictRepo(["shared.ts", "second.ts"]);
        const options = makeOptions(new GitOps(new GitExecutor(repoRoot)));
        await MergeEditorPanel.open(options);
        const first = lastPanel();
        await fireMessage(first, { type: "ready" });
        await fireMessage(first, { type: "applyResolution", content: "old saved result\n" });
        git(["merge", "--abort"]);
        git(["merge", "feature"], { allowFailure: true });
        await MergeEditorPanel.open(options);
        const current = lastPanel();
        await fireMessage(current, { type: "ready" });
        const diff = vi.spyOn(DiffViewerPanel, "open").mockResolvedValue(undefined);
        await fireMessage(current, { type: "reviewMergeFile", filePath: "shared.ts" });
        expect(diff).not.toHaveBeenCalled();
    });

    it("refuses a dirty buffer opened through a symlinked workspace alias", async () => {
        await createConflictRepo();
        const alias = path.join(repoRoot, "workspace-alias");
        await fs.symlink(repoRoot, alias, process.platform === "win32" ? "junction" : "dir");
        mocks.textDocuments.push({
            uri: { scheme: "file", fsPath: path.join(alias, "shared.ts") },
            isDirty: true,
        });
        await MergeEditorPanel.open(makeOptions(new GitOps(new GitExecutor(repoRoot))));
        const panel = lastPanel();
        await fireMessage(panel, { type: "ready" });
        const before = await fs.readFile(path.join(repoRoot, "shared.ts"));
        await fireMessage(panel, { type: "applyResolution", content: "resolved\n" });
        expect(panel.disposed).toBe(false);
        expect(panel.postedMessages).toContainEqual({
            type: "resolutionError",
            message: expect.stringContaining("unsaved editor changes"),
        });
        expect(await fs.readFile(path.join(repoRoot, "shared.ts"))).toEqual(before);
        expect(git(["ls-files", "-u"])).not.toBe("");
    });
    it("persists drafts in message order and clears them after Apply without late recreation", async () => {
        await createConflictRepo();
        const values = new Map<string, unknown>();
        const store = {
            get: (key: string) => values.get(key),
            update: async (key: string, value: unknown) => {
                await new Promise((resolve) => setTimeout(resolve, 10));
                values.set(key, value);
            },
        };
        await MergeEditorPanel.open(
            makeOptions(new GitOps(new GitExecutor(repoRoot)), { draftStore: store as never }),
        );
        const panel = lastPanel();
        await fireMessage(panel, { type: "ready" });
        const snapshotId = findConflictData(panel).workbench!.snapshotId;
        const first = { snapshotId, content: "first", hunks: [] };
        const second = { snapshotId, content: "second", hunks: [] };
        await Promise.all([
            fireMessage(panel, { type: "saveMergeDraft", draft: first, revision: 1 }),
            fireMessage(panel, { type: "saveMergeDraft", draft: second, revision: 2 }),
        ]);
        expect([...values.values()]).toEqual([second]);
        await fireMessage(panel, { type: "applyResolution", content: "resolved\n" });
        await fireMessage(panel, { type: "saveMergeDraft", draft: first, revision: 3 });
        expect([...values.values()]).toEqual([undefined]);
    });

    it("clears the committed draft when the panel closes while Apply is staging", async () => {
        await createConflictRepo();
        const values = new Map<string, unknown>();
        const store = {
            get: (key: string) => values.get(key),
            update: async (key: string, value: unknown) => {
                values.set(key, value);
            },
        };
        const gitOps = new GitOps(new GitExecutor(repoRoot));
        const derive = gitOps.deriveFor.bind(gitOps);
        gitOps.deriveFor = (root) => {
            const derived = derive(root);
            const apply = derived.applyMergeResolution.bind(derived);
            derived.applyMergeResolution = async (...args) => {
                lastPanel().dispose();
                await apply(...args);
            };
            return derived;
        };
        await MergeEditorPanel.open(makeOptions(gitOps, { draftStore: store as never }));
        const panel = lastPanel();
        await fireMessage(panel, { type: "ready" });
        const snapshotId = findConflictData(panel).workbench!.snapshotId;
        const draft = { snapshotId, content: "draft", hunks: [] };
        await fireMessage(panel, { type: "saveMergeDraft", draft, revision: 1 });
        expect([...values.values()]).toEqual([draft]);
        await fireMessage(panel, { type: "applyResolution", content: "resolved\n" });
        expect(git(["ls-files", "-u"])).toBe("");
        expect([...values.values()]).toEqual([undefined]);
    });

    it("keeps successful staging terminal when durable draft cleanup rejects", async () => {
        await createConflictRepo();
        let value: unknown;
        const cleanupError = new Error("draft storage unavailable");
        let release!: () => void;
        let cleanupStarted!: () => void;
        const cleanupGate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const cleaning = new Promise<void>((resolve) => {
            cleanupStarted = resolve;
        });
        const diagnostics = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const store = {
            get: () => value,
            update: vi.fn(async (_key: string, next: unknown) => {
                if (next === undefined) {
                    cleanupStarted();
                    await cleanupGate;
                    throw cleanupError;
                }
                value = next;
            }),
        };
        const onConflictStateChanged = vi.fn(async () => undefined);
        await MergeEditorPanel.open(
            makeOptions(new GitOps(new GitExecutor(repoRoot)), {
                draftStore: store as never,
                onConflictStateChanged,
            }),
        );
        const panel = lastPanel();
        await fireMessage(panel, { type: "ready" });
        const snapshotId = findConflictData(panel).workbench!.snapshotId;
        const draft = { snapshotId, content: "resolved\n", hunks: [] };
        await fireMessage(panel, { type: "saveMergeDraft", draft, revision: 1 });
        const applying = fireMessage(panel, { type: "applyResolution", content: draft.content });
        await cleaning;
        await fireMessage(panel, { type: "applyResolution", content: "late apply\n" });
        const lateSave = fireMessage(panel, {
            type: "saveMergeDraft",
            draft: { ...draft, content: "late draft\n" },
            revision: 2,
        });
        release();
        await Promise.all([applying, lateSave]);
        expect(git(["ls-files", "-u"])).toBe("");
        expect(git(["show", ":shared.ts"])).toBe(draft.content);
        expect(panel.postedMessages).toContainEqual({ type: "resolutionApplied" });
        expect(panel.postedMessages).not.toContainEqual(
            expect.objectContaining({ type: "resolutionError" }),
        );
        expect(mocks.showErrorMessage).not.toHaveBeenCalled();
        expect(mocks.showInformationMessage).toHaveBeenCalledWith("Merged and staged: shared.ts");
        expect(onConflictStateChanged).toHaveBeenCalledOnce();
        expect(panel.disposed).toBe(true);
        expect(value).toEqual(draft);
        expect(diagnostics).toHaveBeenCalledWith(
            "[IntelliGit] Failed to clear an applied merge draft:",
            cleanupError,
        );
        await fireMessage(panel, { type: "saveMergeDraft", draft, revision: 2 });
        expect(store.update).toHaveBeenCalledTimes(2);
    });

    it("finishes staged resolutions even when completion delivery rejects", async () => {
        await createConflictRepo();
        let value: unknown;
        const store = {
            get: () => value,
            update: async (_key: string, next: unknown) => {
                value = next;
            },
        };
        const diagnostics = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const deliveryError = new Error("webview unavailable");
        const onConflictStateChanged = vi.fn(async () => undefined);
        await MergeEditorPanel.open(
            makeOptions(new GitOps(new GitExecutor(repoRoot)), {
                draftStore: store as never,
                onConflictStateChanged,
            }),
        );
        const panel = lastPanel();
        await fireMessage(panel, { type: "ready" });
        const draft = {
            snapshotId: findConflictData(panel).workbench!.snapshotId,
            content: "resolved\n",
            hunks: [],
        };
        await fireMessage(panel, { type: "saveMergeDraft", draft, revision: 1 });
        mocks.completionDeliveryError = deliveryError;
        await fireMessage(panel, { type: "applyResolution", content: draft.content });
        expect(git(["ls-files", "-u"])).toBe("");
        expect(git(["show", ":shared.ts"])).toBe(draft.content);
        expect(panel.postedMessages).not.toContainEqual(
            expect.objectContaining({ type: "resolutionError" }),
        );
        expect(mocks.showErrorMessage).not.toHaveBeenCalled();
        expect(onConflictStateChanged).toHaveBeenCalledOnce();
        expect(panel.disposed).toBe(true);
        expect(value).toBeUndefined();
        expect(diagnostics).toHaveBeenCalledWith(
            "[IntelliGit] Failed to deliver merge completion:",
            deliveryError,
        );
    });

    it("orders in-flight saves across native disposal and rejects superseded queued writes", async () => {
        await createConflictRepo();
        let release!: () => void;
        let started!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const writing = new Promise<void>((resolve) => {
            started = resolve;
        });
        let value: unknown;
        const writes: unknown[] = [];
        const store = {
            get: () => value,
            update: async (_key: string, next: unknown) => {
                writes.push(next);
                if (writes.length === 1) {
                    started();
                    await gate;
                }
                value = next;
            },
        };
        const options = makeOptions(new GitOps(new GitExecutor(repoRoot)), {
            draftStore: store as never,
        });
        await MergeEditorPanel.open(options);
        const oldPanel = lastPanel();
        await fireMessage(oldPanel, { type: "ready" });
        const snapshotId = findConflictData(oldPanel).workbench!.snapshotId;
        const first = { snapshotId, content: "in flight", hunks: [] };
        const superseded = { snapshotId, content: "superseded", hunks: [] };
        const latest = { snapshotId, content: "reopened latest", hunks: [] };
        const firstSave = fireMessage(oldPanel, {
            type: "saveMergeDraft",
            draft: first,
            revision: 1,
        });
        await writing;
        const oldSave = fireMessage(oldPanel, {
            type: "saveMergeDraft",
            draft: superseded,
            revision: 2,
        });
        oldPanel.dispose();
        await MergeEditorPanel.open(options);
        const reopened = lastPanel();
        await fireMessage(reopened, { type: "ready" });
        const load = fireMessage(reopened, { type: "loadMergeDraft" });
        const newSave = fireMessage(reopened, {
            type: "saveMergeDraft",
            draft: latest,
            revision: 1,
        });
        await fireMessage(oldPanel, { type: "discardMergeDraft", snapshotId });
        release();
        await Promise.all([firstSave, oldSave, load, newSave]);
        expect(writes).toEqual([first, latest]);
        expect(value).toEqual(latest);
        expect(reopened.postedMessages).toContainEqual({ type: "mergeDraft", draft: first });
        await fireMessage(oldPanel, { type: "saveMergeDraft", draft: superseded, revision: 3 });
        expect(value).toEqual(latest);
    });

    it("drains the current owner's queued draft before explicit close", async () => {
        await createConflictRepo();
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let value: unknown;
        const store = {
            get: () => value,
            update: async (_key: string, next: unknown) => {
                await gate;
                value = next;
            },
        };
        await MergeEditorPanel.open(
            makeOptions(new GitOps(new GitExecutor(repoRoot)), { draftStore: store as never }),
        );
        const panel = lastPanel();
        await fireMessage(panel, { type: "ready" });
        const draft = {
            snapshotId: findConflictData(panel).workbench!.snapshotId,
            content: "last",
            hunks: [],
        };
        const saving = fireMessage(panel, { type: "saveMergeDraft", draft, revision: 1 });
        const closing = fireMessage(panel, { type: "close" });
        expect(panel.disposed).toBe(false);
        release();
        await Promise.all([saving, closing]);
        expect(value).toEqual(draft);
        expect(panel.disposed).toBe(true);
    });

    it("does not overwrite or discard an older operation draft without its identity", async () => {
        await createConflictRepo();
        const old = { snapshotId: "a".repeat(64), content: "previous operation", hunks: [] };
        let value: unknown = old;
        const store = {
            get: () => value,
            update: async (_key: string, next: unknown) => {
                value = next;
            },
        };
        await MergeEditorPanel.open(
            makeOptions(new GitOps(new GitExecutor(repoRoot)), { draftStore: store as never }),
        );
        const panel = lastPanel();
        await fireMessage(panel, { type: "ready" });
        const snapshotId = findConflictData(panel).workbench!.snapshotId;
        await fireMessage(panel, {
            type: "saveMergeDraft",
            draft: { snapshotId, content: "new", hunks: [] },
            revision: 1,
        });
        await fireMessage(panel, { type: "discardMergeDraft", snapshotId });
        expect(value).toEqual(old);
        await fireMessage(panel, { type: "discardMergeDraft", snapshotId: old.snapshotId });
        expect(value).toBeUndefined();
    });

    it("keeps a failed Apply mounted and offers a root-scoped native fallback", async () => {
        await createConflictRepo();
        await MergeEditorPanel.open(makeOptions(new GitOps(new GitExecutor(repoRoot))));
        const panel = lastPanel();
        await fireMessage(panel, { type: "ready" });
        await writeRepoFile("shared.ts", "external\n");
        await fireMessage(panel, { type: "applyResolution", content: "draft\n" });
        expect(panel.disposed).toBe(false);
        expect(panel.postedMessages).toContainEqual({
            type: "resolutionError",
            message: expect.stringContaining("changed"),
        });
        expect(await fs.readFile(path.join(repoRoot, "shared.ts"), "utf8")).toBe("external\n");
        await fireMessage(panel, { type: "openNativeMerge" });
        expect(mocks.executeCommand).toHaveBeenCalledWith(
            "git.openMergeEditor",
            expect.objectContaining({ fsPath: path.join(repoRoot, "shared.ts") }),
        );
    });

    it("opens its captured conflict session instead of consulting the active repository", async () => {
        await createConflictRepo();
        const onOpenConflictSession = vi.fn(async () => undefined);
        await MergeEditorPanel.open(
            makeOptions(new GitOps(new GitExecutor(repoRoot)), { onOpenConflictSession }),
        );
        await fireMessage(lastPanel(), { type: "openConflictSession" });
        expect(onOpenConflictSession).toHaveBeenCalledOnce();
        expect(mocks.executeCommand).not.toHaveBeenCalled();
    });

    it("keeps same-path A and B editors separate and applies each draft to its captured repository", async () => {
        await createConflictRepo();
        const a = repoRoot;
        const executor = new GitExecutor(a);
        const gitOps = new GitOps(executor);
        await MergeEditorPanel.open(makeOptions(gitOps));
        const panelA = lastPanel();
        await fireMessage(panelA, { type: "ready" });
        const messagesA = [...panelA.postedMessages];
        // Unsubmitted editor content lives in its webview. B must not refresh or replace A.
        const draftA = "A unsubmitted resolution\n";
        const b = await fs.mkdtemp(path.join(os.tmpdir(), "intelligit-merge-editor-b-"));
        try {
            repoRoot = b;
            await createConflictRepo();
            executor.setRoot(b);
            const bBefore = await fs.readFile(path.join(b, "shared.ts"), "utf8");
            await MergeEditorPanel.open(makeOptions(gitOps));
            const panelB = lastPanel();
            await fireMessage(panelB, { type: "ready" });
            expect(
                panelB,
                "same relative path in another repository gets an independent editor",
            ).not.toBe(panelA);
            expect(panelA.disposed).toBe(false);
            expect(panelA.postedMessages, "opening B must preserve A's unsubmitted draft").toEqual(
                messagesA,
            );
            await fireMessage(panelA, { type: "applyResolution", content: draftA });
            expect(await fs.readFile(path.join(a, "shared.ts"), "utf8")).toBe(draftA);
            expect(await fs.readFile(path.join(b, "shared.ts"), "utf8")).toBe(bBefore);
            expect(
                execFileSync("git", ["ls-files", "-u"], { cwd: a, encoding: "utf8" }),
                "applying A stages A instead of the currently active B",
            ).toBe("");
            expect(execFileSync("git", ["show", ":shared.ts"], { cwd: a, encoding: "utf8" })).toBe(
                draftA,
            );
            expect(MergeEditorPanel.isOpen(), "closing A must leave B registered").toBe(true);
            repoRoot = a;
            executor.setRoot(a);
            await fireMessage(panelB, { type: "applyResolution", content: "B draft\n" });
            expect(await fs.readFile(path.join(b, "shared.ts"), "utf8")).toBe("B draft\n");
            expect(execFileSync("git", ["show", ":shared.ts"], { cwd: b, encoding: "utf8" })).toBe(
                "B draft\n",
            );
            expect(MergeEditorPanel.isOpen()).toBe(false);
        } finally {
            repoRoot = a;
            await removeScratchDirectories(b);
        }
    });

    it.each(["acceptTheirs", "abortMerge"])(
        "recreates conflict sessions across repositories and keeps B %s fixed after switching to A",
        async (action) => {
            await createConflictRepo();
            const a = repoRoot;
            const executor = new GitExecutor(a);
            const gitOps = new GitOps(executor);
            const callbacksA = {
                changelists: new ChangelistStore(),
                onOpenMergeConflict: vi.fn(async () => undefined),
                onConflictStateChanged: vi.fn(async () => undefined),
            };
            await MergeConflictSessionPanel.open(
                EXTENSION_URI as never,
                gitOps,
                { sourceBranch: "feature-A", targetBranch: "main-A" },
                callbacksA,
            );
            const panelA = lastPanel();
            const b = await fs.mkdtemp(path.join(os.tmpdir(), "intelligit-conflict-session-b-"));
            try {
                repoRoot = b;
                await createConflictRepo();
                executor.setRoot(b);
                const callbacksB = {
                    changelists: new ChangelistStore(),
                    onOpenMergeConflict: vi.fn(async () => undefined),
                    onConflictStateChanged: vi.fn(async () => undefined),
                };
                await MergeConflictSessionPanel.open(
                    EXTENSION_URI as never,
                    gitOps,
                    { sourceBranch: "feature-B", targetBranch: "main-B" },
                    callbacksB,
                );
                const panelB = lastPanel();
                expect(
                    panelB,
                    "cross-repository session must not reuse the old Git facade",
                ).not.toBe(panelA);
                expect(panelA.disposed).toBe(true);
                expect(panelB.postedMessages).toContainEqual(
                    expect.objectContaining({
                        type: "setSessionData",
                        data: expect.objectContaining({
                            sourceBranch: "feature-B",
                            targetBranch: "main-B",
                            files: [expect.objectContaining({ path: "shared.ts" })],
                        }),
                    }),
                );
                executor.setRoot(a);
                repoRoot = a;
                await fireMessage(panelB, { type: "openMerge", filePath: "shared.ts" });
                expect(callbacksB.onOpenMergeConflict).toHaveBeenCalledWith("shared.ts");
                expect(callbacksA.onOpenMergeConflict).not.toHaveBeenCalled();
                if (action === "abortMerge")
                    mocks.showWarningMessage.mockResolvedValueOnce("Abort Merge");
                await fireMessage(panelB, { type: action, filePath: "shared.ts" });
                expect(execFileSync("git", ["ls-files", "-u"], { cwd: b, encoding: "utf8" })).toBe(
                    "",
                );
                expect(
                    execFileSync("git", ["ls-files", "-u"], { cwd: a, encoding: "utf8" }),
                ).not.toBe("");
                expect(callbacksB.onConflictStateChanged).toHaveBeenCalledOnce();
            } finally {
                repoRoot = a;
                await removeScratchDirectories(b);
            }
        },
    );

    it("opens a real conflict, resolves via webview content, writes and stages the file", async () => {
        await createConflictRepo();
        const gitOps = new GitOps(new GitExecutor(repoRoot));
        const onConflictStateChanged = vi.fn(async () => undefined);

        await MergeEditorPanel.open(makeOptions(gitOps, { onConflictStateChanged }));
        const panel = lastPanel();
        expect(panel.html).toContain("webview-mergeeditor.js");

        await fireMessage(panel, { type: "ready" });
        const data = findConflictData(panel);

        expect(data.filePath).toBe("shared.ts");
        expect(data.oursLabel).toBe("main");
        expect(data.theirsLabel).toBe("feature");
        expect(data.eol).toBe("\n");
        expect(data.hasTrailingNewline).toBe(true);

        const conflicts = conflictSegments(data);
        expect(conflicts).toHaveLength(1);
        expect(conflicts[0]).toMatchObject({
            changeKind: "conflict",
            oursLines: ["    return 3;"],
            theirsLines: ["    return 2;"],
            baseLines: ["    return 1;"],
        });

        // Build the merged result exactly the way the webview does, then apply it.
        const content = buildResultContent(data, { [conflicts[0].id]: "theirs" });
        expect(content).toBe("function shared() {\n    return 2;\n}\n");
        await fireMessage(panel, { type: "applyResolution", content });

        const written = await fs.readFile(path.join(repoRoot, "shared.ts"), "utf8");
        expect(written).toBe("function shared() {\n    return 2;\n}\n");
        expect(git(["ls-files", "-u"]).trim()).toBe("");
        expect(git(["diff", "--cached", "--name-only"])).toContain("shared.ts");
        expect(onConflictStateChanged).toHaveBeenCalledTimes(1);
        expect(panel.disposed).toBe(true);
        expect(mocks.showInformationMessage).toHaveBeenCalledWith("Merged and staged: shared.ts");
    });

    it("accepts the full ours side through Git and disposes the panel", async () => {
        await createConflictRepo();
        const gitOps = new GitOps(new GitExecutor(repoRoot));

        await MergeEditorPanel.open(makeOptions(gitOps));
        const panel = lastPanel();
        await fireMessage(panel, { type: "ready" });
        await fireMessage(panel, { type: "acceptYours" });

        const written = await fs.readFile(path.join(repoRoot, "shared.ts"), "utf8");
        expect(written).toBe("function shared() {\n    return 3;\n}\n");
        expect(git(["ls-files", "-u"]).trim()).toBe("");
        expect(panel.disposed).toBe(true);
    });

    it.each(["editor", "session"] as const)(
        "targeted %s host checks pending before native state and never falls through after cancellation",
        async (host) => {
            await createConflictRepo();
            const ops = new GitOps(new GitExecutor(repoRoot));
            const control = vi
                .spyOn(GitOps.prototype, "controlTargetHistory")
                .mockResolvedValue({ status: "cancelled", id: "pending" });
            const native = vi.spyOn(GitOps.prototype, "getActiveOperation");
            const abort = vi.spyOn(GitOps.prototype, "abortMerge");
            try {
                if (host === "editor") await MergeEditorPanel.open(makeOptions(ops));
                else
                    await MergeConflictSessionPanel.open(
                        EXTENSION_URI as never,
                        ops,
                        {},
                        {
                            changelists: new ChangelistStore(),
                            onOpenMergeConflict: async () => undefined,
                            onConflictStateChanged: async () => undefined,
                        },
                    );
                native.mockClear();
                await fireMessage(lastPanel(), { type: "abortMerge" });
                const sessionRoot = await fs.realpath(repoRoot);
                expect(
                    control,
                    "both conflict hosts must consult targeted pending state",
                ).toHaveBeenCalledWith(
                    // The session host passes Git's own spelling, which uses `/` on Windows.
                    host === "session"
                        ? expect.toSatisfy((root: string) =>
                              areSameRepositoryRoot(root, sessionRoot),
                          )
                        : repoRoot,
                    expect.any(ChangelistStore),
                    "abort",
                    expect.any(Function),
                );
                expect(
                    native,
                    "targeted cancellation must precede native operation classification",
                ).not.toHaveBeenCalled();
                expect(
                    abort,
                    "targeted cancellation must bypass ordinary abort/reset",
                ).not.toHaveBeenCalled();
                expect(git(["ls-files", "-u"]).trim()).not.toBe("");
            } finally {
                control.mockRestore();
                native.mockRestore();
                abort.mockRestore();
            }
        },
    );

    it("opens the conflict list and aborts the backing merge after confirmation", async () => {
        await createConflictRepo();
        const gitOps = new GitOps(new GitExecutor(repoRoot));
        const onConflictStateChanged = vi.fn(async () => undefined);

        await MergeEditorPanel.open(makeOptions(gitOps, { onConflictStateChanged }));
        const panel = lastPanel();
        await fireMessage(panel, { type: "ready" });

        await fireMessage(panel, { type: "openConflictSession" });
        expect(mocks.executeCommand).toHaveBeenCalledWith("intelligit.openConflictSession");

        mocks.showWarningMessage.mockResolvedValueOnce("Abort Merge");
        await fireMessage(panel, { type: "abortMerge" });

        expect(git(["ls-files", "-u"]).trim()).toBe("");
        expect(onConflictStateChanged).toHaveBeenCalledTimes(1);
        expect(panel.disposed).toBe(true);
        expect(mocks.showInformationMessage).toHaveBeenCalledWith("Merge aborted.");
    });

    it("does not reseed a live workbench for legacy ignore-mode or repeated ready messages", async () => {
        initRepo();
        await writeRepoFile("config.ts", "const value = 1;\n");
        git(["add", "."]);
        git(["commit", "-m", "base"]);
        git(["checkout", "-b", "feature"]);
        await writeRepoFile("config.ts", "const other = 2;\nconst value = 1;\n");
        git(["commit", "-am", "feature adds line"]);
        git(["checkout", "main"]);
        await writeRepoFile("config.ts", "const value  =  1;\n");
        git(["commit", "-am", "main reformats"]);
        git(["merge", "feature"], { allowFailure: true });

        const gitOps = new GitOps(new GitExecutor(repoRoot));
        await MergeEditorPanel.open(makeOptions(gitOps, { filePath: "config.ts" }));
        const panel = lastPanel();

        await fireMessage(panel, { type: "ready" });
        const strict = findConflictData(panel);
        expect(strict.diffOptions?.ignoreWhitespace).toBeFalsy();
        expect(strict.segments.some((seg) => seg.type === "conflict")).toBe(true);

        await fireMessage(panel, { type: "setIgnoreMode", mode: "whitespace" });
        expect(findConflictData(panel)).toEqual(strict);
        await writeRepoFile("config.ts", "external\n");
        await fireMessage(panel, { type: "ready" });
        expect(findConflictData(panel)).toEqual(strict);
        await fireMessage(panel, { type: "applyResolution", content: "draft\n" });
        expect(await fs.readFile(path.join(repoRoot, "config.ts"), "utf8")).toBe("external\n");
        expect(panel.postedMessages).toContainEqual({
            type: "resolutionError",
            message: expect.stringContaining("changed"),
        });
    });

    it("reports a load error instead of opening an empty editor for non-conflicted files", async () => {
        initRepo();
        await writeRepoFile("clean.ts", "export const ok = true;\n");
        git(["add", "."]);
        git(["commit", "-m", "base"]);

        const gitOps = new GitOps(new GitExecutor(repoRoot));
        await MergeEditorPanel.open(makeOptions(gitOps, { filePath: "clean.ts" }));
        const panel = lastPanel();
        await fireMessage(panel, { type: "ready" });

        expect(panel.postedMessages).toContainEqual({
            type: "loadError",
            message: "The file is no longer conflicted. Reopen the conflict list.",
            nativeMerge: true,
        });
    });

    it("rejects traversal paths before creating any panel", async () => {
        await createConflictRepo();
        const gitOps = new GitOps(new GitExecutor(repoRoot));

        await expect(
            MergeEditorPanel.open(makeOptions(gitOps, { filePath: "../outside.ts" })),
        ).rejects.toThrow(/escaping repo root/);
        expect(mocks.capturedPanels).toHaveLength(0);
    });

    it("surfaces invalid apply payloads as errors without writing files", async () => {
        await createConflictRepo();
        const gitOps = new GitOps(new GitExecutor(repoRoot));

        await MergeEditorPanel.open(makeOptions(gitOps));
        const panel = lastPanel();
        await fireMessage(panel, { type: "ready" });
        const before = await fs.readFile(path.join(repoRoot, "shared.ts"), "utf8");

        await fireMessage(panel, { type: "applyResolution", content: 42 });

        expect(mocks.showErrorMessage).toHaveBeenCalledWith(
            "Merge result payload must be a string.",
        );
        const after = await fs.readFile(path.join(repoRoot, "shared.ts"), "utf8");
        expect(after).toBe(before);
        expect(panel.disposed).toBe(false);
        expect(git(["ls-files", "-u"]).trim()).not.toBe("");
    });

    it.each([
        { encoding: "ASCII", unit: "x" },
        { encoding: "CJK", unit: "\u4e2d" },
        { encoding: "astral", unit: "\u{1f642}" },
    ])("rejects oversized $encoding Apply payloads before the write path", async ({ unit }) => {
        await createConflictRepo();
        let saved: unknown;
        const store = {
            get: () => saved,
            update: async (_key: string, value: unknown) => {
                saved = value;
            },
        };
        const onConflictStateChanged = vi.fn(async () => undefined);
        await MergeEditorPanel.open(
            makeOptions(new GitOps(new GitExecutor(repoRoot)), {
                draftStore: store as never,
                onConflictStateChanged,
            }),
        );
        const panel = lastPanel();
        await fireMessage(panel, { type: "ready" });
        const draft = {
            snapshotId: findConflictData(panel).workbench!.snapshotId,
            content: "retained draft\n",
            hunks: [],
        };
        await fireMessage(panel, { type: "saveMergeDraft", draft, revision: 1 });
        const before = await fs.readFile(path.join(repoRoot, "shared.ts"));
        const index = git(["ls-files", "-u"]);
        const head = git(["rev-parse", "HEAD"]);
        const operation = git(["rev-parse", "MERGE_HEAD"]);
        const apply = vi.spyOn(GitOps.prototype, "applyMergeResolution");
        const limit = 2 * 1024 * 1024;
        const content = unit.repeat(Math.floor(limit / Buffer.byteLength(unit, "utf8")) + 1);
        expect(Buffer.byteLength(content, "utf8")).toBeGreaterThan(limit);

        await fireMessage(panel, { type: "applyResolution", content, openNext: true });

        expect(apply.mock.calls.length).toBe(0);
        expect(panel.postedMessages).toContainEqual({
            type: "resolutionError",
            message: "Merge result payload exceeds the supported size.",
        });
        expect(await fs.readFile(path.join(repoRoot, "shared.ts"))).toEqual(before);
        expect(git(["ls-files", "-u"])).toBe(index);
        expect(git(["rev-parse", "HEAD"])).toBe(head);
        expect(git(["rev-parse", "MERGE_HEAD"])).toBe(operation);
        expect(saved).toEqual(draft);
        expect(panel.disposed).toBe(false);
        expect(mocks.capturedPanels).toHaveLength(1);
        expect(onConflictStateChanged).not.toHaveBeenCalled();
    });

    it.each([
        { encoding: "ASCII", unit: "x" },
        { encoding: "CJK", unit: "\u4e2d" },
        { encoding: "astral", unit: "\u{1f642}" },
    ])("stages a $encoding Apply payload at the exact UTF-8 byte limit", async ({ unit }) => {
        await createConflictRepo();
        const head = git(["rev-parse", "HEAD"]);
        const operation = git(["rev-parse", "MERGE_HEAD"]);
        await MergeEditorPanel.open(makeOptions(new GitOps(new GitExecutor(repoRoot))));
        const panel = lastPanel();
        await fireMessage(panel, { type: "ready" });
        const limit = 2 * 1024 * 1024;
        const unitBytes = Buffer.byteLength(unit, "utf8");
        const content = unit.repeat(Math.floor(limit / unitBytes)) + "x".repeat(limit % unitBytes);
        expect(Buffer.byteLength(content, "utf8")).toBe(limit);

        await fireMessage(panel, { type: "applyResolution", content });

        expect(mocks.showErrorMessage).not.toHaveBeenCalled();
        expect((await fs.readFile(path.join(repoRoot, "shared.ts"), "utf8")) === content).toBe(
            true,
        );
        expect(
            execFileSync("git", ["show", ":shared.ts"], {
                cwd: repoRoot,
                maxBuffer: limit * 2,
            }).equals(Buffer.from(content, "utf8")),
        ).toBe(true);
        expect(git(["ls-files", "-u"])).toBe("");
        expect(git(["rev-parse", "HEAD"])).toBe(head);
        expect(git(["rev-parse", "MERGE_HEAD"])).toBe(operation);
        expect(panel.disposed).toBe(true);
    });

    it("reveals the existing panel without reseeding its unsubmitted result", async () => {
        await createConflictRepo();
        const gitOps = new GitOps(new GitExecutor(repoRoot));

        await MergeEditorPanel.open(makeOptions(gitOps));
        const panel = lastPanel();
        await fireMessage(panel, { type: "ready" });

        await MergeEditorPanel.open(makeOptions(gitOps));
        expect(mocks.capturedPanels).toHaveLength(1);
        expect(panel.revealCalls).toBe(1);
        // Reopening must keep the current immutable session and its editing history.
        const dataMessages = panel.postedMessages.filter(
            (msg) => (msg as { type?: unknown }).type === "setConflictData",
        );
        expect(dataMessages.length).toBe(1);
    });
});
