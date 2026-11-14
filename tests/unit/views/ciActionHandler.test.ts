// Host side of the Checks tab's write actions: the action message is validated and answered
// once, Refresh goes through the fence's user-refresh rule, and a fence change re-posts the
// shown detail under the newest request id.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setE2eControlChannelActive } from "../../../src/e2e/activationState";
import {
    ACTION_FENCE_NOT_SEEN_MS,
    CiActionFenceStore,
} from "../../../src/services/commitChecks/ciActionFence";
import { CiGenerations } from "../../../src/services/commitChecks/ciGenerations";
import { NO_CI_CAPABILITIES } from "../../../src/shared/ci/capabilities";
import { PENDING_CHECK_RETRY_DELAYS_MS } from "../../../src/shared/ci/pollSchedule";
import type { CommitCiDetail } from "../../../src/types";
import { answerCiActionMessage } from "../../../src/views/ciActionHandler";
import {
    answerCommitCiDetailRequest,
    CommitCiDetailLoops,
    type CiActionAccess,
    type CommitCiDetailSource,
} from "../../../src/views/ciDetailHandler";

// The hash validator lives in a module that imports the VS Code API.
vi.mock("vscode", () => ({}));

const HASH = "a".repeat(40);
const REPO = "/repo";

function detail(actionFence?: CommitCiDetail["actionFence"]): CommitCiDetail {
    return {
        hash: HASH,
        provider: "github",
        complete: true,
        outcome: "failure",
        runs: [
            { id: "77", name: "CI", state: "failure", attempt: 1, jobs: [], jobsCoverage: "full" },
        ],
        runsCoverage: "full",
        otherChecks: [],
        otherChecksCoverage: "full",
        capabilities: NO_CI_CAPABILITIES,
        repoKey: REPO,
        ...(actionFence && { actionFence }),
    };
}

function memento() {
    const values = new Map<string, unknown>();
    return {
        get: <T>(key: string) => values.get(key) as T | undefined,
        keys: () => [...values.keys()],
        update: async (key: string, value: unknown) => {
            if (value === undefined) values.delete(key);
            else values.set(key, value);
        },
    };
}

function fencedSource(fences: CiActionFenceStore, actions: Partial<CiActionAccess> = {}) {
    const getDetail = vi.fn(async () => detail(fences.fenceFor(REPO, HASH)));
    const source: CommitCiDetailSource = {
        repoKey: () => REPO,
        generations: new CiGenerations(),
        getDetail,
        actions: {
            fences,
            run: vi.fn(),
            refresh: vi.fn(async () => detail()),
            ...actions,
        },
    };
    return { source, getDetail };
}

async function beginFence(fences: CiActionFenceStore): Promise<void> {
    await fences.begin({
        repoKey: REPO,
        hash: HASH,
        provider: "github",
        action: "rerunFailed",
        targetId: "77",
        runId: "77",
        before: { attempt: 1, state: "failure" },
        evidence: "runAttempt",
    });
}

function deferredVoid(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
}

const request = (requestId: number, force?: boolean) => ({
    type: "requestCommitCiDetail",
    requestId,
    repoKey: REPO,
    hash: HASH,
    ...(force !== undefined && { force }),
});

beforeEach(() => setE2eControlChannelActive(true));
afterEach(() => {
    setE2eControlChannelActive(false);
    vi.useRealTimers();
});

