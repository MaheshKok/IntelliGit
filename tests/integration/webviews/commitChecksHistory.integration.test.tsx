// @vitest-environment jsdom
// The Checks tab's history tags (PLAN.md journey 9, Phase 11): once a commit's detail renders,
// the tab asks its host for the first parent's and the default branch tip's snapshots and tags
// each job "new", "still", "fixed" or "unknown", plus "also red on <branch>". Only the reply to
// the newest request for the commit on screen renders.

import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CiDetailPersistentCache } from "../../../src/services/commitChecks/detailPersistentCache";
import { CommitCiDetailService } from "../../../src/services/commitChecks/detailService";
import { NO_CI_CAPABILITIES } from "../../../src/shared/ci/capabilities";
import type { CiHistory } from "../../../src/shared/ci/history";
import type { CiJob, CommitCheckItem, CommitCiDetail, CommitDetail } from "../../../src/types";
import { CommitInfoPane } from "../../../src/webviews/react/commit-info/CommitInfoPane";
import { initReactDomTestEnvironment, mount } from "../../helpers/reactDomTestUtils";
import { installWebviewI18n } from "../../helpers/webviewI18nTestUtils";

const mockVscodeApi = vi.hoisted(() => ({
    postMessage: vi.fn(),
    getState: vi.fn((): unknown => undefined),
    setState: vi.fn(),
}));

vi.mock("../../../src/webviews/react/shared/vscodeApi", () => ({
    getVsCodeApi: () => mockVscodeApi,
}));

initReactDomTestEnvironment();

const HASH = "a".repeat(40);
const PARENT = "b".repeat(40);
const OTHER_PARENT = "c".repeat(40);
const TIP = "d".repeat(40);

beforeEach(() => {
    installWebviewI18n();
    mockVscodeApi.postMessage.mockReset();
    mockVscodeApi.getState.mockReset();
    mockVscodeApi.getState.mockReturnValue({ commitInfoTab: "checks" });
    window.intelligitE2E = true;
});

afterEach(() => {
    delete window.intelligitE2E;
});

function commit(hash: string, parentHashes = [PARENT, OTHER_PARENT]): CommitDetail {
    return {
        hash,
        shortHash: hash.slice(0, 7),
        message: "Commit",
        body: "",
        author: "Mahesh Kokare",
        email: "mahesh@example.com",
        date: "2026-11-07T12:00:00.000Z",
        parentHashes,
        refs: [],
        files: [],
    };
}

function job(name: string, state: CiJob["state"]): CiJob {
    return { id: name, logicalId: `job\0CI\0${name}`, name, checkName: name, state, steps: [] };
}

function detail(hash: string): CommitCiDetail {
    return {
        hash,
        provider: "github",
        complete: true,
        outcome: "failure",
        runs: [
            {
                id: "1",
                name: "CI",
                state: "failure",
                jobs: [
                    job("broke-here", "failure"),
                    job("was-broken", "failure"),
                    job("repaired", "success"),
                    job("renamed", "failure"),
                ],
                jobsCoverage: "full",
            },
        ],
        runsCoverage: "full",
        otherChecks: [],
        otherChecksCoverage: "full",
        capabilities: { ...NO_CI_CAPABILITIES, runs: true, jobs: true },
        repoKey: "/repo",
    };
}

function item(name: string, state: CommitCheckItem["state"]): CommitCheckItem {
    return { name, description: "", state, source: "check-run" };
}

const HISTORY: CiHistory = {
    parent: {
        hash: PARENT,
        items: [
            item("broke-here", "success"),
            item("was-broken", "failure"),
            item("repaired", "failure"),
            item("renamed-before", "success"),
        ],
    },
    // Disagrees with the parent on purpose, so a tag read from the wrong snapshot shows.
    defaultBranch: {
        name: "trunk",
        tipHash: TIP,
        items: [item("broke-here", "failure"), item("was-broken", "success")],
    },
};

function posted<T extends { type: string }>(type: string): T[] {
    return mockVscodeApi.postMessage.mock.calls
        .map(([message]) => message as T)
        .filter((message) => message.type === type);
}

function send(data: Record<string, unknown>): void {
    act(() => {
        window.dispatchEvent(new MessageEvent("message", { data }));
    });
}

