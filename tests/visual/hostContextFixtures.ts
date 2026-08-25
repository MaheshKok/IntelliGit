import type { WebviewContextId } from "../../src/e2e/webviewCapture";
import { WEBVIEW_HOST_CONTEXTS } from "./harness/hostContexts";

/** The recorded inbound fixture selected for each resolved production host context. */
export const HOST_CONTEXT_FIXTURES = {
    "commit-graph-card": "clean.json",
    "commit-graph-compact": "clean.json",
    "commit-panel": "dirty.json",
    "commit-info": "clean.json",
    undocked: "mid-rebase.json",
    "merge-editor": "conflicted.json",
    "shelf-conflict-editor": "shelf-conflicted.json",
    "merge-conflict-session": "conflicted.json",
    "diff-viewer": "clean.json",
} as const satisfies Readonly<Record<WebviewContextId, string>>;

/**
 * Iteration order comes from the resolved host-context table rather than from the keys above, so
 * a context registered in production but never given a fixture is a compile error here instead of
 * a context the visual suite silently never mounts.
 */
export const HOST_CONTEXT_IDS: readonly WebviewContextId[] = WEBVIEW_HOST_CONTEXTS.map(
    (context) => context.contextId,
);
