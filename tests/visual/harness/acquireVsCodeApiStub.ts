/** The observable state of one installed browser-side VS Code API stub. */
export interface RecordedVsCodeApi {
    readonly postedMessages: readonly unknown[];
    readonly state: unknown;
}

interface VsCodeApi {
    readonly postMessage: (message: unknown) => void;
    readonly getState: () => unknown;
    readonly setState: (state: unknown) => void;
}

/**
 * Installs a deterministic stand-in for `acquireVsCodeApi` on a browser-like global target.
 *
 * The target is deliberately generic so Playwright can pass its page-global object without this
 * Node-tested module importing browser-only APIs or serializing its source into the page.
 */
export function installAcquireVsCodeApiStub(target: Record<string, unknown>): {
    readonly recorder: () => RecordedVsCodeApi;
} {
    if (Object.prototype.hasOwnProperty.call(target, "acquireVsCodeApi")) {
        throw new Error("acquireVsCodeApi stub is already installed on this target.");
    }

    const postedMessages: unknown[] = [];
    let state: unknown;
    let acquired = false;

    const acquireVsCodeApi = (): VsCodeApi => {
        if (acquired) {
            throw new Error("acquireVsCodeApi may only be acquired once per webview.");
        }
        acquired = true;

        return {
            postMessage: (message: unknown): void => {
                postedMessages.push(message);
            },
            getState: (): unknown => state,
            setState: (nextState: unknown): void => {
                state = nextState;
            },
        };
    };

    target.acquireVsCodeApi = acquireVsCodeApi;

    return {
        recorder: (): RecordedVsCodeApi => ({
            postedMessages: [...postedMessages],
            state,
        }),
    };
}
