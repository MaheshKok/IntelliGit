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

import type {
    CiAttemptHistory,
    CiState,
    CommitCheckItem,
    CommitCheckState,
    CommitCiDetailData,
} from "../../types";

/** How a check compares with the same check on the parent commit. */
export type CiHistoryTag = "new" | "still" | "fixed" | "unknown";

/** One check of the current commit as the join sees it: a job by its check name, or a flat check. */
export interface CiHistoryCheck {
    logicalId?: string;
    name: string;
    state: CiState | CommitCheckState;
}

/**
 * A snapshot the host read for the comparison; `items` is `null` when it could not be read.
 * `partial` is set when only some items were read, so the list cannot prove a name unique.
 */
interface CiHistorySnapshot {
    hash: string;
    items: CommitCheckItem[] | null;
    partial?: true;
}

/**
 * A first-parent ancestor inside the commits the Git Log loaded, read from the cache only:
 * `items` is `null` when its snapshot was not cached, and `attempts` holds the re-runs its
 * cached detail lists. `attemptsUnavailable` is set when the provider's attempt read for the
 * commit failed: its re-runs are unknown, not none, so `attempts` is empty but not complete.
 */
export interface CiHistoryLineCommit extends CiHistorySnapshot {
    attempts: CiAttemptHistory[];
    attemptsUnavailable?: true;
}

/** The host's answer: the first parent's snapshot and the default branch tip's. */
export interface CiHistory {
    /** The loaded first-parent ancestors, newest first, that "flaky n/m" counts. */
    line?: CiHistoryLineCommit[];
    /** `null` for a root commit. */
    parent: CiHistorySnapshot | null;
    /** `null` when `origin/HEAD` or its tip is missing (shown as "default branch unknown"). */
    defaultBranch: {
        name: string;
        tipHash: string;
        items: CommitCheckItem[] | null;
        partial?: true;
    } | null;
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
    const match = matchCheck(check, current, parent);
    return typeof match === "string" ? undefined : match;
}

/**
 * `join`, telling "no such check" (`none`) from "more than one it could be" (`ambiguous`).
 */
export function matchCheck(
    check: CiHistoryCheck,
    current: readonly CiHistoryCheck[],
    parent: readonly CommitCheckItem[],
): CommitCheckItem | "none" | "ambiguous" {
    if (check.logicalId !== undefined) {
        const byId = parent.filter((item) => item.logicalId === check.logicalId);
        if (byId.length > 0) {
            const sameIdNow = current.filter((other) => other.logicalId === check.logicalId);
            return byId.length === 1 && sameIdNow.length === 1 ? byId[0] : "ambiguous";
        }
    }
    // The name fallback's scope is the whole commit: every same-named parent item counts, an
    // identified one of another workflow included. Only then is the one left a match, and
    // another logical id on both sides is another check, even under the same name.
    const byName = parent.filter((item) => item.name === check.name);
    const sameNameNow = current.filter((other) => other.name === check.name).length;
    const [only] = byName;
    if (byName.length === 0) return "none";
    if (byName.length === 1 && only.logicalId !== undefined && check.logicalId !== undefined) {
        return "none";
    }
    return byName.length === 1 && sameNameNow === 1 ? only : "ambiguous";
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
 * One commit of a check's first-parent line for `flaky`: the check's state there (`null` when
 * the commit has no result for it) and the commit's attempt histories, any check's.
 */
export interface CiFlakyCommit {
    state: CiState | CommitCheckState | null;
    attempts: readonly CiAttemptHistory[];
}

/** "flaky n/m": `n` flaky commits out of `m` with a pass or a failure for the check. */
export interface CiFlaky {
    n: number;
    m: number;
    /** `false` when the provider cannot list re-runs: the tag says "(estimated)" (O3). */
    attemptsCounted: boolean;
}

/** A pass or a failure; a running, skipped or cancelled check says nothing about flakiness. */
export function isComplete(state: CiFlakyCommit["state"]): boolean {
    return state === "success" || (state !== null && isRed(state));
}

function failedThenPassed(logicalId: string, attempts: readonly CiAttemptHistory[]): boolean {
    return attempts.some((history) => {
        if (history.logicalId !== logicalId) return false;
        const firstRed = history.attempts.findIndex((attempt) => isRed(attempt.state));
        return (
            firstRed !== -1 &&
            history.attempts.slice(firstRed + 1).some((attempt) => attempt.state === "success")
        );
    });
}

/**
 * Counts the commits of `line` (newest first, first parents only) where the check flaked:
 * an isolated red (the nearest newer and older commits with a result are both green) or an
 * attempt history of the check that failed and then passed. `null` when none did.
 */
export function flaky(
    logicalId: string,
    line: readonly CiFlakyCommit[],
    attemptsCounted: boolean,
): CiFlaky | null {
    const complete = line.filter((commit) => isComplete(commit.state));
    const n = complete.filter((commit, index) => {
        const isolated =
            isRed(commit.state as string) &&
            complete[index - 1]?.state === "success" &&
            complete[index + 1]?.state === "success";
        return isolated || failedThenPassed(logicalId, commit.attempts);
    }).length;
    return n === 0 ? null : { n, m: complete.length, attemptsCounted };
}

/**
 * The check's line for `flaky`: the selected commit with its own attempts, then each loaded
 * ancestor's matched state. An ancestor read in part counts only an identity match.
 */
export function flakyLineOf(
    check: CiHistoryCheck,
    current: readonly CiHistoryCheck[],
    attempts: readonly CiAttemptHistory[],
    line: readonly CiHistoryLineCommit[],
): CiFlakyCommit[] {
    return [
        { state: check.state, attempts },
        ...line.map((commit) => {
            const match = commit.items ? join(check, current, commit.items) : undefined;
            const usable = match && (!commit.partial || match.logicalId !== undefined);
            return { state: usable ? match.state : null, attempts: commit.attempts };
        }),
    ];
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
