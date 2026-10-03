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
import {
    MergeEditorPanel,
    type MergeEditorPanelOptions,
} from "../../../src/views/MergeEditorPanel";
import { MergeConflictSessionPanel } from "../../../src/views/MergeConflictSessionPanel";
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
async function createConflictRepo(): Promise<void> {
    initRepo();

    await writeRepoFile("shared.ts", "function shared() {\n    return 1;\n}\n");
    git(["add", "."]);
    git(["commit", "-m", "base"]);

    git(["checkout", "-b", "feature"]);
    await writeRepoFile("shared.ts", "function shared() {\n    return 2;\n}\n");
    git(["commit", "-am", "feature change"]);

    git(["checkout", "main"]);
    await writeRepoFile("shared.ts", "function shared() {\n    return 3;\n}\n");
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
});

describe("MergeEditorPanel end-to-end merge flow", () => {
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
