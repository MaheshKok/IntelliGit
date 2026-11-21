import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitOps } from "../../../../src/git/operations";
import {
    NO_CI_CAPABILITIES,
    type ProviderCiCapabilities,
} from "../../../../src/shared/ci/capabilities";
import type {
    CiState,
    CommitCheckState,
    CommitChecksSnapshot,
    CommitCiDetail,
    CommitCiDetailData,
} from "../../../../src/types";
import { removeScratchDirectories } from "../../../helpers/scratchDirectories";

vi.mock("vscode", () => ({
    l10n: {
        t: (message: string, ...args: unknown[]) =>
            message.replace(/\{(\d+)\}/g, (_match, index: string) => String(args[Number(index)])),
    },
}));

import { CiGenerations } from "../../../../src/services/commitChecks/ciGenerations";
import { CommitChecksCoordinator } from "../../../../src/services/commitChecks/coordinator";
import type { CommitChecksProvider } from "../../../../src/services/commitChecks/types";
import {
    HeadCiStatus,
    PENDING_OBSERVED_KEY,
    type HeadCiStatusDeps,
    type HeadStatusBarItem,
} from "../../../../src/services/commitChecks/headStatus";

const REPO = "/repo";
const HASH = "a".repeat(40);
const RUNS_CAPS: ProviderCiCapabilities = {
    ...NO_CI_CAPABILITIES,
    runs: true,
    jobs: true,
    logs: true,
    rerunFailed: true,
};

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function snapshotOf(state: CommitCheckState): CommitChecksSnapshot {
    return {
        hash: HASH,
        state,
        summary: `summary:${state}`,
        items: [{ name: "check-0", description: "", state, source: "check-run" }],
    };
}

function detailData(job: CiState, outcome: CommitCheckState = "success"): CommitCiDetailData {
    return {
        hash: HASH,
        provider: "github",
        complete: true,
        outcome,
        runs: [
            {
                id: "run-1",
                name: "CI",
                state: job,
                jobs: [
                    {
                        id: "job-0",
                        logicalId: "ci/job-0",
                        name: "job-0",
                        checkName: "job-0",
                        state: job,
                        steps: [],
                    },
                ],
                jobsCoverage: "full",
            },
        ],
        runsCoverage: "full",
        otherChecks: [],
        otherChecksCoverage: "full",
    };
}

function detailOf(job: CiState, outcome: CommitCheckState = "success"): CommitCiDetail {
    return { ...detailData(job, outcome), capabilities: RUNS_CAPS, repoKey: REPO };
}

function fakeItem(): HeadStatusBarItem {
    const item: HeadStatusBarItem = {
        text: "",
        tooltip: undefined,
        command: undefined,
        show: () => undefined,
        hide: () => undefined,
        dispose: () => undefined,
    };
    return item;
}

function pendingMemento() {
    const store = new Map<string, unknown>([
        [PENDING_OBSERVED_KEY, [{ repoKey: REPO, hash: HASH, observedAt: Date.now() }]],
    ]);
    return {
        get: <T>(key: string) => store.get(key) as T | undefined,
        update: async (key: string, value: unknown): Promise<void> => {
            store.set(key, value);
        },
    };
}

interface Setup {
    deps: HeadCiStatusDeps;
    items: HeadStatusBarItem[];
    show: ReturnType<typeof vi.fn>;
    detail: ReturnType<typeof vi.fn>;
    generations: CiGenerations;
    setCooldown(until: number): void;
}

