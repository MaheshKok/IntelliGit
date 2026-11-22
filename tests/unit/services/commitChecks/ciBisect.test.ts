// "Find where CI broke" (PLAN.md §13, Phase 16): the bisect reads each selected commit's checks
// through the coordinator and the request gate, stops on cancel (before queueing, inside the gate
// and before progress), keeps to the loaded commits and names a break only on a first-parent chain.

import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({ l10n: { t: (message: string) => message } }));

import { runCiBisect, type CiBisectSource } from "../../../../src/services/commitChecks/ciBisect";
import { CommitChecksCoordinator } from "../../../../src/services/commitChecks/coordinator";
import { normalizeGithubChecks } from "../../../../src/services/commitChecks/githubProvider";
import { CommitChecksRequestGateRegistry } from "../../../../src/services/commitChecks/requestGate";
import { brokeAt } from "../../../../src/shared/ci/history";
import type {
    CiAttemptHistory,
    CommitCheckItem,
    CommitChecksSnapshot,
} from "../../../../src/types";

const API = "https://api.github.com/repos/o/r";
const h = (c: string): string => c.repeat(40);

type Items = Record<string, CommitCheckItem[]>;

function check(name: string, state: CommitCheckItem["state"], logicalId?: string): CommitCheckItem {
    return {
        name,
        description: "",
        state,
        source: "check-run",
        ...(logicalId === undefined ? {} : { logicalId }),
    };
}

/** A real coordinator over a provider whose every request goes through a real request gate. */
function harness(
    items: Items,
    options: { hold?: boolean; attempts?: Record<string, CiAttemptHistory[]> } = {},
) {
    const registry = new CommitChecksRequestGateRegistry("cooling down", () => 1_000);
    const sent: string[] = [];
    const attemptReads: string[] = [];
    const held: Array<() => void> = [];
    const hold = (): Promise<void> =>
        options.hold ? new Promise<void>((resolve) => held.push(resolve)) : Promise.resolve();
    const provider = {
        id: "github",
        capabilities: { attemptHistory: options.attempts !== undefined },
        match: () => ({ host: "github.com", owner: "o", repo: "r" }),
        keyFor: () => "github:github.com/o/r",
        // Like the real providers, a failed request becomes an unavailable snapshot.
        async getChecks(_ref: unknown, hash: string): Promise<CommitChecksSnapshot> {
            try {
                return await registry.run("github", `${API}/commits/${hash}`, async () => {
                    sent.push(hash);
                    await hold();
                    const list = items[hash] ?? [];
                    return { hash, state: "success", summary: "", items: list };
                });
            } catch (err) {
                return { hash, state: "unavailable", summary: "", items: [], error: String(err) };
            }
        },
        async getAttemptHistory(_ref: unknown, hash: string): Promise<CiAttemptHistory[]> {
            return registry.run("github", `${API}/runs/${hash}`, async () => {
                attemptReads.push(hash);
                return options.attempts?.[hash] ?? [];
            });
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
    /** Occupies every slot of the bucket with other work until `release` runs. */
    const occupy = (): { release: () => void; done: Promise<unknown> } => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        const done = Promise.all(
            Array.from({ length: 4 }, () => registry.run("github", `${API}/other`, () => gate)),
        );
        return { release, done };
    };
    return { coordinator, sent, attemptReads, held, occupy };
}

/** A first-parent chain, newest first: each commit's first parent is the next one. */
function chain(...hashes: string[]): { hash: string; parents: string[] }[] {
    return hashes.map((hash, index) => ({
        hash,
        parents: index + 1 < hashes.length ? [hashes[index + 1]] : [h("0")],
    }));
}

const flush = async (): Promise<void> => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
};

