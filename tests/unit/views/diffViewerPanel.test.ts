import { afterEach, describe, expect, it, vi } from "vitest";

interface CapturedPanel {
    title: string;
    postedMessages: unknown[];
    messageHandler: ((message: unknown) => Promise<void>) | undefined;
    reveal: ReturnType<typeof vi.fn>;
    dispose: () => void;
}

const mocks = vi.hoisted(() => ({ panels: [] as CapturedPanel[] }));

vi.mock("vscode", () => ({
    ViewColumn: { Active: -1 },
    l10n: {
        t: (message: string, args?: Record<string, string>) =>
            args ? message.replace("{file}", args.file ?? "") : message,
    },
    Uri: {
        joinPath: (base: { fsPath: string }, ...parts: string[]) => ({
            fsPath: [base.fsPath, ...parts].join("/"),
        }),
    },
    window: {
        createWebviewPanel: (_viewType: string, title: string) => {
            const disposeListeners: Array<() => void> = [];
            const captured: CapturedPanel = {
                title,
                postedMessages: [],
                messageHandler: undefined,
                reveal: vi.fn(),
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
                get title() {
                    return captured.title;
                },
                set title(value: string) {
                    captured.title = value;
                },
                reveal: captured.reveal,
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

import { DiffViewerPanel, type DiffViewerPanelOptions } from "../../../src/views/DiffViewerPanel";

const extensionUri = { fsPath: "/extension" } as never;

function options(overrides: Partial<DiffViewerPanelOptions> = {}): DiffViewerPanelOptions {
    return {
        extensionUri,
        path: "src/example.ts",
        leftLabel: "HEAD",
        rightLabel: "Working tree",
        languageId: "typescript",
        leftText: "before\n",
        rightText: "after\n",
        ...overrides,
    };
}

function lastPanel(): CapturedPanel {
    const panel = mocks.panels.at(-1);
    if (!panel) throw new Error("Expected a diff viewer panel");
    return panel;
}

function clearPosted(panel: CapturedPanel): void {
    panel.postedMessages.length = 0;
}

afterEach(() => {
    lastPanel().dispose();
    mocks.panels.length = 0;
});

describe("DiffViewerPanel", () => {
    it("reveals and reuses one panel on a second open", async () => {
        await DiffViewerPanel.open(options());
        const panel = lastPanel();

        await DiffViewerPanel.open(options({ path: "src/updated.ts", rightText: "updated\n" }));

        expect(mocks.panels).toHaveLength(1);
        expect(panel.reveal).toHaveBeenCalledOnce();
        expect(panel.title).toBe("Diff: updated.ts");
        expect(panel.postedMessages.at(-1)).toMatchObject({
            type: "setDiffData",
            data: { segments: [{ type: "changed", left: ["before"], right: ["updated"] }] },
        });
    });

    it("uses an explicit title for creation and reveal updates", async () => {
        await DiffViewerPanel.open(options({ title: "Custom diff title" }));
        const panel = lastPanel();

        expect(panel.title).toBe("Custom diff title");

        await DiffViewerPanel.open(
            options({
                path: "src/updated.ts",
                title: "Updated diff title",
                rightText: "updated\n",
            }),
        );

        expect(mocks.panels).toHaveLength(1);
        expect(panel.reveal).toHaveBeenCalledOnce();
        expect(panel.title).toBe("Updated diff title");
    });

    it("replays the latest payload when the webview reports ready", async () => {
        await DiffViewerPanel.open(options());
        const panel = lastPanel();
        clearPosted(panel);

        await panel.messageHandler?.({ type: "ready" });

        expect(panel.postedMessages).toHaveLength(1);
        expect(panel.postedMessages[0]).toMatchObject({
            type: "setDiffData",
            data: { path: "src/example.ts", leftLabel: "HEAD" },
        });
    });

    it("replays the authoritative ignore mode when the webview reports ready", async () => {
        await DiffViewerPanel.open(options({ leftText: "  same  ", rightText: "same" }));
        const panel = lastPanel();

        await panel.messageHandler?.({ type: "setIgnoreMode", mode: "whitespace" });
        clearPosted(panel);

        await panel.messageHandler?.({ type: "ready" });

        expect(panel.postedMessages).toHaveLength(1);
        expect(panel.postedMessages[0]).toMatchObject({
            type: "setDiffData",
            data: { ignoreWhitespace: true },
        });
    });

    it("recomputes ignore mode from the held texts without loading a source", async () => {
        await DiffViewerPanel.open(options({ leftText: "  same  ", rightText: "same" }));
        const panel = lastPanel();
        clearPosted(panel);

        await panel.messageHandler?.({ type: "setIgnoreMode", mode: "whitespace" });

        expect(panel.postedMessages[0]).toMatchObject({
            type: "setDiffData",
            data: { segments: [{ type: "common", left: ["  same  "], right: ["same"] }] },
        });
    });
});
