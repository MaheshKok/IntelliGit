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

import checkRunsFixture from "../../../fixtures/commitChecks/github/checkRuns.json";
import gitlabStatusesFixture from "../../../fixtures/commitChecks/gitlab/statuses.json";
import { readCiHistory } from "../../../../src/services/commitChecks/ciHistory";
import { CredentialStore } from "../../../../src/services/commitChecks/credentialStore";
import type { DefaultBranch } from "../../../../src/services/commitChecks/defaultBranch";
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

    it("two current checks with one logical identity → unknown for both", () => {
        const first = job("CI", "unit", "failure");
        const second = job("CI", "unit", "failure");
        const parent = [item("unit", "success", { logicalId: jobId("CI", "unit") })];
        expect(tag(first, parent, [first, second])).toBe("unknown");
        expect(tag(second, parent, [first, second])).toBe("unknown");
    });
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
        expect(alsoRed(job("CI", "unit", "success"), [], [item("unit", "failure")])).toBe(false);
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

    it("a throwing snapshot read gives null items", async () => {
        const d = deps();
        d.getChecks.mockRejectedValue(new Error("boom"));
        expect((await readCiHistory(d, [PARENT_1])).parent).toEqual({
            hash: PARENT_1,
            items: null,
        });
    });
});

// Recorded per provider (PLAN.md Phase 11): a snapshot item carries `logicalId` only where its
// API names the workflow or pipeline. These fixtures follow the providers' documented response
// shapes; neither names one, so GitHub and GitLab parents are joined by the unique name. A
// logical id set here from the item's own name would make every job on both sides "unknown".
describe("snapshot logical identity per provider", () => {
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
