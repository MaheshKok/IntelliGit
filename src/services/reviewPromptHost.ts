import type {
    ReviewPromptDecision,
    ReviewPromptTarget,
} from "../webviews/protocol/commitGraphTypes";

/** A review card answer as it crosses the webview boundary, already validated by the host. */
export interface ReviewPromptResult {
    /** Terminal decisions silence the prompt forever; `later` leaves the snooze in place. */
    decision: ReviewPromptDecision;
    /** External page the answer asked for, if any. */
    open?: ReviewPromptTarget;
}

/**
 * A surface that can render the review card in place of the notification.
 *
 * Implemented by graph webview providers. Registration is deliberately not a
 * `vscode.Disposable` so this module stays importable from tests without the editor API.
 */
export interface ReviewPromptHost {
    /** True only while this surface is on screen and could actually be read. */
    canShowReviewPrompt(): boolean;
    /**
     * Renders the card and resolves with the user's answer.
     *
     * Resolves `undefined` when the surface disappeared before answering, which tells the
     * caller to fall back to the notification rather than spend the ask on nobody.
     */
    showReviewPrompt(): Promise<ReviewPromptResult | undefined>;
}

/**
 * Live hosts in registration order.
 *
 * A `Set` rather than a single slot because the extension runs more than one graph
 * provider (main view and sidebar) and either one may be the visible surface.
 */
const hosts = new Set<ReviewPromptHost>();

/** Registers a surface for as long as its webview lives; call the returned function on dispose. */
export function registerReviewPromptHost(host: ReviewPromptHost): () => void {
    hosts.add(host);
    return () => {
        hosts.delete(host);
    };
}

/** Returns the first visible surface, or `undefined` when the card has nowhere to render. */
export function findVisibleReviewPromptHost(): ReviewPromptHost | undefined {
    for (const host of hosts) {
        if (host.canShowReviewPrompt()) return host;
    }
    return undefined;
}

/** Clears every registration. Test-only seam; production unregisters through disposal. */
export function resetReviewPromptHosts(): void {
    hosts.clear();
}
