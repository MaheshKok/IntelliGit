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
    indexChecks,
    isolatedReds,
    matchIndexed,
    type CheckIndex,
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
        options: {
            isCurrent: () => boolean;
            sendGuard: () => boolean;
            refreshUnavailable?: true;
        },
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
    /**
     * Set when some commits' checks or re-run histories could not be read: how many commits, so
     * the view shows an error with Retry.
     */
    failedReads?: number;
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
    /** The commit's re-run history could not be read: `attempts` is empty but not complete. */
    attemptsFailed: boolean;
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

/** Join steps between two returns to the event loop, so a cancel message can run meanwhile. */
const STEPS_PER_SLICE = 20_000;

/**
 * Counts join work; once a slice is used up it lets the event loop run, and always says whether
 * the bisect is still live, so a cancel stops the join rather than waiting for its end.
 */
function slicer(live: () => boolean): (steps: number) => Promise<boolean> {
    let used = 0;
    return async (steps) => {
        used += steps;
        if (used >= STEPS_PER_SLICE) {
            used = 0;
            await new Promise<void>((resolve) => setImmediate(resolve));
        }
        return live();
    };
}

/** One job of the bisect for the join; `status` = every item of it is a flat commit status. */
interface JobRow extends CiHistoryCheck {
    status: boolean;
}

/**
 * A commit's items (or the bisect's jobs) indexed apart by kind: a flat commit status and a
 * workflow check run never join, even under one name, so a green status cannot stand in for the
 * earlier state of a red job.
 */
interface KindIndex<T extends { name: string; logicalId?: string }> {
    status: CheckIndex<T>;
    other: CheckIndex<T>;
}

function indexByKind<T extends { name: string; logicalId?: string }>(
    items: readonly T[],
    isStatus: (item: T) => boolean,
): KindIndex<T> {
    return {
        status: indexChecks(items.filter(isStatus)),
        other: indexChecks(items.filter((item) => !isStatus(item))),
    };
}

const isStatusItem = (item: CommitCheckItem): boolean => item.source === "status";

/**
 * Every job seen in the commits, once each; `undefined` once `tick` says the bisect stopped. Two
 * items of two commits are one job when the §9 join, run on each commit's own items, matches
 * them (by logical id, else by a name unique in both); an identified and an unlabelled version
 * of one uniquely named check are one job. Two known logical ids never share a job, so an
 * unlabelled commit between two workflows' same-named jobs joins the first and proves neither.
 * A partial read joins too, so a job keeps one row; `jobOf` decides what such a read proves.
 */
async function jobsOf(
    reads: readonly CommitRead[],
    tick: (steps: number) => Promise<boolean>,
): Promise<JobRow[] | undefined> {
    const indexes = reads.map((read) => read.items && indexByKind(read.items, isStatusItem));
    const nodes = reads.flatMap((read, at) => (read.items ?? []).map((item) => ({ item, at })));
    const start: number[] = [];
    const nodeOf = reads.map(() => new Map<CommitCheckItem, number>());
    nodes.forEach(({ item, at }, index) => {
        start[at] ??= index;
        if (!nodeOf[at].has(item)) nodeOf[at].set(item, index);
    });
    const root = nodes.map((_, index) => index);
    // The one logical id a group of nodes holds, by the group's root.
    const known = nodes.map(({ item }) => item.logicalId);
    const find = (index: number): number => {
        while (root[index] !== index) index = root[index] = root[root[index]];
        return index;
    };
    const union = (a: number, b: number): void => {
        const [rootA, rootB] = [find(a), find(b)];
        if (rootA === rootB) return;
        if (
            known[rootA] !== undefined &&
            known[rootB] !== undefined &&
            known[rootA] !== known[rootB]
        ) {
            return;
        }
        root[rootA] = rootB;
        known[rootB] ??= known[rootA];
    };
    for (let at = 0; at < reads.length; at += 1) {
        const items = reads[at].items ?? [];
        const own = indexes[at];
        for (let offset = 0; own && offset < items.length; offset += 1) {
            const kind = isStatusItem(items[offset]) ? "status" : "other";
            for (let otherAt = at + 1; otherAt < reads.length; otherAt += 1) {
                const other = indexes[otherAt];
                if (!other) continue;
                const found = matchIndexed(items[offset], own[kind], other[kind]);
                if (typeof found === "object") {
                    union(start[at] + offset, nodeOf[otherAt].get(found) as number);
                }
            }
        }
        if (!(await tick(items.length * (reads.length - at)))) return undefined;
    }
    const groups = new Map<number, CommitCheckItem[]>();
    nodes.forEach(({ item }, index) => {
        const key = find(index);
        const group = groups.get(key);
        if (group) group.push(item);
        else groups.set(key, [item]);
    });
    return [...groups.values()].map((items): JobRow => {
        const named = items.find((item) => item.logicalId !== undefined) ?? items[0];
        return {
            ...(named.logicalId === undefined ? {} : { logicalId: named.logicalId }),
            name: named.name,
            state: "unknown",
            status: items.every((item) => item.source === "status"),
        };
    });
}

