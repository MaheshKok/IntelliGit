import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    panels: [] as Array<{
        messages: unknown[];
        receive: (v: unknown) => Promise<void>;
        close: () => void;
        reveal: ReturnType<typeof vi.fn>;
    }>,
    move: vi.fn().mockResolvedValue(undefined),
    html: vi.fn(() => "html"),
    warning: vi.fn(),
    history: vi.fn(),
    load: vi.fn(),
}));
vi.mock("vscode", () => ({
    ViewColumn: { Active: -1 },
    Uri: { joinPath: (base: unknown) => base },
    l10n: { t: (value: string) => value },
    commands: { executeCommand: mocks.move },
    extensions: { all: [] },
    window: {
        createWebviewPanel: () => {
            const state = {
                messages: [] as unknown[],
                receive: async (_v: unknown) => {},
                close: () => {},
                reveal: vi.fn(),
            };
            mocks.panels.push(state);
            return {
                title: "",
                reveal: state.reveal,
                onDidDispose: (fn: () => void) => {
                    state.close = fn;
                    return { dispose() {} };
                },
                webview: {
                    html: "",
                    onDidReceiveMessage: (fn: typeof state.receive) => {
                        state.receive = fn;
                        return { dispose() {} };
                    },
                    postMessage: async (v: unknown) => {
                        state.messages.push(v);
                        return true;
                    },
                },
            };
        },
        showWarningMessage: mocks.warning,
    },
}));
vi.mock("../../../src/views/webviewHtml", () => ({ buildWebviewShellHtml: mocks.html }));
vi.mock("../../../src/e2e/webviewCapture", () => ({ captureWebview: (p: unknown) => p }));
vi.mock("../../../src/git/executor", () => ({
    GitExecutor: class {
        run = vi.fn().mockResolvedValue("a".repeat(40));
    },
}));
vi.mock("../../../src/git/fileHistory", () => ({
    getFileHistory: mocks.history,
    getFileHistoryParentPath: async (
        _executor: unknown,
        entry: { previousPath?: string; pathAtRevision: string },
    ) => entry.previousPath ?? entry.pathAtRevision,
}));
vi.mock("../../../src/diff/sideLoader", () => ({
    loadDiffSide: mocks.load,
    toViewerSide: (s: unknown) => s,
}));
import { FileHistoryPanel } from "../../../src/views/FileHistoryPanel";

const entry = {
    hash: "a".repeat(40),
    parents: ["b".repeat(40)],
    subject: "rename",
    authorName: "A",
    authorEmail: "a@test",
    authoredAt: "2026-01-01",
    committerName: "A",
    committerEmail: "a@test",
    committedAt: "2026-01-01",
    pathAtRevision: "new.txt",
    previousPath: "old.txt",
    status: "renamed",
};
const options = { extensionUri: {} as never, repoRoot: "/repo", filePath: "new.txt" };
afterEach(() => {
    mocks.panels.forEach((p) => p.close());
    mocks.panels.length = 0;
    vi.clearAllMocks();
});

