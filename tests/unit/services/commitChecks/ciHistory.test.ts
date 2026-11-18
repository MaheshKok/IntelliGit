// "new" / "still" / "fixed" / "unknown" and "also red on <default branch>" (PLAN.md §9, K22,
// K35, Phase 11). A check is matched across commits by its logical identity, never by an
// execution id; without one on both sides, by a name that is unique on both sides.

import { describe, expect, it, vi } from "vitest";
import { interpolateL10n } from "../../../helpers/l10nTestHelper";

vi.mock("vscode", () => ({
    authentication: {
        getSession: vi.fn(async () => ({
            id: "session",
            accessToken: "gh-token",
            account: { id: "account", label: "GitHub User" },
            scopes: ["repo"],
        })),
    },
    l10n: { t: interpolateL10n },
}));

import bitbucketCloudStatusesFixture from "../../../fixtures/commitChecks/bitbucket/cloudStatuses.json";
import bitbucketServerStatusesFixture from "../../../fixtures/commitChecks/bitbucket/serverStatuses.json";
import checkRunsFixture from "../../../fixtures/commitChecks/github/checkRuns.json";
import gitlabStatusesFixture from "../../../fixtures/commitChecks/gitlab/statuses.json";
import { BitbucketCloudProvider } from "../../../../src/services/commitChecks/bitbucketCloudProvider";
import { BitbucketServerProvider } from "../../../../src/services/commitChecks/bitbucketServerProvider";
import {
    attemptHistories,
    readCiHistory,
    type CiAttemptJob,
} from "../../../../src/services/commitChecks/ciHistory";
import { CredentialStore } from "../../../../src/services/commitChecks/credentialStore";
import {
    readDefaultBranch,
    type DefaultBranch,
} from "../../../../src/services/commitChecks/defaultBranch";
import { GitHubProvider } from "../../../../src/services/commitChecks/githubProvider";
import { GitLabProvider } from "../../../../src/services/commitChecks/gitlabProvider";
import type { ProviderRepoRef } from "../../../../src/services/commitChecks/types";
import {
    alsoRed,
    compare,
    flaky,
    flakyLineOf,
    historyChecksOf,
    join,
    type CiFlakyCommit,
    type CiHistoryCheck,
} from "../../../../src/shared/ci/history";
import { logicalCheckId } from "../../../../src/shared/ci/identity";
import type {
    CiAttemptHistory,
    CiJob,
    CommitCheckItem,
    CommitChecksSnapshot,
} from "../../../../src/types";

const jobId = (scope: string, name: string): string => logicalCheckId({ kind: "job", scope, name });

/** A job of the current commit as the join sees it. */
function job(scope: string, name: string, state: CiJob["state"]): CiHistoryCheck {
    return { logicalId: jobId(scope, name), name, state };
}

/** A parent snapshot item; `logicalId` only where the snapshot API names the workflow. */
function item(
    name: string,
    state: CommitCheckItem["state"],
    extra: Partial<CommitCheckItem> = {},
): CommitCheckItem {
    return { name, description: "", state, source: "check-run", ...extra };
}

/** Compares `check` within a current commit made of `current` (itself included). */
function tag(check: CiHistoryCheck, parent: CommitCheckItem[], current = [check]) {
    return compare(check, current, parent);
}

