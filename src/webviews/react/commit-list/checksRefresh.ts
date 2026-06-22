// Shared rules for re-fetching GitHub commit-check snapshots in the commit graph.
// A snapshot is worth re-requesting while it is non-terminal: still "pending"
// (CI running) or "none" (a just-pushed commit whose checks have not registered
// yet). Centralized here so the two graph apps and the list poll stay in sync,
// and aligned with the host via `isPendingCheckState`.

import { isPendingCheckState, type CommitChecksSnapshot } from "../../../types";

/**
 * Maximum number of automatic retries for a commit reporting no checks yet.
 *
 * A freshly pushed commit briefly reports `"none"` until GitHub registers its
 * CI runs. Retrying a bounded number of times (at the list poll interval) lets
 * the status appear without a manual refresh, while preventing an endless poll
 * for commits that genuinely have no checks.
 */
export const MAX_NONE_REFRESH_ATTEMPTS = 6;

/**
 * Decides whether a cached commit-check entry should trigger a new fetch.
 *
 * Returns true when nothing is cached or the cached snapshot has not settled
 * (`"pending"` or `"none"`). Returns false while a request is already in flight
 * (`"loading"`) or once the snapshot has reached a terminal state.
 */
export function shouldRequestCommitChecks(
    cached: CommitChecksSnapshot | "loading" | undefined,
): boolean {
    if (cached === undefined) return true;
    if (cached === "loading") return false;
    return isPendingCheckState(cached.state);
}

/**
 * Whether two commit-check snapshots are display-equivalent.
 *
 * Used to drop no-op refreshes: a background re-fetch that returns the same
 * state, summary, error, and item rows should not replace the cached snapshot,
 * so React skips the re-render and the badge does not flicker.
 */
export function commitChecksSnapshotEqual(
    a: CommitChecksSnapshot,
    b: CommitChecksSnapshot,
): boolean {
    if (a.state !== b.state || a.summary !== b.summary || a.error !== b.error) return false;
    if (a.items.length !== b.items.length) return false;
    return a.items.every((item, index) => {
        const other = b.items[index];
        return (
            item.state === other.state &&
            item.name === other.name &&
            item.description === other.description &&
            item.source === other.source &&
            item.url === other.url
        );
    });
}