function setup(options: {
    detail: () => Promise<CommitCiDetail | undefined>;
    snapshot?: CommitCheckState;
    claimDir?: string;
    mkdir?: HeadCiStatusDeps["mkdir"];
    pending?: boolean;
}): Setup {
    const items: HeadStatusBarItem[] = [];
    const generations = new CiGenerations();
    const show = vi.fn(async (_message: string, ..._buttons: string[]) => undefined);
    const detail = vi.fn(options.detail);
    let cooldown = 0;
    const deps: HeadCiStatusDeps = {
        switchOn: () => true,
        enabled: () => true,
        settings: () => ({ statusBar: true, notifyOnSettle: true }),
        repoKey: () => REPO,
        headHash: async () => HASH,
        isUnpushed: async () => false,
        capabilities: async () => RUNS_CAPS,
        snapshot: async () => snapshotOf(options.snapshot ?? "success"),
        detail,
        invalidateDetail: async () => undefined,
        cooldownUntil: () => cooldown,
        isFenced: () => false,
        generations,
        workspaceState: pendingMemento(),
        claimDir: options.claimDir ?? path.join(os.tmpdir(), "unused-claims"),
        ...(options.mkdir && { mkdir: options.mkdir }),
        focused: () => true,
        createStatusBarItem: () => {
            const item = fakeItem();
            items.push(item);
            return item;
        },
        showInformationMessage: show,
        openChecks: vi.fn(async () => undefined),
        openLog: vi.fn(async () => undefined),
        rerunFailed: vi.fn(async () => undefined),
    };
    return {
        deps,
        items,
        show,
        detail,
        generations,
        setCooldown: (until) => {
            cooldown = until;
        },
    };
}

let tempDir: string;
let claimDir: string;
const live: HeadCiStatus[] = [];

function track(status: HeadCiStatus): HeadCiStatus {
    live.push(status);
    return status;
}

async function settle(): Promise<void> {
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "intelligit-head-status-review-"));
    claimDir = path.join(tempDir, "ci-toast-claims");
});

afterEach(async () => {
    for (const status of live.splice(0)) status.dispose();
    vi.useRealTimers();
    await removeScratchDirectories(tempDir);
});

describe("round 3 independent interruption variants", () => {
    it.each(["github", "gitlab", "bitbucket-cloud", "bitbucket-server"] as const)(
        "%s snapshot remote await is gated by caller liveness",
        async (id) => {
            const url = deferred<string>();
            const entered = deferred<void>();
            let on = true;
            const getChecks = vi.fn(async () => snapshotOf("pending"));
            const provider = {
                id,
                capabilities: RUNS_CAPS,
                match: () => ({ host: "forge.test", owner: "o", repo: "r" }),
                keyFor: () => `${id}:forge.test:o/r`,
                accountKey: async () => "account-1",
                getChecks,
            } as CommitChecksProvider;
            const gitOps = {
                getRemotes: async () => ["origin"],
                getRemoteUrl: () => {
                    entered.resolve();
                    return url.promise;
                },
            } as unknown as GitOps;
            const s = setup({ detail: async () => undefined, claimDir });
            s.deps.switchOn = () => on;
            const coordinator = new CommitChecksCoordinator(
                gitOps,
                [provider],
                {},
                { generations: s.generations },
            );
            s.deps.snapshot = (hash, opts) => coordinator.getChecks(hash, opts);
            const status = track(new HeadCiStatus(s.deps));
            const run = status.onRepositoryChanged();
            await entered.promise;
            on = false;
            url.resolve("https://forge.test/o/r.git");
            await run;
            expect(
                getChecks,
                "no provider snapshot request after switch off",
            ).not.toHaveBeenCalled();
        },
    );

    it("pending-observed removal failure is traced", async () => {
        const s = setup({ detail: async () => detailOf("success"), claimDir });
        const trace = vi.fn();
        s.deps.trace = trace;
        s.deps.workspaceState.update = async () => {
            throw new Error("memento unavailable");
        };
        await track(new HeadCiStatus(s.deps)).onRepositoryChanged();
        expect(trace, "failed pending-observed writes are traced").toHaveBeenCalledWith(
            expect.objectContaining({ outcome: "failed", reason: "storage" }),
        );
    });

    it.each(["cooldown", "capabilities", "snapshot", "observation"] as const)(
        "switch off during %s does not publish or schedule later work",
        async (step) => {
            let on = true;
            const entered = deferred<void>();
            const gate = deferred<void>();
            const s = setup({
                snapshot: "pending",
                detail: async () => ({ ...detailOf("running", "pending"), complete: false }),
                claimDir,
            });
            s.deps.switchOn = () => on;
            const hold = async <T>(value: T): Promise<T> => {
                entered.resolve();
                await gate.promise;
                return value;
            };
            if (step === "cooldown") s.deps.cooldownUntil = () => hold(0);
            if (step === "capabilities") s.deps.capabilities = () => hold(RUNS_CAPS);
            if (step === "snapshot") s.deps.snapshot = () => hold(snapshotOf("pending"));
            if (step === "observation") s.deps.workspaceState.update = () => hold(undefined);
            const status = track(new HeadCiStatus(s.deps));
            const run = status.onRepositoryChanged();
            await entered.promise;
            on = false;
            const shown = s.items.map((i) => i.text);
            gate.resolve();
            await run;
            await settle();
            expect(s.items.map((i) => i.text)).toEqual(shown);
            expect(status.isPolling(), "no HEAD timer remains after switch-off await").toBe(false);
            expect(s.show).not.toHaveBeenCalled();
        },
    );
});

