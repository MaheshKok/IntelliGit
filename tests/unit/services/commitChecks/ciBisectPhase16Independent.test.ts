// "Find where CI broke" (PLAN.md section 9 and 13): a flat commit status keeps its own identity
// when re-run histories are associated, and one Retry sends one request per failed commit.

import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({ l10n: { t: (message: string) => message } }));

import { runCiBisect, type CiBisectSource } from "../../../../src/services/commitChecks/ciBisect";
import { CommitChecksCoordinator } from "../../../../src/services/commitChecks/coordinator";
import type {
    CiAttemptHistory,
    CommitCheckItem,
    CommitChecksSnapshot,
} from "../../../../src/types";

const h = (c: string): string => c.repeat(40);

function item(source: CommitCheckItem["source"]): CommitCheckItem {
    return { name: "build", description: "", state: "success", source };
}

/** A workflow job `build` that failed and then passed on a re-run. */
const jobRerun: CiAttemptHistory = {
    runId: "1",
    logicalId: "job\0wf\0build",
    coverage: "full",
    attempts: [
        { attempt: 1, executionId: "1", state: "failure" },
        { attempt: 2, executionId: "2", state: "success" },
    ],
};

describe("runCiBisect job identity", () => {
    async function flakyOf(source: CommitCheckItem["source"]) {
        const bisectSource: CiBisectSource = {
            capabilities: async () => ({ attemptHistory: true }) as never,
            attemptHistory: async () => [jobRerun],
            getChecks: async (hash) => ({
                hash,
                state: "success",
                summary: "",
                items: [item(source)],
            }),
        };
        const commits = [{ hash: h("a"), parents: [h("b")] }];
        const result = await runCiBisect(
            bisectSource,
            commits,
            commits,
            new AbortController().signal,
            () => {},
        );
        return result?.jobs[0].flaky;
    }

    it("does not transfer a workflow job's re-run to an identically named flat commit status", async () => {
        expect(
            await flakyOf("status"),
            "the flat status cannot inherit a workflow job's retry",
        ).toBeNull();
    });

    it("control: a check run of the same name keeps the job's re-run", async () => {
        expect(await flakyOf("check-run")).toEqual({ n: 1, m: 1, attemptsCounted: true });
    });
});

describe("runCiBisect Retry", () => {
    function harness(getChecks: (hash: string) => Promise<CommitChecksSnapshot>) {
        const provider = {
            id: "github",
            capabilities: { attemptHistory: false },
            match: () => ({ host: "github.com", owner: "o", repo: "r" }),
            keyFor: () => "github:github.com/o/r",
            getChecks: vi.fn((_ref: unknown, hash: string) => getChecks(hash)),
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
        const commits = [{ hash: h("a"), parents: [h("b")] }];
        const run = (refresh: boolean) =>
            runCiBisect(
                coordinator,
                commits,
                commits,
                new AbortController().signal,
                () => {},
                () => true,
                refresh,
            );
        return { provider, run };
    }

    const unavailable = (hash: string): CommitChecksSnapshot => ({
        hash,
        state: "unavailable",
        summary: "",
        items: [],
        error: "outage",
    });

    it("one Retry does not send a second request when an uncached read fails", async () => {
        const { provider, run } = harness(async (hash) => unavailable(hash));
        const result = await run(true);
        expect(result?.failedReads).toBe(1);
        expect(
            provider.getChecks,
            "one Retry should make one fresh request per failed commit",
        ).toHaveBeenCalledTimes(1);
    });

    it("control: Retry asks a commit cached as an error once more and shows its recovery", async () => {
        let outage = true;
        const { provider, run } = harness(async (hash) =>
            outage
                ? unavailable(hash)
                : { hash, state: "success", summary: "", items: [item("check-run")] },
        );
        expect((await run(false))?.failedReads).toBe(1);
        outage = false;
        const retried = await run(true);
        expect(provider.getChecks).toHaveBeenCalledTimes(2);
        expect(retried?.failedReads).toBeUndefined();
    });
});

describe("runCiBisect round 2", () => {
    const chain = ["a", "b", "c", "d"].map((part, index, all) => ({
        hash: h(part),
        parents: index === all.length - 1 ? [] : [h(all[index + 1])],
    }));
    const checkItem = (
        source: CommitCheckItem["source"],
        state: CommitCheckItem["state"],
    ): CommitCheckItem => ({ name: "build", description: "", source, state });
    const run = (byHash: Map<string, CommitCheckItem[] | "unavailable">, commits = chain) =>
        runCiBisect(
            {
                capabilities: async () => undefined,
                attemptHistory: async () => [],
                getChecks: async (hash) => {
                    const items = byHash.get(hash) ?? [];
                    return items === "unavailable"
                        ? { hash, state: "unavailable", summary: "", items: [], error: "offline" }
                        : { hash, state: "success", summary: "", items };
                },
            },
            commits,
            commits,
            new AbortController().signal,
            () => {},
        );

    it("a GitHub check run and a flat status never share a break point", async () => {
        const [newer, older] = chain;
        const result = await run(
            new Map([
                [newer.hash, [checkItem("check-run", "failure")]],
                [older.hash, [checkItem("status", "success")]],
            ]),
            [newer, older],
        );
        expect(
            result?.jobs.map((job) => job.brokeAt),
            "a green flat status must not prove a workflow job's break point",
        ).not.toContain(newer.hash);
        expect(result?.jobs).toHaveLength(2);
    });

    it("a red flat status and a green check run of one name stay two jobs", async () => {
        const [newer, older] = chain;
        const result = await run(
            new Map([
                [newer.hash, [checkItem("status", "failure")]],
                [older.hash, [checkItem("check-run", "success")]],
            ]),
            [newer, older],
        );
        expect(result?.jobs.map((job) => job.brokeAt)).toEqual([null, null]);
        expect(result?.jobs).toHaveLength(2);
    });

    it("control: two flat statuses of one name still find the break point", async () => {
        const [newer, older] = chain;
        const result = await run(
            new Map([
                [newer.hash, [checkItem("status", "failure")]],
                [older.hash, [checkItem("status", "success")]],
            ]),
            [newer, older],
        );
        expect(result?.jobs.map((job) => job.brokeAt)).toEqual([newer.hash]);
    });

    it("marks a red isolated across a fully read commit where the job did not run", async () => {
        const result = await run(
            new Map([
                [chain[0].hash, [checkItem("check-run", "success")]],
                [chain[2].hash, [checkItem("check-run", "failure")]],
                [chain[3].hash, [checkItem("check-run", "success")]],
            ]),
        );
        expect(result?.jobs[0]).toMatchObject({
            states: ["success", "failure", null, "success"],
            isolated: [false, true, false, false],
            flaky: { n: 1, m: 3, attemptsCounted: false },
        });
    });

    it("control: an unread commit between a red and a green keeps the red not isolated", async () => {
        const result = await run(
            new Map<string, CommitCheckItem[] | "unavailable">([
                [chain[0].hash, [checkItem("check-run", "success")]],
                [chain[1].hash, "unavailable"],
                [chain[2].hash, [checkItem("check-run", "failure")]],
                [chain[3].hash, [checkItem("check-run", "success")]],
            ]),
        );
        expect(result?.jobs[0].isolated).toEqual([false, false, false, false]);
        expect(result?.jobs[0].flaky).toBeNull();
    });
});
