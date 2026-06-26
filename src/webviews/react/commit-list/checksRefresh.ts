// Shared rules for re-fetching commit-check snapshots in the commit graph.
// A snapshot is worth re-requesting while it is non-terminal: still "pending"
// (CI running) or "none" (a just-pushed commit whose checks have not registered
// yet), or recoverable "unavailable" (a sign-in or a transient 429 that the
// coordinator TTL re-fetches). Centralized here so the two graph apps and the
// list poll stay in sync, and aligned with the host via `isPendingCheckState`.

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
 * Returns true when nothing is cached, the cached snapshot has not settled
 * (`"pending"` or `"none"`), or it is a recoverable `"unavailable"` (a missing
 * token to sign in for, or a transient host error that may clear). Returns false
 * while a request is already in flight (`"loading"`) or once the snapshot has
 * reached a genuinely terminal state. The coordinator TTL throttles the actual
 * fetch, so re-requesting `"unavailable"` every poll costs at most one fetch/TTL.
 */
export function shouldRequestCommitChecks(
    cached: CommitChecksSnapshot | "loading" | undefined,
): boolean {
    if (cached === undefined) return true;
    if (cached === "loading") return false;
    return isPendingCheckState(cached.state) || cached.state === "unavailable";
}