/**
 * The attempt histories' logical ids by job name: a GitHub snapshot check carries no logical id,
 * its re-runs are keyed by workflow and job name.
 */
function attemptIdsByName(reads: readonly CommitRead[]): Map<string, Set<string>> {
    const byName = new Map<string, Set<string>>();
    for (const read of reads) {
        for (const { logicalId: id } of read.attempts) {
            if (!id.startsWith("job\0")) continue;
            const name = id.slice(id.lastIndexOf("\0") + 1);
            const ids = byName.get(name) ?? new Set<string>();
            ids.add(id);
            byName.set(name, ids);
        }
    }
    return byName;
}

/** What `jobOf` needs of the whole read, built once. */
interface JobContext {
    reads: readonly CommitRead[];
    jobs: KindIndex<CiHistoryCheck>;
    readIndexes: readonly (KindIndex<CommitCheckItem> | null)[];
    attemptIds: ReadonlyMap<string, ReadonlySet<string>>;
    linear: boolean;
    attemptsCounted: boolean;
}

function jobOf(job: JobRow, context: JobContext): CiBisectJob {
    const { reads, linear, attemptsCounted } = context;
    const line = reads.map((read, at): CiFlakyCommit & { hash: string } => {
        const index = context.readIndexes[at];
        const kind = job.status ? "status" : "other";
        const found = index ? matchIndexed(job, context.jobs[kind], index[kind]) : "ambiguous";
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
    // A flat commit status has no re-runs: a same-named workflow job's history is not its own.
    const named = job.status ? undefined : context.attemptIds.get(job.name);
    return {
        checkName: job.name,
        states: line.map((commit) => commit.state as CiState | null).reverse(),
        isolated: isolatedReds(line).reverse(),
        brokeAt: linear ? brokeAt(line) : null,
        flaky: flaky(
            // The one history job bearing the name; none or several name no job.
            job.logicalId ?? (named?.size === 1 ? [...named][0] : undefined) ?? job.name,
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
 * @param refresh - Retry: a commit whose cached checks are an error is asked again; every other
 *   read stays cache first, as for an ordinary start.
 * @returns `undefined` once cancelled or no longer current.
 */
export async function runCiBisect(
    source: CiBisectSource,
    selected: readonly LoadedCommit[],
    loaded: readonly LoadedCommit[],
    signal: AbortSignal,
    onProgress: (done: number, total: number) => void,
    isCurrent: () => boolean = () => true,
    refresh = false,
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
    let attemptsCounted = false;
    // Unreadable Git remotes leave no provider to ask: every commit reads as unread, so the view
    // shows its error with Retry instead of staying on progress.
    let discoveryFailed = false;
    if (newest !== undefined) {
        try {
            attemptsCounted = (await source.capabilities(newest.hash))?.attemptHistory === true;
        } catch {
            if (!live()) return undefined;
            discoveryFailed = true;
        }
    }
    let done = 0;
    const reads = await mapWithConcurrency(
        ordered,
        BISECT_CONCURRENCY,
        async ({ hash }): Promise<CommitRead | undefined> => {
            if (!live()) return undefined;
            // One read per commit: a retry asks again only a commit the cache holds as an error.
            const snapshot = discoveryFailed
                ? undefined
                : await source.getChecks(hash, {
                      isCurrent: live,
                      sendGuard: live,
                      ...(refresh && { refreshUnavailable: true as const }),
                  });
            const attempts =
                attemptsCounted && live() ? await source.attemptHistory(hash, live) : [];
            if (!live()) return undefined;
            done += 1;
            onProgress(done, ordered.length);
            return {
                hash,
                items: !snapshot || snapshot.state === "unavailable" ? null : snapshot.items,
                partial: snapshot?.partial === true,
                attempts: attempts ?? [],
                attemptsFailed: attempts === null,
            };
        },
    );
    if (!live()) return undefined;
    const known = reads.filter((read): read is CommitRead => read !== undefined);
    const tick = slicer(live);
    const rows = await jobsOf(known, tick);
    if (!rows) return undefined;
    const context: JobContext = {
        reads: known,
        jobs: indexByKind(rows, (row) => row.status),
        readIndexes: known.map((read) => read.items && indexByKind(read.items, isStatusItem)),
        attemptIds: attemptIdsByName(known),
        linear: chain !== null,
        // A re-run history that could not be read leaves the flaky tag an estimate.
        attemptsCounted: attemptsCounted && known.every((read) => !read.attemptsFailed),
    };
    const jobs: CiBisectJob[] = [];
    for (const row of rows) {
        if (!(await tick(known.length))) return undefined;
        jobs.push(jobOf(row, context));
    }
    const failedReads = known.filter((read) => read.items === null || read.attemptsFailed).length;
    return {
        linear: chain !== null,
        commits: known.map((read) => read.hash).reverse(),
        jobs,
        ...(failedReads > 0 && { failedReads }),
        ...(commits.length < selected.length && { limitedTo: commits.length }),
    };
}