describe("compare", () => {
    it("new", () => {
        expect(tag(job("CI", "unit", "failure"), [item("unit", "success")])).toBe("new");
    });

    it("still", () => {
        expect(tag(job("CI", "unit", "failure"), [item("unit", "failure")])).toBe("still");
    });

    it("fixed", () => {
        expect(tag(job("CI", "unit", "success"), [item("unit", "failure")])).toBe("fixed");
    });

    it("a green job whose parent was green carries no tag", () => {
        expect(tag(job("CI", "unit", "success"), [item("unit", "success")])).toBeNull();
    });

    it("renamed matrix job → unknown", () => {
        const renamed = job("CI", "test (node 22)", "failure");
        expect(tag(renamed, [item("test (node 20)", "success")])).toBe("unknown");
    });

    it("two parent items with the same name → unknown", () => {
        const failed = job("CI", "lint", "failure");
        expect(tag(failed, [item("lint", "success"), item("lint", "failure")])).toBe("unknown");
    });

    it("execution ids differ across commits, logical id matches", () => {
        // The parent ran the same workflow job as another execution: other job and check-run ids.
        const current: CiHistoryCheck = { ...job("CI", "build", "failure") };
        const parent = [
            item("build", "success", { id: "1001", logicalId: jobId("CI", "build") }),
            item("build", "failure", { id: "2002", logicalId: jobId("Nightly", "build") }),
        ];
        expect(join(current, [current], parent)).toBe(parent[0]);
        expect(tag(current, parent)).toBe("new");
    });

    it("same job name in two workflows matched by workflow", () => {
        const ci = job("CI", "build", "failure");
        const release = job("Release", "build", "failure");
        const parent = [
            item("build", "failure", { logicalId: jobId("CI", "build") }),
            item("build", "success", { logicalId: jobId("Release", "build") }),
        ];
        expect(tag(ci, parent, [ci, release])).toBe("still");
        expect(tag(release, parent, [ci, release])).toBe("new");
    });

    it("a parent check of another workflow with the job's name is not the job", () => {
        const ci = job("CI", "build", "failure");
        const parent = [item("build", "success", { logicalId: jobId("Release", "build") })];
        expect(tag(ci, parent)).toBe("unknown");
    });

    it("parent incomplete → no tag", () => {
        expect(tag(job("CI", "unit", "failure"), [item("unit", "pending")])).toBeNull();
        expect(tag(job("CI", "unit", "success"), [item("unit", "pending")])).toBeNull();
    });

    it("two current workflows with the same job name against one parent job → unknown", () => {
        // GitHub parents carry no workflow name, so the name must be unique on both sides.
        const ci = job("CI", "lint", "failure");
        const docs = job("Docs", "lint", "success");
        const parent = [item("lint", "success")];
        expect(tag(ci, parent, [ci, docs])).toBe("unknown");
        expect(tag(docs, parent, [ci, docs])).toBeNull();
    });

    it("a parent whose check timed out counts as red", () => {
        expect(tag(job("CI", "e2e", "success"), [item("e2e", "timed_out")])).toBe("fixed");
    });

    it("a running job gets no tag", () => {
        expect(tag(job("CI", "unit", "running"), [item("unit", "failure")])).toBeNull();
    });

    it("only the parent carries a logical identity → the unique name still matches", () => {
        const flat: CiHistoryCheck = { name: "unit", state: "failure" };
        const parent = [item("unit", "success", { logicalId: jobId("CI", "unit") })];
        expect(tag(flat, parent)).toBe("new");
    });

    it("two parent items with the same name and different identities → unknown for a flat check", () => {
        const flat: CiHistoryCheck = { name: "unit", state: "failure" };
        const parent = [
            item("unit", "success", { logicalId: jobId("CI", "unit") }),
            item("unit", "failure", { logicalId: jobId("Nightly", "unit") }),
        ];
        expect(tag(flat, parent)).toBe("unknown");
    });

    it("a fallback name repeated by another identified parent is ambiguous across the whole commit", () => {
        // The parent holds an unidentified green `unit` and an identified red `Release/unit`;
        // the identified current `CI/unit` cannot tell which one it is.
        const ci = job("CI", "unit", "failure");
        const parent = [
            item("unit", "success"),
            item("unit", "failure", { logicalId: jobId("Release", "unit") }),
        ];
        expect(tag(ci, parent)).toBe("unknown");
    });

    it("two current checks with one logical identity → unknown for both", () => {
        const first = job("CI", "unit", "failure");
        const second = job("CI", "unit", "failure");
        const parent = [item("unit", "success", { logicalId: jobId("CI", "unit") })];
        expect(tag(first, parent, [first, second])).toBe("unknown");
        expect(tag(second, parent, [first, second])).toBe("unknown");
    });

    it("two parent items with one logical identity → unknown", () => {
        const failed = job("CI", "unit", "failure");
        const parent = [
            item("unit", "success", { logicalId: jobId("CI", "unit") }),
            item("unit", "failure", { logicalId: jobId("CI", "unit") }),
        ];
        expect(tag(failed, parent)).toBe("unknown");
    });

    it.each(["failure", "timed_out", "action_required"] as const)(
        "a check in state %s is red on either side",
        (state) => {
            const flat: CiHistoryCheck = { name: "unit", state };
            expect(tag(flat, [item("unit", "failure")])).toBe("still");
            expect(tag(flat, [item("unit", "success")])).toBe("new");
            expect(tag({ name: "unit", state: "success" }, [item("unit", state)])).toBe("fixed");
            expect(alsoRed(flat, [flat], [item("unit", state)])).toBe(true);
        },
    );
});

