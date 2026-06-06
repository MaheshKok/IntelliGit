/**
 * Minimal VS Code webview API facade used by React webview modules.
 *
 * Outbound messages are posted to the extension host, while state values are
 * persisted by VS Code for the lifetime of the webview instance.
 */
export interface VsCodeApi<Outbound = unknown, State = unknown> {
    postMessage(msg: Outbound): void;
    getState(): State | undefined;
    setState(state: State): void;
}

declare function acquireVsCodeApi<Outbound = unknown, State = unknown>(): VsCodeApi<
    Outbound,
    State
>;

let api: VsCodeApi<unknown, unknown> | null = null;

/**
 * Returns the cached VS Code API handle for the current webview.
 *
 * VS Code expects `acquireVsCodeApi` to be called once per webview, so this
 * wrapper centralizes acquisition while allowing callers to narrow message and
 * persisted-state shapes at their own boundaries.
 */
export function getVsCodeApi<Outbound = unknown, State = unknown>(): VsCodeApi<Outbound, State> {
    if (!api) {
        api = acquireVsCodeApi<unknown, unknown>();
    }
    return api as VsCodeApi<Outbound, State>;
}
