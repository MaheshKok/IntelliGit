/**
 * "Changed since last green" (PLAN.md §14): the newest first-parent ancestor, inside the
 * commits the Git Log has loaded, where the selected job passed, and the files changed from
 * there to the selected commit. Ancestor snapshots come from the cache only, never the network.
 */

import { historyChecksOf, matchCheck, type CiHistoryCheck } from "../../shared/ci/history";
import type {
    CiChangedFile,
    CommitChecksSnapshot,
    CommitCiDetailData,
    CommitFile,
} from "../../types";

/** One loaded Git Log commit and its parents, first parent first. */
export interface LoadedCommit {
    hash: string;
    parents: readonly string[];
}

/** What the Checks tab asks for a failed job. */
export interface ChangedSinceGreenRequest {
    hash: string;
    logicalCheckId: string;
    /** The job's workflow or pipeline name; its logical id already carries it. */
    scopeName: string | null;
    checkName: string;
    loaded: readonly LoadedCommit[];
}

/** The answer: the last commit where the job passed and the files changed since. */
export interface ChangedSinceGreen {
    /** `null` when no ancestor in the loaded history passed, or the job cannot be matched. */
    lastGreen: string | null;
    /** Set when an ancestor has more than one check the job could be. */
    unknownReason?: "ambiguous";
    files: CiChangedFile[];
}

/** The caches and the Git read the walk uses. */
export interface ChangedSinceGreenDeps {
    /** L1 then L2 only; `undefined` on a miss. Never fetches. */
    cachedChecks(hash: string): Promise<CommitChecksSnapshot | undefined>;
    /** The selected commit's cached detail, the current side of the join; never fetches. */
    cachedDetail(hash: string): Promise<CommitCiDetailData | undefined>;
    /** `git diff --name-status -M -z <from> <to> --` output. */
    diffNameStatus(from: string, to: string): Promise<string>;
}

/**
 * The first-parent ancestors of `start`, newest first, while they stay inside `loaded`; the
 * walk stops at the first hash the Git Log has not loaded.
 */
export function firstParentLine(start: string, loaded: readonly LoadedCommit[]): string[] {
    const parentsOf = new Map(loaded.map((commit) => [commit.hash, commit.parents]));
    const line: string[] = [];
    let current = parentsOf.get(start)?.[0];
    while (current !== undefined && parentsOf.has(current) && !line.includes(current)) {
        line.push(current);
        current = parentsOf.get(current)?.[0];
    }
    return line;
}

const STATUSES: ReadonlySet<string> = new Set(["A", "M", "D", "R", "C", "T"]);

/**
 * Parses `git diff --name-status -z`: fields are NUL-separated, so any byte but NUL survives
 * in a name. A rename or copy row carries its source path before its destination.
 */
export function parseNameStatusZ(output: string): CiChangedFile[] {
    const fields = output.split("\0");
    const files: CiChangedFile[] = [];
    for (let index = 0; index < fields.length;) {
        const code = fields[index++];
        if (!code) continue;
        const first = fields[index++];
        if (first === undefined) break;
        const letter = code[0];
        const status = (STATUSES.has(letter) ? letter : "M") as CommitFile["status"];
        if (letter === "R" || letter === "C") {
            const path = fields[index++];
            if (path === undefined) break;
            files.push({ path, status, oldPath: first });
        } else {
            files.push({ path: first, status });
        }
    }
    return files;
}

/** Which path at which revision each side of the two-revision diff shows; `null` = empty. */
export function rangeDiffSides(
    file: CiChangedFile,
    fromRev: string,
    toRev: string,
): { left: { path: string; rev: string } | null; right: { path: string; rev: string } | null } {
    return {
        left: file.status === "A" ? null : { path: file.oldPath ?? file.path, rev: fromRev },
        right: file.status === "D" ? null : { path: file.path, rev: toRev },
    };
}

/**
 * Walks the loaded first-parent line from the selected commit and answers the newest ancestor
 * where the job passed. A git failure rejects; the caller shows it.
 */
export async function changedSinceGreen(
    deps: ChangedSinceGreenDeps,
    request: ChangedSinceGreenRequest,
): Promise<ChangedSinceGreen> {
    const check: CiHistoryCheck = {
        logicalId: request.logicalCheckId,
        name: request.checkName,
        state: "failure",
    };
    const detail = await deps.cachedDetail(request.hash);
    // Without the selected commit's checks no match can be proven unique on its side.
    if (!detail) return { lastGreen: null, unknownReason: "ambiguous", files: [] };
    const current = historyChecksOf(detail);
    for (const hash of firstParentLine(request.hash, request.loaded)) {
        // Serial: the walk stops at the first green or ambiguous ancestor.
        // react-doctor-disable-next-line react-doctor/async-await-in-loop
        const snapshot = await deps.cachedChecks(hash);
        // An ancestor not in the cache, or not read, says nothing: the walk goes on past it.
        if (!snapshot || snapshot.state === "unavailable") continue;
        const match = matchCheck(check, current, snapshot.items);
        if (match === "ambiguous")
            return { lastGreen: null, unknownReason: "ambiguous", files: [] };
        if (match === "none" || match.state !== "success") continue;
        // A list read in part cannot prove a name unique: only an identity match counts there.
        if (snapshot.partial && match.logicalId === undefined) continue;
        // react-doctor-disable-next-line react-doctor/async-await-in-loop
        const output = await deps.diffNameStatus(hash, request.hash);
        return { lastGreen: hash, files: parseNameStatusZ(output) };
    }
    return { lastGreen: null, files: [] };
}
