import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    disposables: [] as Array<{ dispose: ReturnType<typeof vi.fn> }>,
    watchers: [] as Array<{
        onDidChange: ReturnType<typeof vi.fn>;
        onDidCreate: ReturnType<typeof vi.fn>;
        onDidDelete: ReturnType<typeof vi.fn>;
        dispose: ReturnType<typeof vi.fn>;
    }>,
}));

vi.mock("vscode", () => {
    const disposable = () => {
        const value = { dispose: vi.fn() };
        mocks.disposables.push(value);
        return value;
    };
    return {
        EventEmitter: class EventEmitter<T> {
            private readonly listeners = new Set<(value: T) => unknown>();
            readonly event = (listener: (value: T) => unknown) => {
                this.listeners.add(listener);
                return { dispose: () => this.listeners.delete(listener) };
            };
            fire(value: T): void {
                for (const listener of this.listeners) listener(value);
            }
            dispose(): void {
                this.listeners.clear();
            }
        },
        Uri: { file: (fsPath: string) => ({ fsPath }) },
        RelativePattern: class RelativePattern {
            constructor(
                readonly baseUri: { fsPath: string },
                readonly pattern: string,
            ) {}
        },
        workspace: {
            onDidChangeTextDocument: vi.fn(() => disposable()),
            onDidSaveTextDocument: vi.fn(() => disposable()),
            onDidCreateFiles: vi.fn(() => disposable()),
            onDidDeleteFiles: vi.fn(() => disposable()),
            onDidRenameFiles: vi.fn(() => disposable()),
            createFileSystemWatcher: vi.fn(() => {
                const watcher = {
                    onDidChange: vi.fn(() => disposable()),
                    onDidCreate: vi.fn(() => disposable()),
                    onDidDelete: vi.fn(() => disposable()),
                    dispose: vi.fn(),
                };
                mocks.watchers.push(watcher);
                return watcher;
            }),
        },
    };
});

vi.mock("fs", () => ({ watch: vi.fn(() => ({ close: vi.fn() })) }));
vi.mock("../../../src/git/gitDirectory", () => ({ resolveGitDir: () => "/repo/.git" }));

import { subscribeToRepositoryWorkingTreeChanges } from "../../../src/services/repositoryChangeEvents";

afterEach(() => {
    mocks.disposables.length = 0;
    mocks.watchers.length = 0;
    vi.clearAllMocks();
});

describe("repository working-tree changes", () => {
    it("keeps a root watcher armed after an expanded row releases while a diff panel remains subscribed", () => {
        const row = subscribeToRepositoryWorkingTreeChanges("/repo", vi.fn());
        const panel = subscribeToRepositoryWorkingTreeChanges("/repo", vi.fn());
        const watcher = mocks.watchers[0];
        if (!watcher) throw new Error("Expected a root watcher");

        row.dispose();
        expect(watcher.dispose).not.toHaveBeenCalled();

        panel.dispose();
        expect(watcher.dispose).toHaveBeenCalledOnce();
    });

    it("emits the root and repository-relative path from the workspace watcher", () => {
        const listener = vi.fn();
        const subscription = subscribeToRepositoryWorkingTreeChanges("/repo", listener);
        const watcher = mocks.watchers[0];
        if (!watcher) throw new Error("Expected a root watcher");

        const onDidChange = watcher.onDidChange.mock.calls[0]?.[0] as
            | ((uri: { fsPath: string }) => void)
            | undefined;
        onDidChange?.({ fsPath: "/repo/src/example.ts" });

        expect(listener).toHaveBeenCalledWith({
            repoRoot: "/repo",
            path: "src/example.ts",
            source: "workspace-file",
        });
        subscription.dispose();
    });

    it("keeps the old root watcher alive across an active-root switch while a panel is open", () => {
        const activeRootA = subscribeToRepositoryWorkingTreeChanges("/repo-a", vi.fn());
        const panel = subscribeToRepositoryWorkingTreeChanges("/repo-a", vi.fn());
        const watcherA = mocks.watchers[0];
        if (!watcherA) throw new Error("Expected the first root watcher");

        activeRootA.dispose();
        expect(watcherA.dispose).not.toHaveBeenCalled();

        const activeRootB = subscribeToRepositoryWorkingTreeChanges("/repo-b", vi.fn());
        const watcherB = mocks.watchers[1];
        if (!watcherB) throw new Error("Expected the replacement root watcher");
        panel.dispose();
        expect(watcherA.dispose).toHaveBeenCalledOnce();

        activeRootB.dispose();
        expect(watcherB.dispose).toHaveBeenCalledOnce();
    });
});