interface HistoryRequest {
    type: "requestCiHistory";
    requestId: number;
    repoKey: string;
    hash: string;
    parents: string[];
}

function lastHistoryRequest(): HistoryRequest {
    const requests = posted<HistoryRequest>("requestCiHistory");
    expect(requests.length, "a history request was posted").toBeGreaterThan(0);
    return requests[requests.length - 1]!;
}

function answerHistory(request: HistoryRequest, history: CiHistory = HISTORY): void {
    send({
        type: "ciHistory",
        requestId: request.requestId,
        repoKey: "/repo",
        hash: request.hash,
        ...history,
    });
}

function showDetail(
    container: HTMLElement,
    build: (hash: string) => CommitCiDetail = detail,
): void {
    const request = posted<{ type: string; requestId: number; hash: string }>(
        "requestCommitCiDetail",
    ).at(-1)!;
    send({
        type: "commitCiDetail",
        requestId: request.requestId,
        repoKey: "/repo",
        hash: request.hash,
        detail: build(request.hash),
    });
    expect(container.querySelector('[data-testid="checks-tab"]')?.getAttribute("data-state")).toBe(
        "detail",
    );
}

function tagsOf(container: HTMLElement, name: string): string[] {
    const row = container.querySelector(`[data-testid="ci-job-row"][data-name="${name}"]`);
    expect(row, `job row ${name}`).not.toBeNull();
    return Array.from(row!.querySelectorAll('[data-testid^="ci-tag-"]')).map(
        (tag) => tag.textContent ?? "",
    );
}

