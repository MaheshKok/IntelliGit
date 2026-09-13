import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    panels: [] as Array<{
        messages: unknown[];
        receive: (v: unknown) => Promise<void>;
        close: () => void;
        reveal: ReturnType<typeof vi.fn>;
    }>,
    move: vi.fn().mockResolvedValue(undefined),
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
        showWarningMessage: vi.fn(),
    },
}));
vi.mock("../../../src/views/webviewHtml", () => ({ buildWebviewShellHtml: () => "html" }));
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
        expect(mocks.panels).toHaveLength(1);
        expect(mocks.move).toHaveBeenCalledWith("workbench.action.moveEditorToNewWindow");
        await FileHistoryPanel.open(options);
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
        await mocks.panels[0].receive({
            type: "historySelect",
            hashes: ["c".repeat(40)],
            requestId: 1,
        });
        expect(mocks.load).not.toHaveBeenCalled();
    });
});
