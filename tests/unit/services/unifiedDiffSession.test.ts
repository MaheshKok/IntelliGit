// Aliased: the parametrized separator cases below bind `path` as the descriptor under test.
import * as nodePath from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderLoadResult, UnifiedDiffRequest } from "../../../src/diff/unifiedDiffTypes";

/**
 * The fixture repository root, resolved the way the worktree loader resolves it.
 *
 * `/repo` is not an absolute path on Windows, so `path.resolve` in `loadWorktree` rewrites it
 * against the current drive; a document URI hand-written as `file:/repo/...` then fails to match
 * the URI the loader computes, the open buffer is missed, and the session silently renders the
 * file from disk instead of the dirty text these tests assert on.
 */
const REPO_ROOT = nodePath.resolve("/repo");

interface CapturedPanel {
    postedMessages: unknown[];
    messageHandler: ((message: unknown) => Promise<void>) | undefined;
    dispose(): void;
}

const mocks = vi.hoisted(() => ({
    panels: [] as CapturedPanel[],
    subscriptions: [] as Array<{
        repoRoot: string;
        listener: (event: { repoRoot: string; path?: string; source: string }) => void;
        dispose: ReturnType<typeof vi.fn>;
        rebind: ReturnType<typeof vi.fn>;
    }>,
    worktreeText: "working tree\n",
    documents: [] as Array<{ uri: { toString(): string }; getText(): string }>,
    readFile: vi.fn(async () => Buffer.from("working tree\n")),
    refText: "first ref\n",
    applyEdit: vi.fn(),
    writeFile: vi.fn(),
    openEditableDiffEditor: vi.fn(async () => undefined),
    refreshEditableDiffEditor: vi.fn(async () => undefined),
}));

vi.mock("vscode", () => ({
    ViewColumn: { Active: -1 },
    l10n: { t: (message: string) => message },
    Uri: {
        file: (fsPath: string) => ({ fsPath, toString: () => `file:${fsPath}` }),
        joinPath: (base: { fsPath: string }, ...parts: string[]) => ({
            fsPath: [base.fsPath, ...parts].join("/"),
            toString: () => `file:${[base.fsPath, ...parts].join("/")}`,
        }),
    },
    FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
    workspace: {
        fs: {
            stat: vi.fn(async () => ({ type: 1, size: 16 })),
            readFile: mocks.readFile,
            writeFile: mocks.writeFile,
        },
        applyEdit: mocks.applyEdit,
        get textDocuments() {
            return mocks.documents;
        },
    },
    window: {
        createWebviewPanel: () => {
            const disposeListeners: Array<() => void> = [];
            const captured: CapturedPanel = {
                postedMessages: [],
                messageHandler: undefined,
                dispose: () => {
                    for (const listener of disposeListeners) listener();
                },
            };
            const panel = {
                webview: {
                    html: "",
                    cspSource: "vscode-resource:",
                    asWebviewUri: (uri: unknown) => uri,
                    onDidReceiveMessage: (handler: (message: unknown) => Promise<void>) => {
                        captured.messageHandler = handler;
                        return { dispose: vi.fn() };
                    },
                    postMessage: async (message: unknown) => {
                        captured.postedMessages.push(message);
                        return true;
                    },
                },
                title: "",
                reveal: vi.fn(),
                onDidDispose: (listener: () => void) => {
                    disposeListeners.push(listener);
                    return { dispose: vi.fn() };
                },
            };
            mocks.panels.push(captured);
            return panel;
        },
        showErrorMessage: vi.fn(),
    },
}));

vi.mock("../../../src/e2e/webviewCapture", () => ({
    captureWebview: (panel: unknown) => panel,
}));

vi.mock("../../../src/views/webviewHtml", () => ({
    buildWebviewShellHtml: () => "<html />",
}));

vi.mock("../../../src/views/EditableDiffEditorProvider", () => ({
    openEditableDiffEditor: mocks.openEditableDiffEditor,
    refreshEditableDiffEditor: mocks.refreshEditableDiffEditor,
}));

