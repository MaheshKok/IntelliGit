// Tiny mutable singleton recording whether the development-only E2E control channel is
// active, and the process-wide webview registry it uses. This exists purely to break an
// import cycle: `src/views/webviewHtml.ts` needs to know whether to inject
// `window.intelligitE2E` and, when so, register the webview it just built HTML for -- but it
// cannot import `controlChannel.ts` directly, because `controlChannel.ts` is wired up from
// `extension.ts`, which itself (transitively) drives the view providers that call
// `webviewHtml.ts`. Routing both reads through this leaf module avoids the cycle.

import type { E2eWebviewRegistry } from "./webviewBridge";

let active = false;
let registry: E2eWebviewRegistry | undefined;

/** Records whether the E2E control channel is active. Called once, from `activateE2eControlChannel`. */
export function setE2eControlChannelActive(value: boolean): void {
    active = value;
}

/** Returns whether the E2E control channel is active for this extension host process. */
export function isE2eControlChannelActive(): boolean {
    return active;
}

/**
 * Stores the process-wide webview registry. Set once, from `activateE2eControlChannel`,
 * regardless of whether the gate passed -- registration against it is a separate decision,
 * gated by `isE2eControlChannelActive()` at the call site.
 */
export function setE2eWebviewRegistry(value: E2eWebviewRegistry): void {
    registry = value;
}

/** Returns the process-wide webview registry, or `undefined` before activation has run. */
export function getE2eWebviewRegistry(): E2eWebviewRegistry | undefined {
    return registry;
}