describe("fence re-post", () => {
    it("the not-seen label is re-posted by the fence's timer with no request", async () => {
        vi.useFakeTimers();
        const fences = new CiActionFenceStore(memento());
        await beginFence(fences);
        const { source, getDetail } = fencedSource(fences);
        const post = vi.fn();

        await answerCommitCiDetailRequest(source, request(1), post, new CommitCiDetailLoops());
        expect(post).toHaveBeenLastCalledWith(
            expect.objectContaining({
                requestId: 1,
                detail: expect.objectContaining({
                    actionFence: expect.objectContaining({ notSeen: false }),
                }),
            }),
        );
        await vi.advanceTimersByTimeAsync(ACTION_FENCE_NOT_SEEN_MS);

        expect(post).toHaveBeenLastCalledWith(
            expect.objectContaining({
                requestId: 1,
                detail: expect.objectContaining({
                    actionFence: expect.objectContaining({ notSeen: true }),
                }),
            }),
        );
        expect(getDetail, "the label switches with no request").toHaveBeenCalledTimes(1);
        fences.dispose();
    });

    it("a detail built while a fence ran is posted without its label once the fence ended", async () => {
        const running = new CiActionFenceStore(memento());
        await beginFence(running);
        const label = running.fenceFor(REPO, HASH);
        const fences = new CiActionFenceStore(memento());
        const { source } = fencedSource(fences);
        source.getDetail = vi.fn(async () => detail(label));
        const post = vi.fn();

        await answerCommitCiDetailRequest(source, request(1), post, new CommitCiDetailLoops());

        expect(label, "the detail was built with a label").toBeDefined();
        expect(
            post.mock.calls.at(-1)?.[0].detail.actionFence,
            "an ended fence's label must not be posted",
        ).toBeUndefined();
        running.dispose();
        fences.dispose();
    });

    it("a fence that ended re-reads the detail instead of re-posting the copy from before", async () => {
        const fences = new CiActionFenceStore(memento());
        await beginFence(fences);
        const { source, getDetail } = fencedSource(fences);
        const post = vi.fn();
        await answerCommitCiDetailRequest(source, request(1), post, new CommitCiDetailLoops());

        await fences.resolve(REPO, HASH, {
            ...detail(),
            runs: [
                {
                    id: "77",
                    name: "CI",
                    state: "queued",
                    attempt: 2,
                    jobs: [],
                    jobsCoverage: "full",
                },
            ],
        });

        await vi.waitFor(() => expect(getDetail).toHaveBeenCalledTimes(2));
        await vi.waitFor(() =>
            expect(post.mock.calls.at(-1)?.[0].detail.actionFence).toBeUndefined(),
        );
        fences.dispose();
    });

    it("a fence change after a scan page re-posts that page, never the older first reply", async () => {
        vi.useFakeTimers();
        const fences = new CiActionFenceStore(memento());
        await beginFence(fences);
        let onScanUpdate: ((update: CommitCiDetail) => void) | undefined;
        const { source } = fencedSource(fences);
        const post = vi.fn();
        await answerCommitCiDetailRequest(
            {
                ...source,
                getDetail: async (_hash, _options, _ctx, onUpdate) => {
                    onScanUpdate = onUpdate;
                    return detail(fences.fenceFor(REPO, HASH));
                },
            },
            request(1),
            post,
            new CommitCiDetailLoops(),
        );
        const page = {
            ...detail(),
            runs: [{ ...detail().runs[0]!, failedScan: { state: "done" as const, found: 1 } }],
        };
        onScanUpdate?.(page);

        await vi.advanceTimersByTimeAsync(ACTION_FENCE_NOT_SEEN_MS);

        expect(
            post.mock.calls.at(-1)?.[0].detail,
            "the not-seen re-post carries the newest scan page",
        ).toEqual({ ...page, actionFence: expect.objectContaining({ notSeen: true }) });
        fences.dispose();
    });

    // The coordinator builds a scan page or a reply with the fence of that moment, then holds it
    // across the rule read and the account check; the not-seen timer can fire meanwhile.
    it("a scan page held across the not-seen timer is posted with the live label", async () => {
        vi.useFakeTimers();
        const fences = new CiActionFenceStore(memento());
        await beginFence(fences);
        let onScanUpdate: ((update: CommitCiDetail) => void) | undefined;
        const { source } = fencedSource(fences);
        const post = vi.fn();
        await answerCommitCiDetailRequest(
            {
                ...source,
                getDetail: async (_hash, _options, _ctx, onUpdate) => {
                    onScanUpdate = onUpdate;
                    return detail(fences.fenceFor(REPO, HASH));
                },
            },
            request(1),
            post,
            new CommitCiDetailLoops(),
        );
        const held = {
            ...detail(fences.fenceFor(REPO, HASH)),
            runs: [{ ...detail().runs[0]!, failedScan: { state: "done" as const, found: 1 } }],
        };

        await vi.advanceTimersByTimeAsync(ACTION_FENCE_NOT_SEEN_MS);
        onScanUpdate?.(held);

        expect(
            post.mock.calls.at(-1)?.[0].detail.actionFence?.notSeen,
            "a held scan page must show the live not-seen label",
        ).toBe(true);
        fences.dispose();
    });

    it("a ladder reply held across the not-seen timer is posted with the live label", async () => {
        vi.useFakeTimers();
        const fences = new CiActionFenceStore(memento());
        await beginFence(fences);
        const running = {
            ...detail(),
            runs: [{ ...detail().runs[0]!, failedScan: { state: "running" as const, found: 0 } }],
        };
        const release = deferredVoid();
        let reads = 0;
        const { source } = fencedSource(fences);
        const post = vi.fn();
        const answered = answerCommitCiDetailRequest(
            {
                ...source,
                getDetail: async () => {
                    reads += 1;
                    const actionFence = fences.fenceFor(REPO, HASH);
                    if (reads === 1) return { ...running, ...(actionFence && { actionFence }) };
                    await release.promise;
                    return detail(actionFence);
                },
            },
            request(1),
            post,
            new CommitCiDetailLoops(),
        );

        await vi.advanceTimersByTimeAsync(PENDING_CHECK_RETRY_DELAYS_MS[0]!);
        expect(reads, "the ladder re-read has started").toBe(2);
        await vi.advanceTimersByTimeAsync(ACTION_FENCE_NOT_SEEN_MS);
        release.resolve();
        await answered;

        expect(
            post.mock.calls.at(-1)?.[0].detail.actionFence?.notSeen,
            "a held ladder reply must show the live not-seen label",
        ).toBe(true);
        fences.dispose();
    });

    it("a newer request stops the older one's re-post", async () => {
        vi.useFakeTimers();
        const fences = new CiActionFenceStore(memento());
        await beginFence(fences);
        const { source } = fencedSource(fences);
        const loops = new CommitCiDetailLoops();
        const older = vi.fn();
        await answerCommitCiDetailRequest(source, request(1), older, loops);
        await answerCommitCiDetailRequest(source, request(2), vi.fn(), loops);

        await vi.advanceTimersByTimeAsync(ACTION_FENCE_NOT_SEEN_MS);

        expect(older).toHaveBeenCalledTimes(1);
        fences.dispose();
    });

    it("Refresh goes through the actions' refresh, never a plain forced fetch", async () => {
        const fences = new CiActionFenceStore(memento());
        const refresh = vi.fn(async () => detail());
        const { source, getDetail } = fencedSource(fences, { refresh });

        await answerCommitCiDetailRequest(
            source,
            request(1, true),
            vi.fn(),
            new CommitCiDetailLoops(),
        );

        expect(refresh).toHaveBeenCalledWith(
            HASH,
            expect.objectContaining({ repoKey: REPO }),
            expect.any(Function),
        );
        expect(getDetail).not.toHaveBeenCalled();
        fences.dispose();
    });
});