vi.mock("../../../src/services/repositoryChangeEvents", () => ({
    subscribeToRepositoryWorkingTreeChanges: (
        repoRoot: string,
        listener: (event: { repoRoot: string; path?: string; source: string }) => void,
    ) => {
        const subscription = { repoRoot, listener, dispose: vi.fn(), rebind: vi.fn() };
        mocks.subscriptions.push(subscription);
        return subscription;
    },
}));

vi.mock("../../../src/git/executor", () => ({
    GitExecutor: class GitExecutor {
        async runBinary(args: string[]) {
            if (args[0] === "cat-file" && args[1] === "-s") {
                return {
                    stdout: Buffer.from(String(Buffer.byteLength(mocks.refText))),
                    truncated: false,
                };
            }
            if (args[0] === "ls-tree") {
                return {
                    stdout: Buffer.from("100644 blob ref\tsrc/example.ts\0"),
                    truncated: false,
                };
            }
            return { stdout: Buffer.from(mocks.refText), truncated: false };
        }
    },
}));

import { MAX_DIFF_BYTES } from "../../../src/diff/diffBudgets";
import { setDiffViewerExtensionUri } from "../../../src/diff/diffViewerOpener";
import { openEditableDiff } from "../../../src/diff/editableDiffOpener";
import { beginEditableDiffSession, openUnifiedDiff } from "../../../src/services/diffService";
import { assertRepoRelativePath } from "../../../src/utils/fileOps";
import { showDiffFromPanel } from "../../../src/views/panelFileActions";

const extensionUri = { fsPath: "/extension" } as Parameters<typeof setDiffViewerExtensionUri>[0];

function request(leftLoad: () => Promise<ProviderLoadResult>): UnifiedDiffRequest {
    const provider = (label: string, load: () => Promise<ProviderLoadResult>) => ({
        kind: "provider" as const,
        label,
        identity: label,
        load,
    });
    return {
        repoRoot: REPO_ROOT,
        path: "src/example.ts",
        left: provider("left", leftLoad),
        right: provider("right", async () => ({
            status: "loaded",
            bytes: Buffer.from("right\n"),
            mode: 0o100644,
        })),
        languageId: "typescript",
        title: "Example diff",
    };
}

afterEach(() => {
    mocks.panels.at(-1)?.dispose();
    mocks.panels.length = 0;
    mocks.subscriptions.length = 0;
    mocks.documents.length = 0;
    mocks.worktreeText = "working tree\n";
    mocks.refText = "first ref\n";
    mocks.readFile.mockReset();
    mocks.readFile.mockResolvedValue(Buffer.from(mocks.worktreeText));
    mocks.applyEdit.mockReset();
    mocks.writeFile.mockReset();
    mocks.openEditableDiffEditor.mockReset();
    mocks.openEditableDiffEditor.mockResolvedValue(undefined);
    mocks.refreshEditableDiffEditor.mockReset();
    mocks.refreshEditableDiffEditor.mockResolvedValue(undefined);
});

