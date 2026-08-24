import { afterEach, describe, expect, it, vi } from "vitest";

/** The shape of a real `fs.FSWatcher` this suite depends on: an emitter that can be closed. */
type FakeFsWatcher = EventEmitter & { close: ReturnType<typeof vi.fn> };

/** The two `TextDocument` members the workspace route reads. */
type FakeDocument = { uri: { fsPath: string }; isDirty: boolean };

const mocks = vi.hoisted(() => ({
    disposables: [] as Array<{ dispose: ReturnType<typeof vi.fn> }>,
    watchers: [] as Array<{
        onDidChange: ReturnType<typeof vi.fn>;
        onDidCreate: ReturnType<typeof vi.fn>;
        onDidDelete: ReturnType<typeof vi.fn>;
        dispose: ReturnType<typeof vi.fn>;
    }>,
    fsWatchers: [] as unknown[],
    documentChangeHandlers: [] as Array<(event: { document: FakeDocument }) => void>,
    documentSaveHandlers: [] as Array<(document: FakeDocument) => void>,
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
            onDidChangeTextDocument: vi.fn(
                (handler: (event: { document: FakeDocument }) => void) => {
                    mocks.documentChangeHandlers.push(handler);
                    return disposable();
                },
            ),
            onDidSaveTextDocument: vi.fn((handler: (document: FakeDocument) => void) => {
                mocks.documentSaveHandlers.push(handler);
                return disposable();
            }),
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

// A real `EventEmitter`, not a stub with an `on` spy. The defect under test is Node's own
// rule that an `error` event with no listener is rethrown as an uncaught exception, so a
// hand-rolled fake would decide the outcome the assertion is supposed to measure.
vi.mock("fs", async () => {
    const { EventEmitter: NodeEventEmitter } = await import("node:events");
    return {
        watch: vi.fn(() => {
            const watcher = Object.assign(new NodeEventEmitter(), { close: vi.fn() });
            mocks.fsWatchers.push(watcher);
            return watcher;
        }),
    };
});
vi.mock("../../../src/git/gitDirectory", () => ({ resolveGitDir: () => "/repo/.git" }));

import { EventEmitter } from "node:events";
import { subscribeToRepositoryWorkingTreeChanges } from "../../../src/services/repositoryChangeEvents";

afterEach(() => {
    mocks.disposables.length = 0;
    mocks.watchers.length = 0;
    mocks.fsWatchers.length = 0;
    mocks.documentChangeHandlers.length = 0;
    mocks.documentSaveHandlers.length = 0;
    vi.clearAllMocks();
});

/** The `fs.watch` handles the root watcher armed, in registration order. */
const fsWatchers = (): FakeFsWatcher[] => mocks.fsWatchers as FakeFsWatcher[];

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

    // One route publishes changes that are not on disk. The diff viewer needs them -- it renders
    // an open document's unsaved text -- while every consumer that reads the filesystem or Git
    // gets an answer that cannot have changed. Marking is what lets the two share one stream; the
    // pair below is asserted in both directions, because a marker set on everything separates
    // nothing.
    it("marks a buffer edit as unsaved and leaves a written file unmarked", () => {
        const listener = vi.fn();
        const subscription = subscribeToRepositoryWorkingTreeChanges("/repo", listener);
        const onDidChangeTextDocument = mocks.documentChangeHandlers[0];
        const onDidSaveTextDocument = mocks.documentSaveHandlers[0];
        if (!onDidChangeTextDocument || !onDidSaveTextDocument)
            throw new Error("Expected both document routes to be registered");

        // `finally`, because the root watcher is module-global and reference-counted: a failure
        // that skipped the release would leave it armed, the next test would reuse it instead of
        // arming its own, and that test would fail for a reason belonging to this one.
        try {
            onDidChangeTextDocument({
                document: { uri: { fsPath: "/repo/src/example.ts" }, isDirty: true },
            });

            expect(
                listener,
                "an edit still only in the buffer published as an ordinary write, so a consumer reading git status cannot tell it apart from one",
            ).toHaveBeenCalledWith({
                repoRoot: "/repo",
                path: "src/example.ts",
                source: "workspace-file",
                unsaved: true,
            });

            listener.mockClear();
            onDidSaveTextDocument({ uri: { fsPath: "/repo/src/example.ts" }, isDirty: false });

            expect(
                listener,
                "the write that lands on disk carried the unsaved marker, which would skip the refresh the save exists to trigger",
            ).toHaveBeenCalledWith({
                repoRoot: "/repo",
                path: "src/example.ts",
                source: "workspace-file",
            });
        } finally {
            subscription.dispose();
        }
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

    // The `try`/`catch` around each `fs.watch` call covers only the synchronous
    // construction. A watch that succeeds and fails later -- the git dir replaced by a
    // checkout, an inotify limit reached, EPERM on Windows -- emits `error` on the
    // returned handle, and an `error` event with no listener is rethrown by Node as an
    // uncaught exception. That does not degrade this one optional watcher: it takes down
    // the extension host, and every other extension in it, with it.
    it("survives a watch that fails after it was armed instead of killing the extension host", () => {
        const subscription = subscribeToRepositoryWorkingTreeChanges("/repo", vi.fn());
        const watchers = fsWatchers();

        expect(
            watchers.length,
            "no fs.watch handle was armed, so this test is not exercising the failure it claims to",
        ).toBeGreaterThan(0);

        for (const [index, watcher] of watchers.entries()) {
            expect(() => {
                watcher.emit("error", new Error("ENOSPC: inotify watch limit reached"));
            }, `fs.watch handle ${index} rethrew its error; an unhandled 'error' event terminates the extension host`).not.toThrow();
            expect(
                watcher.close,
                `fs.watch handle ${index} stayed open after failing, so it can raise again`,
            ).toHaveBeenCalled();
        }

        subscription.dispose();
    });
});
