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
    html: string;
    messageHandler: ((msg: unknown) => Promise<void>) | null;
    postedMessages: unknown[];
    disposed: boolean;
    revealCalls: number;
}

const mocks = vi.hoisted(() => {
    interface HoistedPanel {
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
                    dispose: () => {
                        captured.disposed = true;
                        for (const listener of disposeListeners) listener();
                    },
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

import { GitExecutor } from "../../../src/git/executor";
import { GitOps } from "../../../src/git/operations";
import {
    MergeEditorPanel,
    type MergeEditorPanelOptions,
} from "../../../src/views/MergeEditorPanel";
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
    vi.clearAllMocks();
});

afterEach(async () => {
    // Dispose panels so the static registry cannot leak panels across tests.
    for (const panel of mocks.capturedPanels) {
        if (!panel.disposed && panel.messageHandler) {
            await fireMessage(panel, { type: "close" });
        }
    }
    await fs.rm(repoRoot, { recursive: true, force: true });
});

describe("MergeEditorPanel end-to-end merge flow", () => {
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

    it("re-parses with whitespace ignoring when the webview switches ignore mode", async () => {
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
        const relaxed = findConflictData(panel);
        expect(relaxed.diffOptions?.ignoreWhitespace).toBe(true);
        // With whitespace ignored, main's reformat no longer counts as an "ours"
        // edit, so no segment should be a both-sides conflict anymore.
        const trueConflicts = conflictSegments(relaxed).filter(
            (seg) => seg.changeKind === "conflict",
        );
        expect(trueConflicts).toHaveLength(0);
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
            message: "File is not in a conflicted state: clean.ts",
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

    it("reveals and refreshes the existing panel when the same file opens twice", async () => {
        await createConflictRepo();
        const gitOps = new GitOps(new GitExecutor(repoRoot));

        await MergeEditorPanel.open(makeOptions(gitOps));
        const panel = lastPanel();
        await fireMessage(panel, { type: "ready" });

        await MergeEditorPanel.open(makeOptions(gitOps));
        expect(mocks.capturedPanels).toHaveLength(1);
        expect(panel.revealCalls).toBe(1);
        // Reopening posts fresh conflict data without waiting for another "ready".
        const dataMessages = panel.postedMessages.filter(
            (msg) => (msg as { type?: unknown }).type === "setConflictData",
        );
        expect(dataMessages.length).toBeGreaterThanOrEqual(2);
    });
});
