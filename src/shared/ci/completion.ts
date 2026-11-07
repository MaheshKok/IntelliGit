// Completion, coverage and settlement rules for commit checks. Completion ("has every
// piece of work finished?") is separate from the outcome: a failed job next to a running
// one is a failure that is not finished. Coverage ("did we read every item?") is
// separate from both. Caches, polling and the HEAD toast key on these rules.

import type { CommitChecksSnapshot, CommitCiDetailData } from "../../types";

/** Whether a detail's work is finished, still running, or cannot be known. */
export type CiSettlement = "settled" | "pending" | "unknown";

/**
 * Reports whether every check of a snapshot has finished.
 *
 * @param snapshot - Aggregated snapshot for one commit.
 * @returns False for `pending`, `none` and `unavailable`, and for any snapshot that still
 *   has a pending item (a `failure` with a running job included).
 */
export function isCompleteSnapshot(snapshot: CommitChecksSnapshot): boolean {
    const { state } = snapshot;
    if (state === "pending" || state === "none" || state === "unavailable") return false;
    return !snapshot.items.some((item) => item.state === "pending");
}

/**
 * Settlement of a detail. A run list or flat list that was not read in full may hide
 * queued or running work, so it makes settlement `unknown` whatever the returned items
 * say. A capped job list does not: the run's own state covers its hidden jobs.
 *
 * @param detail - Provider detail for one commit.
 */
export function settlementOf(detail: CommitCiDetailData): CiSettlement {
    if (detail.runsCoverage !== "full" || detail.otherChecksCoverage !== "full") {
        return "unknown";
    }
    return detail.complete ? "settled" : "pending";
}

/**
 * Reports whether a detail is settled; `unknown` counts as incomplete everywhere.
 *
 * @param detail - Provider detail for one commit.
 */
export function isCompleteDetail(detail: CommitCiDetailData): boolean {
    return settlementOf(detail) === "settled";
}

/**
 * Reports whether every bounded collection of a detail was read in full: the run list,
 * each run's jobs, each attempt history and the flat check list.
 *
 * @param detail - Provider detail for one commit.
 */
export function isFullyCovered(detail: CommitCiDetailData): boolean {
    return (
        detail.runsCoverage === "full" &&
        detail.otherChecksCoverage === "full" &&
        detail.runs.every((run) => run.jobsCoverage === "full") &&
        (detail.attemptHistory ?? []).every((history) => history.coverage === "full")
    );
}
