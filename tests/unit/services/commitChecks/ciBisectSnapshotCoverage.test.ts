// "Find where CI broke" over what the provider really returns: a GitLab pipeline job arrives in the
// snapshot as a commit status, and a snapshot read in part is incomplete CI data, not "no jobs".

import { expect, it, vi } from "vitest";
import { runCiBisect, type CiBisectSource } from "../../../../src/services/commitChecks/ciBisect";
import { CommitChecksCoordinator } from "../../../../src/services/commitChecks/coordinator";
import type { CredentialStore } from "../../../../src/services/commitChecks/credentialStore";
import { GitLabProvider } from "../../../../src/services/commitChecks/gitlabProvider";
import type { FetchJson, FetchJsonWithMeta } from "../../../../src/services/commitChecks/http";
import type { CiAttemptHistory, CommitChecksSnapshot } from "../../../../src/types";

vi.mock("vscode", () => ({ l10n: { t: (message: string) => message } }));

const hash = "a".repeat(40);
const range = [{ hash, parents: [] }];
const run = (source: CiBisectSource) =>
    runCiBisect(source, range, range, new AbortController().signal, () => undefined);

it("counts a GitLab pipeline job's failed-then-passed re-run from its real snapshot and attempt adapters", async () => {
    const snapshot: FetchJson = async (url) => {
        expect(new URL(url).pathname).toContain(`/commits/${hash}/statuses`);
        return [
            {
                id: 31,
                name: "unit-tests",
                status: "success",
                target_url: "https://gitlab.com/o/r/-/jobs/31",
            },
        ];
    };
    const fetchHistory: FetchJsonWithMeta = async (url) => {
        const { pathname, searchParams } = new URL(url);
        let body: unknown;
        if (pathname.endsWith("/pipelines")) {
            expect(searchParams.get("sha")).toBe(hash);
            body = [{ id: 21 }];
        } else if (pathname.endsWith("/pipelines/21")) {
            body = { id: 21, name: "Build pipeline" };
        } else {
            expect(pathname).toContain("/pipelines/21/jobs");
            expect(searchParams.get("include_retried")).toBe("true");
            body = [
                {
                    id: 31,
                    name: "unit-tests",
                    status: "success",
                    created_at: "2026-11-07T15:00:00Z",
                },
                {
                    id: 30,
                    name: "unit-tests",
                    status: "failed",
                    created_at: "2026-11-07T14:00:00Z",
                },
            ];
        }
        return { body, headers: {}, statusCode: 200 };
    };
    const credentials = { get: vi.fn(async () => "fixture-token") } as unknown as CredentialStore;
    const provider = new GitLabProvider(snapshot, credentials, /unit-tests/, fetchHistory);
    const ref = { host: "gitlab.com", owner: "o", repo: "r" };
    const git = {
        getRemotes: async () => ["origin"],
        getRemoteUrl: async () => "https://gitlab.com/o/r.git",
    };
    const coordinator = new CommitChecksCoordinator(git as never, [provider]);
    expect((await provider.getChecks(ref, hash)).items).toMatchObject([
        { name: "unit-tests", source: "status" },
    ]);
    expect(await provider.getAttemptHistory(ref, hash)).toMatchObject([
        {
            logicalId: "job\0Build pipeline\0unit-tests",
            attempts: [
                { state: "failure", executionId: "30" },
                { state: "success", executionId: "31" },
            ],
        },
    ]);

    const result = await run(coordinator);
    expect(result?.jobs).toHaveLength(1);
    expect(result?.jobs[0].states).toEqual(["success"]);
    expect(
        result?.jobs[0].flaky,
        "GitLab's verified retry must contribute to the bisect flaky count",
    ).toEqual({
        n: 1,
        m: 1,
        attemptsCounted: true,
    });
});

it.each([
    ["99", "unit-tests", "an outside status whose id is no execution of the history"],
    ["31", "lint", "a status of another name whose id happens to be the job's"],
])(
    "keeps an unrelated flat status apart from a job's re-run history (id %s, %s)",
    async (id, name, why) => {
        const history: CiAttemptHistory[] = [
            {
                runId: "21",
                logicalId: "job\0Build pipeline\0unit-tests",
                coverage: "full",
                attempts: [
                    { attempt: 1, executionId: "30", state: "failure" },
                    { attempt: 2, executionId: "31", state: "success" },
                ],
            },
        ];
        const source: CiBisectSource = {
            capabilities: async () => ({ attemptHistory: true }) as never,
            attemptHistory: async () => history,
            getChecks: async () => ({
                hash,
                state: "success",
                summary: "",
                items: [{ id, name, source: "status", description: "", state: "success" }],
            }),
        };
        expect(
            (await run(source))?.jobs[0].flaky,
            `${why}: the history is not this status's`,
        ).toBeNull();
    },
);

it("reports incomplete CI instead of no jobs when only the empty endpoint responded", async () => {
    const empty: CommitChecksSnapshot = { hash, state: "none", summary: "", items: [] };
    const getChecks = vi.fn(async (): Promise<CommitChecksSnapshot> => ({
        ...empty,
        partial: true,
    }));
    const source: CiBisectSource = {
        capabilities: async () => undefined,
        attemptHistory: async () => [],
        getChecks,
    };
    expect(
        await run(source),
        "an incomplete empty snapshot is not a clean no-jobs result",
    ).toMatchObject({
        commits: [hash],
        jobs: [],
        failedReads: 1,
    });
    getChecks.mockResolvedValueOnce(empty);
    expect(
        (await run(source))?.failedReads,
        "a fully read empty snapshot is clean",
    ).toBeUndefined();
});

it("Retry reads a commit cached as a partial snapshot again", async () => {
    let partial = true;
    const sent: string[] = [];
    const provider = {
        id: "github",
        capabilities: {},
        match: () => ({ host: "github.com", owner: "o", repo: "r" }),
        keyFor: () => "github:github.com/o/r",
        // One of GitHub's two endpoints failing leaves an empty, partial list.
        async getChecks(_ref: unknown, sha: string): Promise<CommitChecksSnapshot> {
            sent.push(sha);
            return partial
                ? { hash: sha, state: "none", summary: "", items: [], partial: true }
                : {
                      hash: sha,
                      state: "success",
                      summary: "",
                      items: [
                          { name: "unit", source: "check-run", description: "", state: "success" },
                      ],
                  };
        },
    };
    const coordinator = new CommitChecksCoordinator(
        {
            getRemotes: async () => ["origin"],
            getRemoteUrl: async () => "https://github.com/o/r",
            readDefaultBranch: async () => null,
        } as never,
        [provider as never],
        {},
    );
    expect((await run(coordinator))?.failedReads, "the partial read is incomplete CI data").toBe(1);
    partial = false;
    expect((await run(coordinator))?.failedReads, "an ordinary start is cache first").toBe(1);
    const retried = await runCiBisect(
        coordinator,
        range,
        range,
        new AbortController().signal,
        () => undefined,
        undefined,
        true,
    );
    expect(retried?.failedReads, "Retry reads the incomplete commit again").toBeUndefined();
    expect(retried?.jobs.map((job) => job.checkName)).toEqual(["unit"]);
    expect(sent, "one first read and one Retry read").toEqual([hash, hash]);
});
