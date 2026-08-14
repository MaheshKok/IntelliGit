// Checked-in allowlists for the development-only E2E control channel (PLAN.md Phase 1
// step 10). Every Memento key, secret key, and webview-state key the channel is permitted
// to touch is named explicitly here; a key that is not matched by one of these lists is a
// rejection, never a passthrough. This module has no `vscode` or `node` imports so it can be
// bundled unmodified into both the extension host and the webview React bundles -- the
// webview leg enforces the same allowlist as the host leg, from the same source of truth.

/** The two Memento scopes VS Code exposes on an `ExtensionContext`. */
export type MementoScope = "global" | "workspace";

/** One allowlist rule: either an exact key or a bounded pattern (e.g. a per-host secret key). */
export interface AllowlistEntry {
    /** Returns whether `key` is permitted by this rule. */
    match(key: string): boolean;
}

/** Builds an allowlist rule that matches one exact key. */
function exact(key: string): AllowlistEntry {
    return { match: (candidate) => candidate === key };
}

/** Builds an allowlist rule that matches any key satisfying a fixed, checked-in pattern. */
function pattern(regex: RegExp): AllowlistEntry {
    return { match: (candidate) => regex.test(candidate) };
}

/**
 * Memento keys the E2E control channel may read, seed, or reset, grouped by scope.
 *
 * Sourced from real production call sites: workspace-scoped repository selection
 * (`src/activation/common.ts`, `src/activation/repositoryMode.ts`) and global-scoped
 * review-prompt/commit-checks caches (`src/services/reviewPrompt.ts`,
 * `src/services/commitChecks/persistentCache.ts`). Extend this list when a new durable
 * Memento key needs E2E coverage -- never widen a match to a pattern for Memento keys,
 * since they are few and fixed.
 */
export const MEMENTO_ALLOWLIST: Readonly<Record<MementoScope, readonly AllowlistEntry[]>> = {
    workspace: [
        exact("intelligit.selectedRepositoryRoot"),
        exact("intelligit.undockedSelectedRepositoryRoot"),
    ],
    global: [
        exact("intelligit.reviewPrompt.status"),
        exact("intelligit.reviewPrompt.installedAt"),
        exact("intelligit.commitChecks.cache.v1"),
    ],
};

/**
 * Secret keys the E2E control channel may read (presence + digest only), seed, or reset.
 *
 * `CredentialStore` (`src/services/commitChecks/credentialStore.ts`) namespaces one token
 * per host under `intelligit.commitChecks.token:<host>`, where `<host>` is validated
 * elsewhere to be a bare hostname-plus-optional-port. The pattern mirrors that shape
 * rather than enumerating hosts, since the host set is test-defined, not fixed.
 */
export const SECRET_ALLOWLIST: readonly AllowlistEntry[] = [
    pattern(/^intelligit\.commitChecks\.token:[A-Za-z0-9.:-]+$/),
];

/**
 * Top-level keys the E2E control channel may read, seed, or reset within a webview's
 * opaque `getState()`/`setState()` blob.
 *
 * Sourced from every real `setState` call site under `src/webviews/react/`: commit-panel
 * file selection and folder grouping, undocked ignored-files/group-by-dir toggles, the
 * commit-graph panel's resizable-column widths (optionally prefixed per graph instance,
 * see `CommitGraphPanel.ts`'s `stateKey` helper), and the branch column's persisted
 * scroll/expansion state.
 */
export const WEBVIEW_STATE_ALLOWLIST: readonly AllowlistEntry[] = [
    exact("groupByDir"),
    exact("showIgnoredFiles"),
    exact("showIgnoredFilesByRepository"),
    exact("checked"),
    exact("checkedByRepository"),
    exact("branchColumn"),
    pattern(/^(?:[A-Za-z0-9_-]+\.)?(?:branchWidth|infoWidth)$/),
];

/** Returns whether `key` is permitted by any rule in `allowlist`. */
function isAllowedKey(allowlist: readonly AllowlistEntry[], key: string): boolean {
    return allowlist.some((entry) => entry.match(key));
}

/** Returns whether `key` is an allowlisted Memento key for the given scope. */
export function isAllowedMementoKey(scope: MementoScope, key: string): boolean {
    return isAllowedKey(MEMENTO_ALLOWLIST[scope], key);
}

/** Returns whether `key` is an allowlisted SecretStorage key. */
export function isAllowedSecretKey(key: string): boolean {
    return isAllowedKey(SECRET_ALLOWLIST, key);
}

/** Returns whether `key` is an allowlisted top-level webview persisted-state key. */
export function isAllowedWebviewStateKey(key: string): boolean {
    return isAllowedKey(WEBVIEW_STATE_ALLOWLIST, key);
}
