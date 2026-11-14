// Which checks must pass before a merge into the default branch (PLAN.md §7, K21).
// Providers read the rules; this module caches them for an hour and marks a served detail.

import type { CiFlatCheck, CiJob, CommitCiDetail, CommitCiDetailData } from "../../types";

/** How much of the merge rule the provider would share. */
type RequiredStatus = NonNullable<CommitCiDetailData["requiredStatus"]>;

/** A provider's merge rule for one branch. */
export interface RequiredChecks {
    readonly status: RequiredStatus;
    /** GitHub: the check names in the union of rulesets and branch protection. */
    readonly names?: readonly string[];
    /** GitLab: "Pipelines must succeed" is on, so every job not allowed to fail is required. */
    readonly nonOptionalJobs?: boolean;
}

/** Nothing could be read; every check shows as "required: unknown". */
export const UNKNOWN_REQUIRED: RequiredChecks = Object.freeze({ status: "unknown" });

/** K21: required checks stay in memory (L1) only, for one hour. */
export const REQUIRED_CHECKS_TTL_MS = 60 * 60 * 1000;

interface Entry {
    readonly at: number;
    readonly value: Promise<RequiredChecks>;
}

/**
 * The L1 required-checks cache, keyed `required:<repoKey>:<branch>`. Callers asking at the
 * same time share one fetch; a fetch that rejects (a transient failure) is not kept.
 */
export class RequiredChecksCache {
    private readonly entries = new Map<string, Entry>();

    /**
     * Creates an empty cache.
     * @param now - Injectable clock for tests.
     */
    constructor(private readonly now: () => number = Date.now) {}

    /** The cached rule for the branch, or `fetch`'s answer when none is younger than an hour. */
    get(
        repoKey: string,
        branch: string,
        fetch: () => Promise<RequiredChecks>,
    ): Promise<RequiredChecks> {
        const key = `required:${repoKey}:${branch}`;
        const hit = this.entries.get(key);
        if (hit && this.now() - hit.at < REQUIRED_CHECKS_TTL_MS) return hit.value;
        const entry: Entry = { at: this.now(), value: fetch() };
        this.entries.set(key, entry);
        entry.value.catch(() => {
            if (this.entries.get(key) === entry) this.entries.delete(key);
        });
        return entry.value;
    }

    /** Drops every entry; called after a sign-in or settings change. */
    clear(): void {
        this.entries.clear();
    }
}

/**
 * The detail with each job and flat check marked `required`, and `requiredStatus` set.
 * `defaultBranchUnknown` says the rule could not be read because `origin/HEAD` is missing.
 */
export function applyRequired(
    detail: CommitCiDetail,
    rule: RequiredChecks,
    defaultBranchUnknown = false,
): CommitCiDetail {
    const names = new Set(rule.names ?? []);
    const byName = (name: string): NonNullable<CiJob["required"]> => {
        if (names.has(name)) return "yes";
        return rule.status === "known" ? "no" : "unknown";
    };
    const forJob = (job: CiJob): NonNullable<CiJob["required"]> => {
        if (rule.status === "unknown") return "unknown";
        if (rule.nonOptionalJobs !== undefined) {
            return rule.nonOptionalJobs && job.optional !== true ? "yes" : "no";
        }
        return byName(job.checkName);
    };
    const forCheck = (check: CiFlatCheck): NonNullable<CiFlatCheck["required"]> => {
        if (rule.status === "unknown") return "unknown";
        // GitLab's rule covers the pipeline's jobs, not statuses other tools post.
        if (rule.nonOptionalJobs !== undefined) return rule.nonOptionalJobs ? "unknown" : "no";
        return byName(check.name);
    };
    return {
        ...detail,
        requiredStatus: rule.status,
        ...(defaultBranchUnknown ? { defaultBranchUnknown: true as const } : {}),
        runs: detail.runs.map((run) => ({
            ...run,
            jobs: run.jobs.map((job) => ({ ...job, required: forJob(job) })),
        })),
        otherChecks: detail.otherChecks.map((check) => ({ ...check, required: forCheck(check) })),
    };
}
