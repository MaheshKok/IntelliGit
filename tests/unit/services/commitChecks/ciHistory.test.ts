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
import { readCiHistory } from "../../../../src/services/commitChecks/ciHistory";
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
    historyChecksOf,
    join,
    type CiHistoryCheck,
} from "../../../../src/shared/ci/history";
import { logicalCheckId } from "../../../../src/shared/ci/identity";
import type { CiJob, CommitCheckItem, CommitChecksSnapshot } from "../../../../src/types";

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
        const provider = new GitHubProvider(async (url: string) =>
            url.includes("/check-runs") ? checkRunsFixture : { statuses: [] },
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
