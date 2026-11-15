/**
 * Reads the snapshots a commit's checks are compared with (PLAN.md §9, K22): the first
 * parent's and the default branch tip's. The join and the tags live in
 * `src/shared/ci/history.ts`, because the Checks tab applies them to the rows it shows.
 */

import type { CiHistory } from "../../shared/ci/history";
import type { CommitCheckItem, CommitChecksSnapshot } from "../../types";
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
