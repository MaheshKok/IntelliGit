/**
 * "Find where CI broke" (PLAN.md §13): reads each selected commit's checks through the
 * coordinator (cache first, then the request gate), joins each job across the commits by the §9
 * rule and names, on a first-parent chain only, the commit where it broke.
 *
 * Cancel is checked before a commit's read is queued, inside the gate right before each request
 * (the coordinator's `sendGuard`), and before each progress report.
 */

import type { ProviderCiCapabilities } from "../../shared/ci/capabilities";
import {
    brokeAt,
    flaky,
    matchCheck,
    type CiBisectJob,
    type CiFlakyCommit,
    type CiHistoryCheck,
} from "../../shared/ci/history";
import type {
    CiAttemptHistory,
    CiState,
    CommitCheckItem,
    CommitCheckState,
    CommitChecksSnapshot,
} from "../../types";
import { mapWithConcurrency } from "../../utils/concurrency";
import type { LoadedCommit } from "./changedSinceGreen";

/** Reads at once; the request gate's own cap, so a bisect never fills its queue. */
const BISECT_CONCURRENCY = 4;

/** What the bisect reads through: the coordinator. */
export interface CiBisectSource {
    getChecks(
        hash: string,
        options: { isCurrent: () => boolean; sendGuard: () => boolean },
    ): Promise<CommitChecksSnapshot>;
    capabilities(hash: string): Promise<ProviderCiCapabilities | undefined>;
    attemptHistory(hash: string, sendGuard: () => boolean): Promise<CiAttemptHistory[] | null>;
}

/** The bisect's answer (§4 `ciBisectResult` without the request fields). */
export interface CiBisectResult {
    /** Every commit is on the newest one's first-parent walk. */
    linear: boolean;
    /** The commit of each job's square, oldest to newest, the order of `states`. */
    commits: string[];
    jobs: CiBisectJob[];
    /** Set when selected commits the Git Log no longer has loaded were dropped: the count read. */
    limitedTo?: number;
}

interface CommitRead {
    hash: string;
    /** `null` when the commit's checks could not be read. */
    items: CommitCheckItem[] | null;
    /** Only some of the commit's items were read: it cannot prove a name unique. */
    partial: boolean;
    attempts: readonly CiAttemptHistory[];
}

/**
 * The selected commits along the first-parent walk from the only one no other selected commit
 * names as first parent, newest first; `null` when the walk misses one (not a straight line).
 */
function firstParentChain(commits: readonly LoadedCommit[]): LoadedCommit[] | null {
    const byHash = new Map(commits.map((commit) => [commit.hash, commit]));
    const firstParents = new Set(commits.map((commit) => commit.parents[0]));
    const heads = commits.filter((commit) => !firstParents.has(commit.hash));
    if (heads.length !== 1) return null;
    const walk: LoadedCommit[] = [];
    for (let at: LoadedCommit | undefined = heads[0]; at; at = byHash.get(at.parents[0] ?? "")) {
        if (walk.includes(at)) break;
        walk.push(at);
    }
    return walk.length === commits.length ? walk : null;
}

function toCiState(state: CommitCheckState): CiState {
    switch (state) {
        case "timed_out":
        case "action_required":
            return "failure";
        case "pending":
            return "running";
        case "none":
        case "unavailable":
            return "unknown";
        default:
            return state;
    }
}

/**
 * Every job seen in the commits, once each. Two items of two commits are one job when the §9
 * join, run on each commit's own items, matches them (by logical id, else by a name unique in
 * both); an identified and an unlabelled version of one uniquely named check are one job. A
 * partial read joins too, so a job keeps one row; `jobOf` decides what such a read proves.
 */
function jobsOf(reads: readonly CommitRead[]): CiHistoryCheck[] {
    const nodes = reads.flatMap((read, at) => (read.items ?? []).map((item) => ({ item, at })));
    const start = reads.map((_, at) => nodes.findIndex((node) => node.at === at));
    const root = nodes.map((_, index) => index);
    const find = (index: number): number => {
        while (root[index] !== index) index = root[index] = root[root[index]];
        return index;
    };
    nodes.forEach(({ item, at }, index) => {
        reads.forEach((other, otherAt) => {
            if (otherAt <= at || !other.items) return;
            const found = matchCheck(item, reads[at].items ?? [], other.items);
            if (typeof found === "object") {
                root[find(index)] = find(start[otherAt] + other.items.indexOf(found));
            }
        });
    });
    const groups = new Map<number, CommitCheckItem[]>();
    nodes.forEach(({ item }, index) => {
        const key = find(index);
        groups.set(key, [...(groups.get(key) ?? []), item]);
    });
    return [...groups.values()].map((items): CiHistoryCheck => {
        const named = items.find((item) => item.logicalId !== undefined) ?? items[0];
        return {
            ...(named.logicalId === undefined ? {} : { logicalId: named.logicalId }),
            name: named.name,
            state: "unknown",
        };
    });
}

