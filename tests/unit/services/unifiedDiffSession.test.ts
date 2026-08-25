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
        },
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

import { setDiffViewerExtensionUri } from "../../../src/diff/diffViewerOpener";
import { openUnifiedDiff } from "../../../src/services/diffService";
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

describe("file-row click reaches the diff viewer with the correct payload", () => {
    // showDiffFromPanel is the real, unmocked caller here (only its transitive vscode/executor/
    // repositoryChangeEvents dependencies are mocked, the same ones every other test in this file
    // relies on) -- unlike the routing tests in panelFileActions.test.ts, which mock openUnifiedDiff
    // itself and so only prove the right SideSpec was built. This proves the full path: a file-row
    // click posts a setDiffData payload assembled from the actual HEAD and working-tree content.
    it("posts HEAD and working-tree content to DiffViewerPanel when a changed-file row is clicked", async () => {
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

        const panel = mocks.panels.at(-1);
        if (!panel) throw new Error("Expected showDiffFromPanel to open a diff viewer panel");
        expect(panel.postedMessages.at(-1)).toMatchObject({
            type: "setDiffData",
            data: {
                segments: expect.arrayContaining([
                    expect.objectContaining({
                        left: ["head content"],
                        right: ["working tree content"],
                    }),
                ]),
            },
        });
    });
});
