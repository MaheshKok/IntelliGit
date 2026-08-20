// Development-only counters that make a commit panel stuck on
// `commit-panel-awaiting-hydration` diagnosable from the E2E failure message alone. Gated at
// runtime on `window.intelligitE2E` -- the same flag the webview shell (src/views/webviewHtml.ts)
// injects only when the extension host's three-gate check passed -- so a production webview
// allocates nothing and carries no global. Runtime-gated rather than build-gated for the reason
// `e2eStateBridge.ts` gives: a build-time `define` would ship a different bundle to tests than to
// users.
//
// Why this exists at all: a blank panel has exactly two causes and the artifact cannot separate
// them. Either the host never answered the `ready` handshake, or it answered and the webview
// never applied the answer. Both render byte-identically -- three CI failures across two runs
// produced the same `root=<children:2 chars:147>` and the same clean console. `asks` and
// `hostMessages` split that fork in one number each: asks>0 with hostMessages 0 is a webview
// talking to a host that never replies, and hostMessages>0 without hydration is a reply the
// reducer refused.

/** Name of the diagnostic global, read by `tests/e2e/pageObjects/intelliGitView.ts`. */
const GLOBAL_KEY = "intelligitHydrationDiagnostics";

/**
 * What the E2E reveal-timeout dump reports about a webview's handshake.
 *
 * Deliberately not exported: the only reader is a Playwright page-side callback
 * (`tests/e2e/pageObjects/intelliGitView.ts`), which is serialized into the webview document and
 * so cannot import anything. It restates this shape inline, and `tests/unit/e2e/pageObjects.test.ts`
 * runs that callback against a body built to match, which is what keeps the two in step.
 */
interface HydrationDiagnostics {
    /** How many `ready` messages this document has posted, including the first. */
    asks: number;
    /** How many messages of any type the host has posted back to this document. */
    hostMessages: number;
    /** `type` of the most recent host message, or `null` while none has arrived. */
    lastHostMessageType: string | null;
}

declare global {
    interface Window {
        /** Present only while the E2E control channel is active. See {@link HydrationDiagnostics}. */
        intelligitHydrationDiagnostics?: HydrationDiagnostics;
    }
}

/**
 * Returns the live diagnostics record, or `undefined` when the E2E gate is off.
 *
 * Allocates on first use so the gate-off path touches nothing: a production webview must not
 * grow a global just because a hook called a recorder.
 */
function diagnostics(): HydrationDiagnostics | undefined {
    if (typeof window === "undefined" || window.intelligitE2E !== true) return undefined;
    window[GLOBAL_KEY] ??= { asks: 0, hostMessages: 0, lastHostMessageType: null };
    return window[GLOBAL_KEY];
}

/** Records that this document posted a `ready` message to the host. */
export function recordHydrationAsk(): void {
    const record = diagnostics();
    if (!record) return;
    record.asks += 1;
}

/**
 * Records that the host posted a message to this document.
 *
 * `message` is whatever arrived, unvalidated -- the point is to count messages the reducer may
 * have rejected, so a payload this webview cannot parse still has to be counted.
 */
export function recordHostMessage(message: unknown): void {
    const record = diagnostics();
    if (!record) return;
    record.hostMessages += 1;
    const type =
        typeof message === "object" && message !== null
            ? (message as { type?: unknown }).type
            : undefined;
    record.lastHostMessageType = typeof type === "string" ? type : null;
}