describe("unified diff session snapshots", () => {
    // Both separators must refresh: watcher events always arrive slash-separated, so a
    // descriptor carrying native Windows separators only matches after normalization. The
    // POSIX case is the one that runs in CI, so neither may stand in for the other.
    it.each([
        ["POSIX separators", "src/example.ts"],
        ["Windows separators", "src\\example.ts"],
    ])("refreshes a mutable worktree session whose descriptor uses %s", async (_name, path) => {
        setDiffViewerExtensionUri(extensionUri);
        const providerLoad = vi.fn(async () => ({
            status: "loaded" as const,
            bytes: Buffer.from("frozen provider\n"),
            mode: 0o100644,
        }));
        mocks.documents.push({
            // The descriptor spelling is the variable under test; the file's identity is not.
            // `loadDiffSide` runs every `filePath` through `assertRepoRelativePath`, which ends
            // in `split(path.sep).join("/")` -- so on Windows the loader looks the buffer up as
            // `src/example.ts` while the descriptor still says `src\example.ts`. A fixture
            // registered under the raw spelling is never found, the loader falls back to disk,
            // and the assertion below reads as "the refresh never happened" when the refresh
            // worked correctly. Calling the same function keeps the two in agreement on every
            // platform without predicting what `path.sep` is.
            //
            // This borrows production's normalizer and so cannot notice a change to it. That is
            // acceptable because the lookup is only how this test OBSERVES the refresh; the
            // behaviour it asserts is the separator handling in `shouldRefreshForChange`, which
            // is a different function and stays measured -- see the mutation note on the case.
            uri: { toString: () => `file:${REPO_ROOT}/${assertRepoRelativePath(path)}` },
            getText: () => mocks.worktreeText,
        });

        await openUnifiedDiff(
            {
                ...request(providerLoad),
                path,
                right: { kind: "worktree" },
            },
            vi.fn(async () => undefined),
        );

        expect(mocks.subscriptions).toHaveLength(1);
        expect(providerLoad).toHaveBeenCalledOnce();
        mocks.worktreeText = "dirty document\n";
        mocks.subscriptions[0]?.listener({
            repoRoot: REPO_ROOT,
            // Watcher events are always slash-separated regardless of the descriptor spelling,
            // which is precisely what `shouldRefreshForChange` has to reconcile.
            path: "src/example.ts",
            source: "workspace-file",
        });

        await vi.waitFor(() => {
            expect(mocks.panels.at(-1)?.postedMessages.at(-1)).toMatchObject({
                type: "setDiffData",
                data: {
                    segments: expect.arrayContaining([
                        expect.objectContaining({ right: ["dirty document"] }),
                    ]),
                },
            });
        });
        expect(providerLoad).toHaveBeenCalledOnce();
    });

    it("re-resolves the historical side of an editable session without replacing dirty document text", async () => {
        const fileUri = {
            fsPath: "/repo/src/example.ts",
            toString: () => "file:/repo/src/example.ts",
        };
        const dirtyDocument = { uri: fileUri, getText: () => "unsaved working tree\n" };
        mocks.documents.push(dirtyDocument);

        await openEditableDiff(
            {
                repoRoot: "/repo",
                path: "src/example.ts",
                left: { kind: "ref", ref: "HEAD" },
                right: { kind: "worktree" },
                languageId: "typescript",
                title: "Editable diff",
                fileUri: fileUri as never,
            },
            vi.fn(async () => undefined),
            beginEditableDiffSession,
        );

        mocks.refText = "updated HEAD\n";
        mocks.subscriptions[0]?.listener({ repoRoot: "/repo", source: "git-state" });

        await vi.waitFor(() => {
            expect(mocks.refreshEditableDiffEditor).toHaveBeenCalledWith(
                fileUri,
                expect.objectContaining({ immutableText: "updated HEAD\n" }),
            );
        });
        expect(mocks.applyEdit).not.toHaveBeenCalled();
        expect(mocks.writeFile).not.toHaveBeenCalled();
        const descriptor = mocks.openEditableDiffEditor.mock.calls[0]?.[1] as {
            onSessionDisposed?: () => void;
        };
        descriptor.onSessionDisposed?.();
    });

    it("keeps every editable editor subscribed after another editor opens and one closes", async () => {
        const fileA = { fsPath: "/repo/src/a.ts", toString: () => "file:/repo/src/a.ts" };
        const fileB = { fsPath: "/repo/src/b.ts", toString: () => "file:/repo/src/b.ts" };
        const openEditor = async (fileUri: typeof fileA, path: string) =>
            openEditableDiff(
                {
                    repoRoot: "/repo",
                    path,
                    left: { kind: "ref", ref: "HEAD" },
                    right: { kind: "worktree" },
                    languageId: "typescript",
                    title: "Editable diff",
                    fileUri: fileUri as never,
                },
                vi.fn(async () => undefined),
                beginEditableDiffSession,
            );

        await openEditor(fileA, "src/a.ts");
        await openEditor(fileB, "src/b.ts");

        expect(mocks.subscriptions).toHaveLength(2);
        const [firstSubscription, secondSubscription] = mocks.subscriptions;
        if (!firstSubscription || !secondSubscription)
            throw new Error("Expected two editable subscriptions");
        mocks.refText = "after first commit\n";
        firstSubscription.listener({ repoRoot: "/repo", source: "git-state" });
        secondSubscription.listener({ repoRoot: "/repo", source: "git-state" });

        await vi.waitFor(() => {
            expect(mocks.refreshEditableDiffEditor).toHaveBeenCalledWith(
                fileA,
                expect.objectContaining({ immutableText: "after first commit\n" }),
            );
            expect(mocks.refreshEditableDiffEditor).toHaveBeenCalledWith(
                fileB,
                expect.objectContaining({ immutableText: "after first commit\n" }),
            );
        });

        const firstDescriptor = mocks.openEditableDiffEditor.mock.calls[0]?.[1] as {
            onSessionDisposed?: () => void;
        };
        const secondDescriptor = mocks.openEditableDiffEditor.mock.calls[1]?.[1] as {
            onSessionDisposed?: () => void;
        };
        firstDescriptor.onSessionDisposed?.();
        mocks.refreshEditableDiffEditor.mockClear();
        mocks.refText = "after second commit\n";
        secondSubscription.listener({ repoRoot: "/repo", source: "git-state" });

        await vi.waitFor(() => {
            expect(mocks.refreshEditableDiffEditor).toHaveBeenCalledWith(
                fileB,
                expect.objectContaining({ immutableText: "after second commit\n" }),
            );
        });
        secondDescriptor.onSessionDisposed?.();
    });

    it("leaves the visible editor subscribed when a second open for the same file declines", async () => {
        const fileUri = {
            fsPath: "/repo/src/example.ts",
            toString: () => "file:/repo/src/example.ts",
        };
        const open = (native: () => Promise<undefined>) =>
            openEditableDiff(
                {
                    repoRoot: "/repo",
                    path: "src/example.ts",
                    left: { kind: "ref", ref: "HEAD" },
                    right: { kind: "worktree" },
                    languageId: "typescript",
                    title: "Editable diff",
                    fileUri: fileUri as never,
                },
                native,
                beginEditableDiffSession,
            );

        await open(vi.fn(async () => undefined));
        expect(mocks.openEditableDiffEditor).toHaveBeenCalledOnce();

        // This request loads both sides and only THEN fails the budget. Retiring the live
        // session the moment a sibling merely STARTS would leave a visible editor bound to a
        // dead one: it stops refreshing, and nothing on screen says why.
        mocks.refText = "x".repeat(MAX_DIFF_BYTES + 1);
        const nativeFallback = vi.fn(async () => undefined);
        await open(nativeFallback);

        expect(nativeFallback).toHaveBeenCalledOnce();
        expect(mocks.subscriptions[0]?.dispose).not.toHaveBeenCalled();
        mocks.refText = "after commit\n";
        mocks.subscriptions[0]?.listener({ repoRoot: "/repo", source: "git-state" });

        await vi.waitFor(() => {
            expect(mocks.refreshEditableDiffEditor).toHaveBeenCalledWith(
                fileUri,
                expect.objectContaining({ immutableText: "after commit\n" }),
            );
        });
        const descriptor = mocks.openEditableDiffEditor.mock.calls[0]?.[1] as {
            onSessionDisposed?: () => void;
        };
        descriptor.onSessionDisposed?.();
    });

    it("retires the previous session when the same file opens a second editor", async () => {
        const fileUri = {
            fsPath: "/repo/src/example.ts",
            toString: () => "file:/repo/src/example.ts",
        };
        const open = () =>
            openEditableDiff(
                {
                    repoRoot: "/repo",
                    path: "src/example.ts",
                    left: { kind: "ref", ref: "HEAD" },
                    right: { kind: "worktree" },
                    languageId: "typescript",
                    title: "Editable diff",
                    fileUri: fileUri as never,
                },
                vi.fn(async () => undefined),
                beginEditableDiffSession,
            );

        await open();
        await open();

        expect(mocks.openEditableDiffEditor).toHaveBeenCalledTimes(2);
        expect(mocks.subscriptions).toHaveLength(2);
        // Both sessions target one editor. Left subscribed, they both refresh on the next
        // repository event and the retired one can land last -- overwriting the editor with
        // its stale title, stale immutable side, and an onSessionDisposed for a dead session.
        expect(mocks.subscriptions[0]?.dispose).toHaveBeenCalled();

        mocks.refreshEditableDiffEditor.mockClear();
        mocks.refText = "after commit\n";
        mocks.subscriptions[0]?.listener({ repoRoot: "/repo", source: "git-state" });
        mocks.subscriptions[1]?.listener({ repoRoot: "/repo", source: "git-state" });

        await vi.waitFor(() => {
            expect(mocks.refreshEditableDiffEditor).toHaveBeenCalledOnce();
        });
        expect(mocks.refreshEditableDiffEditor).toHaveBeenCalledWith(
            fileUri,
            expect.objectContaining({ immutableText: "after commit\n" }),
        );
        const descriptor = mocks.openEditableDiffEditor.mock.calls[1]?.[1] as {
            onSessionDisposed?: () => void;
        };
        descriptor.onSessionDisposed?.();
    });

    it("falls back to the native diff when the editor itself fails to open", async () => {
        const fileUri = {
            fsPath: "/repo/src/example.ts",
            toString: () => "file:/repo/src/example.ts",
        };
        const nativeDelegate = vi.fn(async () => undefined);
        mocks.openEditableDiffEditor.mockRejectedValueOnce(new Error("no editor"));

        // A rejected open is one more "the viewer cannot render this", so it must land where
        // every other decline in this funnel lands. Rethrowing would surface an error toast
        // instead of the native diff, and would leave the slot this session already claimed
        // subscribed to repository events with no editor for its refreshes to reach.
        await openEditableDiff(
            {
                repoRoot: "/repo",
                path: "src/example.ts",
                left: { kind: "ref", ref: "HEAD" },
                right: { kind: "worktree" },
                languageId: "typescript",
                title: "Editable diff",
                fileUri: fileUri as never,
            },
            nativeDelegate,
            beginEditableDiffSession,
        );

        expect(nativeDelegate).toHaveBeenCalledOnce();
        expect(mocks.subscriptions[0]?.dispose).toHaveBeenCalled();
    });

    it("keeps the refreshed historical side on screen when a later refresh fails", async () => {
        const fileUri = {
            fsPath: "/repo/src/example.ts",
            toString: () => "file:/repo/src/example.ts",
        };

        await openEditableDiff(
            {
                repoRoot: "/repo",
                path: "src/example.ts",
                left: { kind: "ref", ref: "HEAD" },
                right: { kind: "worktree" },
                languageId: "typescript",
                title: "Editable diff",
                fileUri: fileUri as never,
            },
            vi.fn(async () => undefined),
            beginEditableDiffSession,
        );

        mocks.refText = "after commit\n";
        mocks.subscriptions[0]?.listener({ repoRoot: "/repo", source: "git-state" });
        await vi.waitFor(() => {
            expect(mocks.refreshEditableDiffEditor).toHaveBeenCalledWith(
                fileUri,
                expect.objectContaining({ immutableText: "after commit\n" }),
            );
        });
        mocks.refreshEditableDiffEditor.mockClear();

        // The error report rebuilds from the descriptor this session retained. If the
        // successful refresh above never wrote its text back, the historical pane rewinds to
        // the content it opened with, while the banner claims only that it stopped updating.
        mocks.refText = "x".repeat(MAX_DIFF_BYTES + 1);
        mocks.subscriptions[0]?.listener({ repoRoot: "/repo", source: "git-state" });

        await vi.waitFor(() => {
            expect(mocks.refreshEditableDiffEditor).toHaveBeenCalledWith(
                fileUri,
                expect.objectContaining({
                    loadError: expect.any(String),
                    immutableText: "after commit\n",
                }),
            );
        });
        const descriptor = mocks.openEditableDiffEditor.mock.calls[0]?.[1] as {
            onSessionDisposed?: () => void;
        };
        descriptor.onSessionDisposed?.();
    });

    it("reports a failed editable refresh in the editor instead of leaving it stale", async () => {
        const fileUri = {
            fsPath: "/repo/src/example.ts",
            toString: () => "file:/repo/src/example.ts",
        };

        await openEditableDiff(
            {
                repoRoot: "/repo",
                path: "src/example.ts",
                left: { kind: "ref", ref: "HEAD" },
                right: { kind: "worktree" },
                languageId: "typescript",
                title: "Editable diff",
                fileUri: fileUri as never,
            },
            vi.fn(async () => undefined),
            beginEditableDiffSession,
        );
        expect(mocks.openEditableDiffEditor).toHaveBeenCalledOnce();
        mocks.refreshEditableDiffEditor.mockClear();

        // An editable session never claims the viewer panel, so the panel's own error channel
        // discards this report on its generation guard. Without a path of its own the pane
        // keeps rendering a historical side that has silently stopped tracking the ref.
        mocks.refText = "x".repeat(MAX_DIFF_BYTES + 1);
        mocks.subscriptions[0]?.listener({ repoRoot: "/repo", source: "git-state" });

        await vi.waitFor(() => {
            expect(mocks.refreshEditableDiffEditor).toHaveBeenCalledWith(
                fileUri,
                expect.objectContaining({ loadError: expect.any(String) }),
            );
        });
        const descriptor = mocks.openEditableDiffEditor.mock.calls[0]?.[1] as {
            onSessionDisposed?: () => void;
        };
        descriptor.onSessionDisposed?.();
    });

    it("leaves a live read-only panel session refreshable after opening an editable diff", async () => {
        setDiffViewerExtensionUri(extensionUri);
        mocks.worktreeText = "read-only before\n";
        mocks.documents.push({
            uri: { toString: () => "file:/repo/src/example.ts" },
            getText: () => mocks.worktreeText,
        });
        await openUnifiedDiff(
            {
                ...request(async () => ({
                    status: "loaded" as const,
                    bytes: Buffer.from("frozen provider\n"),
                    mode: 0o100644,
                })),
                right: { kind: "worktree" },
            },
            vi.fn(async () => undefined),
        );
        const panel = mocks.panels.at(-1);
        const readOnlySubscription = mocks.subscriptions[0];
        if (!panel || !readOnlySubscription) throw new Error("Expected a read-only panel session");

        const editableUri = {
            fsPath: "/repo/src/editable.ts",
            toString: () => "file:/repo/src/editable.ts",
        };
        await openEditableDiff(
            {
                repoRoot: "/repo",
                path: "src/editable.ts",
                left: { kind: "ref", ref: "HEAD" },
                right: { kind: "worktree" },
                languageId: "typescript",
                title: "Editable diff",
                fileUri: editableUri as never,
            },
            vi.fn(async () => undefined),
            beginEditableDiffSession,
        );

        expect(mocks.subscriptions).toHaveLength(2);
        mocks.worktreeText = "read-only after\n";
        readOnlySubscription.listener({
            repoRoot: "/repo",
            path: "src/example.ts",
            source: "workspace-file",
        });

        await vi.waitFor(() => {
            expect(panel.postedMessages.at(-1)).toMatchObject({
                type: "setDiffData",
                data: {
                    segments: expect.arrayContaining([
                        expect.objectContaining({ right: ["read-only after"] }),
                    ]),
                },
            });
        });
        const descriptor = mocks.openEditableDiffEditor.mock.calls.at(-1)?.[1] as {
            onSessionDisposed?: () => void;
        };
        descriptor.onSessionDisposed?.();
    });

    it("does not subscribe fully frozen provider sessions", async () => {
        setDiffViewerExtensionUri(extensionUri);

        await openUnifiedDiff(
            request(async () => ({
                status: "loaded" as const,
                bytes: Buffer.from("left\n"),
                mode: 0o100644,
            })),
            vi.fn(async () => undefined),
        );

        expect(mocks.subscriptions).toHaveLength(0);
    });

    it("does not subscribe a diff between two object-ID refs", async () => {
        setDiffViewerExtensionUri(extensionUri);

        await openUnifiedDiff(
            {
                ...request(async () => ({
                    status: "loaded" as const,
                    bytes: Buffer.from("unused provider\n"),
                    mode: 0o100644,
                })),
                left: { kind: "ref", ref: "a".repeat(40) },
                right: { kind: "ref", ref: "b".repeat(40) },
            },
            vi.fn(async () => undefined),
        );

        expect(mocks.subscriptions).toHaveLength(0);
    });

    it("atomically rebinds the mutable listener when a newer descriptor replaces the panel session", async () => {
        setDiffViewerExtensionUri(extensionUri);
        const mutableRequest = {
            ...request(async () => ({
                status: "loaded" as const,
                bytes: Buffer.from("frozen provider\n"),
                mode: 0o100644,
            })),
            right: { kind: "worktree" as const },
        };

        await openUnifiedDiff(
            mutableRequest,
            vi.fn(async () => undefined),
        );
        const subscription = mocks.subscriptions[0];
        if (!subscription) throw new Error("Expected a mutable session subscription");

        await openUnifiedDiff(
            { ...mutableRequest, repoRoot: "/other-repository" },
            vi.fn(async () => undefined),
        );

        expect(mocks.subscriptions).toHaveLength(1);
        expect(subscription.rebind).toHaveBeenCalledWith("/other-repository", expect.any(Function));
    });

    it.each([
        ["HEAD move", "HEAD", "git-state", "second HEAD\n"],
        ["branch move", "feature", "git-refs", "second branch\n"],
    ])("refreshes a symbolic ref after a %s", async (_name, ref, source, refreshedText) => {
        setDiffViewerExtensionUri(extensionUri);
        const providerLoad = vi.fn(async () => ({
            status: "loaded" as const,
            bytes: Buffer.from("frozen provider\n"),
            mode: 0o100644,
        }));

        await openUnifiedDiff(
            {
                ...request(providerLoad),
                left: { kind: "ref", ref },
                right: {
                    kind: "provider",
                    label: "frozen provider",
                    identity: "frozen-provider",
                    load: providerLoad,
                },
            },
            vi.fn(async () => undefined),
        );
        expect(mocks.subscriptions).toHaveLength(1);
        mocks.refText = refreshedText;
        mocks.subscriptions[0]?.listener({ repoRoot: "/repo", source });

        await vi.waitFor(() => {
            expect(mocks.panels.at(-1)?.postedMessages.at(-1)).toMatchObject({
                type: "setDiffData",
                data: {
                    segments: expect.arrayContaining([
                        expect.objectContaining({ left: [refreshedText.trim()] }),
                    ]),
                },
            });
        });
        expect(providerLoad).toHaveBeenCalledOnce();
    });

    it("posts a refresh loadError atomically with the last rendered panes", async () => {
        setDiffViewerExtensionUri(extensionUri);
        mocks.readFile.mockResolvedValueOnce(Buffer.from("initial worktree\n"));

        await openUnifiedDiff(
            {
                ...request(async () => ({
                    status: "loaded" as const,
                    bytes: Buffer.from("frozen provider\n"),
                    mode: 0o100644,
                })),
                right: { kind: "worktree" },
            },
            vi.fn(async () => undefined),
        );
        const panel = mocks.panels.at(-1);
        if (!panel) throw new Error("Expected a panel");
        mocks.readFile.mockRejectedValueOnce(new Error("permission denied"));
        mocks.subscriptions[0]?.listener({
            repoRoot: "/repo",
            path: "src/example.ts",
            source: "workspace-file",
        });

        await vi.waitFor(() => {
            expect(panel.postedMessages.at(-1)).toEqual({
                type: "setDiffData",
                data: expect.objectContaining({
                    loadError: "permission denied",
                    segments: expect.arrayContaining([
                        expect.objectContaining({ right: ["initial worktree"] }),
                    ]),
                }),
            });
        });
        expect(panel.postedMessages).toContainEqual(
            expect.objectContaining({
                type: "setDiffData",
                data: expect.objectContaining({
                    segments: expect.arrayContaining([
                        expect.objectContaining({ right: ["initial worktree"] }),
                    ]),
                }),
            }),
        );
    });

    it("does not load providers again when the panel toggles ignore mode", async () => {
        setDiffViewerExtensionUri(extensionUri);
        const providerLoad = vi.fn(async () => ({
            status: "loaded" as const,
            bytes: Buffer.from("  same  \n"),
            mode: 0o100644,
        }));
        const nativeDelegate = vi.fn(async () => undefined);

        await openUnifiedDiff(request(providerLoad), nativeDelegate);
        expect(providerLoad).toHaveBeenCalledOnce();
        const panel = mocks.panels.at(-1);
        if (!panel) throw new Error("Expected a panel");

        await panel.messageHandler?.({ type: "setIgnoreMode", mode: "whitespace" });

        expect(providerLoad).toHaveBeenCalledOnce();
        expect(panel.postedMessages.at(-1)).toMatchObject({
            type: "setDiffData",
            data: { ignoreWhitespace: true },
        });
    });

    it("reposts the original text when the provider changes after the initial load", async () => {
        setDiffViewerExtensionUri(extensionUri);
        let loadCount = 0;
        const providerLoad = vi.fn(async () => ({
            status: "loaded" as const,
            bytes: Buffer.from(loadCount++ === 0 ? "  original  \n" : "  mutated  \n"),
            mode: 0o100644,
        }));
        const nativeDelegate = vi.fn(async () => undefined);

        await openUnifiedDiff(request(providerLoad), nativeDelegate);
        const panel = mocks.panels.at(-1);
        if (!panel) throw new Error("Expected a panel");

        await panel.messageHandler?.({ type: "setIgnoreMode", mode: "whitespace" });

        expect(panel.postedMessages.at(-1)).toMatchObject({
            type: "setDiffData",
            data: {
                ignoreWhitespace: true,
                segments: expect.arrayContaining([
                    expect.objectContaining({ left: ["  original  "] }),
                ]),
            },
        });
        expect(panel.postedMessages.at(-1)).not.toMatchObject({
            data: {
                segments: expect.arrayContaining([
                    expect.objectContaining({ left: ["  mutated  "] }),
                ]),
            },
        });
    });
});

describe("file-row click reaches the document-owned diff with the correct payload", () => {
    // The opener is real here, so it still loads and budgets the HEAD and working-tree sides before
    // handing the document-owned view its immutable snapshot. Only the VS Code custom-editor handoff
    // is mocked: this suite does not activate an extension to register that provider.
    it("binds the changed-file URI and HEAD snapshot to the editable diff when clicked", async () => {
        setDiffViewerExtensionUri(extensionUri);
        mocks.refText = "head content\n";
        mocks.readFile.mockResolvedValueOnce(Buffer.from("working tree content\n"));
        const deps = {
            getWorkspaceRoot: () => ({
                fsPath: "/repo",
                toString: () => "file:/repo",
            }),
        } as unknown as Parameters<typeof showDiffFromPanel>[0];

        await showDiffFromPanel(deps, "src/example.ts");

        expect(mocks.panels).toHaveLength(0);
        expect(mocks.openEditableDiffEditor).toHaveBeenCalledWith(
            expect.objectContaining({ fsPath: "/repo/src/example.ts" }),
            expect.objectContaining({
                editablePane: "right",
                immutableText: "head content\n",
                leftLabel: "HEAD",
                rightLabel: "Working tree",
            }),
        );
    });
});