describe("Checks tab history tags", () => {
    it("asks with the commit's parents once its detail renders", () => {
        const { container } = mount(
            <CommitInfoPane detail={commit(HASH)} ciRepoKey="/repo" commitChecksEnabled />,
        );
        expect(posted("requestCiHistory")).toHaveLength(0);
        showDetail(container);
        expect(lastHistoryRequest()).toMatchObject({
            repoKey: "/repo",
            hash: HASH,
            parents: [PARENT, OTHER_PARENT],
        });
    });

    it("tags new, still, fixed and unknown, and also red on the default branch by name", () => {
        const { container } = mount(
            <CommitInfoPane detail={commit(HASH)} ciRepoKey="/repo" commitChecksEnabled />,
        );
        showDetail(container);
        answerHistory(lastHistoryRequest());
        expect(tagsOf(container, "broke-here")).toEqual(["new", "also red on trunk"]);
        expect(tagsOf(container, "was-broken")).toEqual(["still"]);
        expect(tagsOf(container, "repaired")).toEqual(["fixed"]);
        expect(tagsOf(container, "renamed")).toEqual(["unknown"]);
    });

    it("drops a reply to an older request", () => {
        const { container } = mount(
            <CommitInfoPane detail={commit(HASH)} ciRepoKey="/repo" commitChecksEnabled />,
        );
        showDetail(container);
        const older = lastHistoryRequest();
        showDetail(container);
        expect(lastHistoryRequest().requestId).toBeGreaterThan(older.requestId);
        answerHistory(older);
        expect(tagsOf(container, "broke-here")).toEqual([]);
    });

    it("going A, B, A again shows no tags until the newest A reply arrives", () => {
        const { container, root } = mount(
            <CommitInfoPane detail={commit(HASH)} ciRepoKey="/repo" commitChecksEnabled />,
        );
        showDetail(container);
        answerHistory(lastHistoryRequest());
        expect(tagsOf(container, "broke-here")).toEqual(["new", "also red on trunk"]);
        act(() =>
            root.render(
                <CommitInfoPane detail={commit(TIP)} ciRepoKey="/repo" commitChecksEnabled />,
            ),
        );
        showDetail(container);
        act(() =>
            root.render(
                <CommitInfoPane detail={commit(HASH)} ciRepoKey="/repo" commitChecksEnabled />,
            ),
        );
        showDetail(container);
        expect(tagsOf(container, "broke-here")).toEqual([]);
        answerHistory(lastHistoryRequest());
        expect(tagsOf(container, "broke-here")).toEqual(["new", "also red on trunk"]);
    });

    it("a fresh detail after a sign-in invalidation shows no tags from the old account", () => {
        const { container } = mount(
            <CommitInfoPane detail={commit(HASH)} ciRepoKey="/repo" commitChecksEnabled />,
        );
        showDetail(container);
        answerHistory(lastHistoryRequest());
        send({ type: "commitCiDetailInvalidated" });
        showDetail(container);
        expect(tagsOf(container, "broke-here")).toEqual([]);
    });

    it("an unread parent snapshot and a root commit tag nothing", () => {
        const { container } = mount(
            <CommitInfoPane detail={commit(HASH)} ciRepoKey="/repo" commitChecksEnabled />,
        );
        showDetail(container);
        answerHistory(lastHistoryRequest(), {
            parent: { hash: PARENT, items: null },
            defaultBranch: null,
        });
        expect(tagsOf(container, "renamed")).toEqual([]);
        answerHistory(lastHistoryRequest(), { parent: null, defaultBranch: null });
        expect(tagsOf(container, "renamed")).toEqual([]);
    });

    it("shows the default-branch-unknown line when origin/HEAD is missing", () => {
        const { container } = mount(
            <CommitInfoPane detail={commit(HASH)} ciRepoKey="/repo" commitChecksEnabled />,
        );
        showDetail(container);
        const header = (): string | null | undefined =>
            container.querySelector('[data-testid="ci-header-default-branch"]')?.textContent;
        expect(header()).toBeUndefined();
        answerHistory(lastHistoryRequest(), { ...HISTORY, defaultBranch: null });
        expect(header()).toBe("default branch unknown — run git remote set-head origin --auto");
    });

    it("a known default branch in the history answer retires the detail's older unknown line", () => {
        const { container } = mount(
            <CommitInfoPane detail={commit(HASH)} ciRepoKey="/repo" commitChecksEnabled />,
        );
        const request = posted<{ requestId: number }>("requestCommitCiDetail").at(-1)!;
        send({
            type: "commitCiDetail",
            requestId: request.requestId,
            repoKey: "/repo",
            hash: HASH,
            detail: { ...detail(HASH), defaultBranchUnknown: true },
        });
        const line = (): Element | null =>
            container.querySelector('[data-testid="ci-header-default-branch"]');
        expect(line(), "the detail's unknown line shows before history answers").not.toBeNull();
        // origin/HEAD was set between the detail's read and this comparison's read.
        answerHistory(lastHistoryRequest());
        expect(tagsOf(container, "broke-here")).toEqual(["new", "also red on trunk"]);
        expect(line(), "the newer known branch must retire the unknown line").toBeNull();
    });

    it("a history answer with no default branch, or another one than the detail's, makes required status unknown over a known detail", () => {
        const { container } = mount(
            <CommitInfoPane detail={commit(HASH)} ciRepoKey="/repo" commitChecksEnabled />,
        );
        const request = posted<{ requestId: number }>("requestCommitCiDetail").at(-1)!;
        const known = detail(HASH);
        send({
            type: "commitCiDetail",
            requestId: request.requestId,
            repoKey: "/repo",
            hash: HASH,
            detail: {
                ...known,
                capabilities: { ...known.capabilities, requiredChecks: true },
                requiredStatus: "known",
                defaultBranch: "trunk",
                runs: known.runs.map((run) => ({
                    ...run,
                    jobs: run.jobs.map((each) => ({ ...each, required: "yes" as const })),
                })),
                otherChecks: [{ ...item("lint", "failure"), required: "yes" }],
            },
        });
        const header = (id: string): string | null | undefined =>
            container.querySelector(`[data-testid="${id}"]`)?.textContent;
        const blocksMergeTags = (): number =>
            container.querySelectorAll('[data-testid="ci-tag-blocks-merge"]').length;
        expect(header("ci-header-required"), "known before history answers").toBeUndefined();
        expect(header("ci-header-required-scope")).toBe("required checks from trunk");
        expect(blocksMergeTags(), "required failed jobs and checks block merge").toBe(4);
        answerHistory(lastHistoryRequest(), HISTORY);
        expect(
            blocksMergeTags(),
            "a history answer for the detail's own default branch keeps the tags",
        ).toBe(4);
        // origin/HEAD moved to another branch between the detail's read and this comparison's.
        answerHistory(lastHistoryRequest(), {
            ...HISTORY,
            defaultBranch: { ...HISTORY.defaultBranch!, name: "main" },
        });
        expect(
            header("ci-header-required"),
            "a default branch other than the detail's must make required status unknown",
        ).toBe("required: unknown");
        expect(
            blocksMergeTags(),
            "a default branch other than the detail's must drop every blocks-merge tag",
        ).toBe(0);
        // origin/HEAD was removed between the detail's read and this comparison's read.
        answerHistory(lastHistoryRequest(), { ...HISTORY, defaultBranch: null });
        expect(
            header("ci-header-required"),
            "a missing default branch must make required status unknown",
        ).toBe("required: unknown");
        expect(blocksMergeTags(), "a missing default branch must drop every blocks-merge tag").toBe(
            0,
        );
        expect(
            header("ci-header-required-scope"),
            "a missing default branch must drop the required scope line",
        ).toBeUndefined();
    });

    it("a replacement detail never commits the previous history answer's tags", () => {
        let host: HTMLElement | null = null;
        const frames: string[][] = [];
        const { container } = mount(
            <React.Profiler
                id="history"
                onRender={() => {
                    const row = host?.querySelector(
                        '[data-testid="ci-job-row"][data-name="broke-here"]',
                    );
                    frames.push(
                        Array.from(row?.querySelectorAll('[data-testid^="ci-tag-"]') ?? []).map(
                            (tag) => tag.textContent ?? "",
                        ),
                    );
                }}
            >
                <CommitInfoPane detail={commit(HASH)} ciRepoKey="/repo" commitChecksEnabled />
            </React.Profiler>,
        );
        host = container;
        showDetail(container);
        answerHistory(lastHistoryRequest());
        expect(tagsOf(container, "broke-here")).toEqual(["new", "also red on trunk"]);
        frames.length = 0;
        showDetail(container);
        expect(frames.length, "the replacement detail rendered").toBeGreaterThan(0);
        expect(frames, "no committed frame may borrow the previous answer").not.toContainEqual([
            "new",
            "also red on trunk",
        ]);
    });

    it.each([
        ["repository", { repoKey: "/other" }],
        ["hash", { hash: TIP }],
    ])(
        "a reply for another %s with the accepted request id keeps the accepted tags",
        (_n, extra) => {
            const { container } = mount(
                <CommitInfoPane detail={commit(HASH)} ciRepoKey="/repo" commitChecksEnabled />,
            );
            showDetail(container);
            const request = lastHistoryRequest();
            answerHistory(request);
            expect(tagsOf(container, "broke-here")).toEqual(["new", "also red on trunk"]);
            send({
                type: "ciHistory",
                requestId: request.requestId,
                repoKey: "/repo",
                hash: request.hash,
                ...HISTORY,
                ...extra,
                parent: { hash: PARENT, items: [] },
                defaultBranch: null,
            });
            expect(
                tagsOf(container, "broke-here"),
                "a foreign reply must be ignored, not stored over the accepted history",
            ).toEqual(["new", "also red on trunk"]);
        },
    );

    it("an obsolete request's reply after the accepted answer keeps the accepted tags", () => {
        const { container } = mount(
            <CommitInfoPane detail={commit(HASH)} ciRepoKey="/repo" commitChecksEnabled />,
        );
        showDetail(container);
        const older = lastHistoryRequest();
        showDetail(container);
        answerHistory(lastHistoryRequest());
        expect(tagsOf(container, "broke-here")).toEqual(["new", "also red on trunk"]);
        answerHistory(older, { parent: { hash: PARENT, items: [] }, defaultBranch: null });
        expect(
            tagsOf(container, "broke-here"),
            "an obsolete reply must not replace the accepted history",
        ).toEqual(["new", "also red on trunk"]);
    });

    it.each([
        [
            "runs",
            (hash: string): CommitCiDetail => ({
                ...detail(hash),
                runsCoverage: { reason: "pageBound", shown: 1 },
            }),
        ],
        [
            "jobs",
            (hash: string): CommitCiDetail => {
                const full = detail(hash);
                return {
                    ...full,
                    runs: full.runs.map((run) => ({
                        ...run,
                        jobsCoverage: { reason: "pageBound", shown: 4 },
                    })),
                };
            },
        ],
        [
            "otherChecks",
            (hash: string): CommitCiDetail => ({
                ...detail(hash),
                otherChecksCoverage: { reason: "pageBound", shown: 0 },
            }),
        ],
    ])("partial current %s coverage cannot prove a fallback name unique", (_n, build) => {
        const { container } = mount(
            <CommitInfoPane detail={commit(HASH)} ciRepoKey="/repo" commitChecksEnabled />,
        );
        showDetail(container, build);
        answerHistory(lastHistoryRequest());
        expect(
            tagsOf(container, "broke-here"),
            "an incomplete population cannot prove a unique-name match",
        ).toEqual(["unknown"]);
        expect(tagsOf(container, "was-broken")).toEqual(["unknown"]);
        expect(tagsOf(container, "repaired")).toEqual([]);
    });

    it("a truncated detail saved under contract version 6 is a miss after a restart and cannot show new", async () => {
        // Before Phase 11 a cut job list could be saved as fully covered; version 6 entries
        // were written by that code, so a restart must read the commit again.
        const KEY = `github:repo@${HASH}:-#detail`;
        const { capabilities, repoKey, ...claimedFull } = detail(HASH);
        const values = new Map<string, unknown>([
            [
                "intelligit.commitChecks.detailCache.v1",
                {
                    entries: [
                        {
                            key: KEY,
                            contractVersion: 6,
                            data: claimedFull,
                            fetchedAt: 1_000,
                            lastAccessedAt: 1_000,
                        },
                    ],
                    unconfirmed: {},
                },
            ],
        ]);
        const state = {
            get: (key: string) => values.get(key),
            keys: () => [...values.keys()],
            update: async (key: string, value: unknown) => {
                values.set(key, value);
            },
        };
        const restarted = new CommitCiDetailService({
            persistentCache: new CiDetailPersistentCache(state, { now: () => 1_000 }),
            now: () => 1_000,
        });
        const readAgain = vi.fn(async () => {
            const full = detail(HASH);
            return {
                ...claimedFull,
                runs: full.runs.map((run) => ({
                    ...run,
                    jobsCoverage: { reason: "pageBound" as const, shown: 4 },
                })),
            };
        });
        const served = await restarted.getOrFetch(KEY, readAgain, {
            repoKey: repoKey!,
            capabilities: capabilities!,
        });
        expect
            .soft(readAgain, "a version 6 entry must be a miss after a restart")
            .toHaveBeenCalledTimes(1);

        const { container } = mount(
            <CommitInfoPane detail={commit(HASH)} ciRepoKey="/repo" commitChecksEnabled />,
        );
        showDetail(container, () => served);
        answerHistory(lastHistoryRequest());
        expect(
            tagsOf(container, "broke-here"),
            "a detail saved before partial coverage was kept must not certify new",
        ).toEqual(["unknown"]);
    });

    it("a partly read parent snapshot cannot prove a unique name: failed jobs are unknown, green ones untagged", () => {
        const { container } = mount(
            <CommitInfoPane detail={commit(HASH)} ciRepoKey="/repo" commitChecksEnabled />,
        );
        showDetail(container);
        answerHistory(lastHistoryRequest(), {
            ...HISTORY,
            parent: { ...HISTORY.parent!, partial: true },
        });
        expect(
            tagsOf(container, "broke-here"),
            "an unread parent item may share the name, so new is not proven; the tip still answers also-red",
        ).toEqual(["unknown", "also red on trunk"]);
        expect(tagsOf(container, "was-broken")).toEqual(["unknown"]);
        expect(tagsOf(container, "repaired")).toEqual([]);
    });

    it("a partly read default-tip snapshot cannot prove also-red, and leaves the parent tags alone", () => {
        const { container } = mount(
            <CommitInfoPane detail={commit(HASH)} ciRepoKey="/repo" commitChecksEnabled />,
        );
        showDetail(container);
        answerHistory(lastHistoryRequest(), {
            ...HISTORY,
            defaultBranch: { ...HISTORY.defaultBranch!, partial: true },
        });
        expect(
            tagsOf(container, "broke-here"),
            "an unread tip item may share the name, so also red is not proven",
        ).toEqual(["new"]);
        expect(tagsOf(container, "was-broken")).toEqual(["still"]);
    });

    it("no also-red tag when the commit is the default branch's tip", () => {
        const { container } = mount(
            <CommitInfoPane detail={commit(TIP)} ciRepoKey="/repo" commitChecksEnabled />,
        );
        showDetail(container);
        answerHistory(lastHistoryRequest());
        expect(tagsOf(container, "broke-here")).toEqual(["new"]);
    });
});