describe("round 3 deeper coordinator and notification paths", () => {
    it.each(["github", "gitlab"] as const)(
        "%s detail cache await must not start provider after switch off",
        async (id) => {
            const { CommitCiDetailService } =
                await import("../../../../src/services/commitChecks/detailService");
            const gate = deferred<undefined>();
            const entered = deferred<void>();
            let on = true;
            const getDetail = vi.fn(async () => detailData("failure", "failure"));
            const provider = {
                id,
                capabilities: RUNS_CAPS,
                match: () => ({ host: "forge.test" }),
                keyFor: () => `${id}:o/r`,
                accountKey: async () => "account",
                getChecks: vi.fn(),
                getDetail,
            } as CommitChecksProvider;
            const cache = {
                generation: () => "test-generation",
                get: () => {
                    entered.resolve();
                    return gate.promise;
                },
                set: async () => undefined,
            };
            const detailService = new CommitCiDetailService({ persistentCache: cache as never });
            const generations = new CiGenerations();
            const coordinator = new CommitChecksCoordinator(
                {
                    getRemotes: async () => ["origin"],
                    getRemoteUrl: async () => "https://forge.test/o/r.git",
                } as unknown as GitOps,
                [provider],
                {},
                { generations, detailService },
            );
            const run = coordinator.getDetail(
                HASH,
                { isCurrent: () => on },
                generations.capture(REPO),
            );
            await entered.promise;
            on = false;
            gate.resolve(undefined);
            await run;
            expect(
                getDetail,
                "cache await must recheck caller liveness before provider",
            ).not.toHaveBeenCalled();
        },
    );

    it("usual-duration request after detail completion must recheck switch", async () => {
        let on = true;
        const gate = deferred<CommitCiDetailData>();
        const entered = deferred<void>();
        const getUsualDuration = vi.fn(async () => null);
        const provider = {
            id: "github",
            capabilities: { ...RUNS_CAPS, usualDuration: true },
            match: () => ({ host: "github.com" }),
            keyFor: () => "github:o/r",
            accountKey: async () => "account",
            getChecks: vi.fn(),
            getDetail: () => {
                entered.resolve();
                return gate.promise;
            },
            getUsualDuration,
        } as unknown as CommitChecksProvider;
        const generations = new CiGenerations();
        const coordinator = new CommitChecksCoordinator(
            {
                getRemotes: async () => ["origin"],
                getRemoteUrl: async () => "https://github.com/o/r.git",
            } as unknown as GitOps,
            [provider],
            {},
            { generations },
        );
        const run = coordinator.getDetail(HASH, { isCurrent: () => on }, generations.capture(REPO));
        await entered.promise;
        on = false;
        gate.resolve({ ...detailData("running", "pending"), complete: false });
        await run;
        expect(getUsualDuration, "no follow-up CI request after switch off").not.toHaveBeenCalled();
    });

    it("notify disabled suppresses toast and claim even when status remains enabled", async () => {
        const mkdirSpy = vi.fn(async () => undefined);
        const s = setup({ detail: async () => detailOf("success"), claimDir, mkdir: mkdirSpy });
        s.deps.settings = () => ({ statusBar: true, notifyOnSettle: false });
        await track(new HeadCiStatus(s.deps)).onRepositoryChanged();
        expect(s.show).not.toHaveBeenCalled();
        expect(mkdirSpy).not.toHaveBeenCalled();
    });

    it("a real coordinator failed pending refresh shows unavailable and stops retry", async () => {
        let calls = 0;
        const provider = {
            id: "github",
            capabilities: RUNS_CAPS,
            match: () => ({ host: "github.com" }),
            keyFor: () => "github:o/r",
            accountKey: async () => "account",
            getChecks: vi.fn(),
            getDetail: async () =>
                ++calls === 1
                    ? { ...detailData("running", "pending"), complete: false }
                    : { ...detailData("failure", "unavailable"), error: "refresh failed" },
        } as CommitChecksProvider;
        const s = setup({ snapshot: "pending", detail: async () => undefined, claimDir });
        const coordinator = new CommitChecksCoordinator(
            {
                getRemotes: async () => ["origin"],
                getRemoteUrl: async () => "https://github.com/o/r.git",
            } as unknown as GitOps,
            [provider],
            {},
            { generations: s.generations },
        );
        s.deps.detail = (hash, opts, ctx) => coordinator.getDetail(hash, opts, ctx);
        const status = track(new HeadCiStatus(s.deps));
        await status.onRepositoryChanged();
        await settle();
        await status.refresh();
        await settle();
        expect(calls).toBe(2);
        expect
            .soft(s.items[0]?.text, "refreshError must be a failed HEAD detail")
            .toContain("CI unavailable");
        expect.soft(s.items[0]?.tooltip).toBe("refresh failed");
        expect.soft(status.isPolling()).toBe(false);
    });

    it("success notification uses the specified passed text", async () => {
        const s = setup({ detail: async () => detailOf("success"), claimDir });
        await track(new HeadCiStatus(s.deps)).onRepositoryChanged();
        expect(s.show.mock.calls[0][0]).toBe("CI passed on aaaaaaa");
    });

    it("a real file at the child claim path suppresses a toast under EEXIST", async () => {
        const { createHash } = await import("node:crypto");
        const child = createHash("sha256").update(`${REPO}\0${HASH}`).digest("hex");
        await mkdir(claimDir, { recursive: true });
        await writeFile(path.join(claimDir, child), "file already here");
        const s = setup({ detail: async () => detailOf("success"), claimDir });
        await track(new HeadCiStatus(s.deps)).onRepositoryChanged();
        expect(s.show).not.toHaveBeenCalled();
        expect(s.deps.workspaceState.get<unknown[]>(PENDING_OBSERVED_KEY)).toHaveLength(0);
    });
});