describe("alsoRed", () => {
    it("also red on default tip", () => {
        const failed = job("CI", "unit", "failure");
        const parent = [item("unit", "success")];
        const tip = [item("unit", "failure")];
        expect(tag(failed, parent)).toBe("new");
        expect(alsoRed(failed, [failed], tip)).toBe(true);
        expect(alsoRed(failed, [failed], [item("unit", "success")])).toBe(false);
    });

    it("never for a check that passed or has no unique match on the tip", () => {
        // The passed check is its own current population, so the tip item is its unique match.
        const passed = job("CI", "unit", "success");
        expect(alsoRed(passed, [passed], [item("unit", "failure")])).toBe(false);
        const failed = job("CI", "unit", "failure");
        expect(alsoRed(failed, [failed], [item("unit", "failure"), item("unit", "failure")])).toBe(
            false,
        );
    });
});

describe("historyChecksOf", () => {
    it("lists jobs by check name and flat checks of the current commit", () => {
        const checks = historyChecksOf({
            runs: [
                {
                    id: "1",
                    name: "CI",
                    state: "failure",
                    jobs: [
                        {
                            id: "9",
                            logicalId: jobId("CI", "unit"),
                            name: "unit (shown)",
                            checkName: "unit",
                            state: "failure",
                            steps: [],
                        },
                    ],
                    jobsCoverage: "full",
                },
            ],
            otherChecks: [{ name: "codecov", description: "", state: "success", source: "status" }],
        });
        expect(checks).toEqual([
            { logicalId: jobId("CI", "unit"), name: "unit", state: "failure" },
            { name: "codecov", state: "success" },
        ]);
    });
});

describe("readCiHistory", () => {
    const PARENT_1 = "1".repeat(40);
    const PARENT_2 = "2".repeat(40);
    const TIP = "3".repeat(40);

    function snapshot(hash: string, items: CommitCheckItem[]): CommitChecksSnapshot {
        return { hash, state: "success", summary: "", items };
    }

    function deps(branch: DefaultBranch | null = { name: "trunk", tipHash: TIP }) {
        const getChecks = vi.fn(async (hash: string) =>
            snapshot(hash, [item(`check of ${hash.slice(0, 1)}`, "success")]),
        );
        return { getChecks, readDefaultBranch: vi.fn(async () => branch) };
    }

    it("merge commit uses first parent", async () => {
        const d = deps();
        const history = await readCiHistory(d, [PARENT_1, PARENT_2]);
        expect(history.parent).toEqual({
            hash: PARENT_1,
            items: [item("check of 1", "success")],
        });
        expect(d.getChecks).not.toHaveBeenCalledWith(PARENT_2);
    });

    it("reads the default branch tip's snapshot under its real name", async () => {
        const history = await readCiHistory(deps(), [PARENT_1]);
        expect(history.defaultBranch).toEqual({
            name: "trunk",
            tipHash: TIP,
            items: [item("check of 3", "success")],
        });
    });

    it("missing origin/HEAD → no default branch, and no snapshot asked for it", async () => {
        const d = deps(null);
        const history = await readCiHistory(d, [PARENT_1]);
        expect(history.defaultBranch).toBeNull();
        expect(d.getChecks).toHaveBeenCalledTimes(1);
    });

    it("reads the default branch on every request", async () => {
        const d = deps();
        await readCiHistory(d, [PARENT_1]);
        await readCiHistory(d, [PARENT_1]);
        expect(d.readDefaultBranch).toHaveBeenCalledTimes(2);
    });

    it("a root commit has no parent", async () => {
        expect((await readCiHistory(deps(), [])).parent).toBeNull();
    });

    it("a snapshot that could not be read gives null items, not an empty list", async () => {
        const d = deps();
        d.getChecks.mockImplementation(async (hash: string) => ({
            hash,
            state: "unavailable",
            summary: "",
            items: [],
            error: "HTTP 500",
        }));
        const history = await readCiHistory(d, [PARENT_1]);
        expect(history.parent).toEqual({ hash: PARENT_1, items: null });
        expect(history.defaultBranch?.items).toBeNull();
    });

    it("carries a partly read snapshot's flag to the parent and the default tip, and no flag otherwise", async () => {
        const d = deps();
        d.getChecks.mockImplementation(async (hash: string) => ({
            ...snapshot(hash, [item("unit", "success")]),
            ...(hash === PARENT_1 || hash === TIP ? { partial: true } : {}),
        }));
        const partial = await readCiHistory(d, [PARENT_1]);
        expect(partial.parent).toEqual({
            hash: PARENT_1,
            items: [item("unit", "success")],
            partial: true,
        });
        expect(partial.defaultBranch?.partial).toBe(true);
        const whole = await readCiHistory(d, [PARENT_2]);
        expect(whole.parent?.partial).toBeUndefined();
    });

    it("a failing git read of the default branch still answers the parent", async () => {
        // The production reader: Git exits non-zero, which the executor turns into a rejection.
        const d = {
            ...deps(),
            readDefaultBranch: () =>
                readDefaultBranch(async () => {
                    throw new Error("git exited 128");
                }),
        };
        const history = await readCiHistory(d, [PARENT_1]);
        expect(history.defaultBranch).toBeNull();
        expect(history.parent).toEqual({ hash: PARENT_1, items: [item("check of 1", "success")] });
    });

    it("a throwing snapshot read gives null items", async () => {
        const d = deps();
        d.getChecks.mockRejectedValue(new Error("boom"));
        expect((await readCiHistory(d, [PARENT_1])).parent).toEqual({
            hash: PARENT_1,
            items: null,
        });
    });
});