describe("answerCiActionMessage", () => {
    const message = (overrides: Record<string, unknown> = {}) => ({
        type: "runCiAction",
        requestId: 3,
        repoKey: REPO,
        hash: HASH,
        action: "rerunFailed",
        runId: "77",
        ...overrides,
    });

    function actionSource(outcome: Awaited<ReturnType<CiActionAccess["run"]>>, helpUrl?: string) {
        const run = vi.fn(async () => outcome);
        let repoKey = REPO;
        const source: CommitCiDetailSource = {
            repoKey: () => repoKey,
            generations: new CiGenerations(),
            getDetail: vi.fn(),
            actions: {
                fences: new CiActionFenceStore(memento()),
                run,
                refresh: vi.fn(),
                ...(helpUrl && { helpUrl }),
            },
        };
        return { source, run, switchRepo: (next: string) => (repoKey = next) };
    }

    it("runs the action once and posts a forbidden outcome with the help link", async () => {
        const { source, run } = actionSource(
            { outcome: "forbidden" },
            "https://docs.example/write",
        );
        const post = vi.fn();

        await answerCiActionMessage(source, message(), post);

        expect(run).toHaveBeenCalledTimes(1);
        expect(run).toHaveBeenCalledWith(
            HASH,
            { action: "rerunFailed", runId: "77" },
            expect.objectContaining({ repoKey: REPO }),
            expect.any(Function),
        );
        expect(post).toHaveBeenCalledWith({
            type: "ciActionResult",
            requestId: 3,
            repoKey: REPO,
            hash: HASH,
            outcome: "forbidden",
            helpUrl: "https://docs.example/write",
        });
    });

    it("passes the job id of a job re-run", async () => {
        const { source, run } = actionSource({ outcome: "ok" });
        await answerCiActionMessage(
            source,
            message({ action: "rerunJob", jobId: "5001" }),
            vi.fn(),
        );
        expect(run).toHaveBeenCalledWith(
            HASH,
            { action: "rerunJob", runId: "77", jobId: "5001" },
            expect.anything(),
            expect.any(Function),
        );
    });

    it("hands the action the live repository, so a switch during the write is seen", async () => {
        const { source, run, switchRepo } = actionSource({ outcome: "ok" });
        await answerCiActionMessage(source, message(), vi.fn());
        const liveRepoKey = run.mock.calls[0][3] as () => string;
        expect(liveRepoKey()).toBe(REPO);
        switchRepo("/other");
        expect(liveRepoKey(), "the host's current repository, not the captured one").toBe("/other");
    });

    it("posts a sign-in outcome with its message", async () => {
        const { source } = actionSource({ outcome: "signedOut", message: "Sign in to github.com" });
        const post = vi.fn();
        await answerCiActionMessage(source, message(), post);
        expect(post).toHaveBeenCalledWith({
            type: "ciActionResult",
            requestId: 3,
            repoKey: REPO,
            hash: HASH,
            outcome: "signedOut",
            message: "Sign in to github.com",
        });
    });

    it("rejects a malformed message without running anything", async () => {
        const { source, run } = actionSource({ outcome: "ok" });
        for (const bad of [
            { action: "rerun" },
            { hash: "nope" },
            { runId: "" },
            { action: "rerunJob" },
            { action: "cancel", jobId: "5001" },
        ]) {
            await expect(
                answerCiActionMessage(source, message(bad), vi.fn()),
                JSON.stringify(bad),
            ).rejects.toThrow();
        }
        expect(run).not.toHaveBeenCalled();
    });

    it("runs nothing while the Checks tab switch is off or for another repository", async () => {
        const { source, run } = actionSource({ outcome: "ok" });
        setE2eControlChannelActive(false);
        await answerCiActionMessage(source, message(), vi.fn());
        setE2eControlChannelActive(true);
        await answerCiActionMessage(source, message({ repoKey: "/other" }), vi.fn());
        expect(run).not.toHaveBeenCalled();
    });

    it("drops the reply when the repository changed meanwhile", async () => {
        const { source, run, switchRepo } = actionSource({ outcome: "ok" });
        run.mockImplementation(async () => {
            switchRepo("/other");
            return { outcome: "ok" };
        });
        const post = vi.fn();
        await answerCiActionMessage(source, message(), post);
        expect(post).not.toHaveBeenCalled();
    });
});
