/**
 * "new" / "still" / "fixed" / "unknown" and "also red on" the default branch (PLAN.md §9, K35).
 * Pure functions shared by the host and the Checks tab, which tags rows from the parent and
 * default-tip snapshots the host sends.
 *
 * A check is matched across commits by its logical identity when both sides carry one; an
 * execution id (job or check-run id) names one execution and never matches across commits.
 * An identity must be carried by exactly one parent item and exactly one check of the current
 * commit. When either side has none, the name must match exactly one parent item and exactly
 * one check of the current commit (Codex R3 #11); anything else is no match.
 */

import type { CiState, CommitCheckItem, CommitCheckState, CommitCiDetailData } from "../../types";

/** How a check compares with the same check on the parent commit. */
export type CiHistoryTag = "new" | "still" | "fixed" | "unknown";

/** One check of the current commit as the join sees it: a job by its check name, or a flat check. */
export interface CiHistoryCheck {
    logicalId?: string;
    name: string;
    state: CiState | CommitCheckState;
}

/** A snapshot the host read for the comparison; `items` is `null` when it could not be read. */
interface CiHistorySnapshot {
    hash: string;
    items: CommitCheckItem[] | null;
}

/** The host's answer: the first parent's snapshot and the default branch tip's. */
export interface CiHistory {
    /** `null` for a root commit. */
    parent: CiHistorySnapshot | null;
    /** `null` when `origin/HEAD` or its tip is missing (shown as "default branch unknown"). */
    defaultBranch: { name: string; tipHash: string; items: CommitCheckItem[] | null } | null;
}

const RED_STATES: ReadonlySet<string> = new Set(["failure", "timed_out", "action_required"]);

function isRed(state: string): boolean {
    return RED_STATES.has(state);
}

/**
 * The parent item that is the same check as `check`, or `undefined` when there is none or
 * more than one. `current` is every check of the current commit, `check` included.
 */
export function join(
    check: CiHistoryCheck,
    current: readonly CiHistoryCheck[],
    parent: readonly CommitCheckItem[],
): CommitCheckItem | undefined {
    if (check.logicalId !== undefined) {
        const byId = parent.filter((item) => item.logicalId === check.logicalId);
        if (byId.length > 0) {
            const sameIdNow = current.filter((other) => other.logicalId === check.logicalId);
            return byId.length === 1 && sameIdNow.length === 1 ? byId[0] : undefined;
        }
    }
    // The name fallback's scope is the whole commit: every same-named parent item counts, an
    // identified one of another workflow included. Only then is the one left a match, and
    // another logical id on both sides is another check, even under the same name.
    const byName = parent.filter((item) => item.name === check.name);
    const sameNameNow = current.filter((other) => other.name === check.name).length;
    const [only] = byName;
    return byName.length === 1 &&
        sameNameNow === 1 &&
        (only.logicalId === undefined || check.logicalId === undefined)
        ? only
        : undefined;
}

/**
 * Tags a failed or passed check against the parent; `null` = nothing to say (still running,
 * the parent's run not finished, green on both, or a green check without a match).
 */
export function compare(
    check: CiHistoryCheck,
    current: readonly CiHistoryCheck[],
    parent: readonly CommitCheckItem[],
): CiHistoryTag | null {
    const red = isRed(check.state);
    if (!red && check.state !== "success") return null;
    const match = join(check, current, parent);
    if (!match) return red ? "unknown" : null;
    if (red && isRed(match.state)) return "still";
    if (red && match.state === "success") return "new";
    if (!red && isRed(match.state)) return "fixed";
    return null;
}

/** Whether a failed check is also red on the default branch's tip. */
export function alsoRed(
    check: CiHistoryCheck,
    current: readonly CiHistoryCheck[],
    tip: readonly CommitCheckItem[],
): boolean {
    if (!isRed(check.state)) return false;
    const match = join(check, current, tip);
    return match !== undefined && isRed(match.state);
}

/**
 * Every check of a commit's CI detail in the shape the join takes. A job is listed by its
 * check name, the name its check run carries in the parent's snapshot.
 */
export function historyChecksOf(
    detail: Pick<CommitCiDetailData, "runs" | "otherChecks">,
): CiHistoryCheck[] {
    return [
        ...detail.runs.flatMap((run) =>
            run.jobs.map(({ logicalId, checkName, state }) => ({
                logicalId,
                name: checkName,
                state,
            })),
        ),
        ...detail.otherChecks.map(({ logicalId, name, state }) =>
            logicalId === undefined ? { name, state } : { logicalId, name, state },
        ),
    ];
}