// A snapshot is `partial` when not every item was read, so the history never treats it as the
// whole population a name is unique in (K35).
describe("partly read provider snapshots", () => {
    const tokenStore = (): CredentialStore =>
        new CredentialStore({
            get: vi.fn(async () => "bb-token"),
            store: vi.fn(),
            delete: vi.fn(),
            onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
        } as never);
    const hash = "a".repeat(40);

    it("GitHub: one endpoint failing marks the snapshot partial, both answering does not", async () => {
        const ref = { host: "github.com", owner: "o", repo: "r" } as ProviderRepoRef;
        const checkRuns = {
            total_count: 1,
            check_runs: [{ id: 1, name: "unit-tests", status: "completed", conclusion: "success" }],
        };
        // The check-suite count is read through the metadata fetch; one suite is under the limit.
        const suites = async () => ({
            statusCode: 200,
            headers: {},
            body: { total_count: 1, check_suites: [] },
        });
        const statusDown = new GitHubProvider(
            async (url: string) => {
                if (url.includes("/check-runs")) return checkRuns;
                throw new Error("HTTP 503");
            },
            undefined,
            suites,
        );
        const partial = await statusDown.getChecks(ref, hash);
        expect(partial.items.map((i) => i.name)).toEqual(["unit-tests"]);
        expect(partial.partial).toBe(true);
        const whole = new GitHubProvider(
            async (url: string) => (url.includes("/check-runs") ? checkRuns : { statuses: [] }),
            undefined,
            suites,
        );
        expect((await whole.getChecks(ref, hash)).partial).toBeUndefined();
    });

    it("Bitbucket Cloud: the page bound cutting a `next` chain marks the snapshot partial", async () => {
        const ref = { host: "bitbucket.org", workspace: "o", repo: "r" } as ProviderRepoRef;
        const chain = (last: number) => async (url: string) => {
            const page = Number(new URL(url).searchParams.get("page") ?? "1");
            return {
                values: [{ key: `k${page}`, name: `n${page}`, state: "SUCCESSFUL" }],
                next:
                    page < last
                        ? `https://api.bitbucket.org/2.0/repositories/o/r/commit/${hash}/statuses?page=${page + 1}`
                        : undefined,
            };
        };
        const cutProvider = new BitbucketCloudProvider(chain(6), tokenStore());
        const cut = await cutProvider.getChecks(ref, hash);
        expect(cut.items).toHaveLength(5);
        expect(cut.partial).toBe(true);
        // The flag survives the host's history read for both the parent and the default tip.
        const history = await readCiHistory(
            {
                getChecks: (h) => cutProvider.getChecks(ref, h),
                readDefaultBranch: async () => ({ name: "trunk", tipHash: "d".repeat(40) }),
            },
            ["b".repeat(40)],
        );
        expect(history.parent?.partial).toBe(true);
        expect(history.defaultBranch?.partial).toBe(true);
        const whole = await new BitbucketCloudProvider(chain(5), tokenStore()).getChecks(ref, hash);
        expect(whole.items).toHaveLength(5);
        expect(whole.partial).toBeUndefined();
    });

    it("Bitbucket Server: the page bound cutting a `nextPageStart` chain marks the snapshot partial", async () => {
        const ref = { host: "bb.example.com", project: "P", repo: "r" } as ProviderRepoRef;
        const chain = (last: number) => async (url: string) => {
            const start = Number(new URL(url).searchParams.get("start") ?? "0");
            const page = start / 100 + 1;
            return {
                values: [{ key: `k${page}`, name: `n${page}`, state: "SUCCESSFUL" }],
                isLastPage: page >= last,
                nextPageStart: start + 100,
            };
        };
        const cut = await new BitbucketServerProvider(chain(6), tokenStore()).getChecks(ref, hash);
        expect(cut.items).toHaveLength(5);
        expect(cut.partial).toBe(true);
        const whole = await new BitbucketServerProvider(chain(5), tokenStore()).getChecks(
            ref,
            hash,
        );
        expect(whole.partial).toBeUndefined();
    });
});