describe("round 3 builder additions", () => {
    it("failure notification names the first failed job", async () => {
        const s = setup({
            snapshot: "failure",
            detail: async () => detailOf("failure", "failure"),
            claimDir,
        });
        await track(new HeadCiStatus(s.deps)).onRepositoryChanged();
        expect(s.show.mock.calls[0]?.[0], "failed text from PLAN.md journey 4").toBe(
            "CI failed on aaaaaaa: job-0",
        );
    });

    it("a provider without runs names the failed check from the snapshot", async () => {
        const s = setup({ snapshot: "failure", detail: async () => undefined, claimDir });
        s.deps.capabilities = async () => NO_CI_CAPABILITIES;
        await track(new HeadCiStatus(s.deps)).onRepositoryChanged();
        expect(s.show.mock.calls[0]?.[0], "snapshot-only failed text").toBe(
            "CI failed on aaaaaaa: check-0",
        );
    });

    it("a settled detail whose forced refresh failed shows unavailable, no toast, no retry", async () => {
        const s = setup({
            detail: async () => ({ ...detailOf("success"), refreshError: "refresh failed" }),
            claimDir,
        });
        const status = track(new HeadCiStatus(s.deps));
        await status.onRepositoryChanged();
        expect(s.items[0]?.text, "refreshError on a settled detail is a failed read").toContain(
            "CI unavailable",
        );
        expect(s.items[0]?.tooltip).toBe("refresh failed");
        expect(s.show).not.toHaveBeenCalled();
        expect(status.isPolling()).toBe(false);
    });

    it("an already-claimed commit's failed removal is traced", async () => {
        const s = setup({
            detail: async () => detailOf("success"),
            claimDir,
            mkdir: async (_target, opts) => {
                if (opts?.recursive) return;
                throw Object.assign(new Error("already claimed"), { code: "EEXIST" });
            },
        });
        const trace = vi.fn();
        s.deps.trace = trace;
        s.deps.workspaceState.update = async () => {
            throw new Error("memento unavailable");
        };
        await track(new HeadCiStatus(s.deps)).onRepositoryChanged();
        expect(s.show).not.toHaveBeenCalled();
        expect(trace, "failed removal after EEXIST is traced").toHaveBeenCalledWith(
            expect.objectContaining({ kind: "claim", outcome: "failed", reason: "storage" }),
        );
    });

    it("snapshot account await is gated by caller liveness", async () => {
        const account = deferred<string>();
        const entered = deferred<void>();
        let on = true;
        const getChecks = vi.fn(async () => snapshotOf("pending"));
        const provider = {
            id: "github",
            capabilities: RUNS_CAPS,
            match: () => ({ host: "github.com" }),
            keyFor: () => "github:o/r",
            accountKey: () => {
                entered.resolve();
                return account.promise;
            },
            getChecks,
        } as unknown as CommitChecksProvider;
        const coordinator = new CommitChecksCoordinator(
            {
                getRemotes: async () => ["origin"],
                getRemoteUrl: async () => "https://github.com/o/r.git",
            } as unknown as GitOps,
            [provider],
            {},
            { generations: new CiGenerations() },
        );
        const run = coordinator.getChecks(HASH, { isCurrent: () => on });
        await entered.promise;
        on = false;
        account.resolve("account-1");
        await run;
        expect(
            getChecks,
            "no provider snapshot request after the caller went stale",
        ).not.toHaveBeenCalled();
    });

    it("a live caller that joined a stopped snapshot fetch starts its own", async () => {
        const account = deferred<string>();
        let entered = 0;
        const bothEntered = deferred<void>();
        let on = true;
        const getChecks = vi.fn(async () => snapshotOf("pending"));
        const provider = {
            id: "github",
            capabilities: RUNS_CAPS,
            match: () => ({ host: "github.com" }),
            keyFor: () => "github:o/r",
            accountKey: () => {
                if (++entered === 2) bothEntered.resolve();
                return account.promise;
            },
            getChecks,
        } as unknown as CommitChecksProvider;
        const coordinator = new CommitChecksCoordinator(
            {
                getRemotes: async () => ["origin"],
                getRemoteUrl: async () => "https://github.com/o/r.git",
            } as unknown as GitOps,
            [provider],
            {},
            { generations: new CiGenerations() },
        );
        const stale = coordinator.getChecks(HASH, { isCurrent: () => on });
        const live = coordinator.getChecks(HASH);
        await bothEntered.promise;
        on = false;
        account.resolve("account-1");
        expect((await stale).state).toBe("none");
        expect((await live).state, "the live caller gets its own answer").toBe("pending");
        expect(getChecks).toHaveBeenCalledTimes(1);
    });

    it("a live caller that joined a stopped detail fetch starts its own", async () => {
        const { CommitCiDetailService } =
            await import("../../../../src/services/commitChecks/detailService");
        const gate = deferred<undefined>();
        let entered = 0;
        const bothEntered = deferred<void>();
        let on = true;
        const getDetail = vi.fn(async () => detailData("failure", "failure"));
        const provider = {
            id: "github",
            capabilities: RUNS_CAPS,
            match: () => ({ host: "forge.test" }),
            keyFor: () => "github:o/r",
            accountKey: async () => "account",
            getChecks: vi.fn(),
            getDetail,
        } as unknown as CommitChecksProvider;
        const cache = {
            generation: () => "test-generation",
            get: () => {
                if (++entered === 2) bothEntered.resolve();
                return gate.promise;
            },
            set: async () => undefined,
        };
        const detailService = new CommitCiDetailService({ persistentCache: cache as never });
        const generations = new CiGenerations();
        const coordinator = new CommitChecksCoordinator(
            {
                getRemotes: async () => ["origin"],
                getRemoteUrl: async () => "https://forge.test/o/r.git",
            } as unknown as GitOps,
            [provider],
            {},
            { generations, detailService },
        );
        const stale = coordinator.getDetail(
            HASH,
            { isCurrent: () => on },
            generations.capture(REPO),
        );
        const live = coordinator.getDetail(HASH, {}, generations.capture(REPO));
        await bothEntered.promise;
        on = false;
        gate.resolve(undefined);
        expect(await stale).toBeUndefined();
        expect((await live)?.outcome, "the live caller gets its own detail").toBe("failure");
        expect(getDetail).toHaveBeenCalledTimes(1);
    });
});

