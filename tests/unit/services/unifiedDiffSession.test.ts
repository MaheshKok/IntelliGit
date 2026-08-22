import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderLoadResult, UnifiedDiffRequest } from "../../../src/diff/unifiedDiffTypes";

interface CapturedPanel {
    postedMessages: unknown[];
    messageHandler: ((message: unknown) => Promise<void>) | undefined;
    dispose(): void;
}

const mocks = vi.hoisted(() => ({ panels: [] as CapturedPanel[] }));

vi.mock("vscode", () => ({
    ViewColumn: { Active: -1 },
    l10n: { t: (message: string) => message },
    Uri: {
        joinPath: (base: { fsPath: string }, ...parts: string[]) => ({
            fsPath: [base.fsPath, ...parts].join("/"),
        }),
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

import { setDiffViewerExtensionUri } from "../../../src/diff/diffViewerOpener";
import { openUnifiedDiff } from "../../../src/services/diffService";

const extensionUri = { fsPath: "/extension" } as Parameters<typeof setDiffViewerExtensionUri>[0];

function request(leftLoad: () => Promise<ProviderLoadResult>): UnifiedDiffRequest {
    const provider = (label: string, load: () => Promise<ProviderLoadResult>) => ({
        kind: "provider" as const,
        label,
        identity: label,
        load,
    });
    return {
        repoRoot: "/repo",
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
});

describe("unified diff session snapshots", () => {
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
