import { installE2eStateBridge } from "./e2eStateBridge";
import type { VsCodeApi } from "./vscodeApiTypes";

// Re-exported so the many existing `import type { VsCodeApi } from ".../shared/vscodeApi"`
// call sites keep working; the declaration itself lives in the leaf module to keep this
// file and `e2eStateBridge.ts` acyclic. See `vscodeApiTypes.ts`.
export type { VsCodeApi };

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
 * persisted-state shapes at their own boundaries. This is also the single
 * point where the development-only E2E control channel's webview-side bridge
 * is installed (see `installE2eStateBridge`) -- it is a no-op unless the
 * extension host injected `window.intelligitE2E`.
 */
export function getVsCodeApi<Outbound = unknown, State = unknown>(): VsCodeApi<Outbound, State> {
    if (!api) {
        api = acquireVsCodeApi<unknown, unknown>();
        installE2eStateBridge(api);
    }
    return api as VsCodeApi<Outbound, State>;
}