describe("runCiBisect", () => {
    it("uses gate: with every gate slot busy the bisect sends nothing until a slot frees", async () => {
        const commits = chain(h("a"), h("b"));
        const { coordinator, sent, occupy } = harness({});
        const other = occupy();
        await flush();
        const running = runCiBisect(
            coordinator,
            commits,
            commits,
            new AbortController().signal,
            () => {},
        );
        await flush();
        expect(sent, "no bisect request may pass a full gate").toEqual([]);
        other.release();
        await running;
        expect([...sent].sort(), "every commit was read once the gate admitted it").toEqual(
            [h("a"), h("b")].sort(),
        );
    });

    it("cached commits cost no request", async () => {
        const commits = chain(h("a"), h("b"));
        const { coordinator, sent } = harness({ [h("a")]: [check("unit", "failure")] });
        await coordinator.getChecks(h("a"));
        expect(sent).toEqual([h("a")]);
        await runCiBisect(coordinator, commits, commits, new AbortController().signal, () => {});
        expect(sent, "the cached commit is not asked again").toEqual([h("a"), h("b")]);
    });

    it("cancel stops queued: commits not started when the token is cancelled are never read", async () => {
        const hashes = ["a", "b", "c", "d", "e", "f", "g", "i"].map(h);
        const commits = chain(...hashes);
        const { coordinator, sent, held } = harness({}, { hold: true });
        const controller = new AbortController();
        const running = runCiBisect(coordinator, commits, commits, controller.signal, () => {});
        await flush();
        expect(sent.length, "four reads run at once").toBe(4);
        controller.abort();
        for (const release of held.splice(0)) release();
        expect(await running, "a cancelled bisect has no result").toBeUndefined();
        await flush();
        expect(sent.length, "no queued commit started after the cancel").toBe(4);
    });

    it("cancel with all four gate slots busy sends nothing more", async () => {
        const commits = chain(h("a"), h("b"), h("c"));
        const { coordinator, sent, occupy } = harness({});
        const other = occupy();
        await flush();
        const controller = new AbortController();
        const progress: number[] = [];
        const running = runCiBisect(coordinator, commits, commits, controller.signal, (done) =>
            progress.push(done),
        );
        await flush();
        expect(sent, "the bisect's reads wait for a slot").toEqual([]);
        controller.abort();
        other.release();
        await other.done;
        expect(await running).toBeUndefined();
        await flush();
        expect(sent, "a read admitted after the cancel is never sent").toEqual([]);
        expect(progress, "no progress after the cancel").toEqual([]);
        // The refused reads were not cached as answers: a later read asks the provider.
        await coordinator.getChecks(h("a"));
        expect(sent).toEqual([h("a")]);
    });

    it("caps to loaded rows: a selected commit the host has not loaded is dropped", async () => {
        const loaded = chain(h("a"), h("b"));
        const selected = [...loaded, { hash: h("c"), parents: [h("d")] }];
        const { coordinator, sent } = harness({});
        const result = await runCiBisect(
            coordinator,
            selected,
            loaded,
            new AbortController().signal,
            () => {},
        );
        expect([...sent].sort(), "only loaded commits are read").toEqual([h("a"), h("b")].sort());
        expect(result?.limitedTo, "the cap note names the loaded commits read").toBe(2);
    });

    it("an uncapped selection carries no cap note", async () => {
        const commits = chain(h("a"), h("b"));
        const { coordinator } = harness({});
        const result = await runCiBisect(
            coordinator,
            commits,
            commits,
            new AbortController().signal,
            () => {},
        );
        expect(result?.limitedTo).toBeUndefined();
    });

    it("brokeAt only on a first-parent chain, whatever the list order", async () => {
        // Chain a <- b <- c <- d (d oldest); listed out of order.
        const [a, b, c, d] = ["a", "b", "c", "d"].map(h);
        const commits = chain(a, b, c, d);
        const listed = [commits[2], commits[0], commits[3], commits[1]];
        const items: Items = {
            [a]: [check("unit", "failure", "w/unit")],
            [b]: [check("unit", "failure", "w/unit")],
            [c]: [check("unit", "success", "w/unit")],
            [d]: [check("unit", "failure", "w/unit")],
        };
        const { coordinator } = harness(items);
        const result = await runCiBisect(
            coordinator,
            listed,
            commits,
            new AbortController().signal,
            () => {},
        );
        expect(result?.linear).toBe(true);
        expect(result?.jobs).toHaveLength(1);
        expect(result?.jobs[0].brokeAt, "the oldest red of the newest run after a green").toBe(b);
        expect(result?.jobs[0].states, "oldest to newest along the chain").toEqual([
            "failure",
            "success",
            "failure",
            "failure",
        ]);
        expect(result?.commits, "the commit of each square, oldest to newest").toEqual([
            d,
            c,
            b,
            a,
        ]);
    });

    it("non-linear selection gives linear false and brokeAt null", async () => {
        // m merges x into a; x is not on m's first-parent walk.
        const [m, a, x] = ["c", "a", "e"].map(h);
        const commits = [
            { hash: m, parents: [a, x] },
            { hash: x, parents: [h("0")] },
            { hash: a, parents: [h("0")] },
        ];
        const items: Items = {
            [m]: [check("unit", "failure", "w/unit")],
            [x]: [check("unit", "failure", "w/unit")],
            [a]: [check("unit", "success", "w/unit")],
        };
        const { coordinator } = harness(items);
        const result = await runCiBisect(
            coordinator,
            commits,
            commits,
            new AbortController().signal,
            () => {},
        );
        expect(result?.linear, "a merge's second parent is off the walk").toBe(false);
        expect(result?.jobs[0].brokeAt, "no break point off a straight line").toBeNull();
        expect(result?.jobs[0].states, "list order, oldest to newest").toEqual([
            "success",
            "failure",
            "failure",
        ]);
        expect(result?.commits).toEqual([a, x, m]);
    });

    it("progress posted per commit", async () => {
        const commits = chain(h("a"), h("b"), h("c"));
        const { coordinator } = harness({});
        const progress: Array<[number, number]> = [];
        await runCiBisect(coordinator, commits, commits, new AbortController().signal, (d, t) =>
            progress.push([d, t]),
        );
        expect(progress).toEqual([
            [1, 3],
            [2, 3],
            [3, 3],
        ]);
    });

    it("disposal cancels: an aborted run sends nothing and reports nothing", async () => {
        const commits = chain(h("a"), h("b"));
        const { coordinator, sent } = harness({});
        const controller = new AbortController();
        controller.abort();
        const progress: number[] = [];
        const result = await runCiBisect(coordinator, commits, commits, controller.signal, (d) =>
            progress.push(d),
        );
        expect(result).toBeUndefined();
        expect(sent).toEqual([]);
        expect(progress).toEqual([]);
    });

    it("flaky over the chain, with re-runs counted when the provider lists them", async () => {
        const [a, b, c, d] = ["a", "b", "c", "d"].map(h);
        const commits = chain(a, b, c, d);
        const items: Items = {
            [a]: [check("unit", "success", "w/unit")],
            [b]: [check("unit", "failure", "w/unit")],
            [c]: [check("unit", "success", "w/unit")],
            [d]: [check("unit", "success", "w/unit")],
        };
        const { coordinator, attemptReads } = harness(items, { attempts: {} });
        const result = await runCiBisect(
            coordinator,
            commits,
            commits,
            new AbortController().signal,
            () => {},
        );
        expect(result?.jobs[0].flaky).toEqual({ n: 1, m: 4, attemptsCounted: true });
        // §9 as written: the newest run of reds preceded by a green, even one fixed since.
        expect(result?.jobs[0].brokeAt).toBe(b);
        expect([...attemptReads].sort(), "re-runs read per commit").toEqual([a, b, c, d].sort());
    });

    it("flaky is estimated when the provider cannot list re-runs", async () => {
        const [a, b, c] = ["a", "b", "c"].map(h);
        const commits = chain(a, b, c);
        const items: Items = {
            [a]: [check("unit", "success")],
            [b]: [check("unit", "failure")],
            [c]: [check("unit", "success")],
        };
        const { coordinator, attemptReads } = harness(items);
        const result = await runCiBisect(
            coordinator,
            commits,
            commits,
            new AbortController().signal,
            () => {},
        );
        expect(result?.jobs[0]).toMatchObject({
            checkName: "unit",
            flaky: { n: 1, m: 3, attemptsCounted: false },
        });
        expect(attemptReads).toEqual([]);
    });

    it("a live caller joining a cancelled attempt read still gets the re-run history", async () => {
        const [a] = [h("a")];
        const history = [
            {
                runId: "1",
                logicalId: "job\0W\0unit",
                coverage: "full",
                attempts: [
                    { executionId: "1", attempt: 1, state: "failure" },
                    { executionId: "2", attempt: 2, state: "success" },
                ],
            },
        ] as CiAttemptHistory[];
        const { coordinator, occupy } = harness({}, { attempts: { [a]: history } });
        const other = occupy();
        await flush();
        let live = true;
        const first = coordinator.attemptHistory(a, () => live);
        await flush();
        live = false;
        const second = coordinator.attemptHistory(a, () => true);
        await flush();
        other.release();
        await other.done;
        await first;
        expect(await second, "a cancelled owner must not erase the live joiner history").toEqual(
            history,
        );
    });

    it("a cancelled caller alone still sends nothing once the gate admits its read", async () => {
        const [a] = [h("a")];
        const { coordinator, occupy, attemptReads } = harness({}, { attempts: { [a]: [] } });
        const other = occupy();
        await flush();
        let live = true;
        const only = coordinator.attemptHistory(a, () => live);
        await flush();
        live = false;
        other.release();
        await other.done;
        expect(await only).toBeNull();
        expect(attemptReads).toEqual([]);
    });
});