/**
 * The logical id of the one job of the attempt histories that bears `name`: a GitHub snapshot
 * check carries no logical id, its re-runs are keyed by workflow and job name. `undefined` when
 * no job or more than one has the name.
 */
function attemptLogicalId(name: string, reads: readonly CommitRead[]): string | undefined {
    const ids = new Set(
        reads
            .flatMap((read) => read.attempts.map((history) => history.logicalId))
            .filter((id) => id.startsWith("job\0") && id.slice(id.lastIndexOf("\0") + 1) === name),
    );
    return ids.size === 1 ? [...ids][0] : undefined;
}

function jobOf(
    job: CiHistoryCheck,
    jobs: readonly CiHistoryCheck[],
    reads: readonly CommitRead[],
    linear: boolean,
    attemptsCounted: boolean,
): CiBisectJob {
    const line = reads.map((read): CiFlakyCommit & { hash: string } => {
        const found = read.items ? matchCheck(job, jobs, read.items) : "ambiguous";
        // A list read in part proves only an identity match (as `flakyLineOf` has it).
        const usable =
            typeof found === "object" &&
            (!read.partial || (job.logicalId !== undefined && found.logicalId === job.logicalId));
        return {
            hash: read.hash,
            state: usable ? toCiState(found.state) : null,
            attempts: read.attempts,
            // Unread or not provable: may hold a red, so it breaks an isolated one.
            ...((found === "ambiguous" || (read.partial && !usable)) && { unread: true as const }),
        };
    });
    return {
        checkName: job.name,
        states: line.map((commit) => commit.state as CiState | null).reverse(),
        brokeAt: linear ? brokeAt(line) : null,
        flaky: flaky(
            job.logicalId ?? attemptLogicalId(job.name, reads) ?? job.name,
            line,
            attemptsCounted,
        ),
    };
}

/**
 * Bisects the selected commits that the Git Log still has loaded.
 *
 * @param source - The coordinator.
 * @param selected - The webview's selection, newest first, with its parents.
 * @param loaded - The host's loaded commits: the cap, and the parents the walk trusts.
 * @param signal - Aborted on cancel or when the view goes away.
 * @param onProgress - Called after each commit while not cancelled.
 * @param isCurrent - False once the repository, sign-in or CI settings changed; it stops the run
 *   as a cancel does, so no further request is queued or sent.
 * @returns `undefined` once cancelled or no longer current.
 */
export async function runCiBisect(
    source: CiBisectSource,
    selected: readonly LoadedCommit[],
    loaded: readonly LoadedCommit[],
    signal: AbortSignal,
    onProgress: (done: number, total: number) => void,
    isCurrent: () => boolean = () => true,
): Promise<CiBisectResult | undefined> {
    const parentsOf = new Map(loaded.map((commit) => [commit.hash, commit.parents]));
    const seen = new Set<string>();
    const commits = selected.flatMap((commit) => {
        const parents = parentsOf.get(commit.hash);
        if (!parents || seen.has(commit.hash)) return [];
        seen.add(commit.hash);
        return [{ hash: commit.hash, parents }];
    });
    const live = (): boolean => !signal.aborted && isCurrent();
    if (!live()) return undefined;
    const chain = firstParentChain(commits);
    const ordered = chain ?? commits;
    const newest = ordered[0];
    const attemptsCounted =
        newest !== undefined && (await source.capabilities(newest.hash))?.attemptHistory === true;
    let done = 0;
    const reads = await mapWithConcurrency(
        ordered,
        BISECT_CONCURRENCY,
        async ({ hash }): Promise<CommitRead | undefined> => {
            if (!live()) return undefined;
            const snapshot = await source.getChecks(hash, { isCurrent: live, sendGuard: live });
            const attempts =
                attemptsCounted && live() ? await source.attemptHistory(hash, live) : [];
            if (!live()) return undefined;
            done += 1;
            onProgress(done, ordered.length);
            return {
                hash,
                items: snapshot.state === "unavailable" ? null : snapshot.items,
                partial: snapshot.partial === true,
                attempts: attempts ?? [],
            };
        },
    );
    if (!live()) return undefined;
    const known = reads.filter((read): read is CommitRead => read !== undefined);
    const jobs = jobsOf(known);
    return {
        linear: chain !== null,
        commits: known.map((read) => read.hash).reverse(),
        jobs: jobs.map((job) => jobOf(job, jobs, known, chain !== null, attemptsCounted)),
        ...(commits.length < selected.length && { limitedTo: commits.length }),
    };
}