// Recorded per provider (PLAN.md Phase 11): a snapshot item carries `logicalId` only where its
// API names the workflow or pipeline. These fixtures follow the providers' documented response
// shapes; none names one, so GitHub, GitLab and both Bitbucket parents are joined by the unique
// name. A logical id set here from the item's own name would make every job on both sides
// "unknown".
describe("snapshot logical identity per provider", () => {
    const tokenStore = (): CredentialStore =>
        new CredentialStore({
            get: vi.fn(async () => "bb-token"),
            store: vi.fn(),
            delete: vi.fn(),
            onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
        } as never);

    /** The fixture parent joined by unique name: one match each, ambiguous when doubled. */
    function expectUniqueNameJoin(parent: CommitCheckItem[]): void {
        const unit = job("CI", "unit-tests", "failure");
        expect(join(unit, [unit], parent)).toBe(parent.find((i) => i.name === "unit-tests"));
        expect(tag(unit, parent)).toBe("new");
        const flat: CiHistoryCheck = { name: "unit-tests", state: "failure" };
        expect(tag(flat, parent)).toBe("new");
        const twin = job("Nightly", "unit-tests", "failure");
        expect(tag(unit, parent, [unit, twin])).toBe("unknown");
        expect(tag(unit, [...parent, ...parent])).toBe("unknown");
    }

    it("Bitbucket Cloud build statuses name no pipeline, so items carry no logicalId", async () => {
        const provider = new BitbucketCloudProvider(
            async () => bitbucketCloudStatusesFixture,
            tokenStore(),
        );
        const ref = { host: "bitbucket.org", workspace: "acme", repo: "repo" } as ProviderRepoRef;
        const result = await provider.getChecks(ref, "a".repeat(40));
        expect(result.items.map((i) => i.name)).toEqual(["unit-tests", "SonarCloud"]);
        expect(result.items.map((i) => i.logicalId)).toEqual([undefined, undefined]);
        expectUniqueNameJoin(result.items);
    });

    it("Bitbucket Server build statuses name no pipeline, so items carry no logicalId", async () => {
        const provider = new BitbucketServerProvider(
            async () => bitbucketServerStatusesFixture,
            tokenStore(),
        );
        const ref = { host: "bb.example.com", project: "PROJ", repo: "repo" } as ProviderRepoRef;
        const result = await provider.getChecks(ref, "a".repeat(40));
        expect(result.items.map((i) => i.name)).toEqual(["unit-tests", "lint"]);
        expect(result.items.map((i) => i.logicalId)).toEqual([undefined, undefined]);
        expectUniqueNameJoin(result.items);
    });

    it("GitHub check runs and statuses name no workflow, so items carry no logicalId", async () => {
        // The check-suite count goes through the metadata fetch; answering it keeps the test offline.
        const provider = new GitHubProvider(
            async (url: string) =>
                url.includes("/check-runs") ? checkRunsFixture : { statuses: [] },
            undefined,
            async () => ({
                statusCode: 200,
                headers: {},
                body: { total_count: 1, check_suites: [] },
            }),
        );
        const ref = { host: "github.com", owner: "o", repo: "r" } as ProviderRepoRef;
        const result = await provider.getChecks(ref, "a".repeat(40));
        expect(result.items.map((i) => i.name)).toEqual(["unit-tests", "lint"]);
        expect(result.items.every((i) => i.logicalId === undefined)).toBe(true);
    });

    it("GitLab commit statuses name no pipeline, so items carry no logicalId", async () => {
        const store = new CredentialStore({
            get: vi.fn(async () => "gl-token"),
            store: vi.fn(),
            delete: vi.fn(),
            onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
        } as never);
        const provider = new GitLabProvider(async () => gitlabStatusesFixture, store);
        const ref = { host: "gitlab.com", owner: "group", repo: "project" } as ProviderRepoRef;
        const result = await provider.getChecks(ref, "a".repeat(40));
        expect(result.items.map((i) => i.name)).toEqual(["unit-tests"]);
        expect(result.items.every((i) => i.logicalId === undefined)).toBe(true);
    });
});

