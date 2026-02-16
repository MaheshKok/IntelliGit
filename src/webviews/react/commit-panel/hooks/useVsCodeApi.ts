// Singleton accessor for the VS Code webview API.
// Ensures acquireVsCodeApi() is called exactly once across the app.

import type { OutboundMessage } from "../types";

interface VsCodeApi {
    postMessage(msg: OutboundMessage): void;
    getState(): Record<string, unknown> | undefined;
    setState(state: Record<string, unknown>): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

let api: VsCodeApi | null = null;

export function getVsCodeApi(): VsCodeApi {
    if (!api) {
        api = acquireVsCodeApi();
    }
    return api;
}
