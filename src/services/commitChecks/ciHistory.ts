/**
 * Reads the snapshots a commit's checks are compared with (PLAN.md §9, K22): the first
 * parent's and the default branch tip's. The join and the tags live in
 * `src/shared/ci/history.ts`, because the Checks tab applies them to the rows it shows.
 */

import type { CiHistory } from "../../shared/ci/history";
import type {
    CiAttemptHistory,
    CiCoverage,
    CiJob,
    CommitCheckItem,
    CommitChecksSnapshot,
} from "../../types";
import type { DefaultBranch } from "./defaultBranch";

/** Where the history reads from: the coordinator's cache-first snapshots and `origin/HEAD`. */
export interface CiHistoryDeps {
    getChecks(hash: string): Promise<CommitChecksSnapshot>;
    readDefaultBranch(): Promise<DefaultBranch | null>;
}

interface ReadItems {
    items: CommitCheckItem[] | null;
    partial?: true;
}

async function itemsOf(deps: CiHistoryDeps, hash: string): Promise<ReadItems> {
    try {
        const snapshot = await deps.getChecks(hash);
        // An unread snapshot is not "no checks": an empty list would tag every failure "unknown".
        if (snapshot.state === "unavailable") return { items: null };
        return snapshot.partial
            ? { items: snapshot.items, partial: true }
            : { items: snapshot.items };
    } catch {
        return { items: null };
    }
}

/** One execution of a job as a provider lists it with its re-runs (§9, Phase 12). */
export type CiAttemptJob = Pick<
    CiJob,
    "id" | "logicalId" | "name" | "state" | "attempt" | "startedAt" | "completedAt"
> & {
    /** GitLab: retried jobs carry no attempt number, only their creation time. */
    createdAt?: string;
};

/** Every listed execution of one run or pipeline, and how much of the list was read. */
export interface CiAttemptRun {
    runId: string;
    coverage: CiCoverage;
    jobs: readonly CiAttemptJob[];
}

const byTime = (a: string | undefined, b: string | undefined): number =>
    // A missing time sorts last, so it never reorders the attempts that have one.
    a === b ? 0 : a === undefined ? 1 : b === undefined ? -1 : Date.parse(a) - Date.parse(b);

const byJobId = (a: CiAttemptJob, b: CiAttemptJob): number =>
    Number(a.id) - Number(b.id) || a.id.localeCompare(b.id);

/**
 * One attempt history per `(runId, logicalId)`, so same-named jobs of two workflows or two
 * runs never share one. GitHub (`runAttempt`) orders by `run_attempt`, then `started_at`,
 * then job id; GitLab (`createdAt`) by `created_at`, then job id, numbering attempts 1..n.
 * Executions are de-duplicated by job id.
 */
export function attemptHistories(
    runs: readonly CiAttemptRun[],
    order: "runAttempt" | "createdAt",
): CiAttemptHistory[] {
    const seen = new Set<string>();
    const groups = new Map<string, { run: CiAttemptRun; jobs: CiAttemptJob[] }>();
    for (const run of runs) {
        for (const job of run.jobs) {
            if (seen.has(job.id)) continue;
            seen.add(job.id);
            const key = `${run.runId}\0${job.logicalId}`;
            const group = groups.get(key) ?? { run, jobs: [] };
            group.jobs.push(job);
            groups.set(key, group);
        }
    }
    return [...groups.values()].map(({ run, jobs }) => {
        const sorted =
            order === "runAttempt"
                ? jobs.sort(
                      (a, b) =>
                          (a.attempt ?? 1) - (b.attempt ?? 1) ||
                          byTime(a.startedAt, b.startedAt) ||
                          byJobId(a, b),
                  )
                : jobs.sort((a, b) => byTime(a.createdAt, b.createdAt) || byJobId(a, b));
        return {
            runId: run.runId,
            logicalId: sorted[0].logicalId,
            attempts: sorted.map((job, index) => ({
                attempt: order === "runAttempt" ? (job.attempt ?? 1) : index + 1,
                executionId: job.id,
                state: job.state,
                ...(job.startedAt !== undefined && { startedAt: job.startedAt }),
                ...(job.completedAt !== undefined && { completedAt: job.completedAt }),
            })),
            coverage: run.coverage,
        };
    });
}

/**
 * Reads the first parent's snapshot (a merge commit compares with its first parent) and the
 * default branch, whose name and tip are read for this request and never cached.
 */
export async function readCiHistory(
    deps: CiHistoryDeps,
    parents: readonly string[],
): Promise<CiHistory> {
    const parentHash = parents[0];
    const [parent, defaultBranch] = await Promise.all([
        parentHash === undefined
            ? null
            : itemsOf(deps, parentHash).then((read) => ({ hash: parentHash, ...read })),
        deps
            .readDefaultBranch()
            .then(async (branch) =>
                branch ? { ...branch, ...(await itemsOf(deps, branch.tipHash)) } : null,
            ),
    ]);
    return { parent, defaultBranch };
}
