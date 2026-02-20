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

export function getVsCodeApi<Outbound = unknown, State = unknown>(): VsCodeApi<Outbound, State> {
    if (!api) {
        api = acquireVsCodeApi<unknown, unknown>();
    }
    return api as VsCodeApi<Outbound, State>;
}