describe("round 4 fix round 1", () => {
    it("a fenced HEAD with a settled cancelled snapshot fetches the detail that clears the fence", async () => {
        let fenced = true;
        const s = setup({
            snapshot: "cancelled",
            detail: async () => {
                fenced = false;
                return detailOf("success", "cancelled");
            },
            claimDir,
        });
        s.deps.workspaceState = { get: () => undefined, update: async () => undefined };
        s.deps.isFenced = () => fenced;
        const status = track(new HeadCiStatus(s.deps));
        await status.onRepositoryChanged();
        await settle();
        expect(
            s.detail,
            "a cancelled HEAD under a fence must fetch the detail that clears it",
        ).toHaveBeenCalledTimes(1);
        expect(status.isPolling(), "the cleared fence stops the polling").toBe(false);
    });

    it("a required-check lookup is not sent for a caller that went stale during the default branch read", async () => {
        const branch = deferred<{ name: string }>();
        const entered = deferred<void>();
        let on = true;
        const getRequiredChecks = vi.fn(async () => ({ kind: "none" }));
        const provider = {
            id: "github",
            capabilities: { ...RUNS_CAPS, requiredChecks: true },
            match: () => ({ host: "github.com" }),
            keyFor: () => "github:o/r",
            accountKey: async () => "account",
            getChecks: vi.fn(),
            getDetail: async () => detailData("success"),
            getRequiredChecks,
        } as unknown as CommitChecksProvider;
        const generations = new CiGenerations();
        const coordinator = new CommitChecksCoordinator(
            {
                getRemotes: async () => ["origin"],
                getRemoteUrl: async () => "https://github.com/o/r.git",
                readDefaultBranch: () => {
                    entered.resolve();
                    return branch.promise;
                },
            } as unknown as GitOps,
            [provider],
            {},
            { generations },
        );
        const run = coordinator.getDetail(HASH, { isCurrent: () => on }, generations.capture(REPO));
        await entered.promise;
        on = false;
        branch.resolve({ name: "main" });
        await run;
        expect(
            getRequiredChecks,
            "no required-check provider request after the caller became stale",
        ).not.toHaveBeenCalled();
    });

    it("a manual Refresh of an already settled failing HEAD forces the detail fetch", async () => {
        let calls = 0;
        const provider = {
            id: "github",
            capabilities: RUNS_CAPS,
            match: () => ({ host: "github.com" }),
            keyFor: () => "github:o/r",
            accountKey: async () => "account",
            getChecks: vi.fn(),
            getDetail: async () => {
                const first = detailData("failure", "failure");
                if (++calls === 1) return first;
                const run = first.runs[0]!;
                const added = {
                    ...run.jobs[0]!,
                    id: "job-1",
                    name: "job-1",
                    state: "success" as const,
                };
                return { ...first, runs: [{ ...run, jobs: [...run.jobs, added] }] };
            },
        } as unknown as CommitChecksProvider;
        const s = setup({ snapshot: "failure", detail: async () => undefined, claimDir });
        const coordinator = new CommitChecksCoordinator(
            {
                getRemotes: async () => ["origin"],
                getRemoteUrl: async () => "https://github.com/o/r.git",
            } as unknown as GitOps,
            [provider],
            {},
            { generations: s.generations },
        );
        s.deps.detail = (hash, opts, ctx) => coordinator.getDetail(hash, opts, ctx);
        const status = track(new HeadCiStatus(s.deps));
        await status.onRepositoryChanged();
        await settle();
        await status.refresh();
        await settle();
        expect(calls, "Refresh must reach the provider for the detail").toBe(2);
        expect(s.items[0]?.text, "Refresh must show the new successful job").toContain(
            "$(check) 1",
        );
    });
});