const RUN_A = "run-a";
const RUN_B = "run-b";
const UNIT = jobId("CI", "unit");

/** One attempt record of `UNIT` (or `logicalId`) as a provider reads it. */
function attemptJob(
    id: string,
    state: CiJob["state"],
    extra: Partial<CiAttemptJob> = {},
): CiAttemptJob {
    return { id, logicalId: UNIT, name: "unit", state, ...extra };
}

/** A commit of the loaded line with no attempt histories. */
function plain(state: CiFlakyCommit["state"]): CiFlakyCommit {
    return { state, attempts: [] };
}

/** One history of `UNIT` in `RUN_A` with the given attempt states, oldest first. */
function retried(...states: CiJob["state"][]): CiAttemptHistory[] {
    return attemptHistories(
        [
            {
                runId: RUN_A,
                coverage: "full",
                jobs: states.map((state, index) =>
                    attemptJob(String(index + 1), state, { attempt: index + 1 }),
                ),
            },
        ],
        "runAttempt",
    );
}

describe("attempt histories (§9)", () => {
    it("GitHub attempts ordered by run_attempt then started_at", () => {
        const [history] = attemptHistories(
            [
                {
                    runId: RUN_A,
                    coverage: "full",
                    jobs: [
                        attemptJob("300", "failure", {
                            attempt: 1,
                            startedAt: "2026-11-07T09:00:00Z",
                        }),
                        attemptJob("100", "success", {
                            attempt: 2,
                            startedAt: "2026-11-07T10:05:00Z",
                        }),
                        attemptJob("200", "failure", {
                            attempt: 2,
                            startedAt: "2026-11-07T10:00:00Z",
                        }),
                        attemptJob("300", "failure", {
                            attempt: 1,
                            startedAt: "2026-11-07T09:00:00Z",
                        }),
                    ],
                },
            ],
            "runAttempt",
        );
        expect(history.attempts.map((a) => [a.executionId, a.attempt])).toEqual([
            ["300", 1],
            ["200", 2],
            ["100", 2],
        ]);
    });

    it("GitHub orders by run_attempt before an earlier started_at or a lower job id", () => {
        // A clock-skewed re-run: attempt 2 reports an earlier start and a lower id than attempt 1.
        const [history] = attemptHistories(
            [
                {
                    runId: RUN_A,
                    coverage: "full",
                    jobs: [
                        attemptJob("20", "failure", {
                            attempt: 1,
                            startedAt: "2026-11-07T10:00:00Z",
                        }),
                        attemptJob("10", "success", {
                            attempt: 2,
                            startedAt: "2026-11-07T09:00:00Z",
                        }),
                    ],
                },
            ],
            "runAttempt",
        );
        expect(history.attempts.map((a) => [a.executionId, a.attempt])).toEqual([
            ["20", 1],
            ["10", 2],
        ]);
    });

    it("GitLab retried jobs ordered by created_at", () => {
        // Job ids out of time order: a sort by id alone would put 5 first.
        const [history] = attemptHistories(
            [
                {
                    runId: RUN_A,
                    coverage: "full",
                    jobs: [
                        attemptJob("9", "failure", { createdAt: "2026-11-07T10:00:00Z" }),
                        attemptJob("12", "failure", { createdAt: "2026-11-07T09:00:00Z" }),
                        attemptJob("5", "success", { createdAt: "2026-11-07T11:00:00Z" }),
                    ],
                },
            ],
            "createdAt",
        );
        expect(history.attempts.map((a) => [a.executionId, a.attempt])).toEqual([
            ["12", 1],
            ["9", 2],
            ["5", 3],
        ]);
    });

    it("colliding attempt numbers in two runs do not merge", () => {
        const histories = attemptHistories(
            [
                {
                    runId: RUN_A,
                    coverage: "full",
                    jobs: [
                        attemptJob("1", "failure", { attempt: 1 }),
                        attemptJob("2", "success", { attempt: 2 }),
                    ],
                },
                {
                    runId: RUN_B,
                    coverage: { reason: "pageBound", shown: 2 },
                    jobs: [
                        attemptJob("3", "failure", { attempt: 1 }),
                        attemptJob("4", "failure", { attempt: 2 }),
                    ],
                },
            ],
            "runAttempt",
        );
        expect(
            histories.map((h) => [h.runId, h.attempts.map((a) => a.executionId), h.coverage]),
        ).toEqual([
            [RUN_A, ["1", "2"], "full"],
            [RUN_B, ["3", "4"], { reason: "pageBound", shown: 2 }],
        ]);
    });

    it("same-named jobs in two workflows keep separate histories", () => {
        const deploy = jobId("Deploy", "unit");
        const histories = attemptHistories(
            [
                {
                    runId: RUN_A,
                    coverage: "full",
                    jobs: [
                        attemptJob("1", "failure", { attempt: 1 }),
                        attemptJob("2", "success", { attempt: 1, logicalId: deploy }),
                    ],
                },
            ],
            "runAttempt",
        );
        expect(histories.map((h) => h.logicalId)).toEqual([UNIT, deploy]);
        // The CI workflow's job only failed: the Deploy workflow's pass is another check.
        expect(flaky(UNIT, [{ state: "failure", attempts: histories }], true)).toBeNull();
    });
});

