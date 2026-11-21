import { mkdtemp, mkdir, writeFile, unlink } from "node:fs/promises";
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
    PendingObservedSet,
    type HeadCiStatusDeps,
    type HeadStatusBarItem,
} from "../../../../src/services/commitChecks/headStatus";

const REPO = "/repo";
const HASH = "a".repeat(40);
const DAY_MS = 24 * 60 * 60 * 1000;
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

/** A claim `mkdir` that waits at the claim step (not the parent folder) until released. */
function heldClaim(afterGate?: () => void) {
    const gate = deferred<void>();
    const started = deferred<void>();
    const held: HeadCiStatusDeps["mkdir"] = async (target, options) => {
        if (!options?.recursive) {
            started.resolve();
            await gate.promise;
            afterGate?.();
        }
        return mkdir(target, options);
    };
    return { held, started: started.promise, release: () => gate.resolve() };
}

describe("independent phase 13 scenarios", () => {
    it("HEAD A to B to A recovers an unshown claim exactly once", async () => {
        let head = HASH;
        const claim = heldClaim();
        const s = setup({ detail: async () => detailOf("success"), claimDir, mkdir: claim.held });
        s.deps.headHash = async () => head;
        s.deps.capabilities = async (hash) => (hash === HASH ? RUNS_CAPS : undefined);
        const status = track(new HeadCiStatus(s.deps));
        const first = status.onRepositoryChanged();
        await claim.started;
        head = "b".repeat(40);
        await status.onRepositoryChanged();
        claim.release();
        await first;
        expect(s.show).not.toHaveBeenCalled();
        head = HASH;
        await status.onRepositoryChanged();
        await status.refresh();
        await status.onWindowFocused();
        expect(s.show).toHaveBeenCalledTimes(1);
    });

    it("thrown settled detail shows error and stops automatic retry", async () => {
        vi.useFakeTimers();
        const s = setup({
            snapshot: "failure",
            detail: async () => {
                throw new Error("detail throw");
            },
            claimDir,
        });
        const status = track(new HeadCiStatus(s.deps));
        await status.onRepositoryChanged();
        await vi.advanceTimersByTimeAsync(600_000);
        expect.soft(s.items[0]?.text).toContain("CI unavailable");
        expect.soft(s.items[0]?.tooltip).toBe("detail throw");
        expect.soft(s.detail).toHaveBeenCalledTimes(1);
        expect.soft(status.isPolling()).toBe(false);
    });

    it("parent mkdir EEXIST keeps observation and retries after storage repair", async () => {
        await writeFile(claimDir, "existing file at claim parent");
        await expect(mkdir(claimDir, { recursive: true })).rejects.toMatchObject({
            code: "EEXIST",
        });
        const s = setup({ detail: async () => detailOf("success"), claimDir });
        const status = track(new HeadCiStatus(s.deps));
        await status.onRepositoryChanged();
        expect(s.show).not.toHaveBeenCalled();
        const pendingAfterFailure = s.deps.workspaceState.get<unknown[]>(PENDING_OBSERVED_KEY);
        await unlink(claimDir);
        await status.onWindowFocused();
        await settle();
        expect(pendingAfterFailure).toHaveLength(1);
        expect(s.show).toHaveBeenCalledTimes(1);
    });

    it("real coordinator detail resolution rechecks switch before provider request", async () => {
        const url = deferred<string>();
        const entered = deferred<void>();
        let on = true;
        const getDetail = vi.fn(async () => detailData("failure", "failure"));
        const accountKey = vi.fn(async () => "account-1");
        const provider: CommitChecksProvider = {
            id: "github",
            capabilities: RUNS_CAPS,
            match: () => ({ host: "github.com", owner: "o", repo: "r" }),
            keyFor: () => "github:github.com:o/r",
            accountKey,
            getChecks: vi.fn(),
            getDetail,
        };
        const gitOps = {
            getRemotes: vi.fn(async () => ["origin"]),
            getRemoteUrl: vi.fn(() => {
                entered.resolve();
                return url.promise;
            }),
        } as unknown as GitOps;
        const s = setup({ snapshot: "failure", detail: async () => undefined, claimDir });
        s.deps.workspaceState = {
            get: <T>(_key: string): T | undefined => undefined,
            update: async () => undefined,
        };
        const coordinator = new CommitChecksCoordinator(
            gitOps,
            [provider],
            {},
            { generations: s.generations },
        );
        s.deps.switchOn = () => on;
        s.deps.detail = (hash, options, ctx) => coordinator.getDetail(hash, options, ctx);
        const status = track(new HeadCiStatus(s.deps));
        const run = status.onRepositoryChanged();
        await entered.promise;
        on = false;
        url.resolve("https://github.com/o/r.git");
        await run;
        expect(getDetail).not.toHaveBeenCalled();
        // Stopped right after the remote resolution: not even the sign-in is asked.
        expect(accountKey).not.toHaveBeenCalled();
    });

    it("real coordinator account read rechecks switch before provider request", async () => {
        const account = deferred<string>();
        const entered = deferred<void>();
        let on = true;
        const getDetail = vi.fn(async () => detailData("failure", "failure"));
        const provider: CommitChecksProvider = {
            id: "github",
            capabilities: RUNS_CAPS,
            match: () => ({ host: "github.com", owner: "o", repo: "r" }),
            keyFor: () => "github:github.com:o/r",
            accountKey: () => {
                entered.resolve();
                return account.promise;
            },
            getChecks: vi.fn(),
            getDetail,
        };
        const gitOps = {
            getRemotes: vi.fn(async () => ["origin"]),
            getRemoteUrl: vi.fn(async () => "https://github.com/o/r.git"),
        } as unknown as GitOps;
        const s = setup({ snapshot: "failure", detail: async () => undefined, claimDir });
        s.deps.workspaceState = {
            get: <T>(_key: string): T | undefined => undefined,
            update: async () => undefined,
        };
        const coordinator = new CommitChecksCoordinator(
            gitOps,
            [provider],
            {},
            { generations: s.generations },
        );
        s.deps.switchOn = () => on;
        s.deps.detail = (hash, options, ctx) => coordinator.getDetail(hash, options, ctx);
        const status = track(new HeadCiStatus(s.deps));
        const run = status.onRepositoryChanged();
        await entered.promise;
        on = false;
        account.resolve("account-1");
        await run;
        expect(getDetail).not.toHaveBeenCalled();
    });

    it("elapsed ticker stops publishing after switch off", async () => {
        vi.useFakeTimers();
        let on = true;
        const started = { ...detailOf("running", "pending"), complete: false };
        started.runs[0].startedAt = new Date(Date.now() - 10_000).toISOString();
        const s = setup({ snapshot: "pending", detail: async () => started, claimDir });
        s.deps.switchOn = () => on;
        const status = track(new HeadCiStatus(s.deps));
        await status.onRepositoryChanged();
        await Promise.resolve();
        const before = s.items[0]?.text;
        on = false;
        await vi.advanceTimersByTimeAsync(1_000);
        expect.soft(s.items[0]?.text).toBe(before);
        expect.soft(vi.getTimerCount()).toBe(0);
    });

    it.each(["switch", "HEAD", "dispose", "repo", "auth"])(
        "invalidation interrupted by %s sends no detail request",
        async (interrupt) => {
            const gate = deferred<void>();
            const entered = deferred<void>();
            const s = setup({ detail: async () => detailOf("success"), claimDir });
            let on = true;
            let hash = HASH;
            let repo = REPO;
            s.deps.switchOn = () => on;
            s.deps.headHash = async () => hash;
            s.deps.repoKey = () => repo;
            s.deps.capabilities = async (value) => (value === HASH ? RUNS_CAPS : undefined);
            s.deps.invalidateDetail = async () => {
                entered.resolve();
                await gate.promise;
            };
            const status = track(new HeadCiStatus(s.deps));
            const run = status.onRepositoryChanged();
            await entered.promise;
            if (interrupt === "switch") on = false;
            if (interrupt === "dispose") status.dispose();
            if (interrupt === "repo") repo = "/other";
            if (interrupt === "auth") s.generations.bumpAuth();
            if (interrupt === "HEAD") {
                hash = "b".repeat(40);
                await status.onRepositoryChanged();
            }
            const before = s.detail.mock.calls.length;
            gate.resolve();
            await run;
            expect(s.detail.mock.calls.length).toBe(before);
            expect(s.show).not.toHaveBeenCalled();
        },
    );

    it("show command rechecks switch after HEAD lookup", async () => {
        const head = deferred<string>();
        const s = setup({ detail: async () => detailOf("success"), claimDir });
        let on = true;
        s.deps.switchOn = () => on;
        s.deps.headHash = () => head.promise;
        const status = track(new HeadCiStatus(s.deps));
        const run = status.showHeadChecks();
        on = false;
        head.resolve(HASH);
        await run;
        expect(s.deps.openChecks).not.toHaveBeenCalled();
    });

    it("claim waits for pending-observed removal before showing", async () => {
        const s = setup({ detail: async () => detailOf("success"), claimDir });
        const gate = deferred<void>();
        const entered = deferred<void>();
        const original = s.deps.workspaceState.update;
        s.deps.workspaceState.update = async (key, value) => {
            entered.resolve();
            await gate.promise;
            await original(key, value);
        };
        const status = track(new HeadCiStatus(s.deps));
        const run = status.onRepositoryChanged();
        await entered.promise;
        const shownBeforeRemoval = s.show.mock.calls.length;
        gate.resolve();
        await run;
        expect(shownBeforeRemoval).toBe(0);
        expect(s.show).toHaveBeenCalledTimes(1);
    });

    it("switch off during parent mkdir prevents the later claim mkdir", async () => {
        const gate = deferred<void>();
        const entered = deferred<void>();
        let on = true;
        const mkdirSpy = vi.fn(async (target: string, options?: { recursive?: boolean }) => {
            if (options?.recursive) {
                entered.resolve();
                await gate.promise;
            }
            return mkdir(target, options);
        });
        const s = setup({ detail: async () => detailOf("success"), claimDir, mkdir: mkdirSpy });
        s.deps.switchOn = () => on;
        const status = track(new HeadCiStatus(s.deps));
        const run = status.onRepositoryChanged();
        await entered.promise;
        on = false;
        gate.resolve();
        await run;
        expect(mkdirSpy.mock.calls.filter(([, options]) => !options?.recursive)).toHaveLength(0);
        expect(s.show).not.toHaveBeenCalled();
    });

    it("unavailable incomplete detail shows error and stops automatic retry", async () => {
        vi.useFakeTimers();
        const s = setup({
            snapshot: "pending",
            detail: async () => ({ ...detailOf("failure", "unavailable"), error: "detail boom" }),
            claimDir,
        });
        const status = track(new HeadCiStatus(s.deps));
        await status.onRepositoryChanged();
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(600_000);
        expect.soft(s.items[0]?.text).toContain("CI unavailable");
        expect.soft(s.items[0]?.tooltip).toBe("detail boom");
        expect.soft(s.detail).toHaveBeenCalledTimes(1);
        expect.soft(status.isPolling()).toBe(false);
    });

    it("thrown incomplete detail shows error and stops automatic retry", async () => {
        vi.useFakeTimers();
        const s = setup({
            snapshot: "pending",
            detail: async () => {
                throw new Error("detail throw");
            },
            claimDir,
        });
        const status = track(new HeadCiStatus(s.deps));
        await status.onRepositoryChanged();
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(600_000);
        expect.soft(s.items[0]?.text).toContain("CI unavailable");
        expect.soft(s.items[0]?.tooltip).toBe("detail throw");
        expect.soft(s.detail).toHaveBeenCalledTimes(1);
        expect.soft(status.isPolling()).toBe(false);
    });

    it("unavailable incomplete detail during a cooldown pauses and resumes", async () => {
        vi.useFakeTimers();
        let startCooldown = (_until: number): void => undefined;
        let calls = 0;
        const s = setup({
            snapshot: "pending",
            detail: async () => {
                // The gate entered its cooldown while this detail was read.
                if (++calls === 1) startCooldown(Date.now() + 60_000);
                return { ...detailOf("failure", "unavailable"), error: "rate limited" };
            },
            claimDir,
        });
        startCooldown = s.setCooldown;
        const status = track(new HeadCiStatus(s.deps));
        await status.onRepositoryChanged();
        await Promise.resolve();
        await Promise.resolve();
        expect(s.items[0]?.text).toContain("CI paused");
        expect(status.isPolling()).toBe(true);
        s.setCooldown(0);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(s.detail).toHaveBeenCalledTimes(2);
    });

    it("stale during the pending-observed removal keeps the observation for the next poll", async () => {
        const s = setup({ detail: async () => detailOf("success"), claimDir });
        const gate = deferred<void>();
        const entered = deferred<void>();
        const original = s.deps.workspaceState.update;
        let hold = true;
        s.deps.workspaceState.update = async (key, value) => {
            if (hold) {
                hold = false;
                entered.resolve();
                await gate.promise;
            }
            await original(key, value);
        };
        const status = track(new HeadCiStatus(s.deps));
        const run = status.onRepositoryChanged();
        await entered.promise;
        s.generations.bumpAuth();
        gate.resolve();
        await run;
        expect(s.show).not.toHaveBeenCalled();
        expect(s.deps.workspaceState.get<unknown[]>(PENDING_OBSERVED_KEY)).toHaveLength(1);
        await status.refresh();
        expect(s.show).toHaveBeenCalledTimes(1);
    });

    it("dispose during claim publishes nothing", async () => {
        const claim = heldClaim();
        const s = setup({ detail: async () => detailOf("success"), claimDir, mkdir: claim.held });
        const status = track(new HeadCiStatus(s.deps));
        const run = status.onRepositoryChanged();
        await claim.started;
        status.dispose();
        claim.release();
        await run;
        expect(s.show).not.toHaveBeenCalled();
    });

    it("sign-out during claim publishes nothing", async () => {
        const claim = heldClaim();
        const s = setup({ detail: async () => detailOf("success"), claimDir, mkdir: claim.held });
        const status = track(new HeadCiStatus(s.deps));
        const run = status.onRepositoryChanged();
        await claim.started;
        s.generations.bumpAuth();
        claim.release();
        await run;
        expect(s.show).not.toHaveBeenCalled();
    });
});
