// Pure mappers shared by both Bitbucket commit-check providers (Cloud and Data Center).
// Both APIs return the same `{ values: [{ key, name, state, url, description }] }` shape
// and the same build-state vocabulary, so the row-to-item conversion, the page type
// guard, and the state table live here once. No network access and no host-specific
// logic belong in this file.

import type { CommitCheckItem, CommitCheckState } from "../../types";
import { compactText, readString } from "./normalize";

/** One entry in a Bitbucket commit build-statuses response (Cloud and Data Center). */
export interface BitbucketStatus {
    key?: unknown;
    name?: unknown;
    state?: unknown;
    url?: unknown;
    description?: unknown;
}

/**
 * One page of a Bitbucket build-statuses response.
 *
 * The two Bitbucket flavors paginate differently: Cloud uses a cursor (`next` is the
 * absolute URL of the following page), while Server / Data Center uses offset paging
 * (`isLastPage` plus `nextPageStart`). Both shapes are declared here so each provider
 * reads only the fields its API emits.
 */
export interface BitbucketStatusPage {
    values: BitbucketStatus[];
    next?: unknown;
    isLastPage?: unknown;
    nextPageStart?: unknown;
}

/**
 * Type guard for one page of a Bitbucket statuses response.
 *
 * @param raw - The decoded JSON body from a statuses request.
 * @returns True when the body is an object with a `values` array.
 */
export function isStatusPage(raw: unknown): raw is BitbucketStatusPage {
    return (
        typeof raw === "object" &&
        raw !== null &&
        Array.isArray((raw as { values?: unknown }).values)
    );
}

/**
 * Converts one Bitbucket build-status entry into a CommitCheckItem.
 *
 * @param status - A raw object from the statuses `values` array.
 * @returns A normalized CommitCheckItem.
 */
export function toStatusItem(status: BitbucketStatus): CommitCheckItem {
    return {
        name: readString(status.name) || readString(status.key) || "Bitbucket status",
        description: compactText(readString(status.description)),
        state: mapBitbucketState(readString(status.state)),
        source: "status",
        url: readString(status.url) || undefined,
    };
}

/**
 * Maps a Bitbucket build/pipeline state string to the shared CommitCheckState.
 *
 * Cloud emits SUCCESSFUL, FAILED, INPROGRESS, PENDING, STOPPED, and the pipeline-only
 * EXPIRED; Data Center emits the first three. The superset is handled here so the two
 * providers cannot drift. Matching is case-insensitive.
 *
 * @param state - The raw Bitbucket state string.
 * @returns The normalized CommitCheckState.
 */
export function mapBitbucketState(state: string): CommitCheckState {
    switch (state.toUpperCase()) {
        case "SUCCESSFUL":
            return "success";
        case "FAILED":
            return "failure";
        case "INPROGRESS":
        case "PENDING":
            return "pending";
        case "STOPPED":
            return "cancelled";
        case "EXPIRED":
            return "timed_out";
        default:
            return "unknown";
    }
}