describe("flaky (§9, O3)", () => {
    it("isolated red counts, run of reds does not", () => {
        const line = ["success", "failure", "success", "failure", "failure", "success"] as const;
        expect(flaky(UNIT, line.map(plain), true)).toEqual({ n: 1, m: 6, attemptsCounted: true });
    });

    it("an isolated red looks past commits with no complete result", () => {
        const line = [
            plain("success"),
            plain(null),
            plain("failure"),
            plain("running"),
            plain("success"),
        ];
        expect(flaky(UNIT, line, true)).toEqual({ n: 1, m: 3, attemptsCounted: true });
    });

    it("a red at either end of the loaded line is not isolated", () => {
        expect(flaky(UNIT, [plain("failure"), plain("success")], true)).toBeNull();
        expect(flaky(UNIT, [plain("success"), plain("failure")], true)).toBeNull();
    });

    it("same-commit fail-then-pass counts", () => {
        const line: CiFlakyCommit[] = [
            { state: "success", attempts: retried("failure", "success") },
            plain("success"),
            plain("success"),
        ];
        expect(flaky(UNIT, line, true)).toEqual({ n: 1, m: 3, attemptsCounted: true });
    });

    it("another check's fail-then-pass on the same commit does not count", () => {
        const deployRetried = retried("failure", "success").map((history) => ({
            ...history,
            logicalId: jobId("Deploy", "unit"),
        }));
        const line: CiFlakyCommit[] = [
            { state: "success", attempts: deployRetried },
            plain("success"),
        ];
        expect(flaky(UNIT, line, true)).toBeNull();
    });

    it("pass-then-fail on one commit is not a flaky retry", () => {
        const line: CiFlakyCommit[] = [
            { state: "failure", attempts: retried("success", "failure") },
            plain("failure"),
        ];
        expect(flaky(UNIT, line, true)).toBeNull();
    });

    it("a commit meeting both rules counts once", () => {
        const line: CiFlakyCommit[] = [
            plain("success"),
            { state: "failure", attempts: retried("failure", "success") },
            plain("success"),
        ];
        expect(flaky(UNIT, line, true)).toEqual({ n: 1, m: 3, attemptsCounted: true });
    });

    it("no attempt history → attemptsCounted false", () => {
        const line = [plain("success"), plain("failure"), plain("success")];
        expect(flaky(UNIT, line, false)).toEqual({ n: 1, m: 3, attemptsCounted: false });
    });

    it("an ancestor read in part counts only an identity match", () => {
        const check = job("CI", "unit", "failure");
        const nameOnly = [item("unit", "failure")];
        const line = flakyLineOf(
            check,
            [check],
            [],
            [
                { hash: "a".repeat(40), items: nameOnly, attempts: [], partial: true },
                { hash: "b".repeat(40), items: nameOnly, attempts: [] },
                {
                    hash: "c".repeat(40),
                    items: [item("unit", "success", { logicalId: UNIT })],
                    attempts: [],
                    partial: true,
                },
            ],
        );
        expect(line.map((commit) => commit.state)).toEqual(["failure", null, "failure", "success"]);
    });

    describe("an ancestor that was not read breaks isolation", () => {
        const check = job("CI", "unit", "success");
        const hash = (letter: string): string => letter.repeat(40);
        const red = { hash: hash("b"), items: [item("unit", "failure", { logicalId: UNIT })] };
        const green = { hash: hash("c"), items: [item("unit", "success", { logicalId: UNIT })] };

        it("a red after an unread ancestor is not an isolated red", () => {
            const line = flakyLineOf(
                check,
                [check],
                [],
                [
                    { hash: hash("a"), items: null, attempts: [] },
                    { ...red, attempts: [] },
                    { ...green, attempts: [] },
                ],
            );
            expect(flaky(UNIT, line, true)).toBeNull();
        });

        it("a name-only match in a partly read ancestor is unread, not a result", () => {
            const line = flakyLineOf(
                check,
                [check],
                [],
                [
                    {
                        hash: hash("a"),
                        items: [item("unit", "failure")],
                        attempts: [],
                        partial: true,
                    },
                    { ...red, attempts: [] },
                    { ...green, attempts: [] },
                ],
            );
            expect(flaky(UNIT, line, true)).toBeNull();
        });

        it("an ambiguous ancestor cannot prove the next red isolated", () => {
            const line = flakyLineOf(
                check,
                [check],
                [],
                [
                    {
                        hash: hash("a"),
                        items: [
                            item("unit", "success", { logicalId: UNIT }),
                            item("unit", "failure", { logicalId: UNIT }),
                        ],
                        attempts: [],
                    },
                    { ...red, attempts: [] },
                    { ...green, attempts: [] },
                ],
            );
            expect(flaky(UNIT, line, true)).toBeNull();
        });

        it("known Deploy/Lint identities cannot hide CI/unit or break its isolated red", () => {
            const line = flakyLineOf(
                check,
                [check],
                [],
                [
                    {
                        hash: hash("a"),
                        items: [
                            item("unit", "failure", { logicalId: jobId("Deploy", "unit") }),
                            item("unit", "success", { logicalId: jobId("Lint", "unit") }),
                        ],
                        attempts: [],
                    },
                    { ...red, attempts: [] },
                    { ...green, attempts: [] },
                ],
            );
            expect(flaky(UNIT, line, true)).toEqual({ n: 1, m: 3, attemptsCounted: true });
        });

        it("a red between two read greens still counts", () => {
            const line = flakyLineOf(
                check,
                [check],
                [],
                [
                    { ...red, attempts: [] },
                    { ...green, attempts: [] },
                ],
            );
            expect(flaky(UNIT, line, true)).toEqual({ n: 1, m: 3, attemptsCounted: true });
        });
    });

    it("no tag when n=0", () => {
        const line = [plain("success"), plain("failure"), plain("failure")];
        expect(flaky(UNIT, line, true)).toBeNull();
        expect(flaky(UNIT, [], true)).toBeNull();
    });
});