describe("runCiBisect job identity and coverage", () => {
    const quiet = (): [AbortSignal, () => void] => [new AbortController().signal, () => {}];

    /** A source with fixed snapshots, no gate: only what the join and the coverage rules see. */
    function stub(
        items: Items,
        extra: Partial<CommitChecksSnapshot> & { partialOn?: string } = {},
        attempts: CiAttemptHistory[] = [],
    ): CiBisectSource {
        const { partialOn, ...rest } = extra;
        return {
            capabilities: async () => ({ attemptHistory: attempts.length > 0 }) as never,
            getChecks: async (hash) => ({
                hash,
                state: "success",
                summary: "",
                items: items[hash] ?? [],
                ...rest,
                ...(hash === partialOn ? { partial: true } : {}),
            }),
            attemptHistory: async () => attempts,
        };
    }

    it("unique name fallback joins identified and unlabelled snapshots into one job", async () => {
        const [a, b] = ["a", "b"].map(h);
        const commits = chain(a, b);
        const source = stub({
            [a]: [check("unit-tests", "failure", "job\0CI\0unit-tests")],
            [b]: [check("unit-tests", "success")],
        });
        const result = await runCiBisect(source, commits, commits, ...quiet());
        expect(result?.jobs, "one logical check across both commits").toHaveLength(1);
        expect(result?.jobs[0].states).toEqual(["success", "failure"]);
        expect(result?.jobs[0].brokeAt).toBe(a);
    });

    it("two same-named identified jobs stay two jobs, and a flat check of that name proves neither", async () => {
        const [a, b] = ["a", "b"].map(h);
        const commits = chain(a, b);
        const source = stub({
            [a]: [
                check("unit", "failure", "job\0W1\0unit"),
                check("unit", "failure", "job\0W2\0unit"),
            ],
            [b]: [check("unit", "success")],
        });
        const result = await runCiBisect(source, commits, commits, ...quiet());
        expect(result?.jobs).toHaveLength(3);
        expect(result?.jobs.map((job) => job.brokeAt)).toEqual([null, null, null]);
    });

    it("a partial snapshot cannot prove a unique-name green baseline", async () => {
        const [a, b] = ["a", "b"].map(h);
        const commits = chain(a, b);
        const source = stub(
            { [a]: [check("unit", "failure")], [b]: [check("unit", "success")] },
            { partialOn: b },
        );
        const result = await runCiBisect(source, commits, commits, ...quiet());
        expect(result?.jobs).toHaveLength(1);
        expect(
            result?.jobs[0].brokeAt,
            "an incomplete population cannot prove the preceding green",
        ).toBeNull();
        expect(result?.jobs[0].states).toEqual([null, "failure"]);
    });

    it("a partial snapshot still proves a match by logical id", async () => {
        const [a, b] = ["a", "b"].map(h);
        const commits = chain(a, b);
        const source = stub(
            {
                [a]: [check("unit", "failure", "job\0W\0unit")],
                [b]: [check("unit", "success", "job\0W\0unit")],
            },
            { partialOn: b },
        );
        const result = await runCiBisect(source, commits, commits, ...quiet());
        expect(result?.jobs[0].brokeAt).toBe(a);
    });

    it("a GitHub re-run from failed to passed is counted in bisect", async () => {
        const [a] = [h("a")];
        const snapshot = normalizeGithubChecks(
            a,
            {
                check_runs: [
                    { id: 10, name: "unit-tests", status: "completed", conclusion: "success" },
                ],
            },
            [],
        );
        expect(
            snapshot.items[0].logicalId,
            "a GitHub snapshot check has no logical id",
        ).toBeUndefined();
        const attempts = [
            {
                runId: "77",
                logicalId: "job\0CI\0unit-tests",
                coverage: "full",
                attempts: [
                    { executionId: "9", attempt: 1, state: "failure" },
                    { executionId: "10", attempt: 2, state: "success" },
                ],
            },
        ] as CiAttemptHistory[];
        const source: CiBisectSource = {
            ...stub({}, {}, attempts),
            getChecks: async () => snapshot,
        };
        const result = await runCiBisect(source, chain(a), chain(a), ...quiet());
        expect(result?.jobs[0].flaky, "the provider proved a failed then passed attempt").toEqual({
            n: 1,
            m: 1,
            attemptsCounted: true,
        });
    });

    it("a name shared by two workflows' jobs is not resolved to either's re-runs", async () => {
        const [a] = [h("a")];
        const history = (workflow: string): CiAttemptHistory =>
            ({
                runId: workflow,
                logicalId: `job\0${workflow}\0unit-tests`,
                coverage: "full",
                attempts: [
                    { executionId: `${workflow}1`, attempt: 1, state: "failure" },
                    { executionId: `${workflow}2`, attempt: 2, state: "success" },
                ],
            }) as CiAttemptHistory;
        const source = stub({ [a]: [check("unit-tests", "success")] }, {}, [
            history("W1"),
            history("W2"),
        ]);
        const result = await runCiBisect(source, chain(a), chain(a), ...quiet());
        expect(result?.jobs[0].flaky).toBeNull();
    });

    it("does not merge two known workflow identities through an unlabelled middle commit", async () => {
        const [a, b, c] = ["a", "b", "c"].map(h);
        const commits = chain(a, b, c);
        const source = stub({
            [a]: [check("unit", "failure", "job\0W1\0unit")],
            [b]: [check("unit", "success")],
            [c]: [check("unit", "success", "job\0W2\0unit")],
        });
        const result = await runCiBisect(source, commits, commits, ...quiet());
        expect(result?.jobs, "different known logical ids must retain separate rows").toHaveLength(
            2,
        );
        // The unlabelled middle fits both names, so neither identity proves it.
        expect(result?.jobs.map((job) => job.states)).toEqual([
            [null, null, "failure"],
            ["success", null, null],
        ]);
    });

    it("reports the commits whose checks could not be read", async () => {
        const [a, b, c] = ["a", "b", "c"].map(h);
        const commits = chain(a, b, c);
        const source: CiBisectSource = {
            ...stub({}),
            getChecks: async (hash) =>
                hash === b
                    ? { hash, state: "unavailable", summary: "", items: [], error: "timed out" }
                    : { hash, state: "success", summary: "", items: [check("unit", "success")] },
        };
        const some = await runCiBisect(source, commits, commits, ...quiet());
        expect(some?.failedReads, "one unread commit of three").toBe(1);
        const none = await runCiBisect(stub({}), commits, commits, ...quiet());
        expect(none?.failedReads, "a successful empty read is not a failure").toBeUndefined();
        const every: CiBisectSource = {
            ...stub({}),
            getChecks: async (hash) => ({
                hash,
                state: "unavailable",
                summary: "",
                items: [],
                error: "timed out",
            }),
        };
        const all = await runCiBisect(every, commits, commits, ...quiet());
        expect(all?.jobs).toEqual([]);
        expect(all?.failedReads, "every read failed").toBe(3);
    });

    describe("cost of the join", () => {
        const hashes = Array.from({ length: 20 }, (_, index) => h(String.fromCharCode(97 + index)));
        interface Counter {
            reads: number;
            limit: number;
            hit: () => void;
        }

        /** An item whose name counts every read of it: the join's work, measured without a clock. */
        function counted(name: string, counter: Counter): CommitCheckItem {
            const item = check(name, "success");
            Object.defineProperty(item, "name", {
                enumerable: true,
                get: () => {
                    counter.reads += 1;
                    if (counter.reads === counter.limit) counter.hit();
                    return name;
                },
            });
            return item;
        }

        const sourceOf = (counter: Counter): CiBisectSource => ({
            ...stub({}),
            getChecks: async (hash) => ({
                hash,
                state: "success",
                summary: "",
                items: Array.from({ length: 200 }, (_, index) => counted(`job-${index}`, counter)),
            }),
        });

        it("reads each item a bounded number of times, not once per pair of commits", async () => {
            const counter: Counter = { reads: 0, limit: -1, hit: () => {} };
            const commits = chain(...hashes);
            const result = await runCiBisect(sourceOf(counter), commits, commits, ...quiet());
            expect(result?.jobs).toHaveLength(200);
            expect(counter.reads, "name reads for 20 commits of 200 checks").toBeLessThan(
                1_000_000,
            );
        });

        it("stops joining once cancelled instead of running to the end", async () => {
            const commits = chain(...hashes);
            const full: Counter = { reads: 0, limit: -1, hit: () => {} };
            await runCiBisect(sourceOf(full), commits, commits, ...quiet());
            const controller = new AbortController();
            const cut: Counter = {
                reads: 0,
                limit: Math.floor(full.reads / 4),
                hit: () => controller.abort(),
            };
            const result = await runCiBisect(
                sourceOf(cut),
                commits,
                commits,
                controller.signal,
                () => {},
            );
            expect(result, "a cancel during the join returns nothing").toBeUndefined();
            expect(cut.reads, "the join stopped early").toBeLessThan(full.reads / 2);
        });
    });
});

describe("brokeAt", () => {
    const line = (...states: Array<"failure" | "success" | null>) =>
        states.map((state, index) => ({ hash: String(index), state }));

    it("names the oldest red of the newest run that a green precedes", () => {
        expect(brokeAt(line("failure", "failure", "success", "failure"))).toBe("1");
    });

    it("is null without a preceding green", () => {
        expect(brokeAt(line("failure", "failure"))).toBeNull();
        expect(brokeAt(line("failure", null, "success"))).toBeNull();
    });

    it("is null with no red", () => {
        expect(brokeAt(line("success", "success"))).toBeNull();
    });
});
