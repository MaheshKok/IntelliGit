import { mkdtemp, mkdir } from "node:fs/promises";
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

describe("HeadCiStatus review round 2", () => {
    it("real coordinator sends no provider request after invalidation interrupted by switch", async () => {
        const generations = new CiGenerations();
        const url = deferred<string>();
        let urlCalls = 0;
        const getDetail = vi.fn(async () => detailData("success"));
        const provider: CommitChecksProvider = {
            id: "github",
            capabilities: NO_CI_CAPABILITIES,
            match: () => ({ host: "github.com", owner: "o", repo: "r" }),
            keyFor: () => "github:github.com:o/r",
            getChecks: vi.fn(),
            getDetail,
        };
        const gitOps = {
            getRemotes: vi.fn(async () => ["origin"]),
            getRemoteUrl: vi.fn(() =>
                ++urlCalls === 1 ? url.promise : Promise.resolve("https://github.com/o/r.git"),
            ),
        } as unknown as GitOps;
        const coordinator = new CommitChecksCoordinator(gitOps, [provider], {}, { generations });
        const s = setup({ detail: async () => undefined });
        let on = true;
        s.deps.switchOn = () => on;
        s.deps.generations = generations;
        s.deps.invalidateDetail = (hash) => coordinator.invalidateDetail(hash);
        s.deps.detail = (hash, fetchOptions, ctx) => coordinator.getDetail(hash, fetchOptions, ctx);
        const status = track(new HeadCiStatus(s.deps));

        const run = status.onRepositoryChanged();
        await vi.waitFor(() => expect(urlCalls).toBe(1));
        on = false;
        url.resolve("https://github.com/o/r.git");
        await run;

        expect(getDetail).not.toHaveBeenCalled();
    });

    it("same HEAD refresh during the atomic claim does not lose the only notification", async () => {
        const claim = heldClaim();
        const s = setup({
            detail: async () => detailOf("success"),
            claimDir,
            mkdir: claim.held,
        });
        const status = track(new HeadCiStatus(s.deps));

        const first = status.onRepositoryChanged();
        await claim.started;
        await status.refresh();
        claim.release();
        await first;
        await settle();

        expect(s.show).toHaveBeenCalledTimes(1);
    });

    it("same HEAD refresh that settles after the claim finished still shows the notification", async () => {
        const claim = heldClaim();
        const second = deferred<CommitCiDetail>();
        let calls = 0;
        const s = setup({
            detail: () => (++calls === 1 ? Promise.resolve(detailOf("success")) : second.promise),
            claimDir,
            mkdir: claim.held,
        });
        const status = track(new HeadCiStatus(s.deps));

        const first = status.onRepositoryChanged();
        await claim.started;
        const refresh = status.refresh();
        await vi.waitFor(() => expect(s.detail).toHaveBeenCalledTimes(2));
        claim.release();
        await first;
        second.resolve(detailOf("success"));
        await refresh;
        await settle();

        expect(s.show).toHaveBeenCalledTimes(1);
    });

    it("same HEAD refresh during a failed claim keeps the notification for the next focus", async () => {
        let failures = 1;
        const gate = deferred<void>();
        const started = deferred<void>();
        const flaky: HeadCiStatusDeps["mkdir"] = async (target, options) => {
            if (!options?.recursive && failures-- > 0) {
                started.resolve();
                await gate.promise;
                const error = new Error("denied") as NodeJS.ErrnoException;
                error.code = "EACCES";
                throw error;
            }
            return mkdir(target, options);
        };
        const s = setup({ detail: async () => detailOf("success"), claimDir, mkdir: flaky });
        const status = track(new HeadCiStatus(s.deps));

        const first = status.onRepositoryChanged();
        await started.promise;
        await status.refresh();
        gate.resolve();
        await first;
        await settle();
        expect(s.show).not.toHaveBeenCalled();
        await status.onWindowFocused();
        await settle();

        expect(s.show).toHaveBeenCalledTimes(1);
    });

    it("unavailable settled detail shows the error and has no automatic retry", async () => {
        vi.useFakeTimers();
        const s = setup({
            snapshot: "failure",
            detail: async () => ({ ...detailOf("failure", "unavailable"), error: "detail boom" }),
        });
        const status = track(new HeadCiStatus(s.deps));

        await status.onRepositoryChanged();
        await vi.advanceTimersByTimeAsync(600_000);

        expect(s.items[0]?.text).toContain("CI unavailable");
        expect(s.items[0]?.tooltip).toBe("detail boom");
        expect(s.detail).toHaveBeenCalledTimes(1);
        expect(status.isPolling()).toBe(false);
        expect(s.show).not.toHaveBeenCalled();
    });

    it("unavailable settled detail still pauses and resumes around a rate limit", async () => {
        vi.useFakeTimers();
        const s = setup({
            snapshot: "failure",
            detail: async () => {
                s.setCooldown(Date.now() + 60_000);
                return { ...detailOf("failure", "unavailable"), error: "HTTP 429" };
            },
        });
        const status = track(new HeadCiStatus(s.deps));

        await status.onRepositoryChanged();
        expect(s.items[0]?.text).toContain("CI paused");
        expect(status.isPolling()).toBe(true);
        s.setCooldown(0);
        await vi.advanceTimersByTimeAsync(60_000);

        expect(s.detail).toHaveBeenCalledTimes(2);
    });

    it("failed-write observations also expire after seven days", async () => {
        let now = Date.UTC(2026, 10, 1);
        const failing = {
            get: <T>(_key: string): T | undefined => undefined,
            update: async (): Promise<void> => {
                throw new Error("memento disk full");
            },
        };
        const set = new PendingObservedSet(failing, () => now);

        await expect(set.add(REPO, HASH)).rejects.toThrow("memento disk full");
        now += 7 * DAY_MS - 1;
        expect(set.has(REPO, HASH)).toBe(true);
        now += 2;

        expect(set.has(REPO, HASH)).toBe(false);
    });
});