describe("standalone file history", () => {
    it("waits for the initial document handshake before moving and loads the destination once ready", async () => {
        mocks.history.mockResolvedValue({ entries: [entry], hasMore: false });
        await FileHistoryPanel.open(options);
        const panel = mocks.panels[0];
        expect(mocks.html).toHaveBeenCalledTimes(1);
        expect(
            mocks.move,
            "an initializing webview must not be transferred",
        ).not.toHaveBeenCalled();
        await panel.receive({ type: "historyReady" });
        expect(mocks.move).toHaveBeenCalledTimes(1);
        expect(mocks.history, "load data only for the destination document").not.toHaveBeenCalled();
        await panel.receive({ type: "historyReady" });
        expect(mocks.history).toHaveBeenCalledTimes(1);
        await panel.receive({ type: "historyReady" });
        expect(mocks.move).toHaveBeenCalledTimes(1);
    });

    it("does not move a panel closed before its first handshake", async () => {
        await FileHistoryPanel.open(options);
        mocks.panels[0].close();
        await mocks.panels[0].receive({ type: "historyReady" });
        expect(mocks.move).not.toHaveBeenCalled();
    });

    it("does not load data for a panel closed during transfer", async () => {
        await FileHistoryPanel.open(options);
        let finishMove!: () => void;
        mocks.move.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    finishMove = resolve;
                }),
        );
        const moving = mocks.panels[0].receive({ type: "historyReady" });
        await vi.waitFor(() => expect(finishMove).toBeDefined());
        mocks.panels[0].close();
        finishMove();
        await moving;
        await mocks.panels[0].receive({ type: "historyReady" });
        expect(mocks.history).not.toHaveBeenCalled();
    });

    it("loads the original document after a failed move without waiting for warning dismissal", async () => {
        mocks.history.mockResolvedValue({ entries: [entry], hasMore: false });
        await FileHistoryPanel.open(options);
        mocks.move.mockRejectedValueOnce(new Error("move failed"));
        let dismissWarning!: () => void;
        mocks.warning.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    dismissWarning = resolve;
                }),
        );
        const ready = mocks.panels[0].receive({ type: "historyReady" });
        await vi.waitFor(() => expect(mocks.history).toHaveBeenCalledTimes(1));
        dismissWarning();
        await ready;
        expect(mocks.panels[0].messages.at(-1)).toMatchObject({ type: "historyState" });
    });

    it("discards an old query failure after a newer branch has loaded", async () => {
        let rejectOld!: (error: Error) => void;
        mocks.history
            .mockImplementationOnce(
                () =>
                    new Promise((_resolve, reject) => {
                        rejectOld = reject;
                    }),
            )
            .mockResolvedValue({ entries: [entry], hasMore: false });
        await FileHistoryPanel.open(options);
        await mocks.panels[0].receive({ type: "historyReady" });
        const panel = mocks.panels[0];
        const old = panel.receive({ type: "historyReady" });
        await vi.waitFor(() => expect(rejectOld).toBeDefined());
        await panel.receive({ type: "historyRefresh", ref: "other" });
        rejectOld(new Error("stale failure"));
        await old;
        expect(panel.messages.at(-1)).toMatchObject({
            type: "historyState",
            state: { ref: "other" },
        });
        expect(panel.messages).not.toContainEqual({
            type: "historyError",
            message: "stale failure",
        });
    });

    it("never sends a preview that finished after the panel closed", async () => {
        let resolveSide!: (value: unknown) => void;
        mocks.history.mockResolvedValue({ entries: [entry], hasMore: false });
        mocks.load
            .mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        resolveSide = resolve;
                    }),
            )
            .mockResolvedValue({
                status: "loaded",
                bytes: new Uint8Array(),
                text: "text\n",
                lineCount: 1,
            });
        await FileHistoryPanel.open(options);
        await mocks.panels[0].receive({ type: "historyReady" });
        const panel = mocks.panels[0];
        await panel.receive({ type: "historyReady" });
        const pending = panel.receive({
            type: "historySelect",
            hashes: [entry.hash],
            requestId: 8,
        });
        await vi.waitFor(() => expect(resolveSide).toBeDefined());
        panel.close();
        resolveSide({ status: "loaded", bytes: new Uint8Array(), text: "old\n", lineCount: 1 });
        await pending;
        expect(panel.messages.some((message: any) => message.type === "historyDiff")).toBe(false);
    });
    it("opens a new window and reveals the same root/file without duplicating it", async () => {
        await FileHistoryPanel.open(options);
        await mocks.panels[0].receive({ type: "historyReady" });
        expect(mocks.panels).toHaveLength(1);
        expect(mocks.move).toHaveBeenCalledWith("workbench.action.moveEditorToNewWindow");
        await FileHistoryPanel.open(options);
        await mocks.panels[0].receive({ type: "historyReady" });
        expect(mocks.panels).toHaveLength(1);
        expect(mocks.panels[0].reveal).toHaveBeenCalled();
    });

    it("loads each side of a rename from its historical path using the existing loader", async () => {
        mocks.history.mockResolvedValue({ entries: [entry], hasMore: false });
        mocks.load.mockResolvedValue({
            status: "loaded",
            bytes: new Uint8Array(),
            text: "text\n",
            lineCount: 1,
        });
        await FileHistoryPanel.open(options);
        await mocks.panels[0].receive({ type: "historyReady" });
        await mocks.panels[0].receive({ type: "historyReady" });
        await mocks.panels[0].receive({
            type: "historySelect",
            hashes: [entry.hash],
            requestId: 7,
        });
        expect(mocks.load).toHaveBeenCalledWith(
            expect.objectContaining({
                filePath: "old.txt",
                side: { kind: "ref", ref: "b".repeat(40) },
            }),
        );
        expect(mocks.load).toHaveBeenCalledWith(
            expect.objectContaining({
                filePath: "new.txt",
                side: { kind: "ref", ref: entry.hash },
            }),
        );
        expect(mocks.panels[0].messages.at(-1)).toMatchObject({
            type: "historyDiff",
            requestId: 7,
            data: { path: "new.txt" },
        });
    });

    it("does not accept hashes absent from the displayed history", async () => {
        mocks.history.mockResolvedValue({ entries: [entry], hasMore: false });
        await FileHistoryPanel.open(options);
        await mocks.panels[0].receive({ type: "historyReady" });
        await mocks.panels[0].receive({ type: "historyReady" });
        await mocks.panels[0].receive({
            type: "historySelect",
            hashes: ["c".repeat(40)],
            requestId: 1,
        });
        expect(mocks.load).not.toHaveBeenCalled();
    });
});
