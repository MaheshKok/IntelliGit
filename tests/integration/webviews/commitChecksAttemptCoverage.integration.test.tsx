// @vitest-environment jsdom
// K34 attempt coverage beside the Checks tab's "flaky n/m" tag (PLAN.md §9, Phase 12): every
// attempt history read in part, the commit's own and each loaded ancestor's, is disclosed with
// its own reason, and an ancestor whose attempt page could not be read never counts as a fully
// read history. Codex's Phase 12 review cases (owner answer 2026-11-18), assertions verbatim.

import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitOps } from "../../../src/git/operations";
import { CommitChecksCoordinator } from "../../../src/services/commitChecks/coordinator";
import type { CommitChecksProvider } from "../../../src/services/commitChecks/types";
import { NO_CI_CAPABILITIES } from "../../../src/shared/ci/capabilities";
import type { CiHistory } from "../../../src/shared/ci/history";
import type {
    CiAttemptHistory,
    CiJob,
    CommitCheckItem,
    CommitCiDetail,
    CommitDetail,
} from "../../../src/types";
import { CommitInfoPane } from "../../../src/webviews/react/commit-info/CommitInfoPane";
import { initReactDomTestEnvironment, mount } from "../../helpers/reactDomTestUtils";
import { installWebviewI18n } from "../../helpers/webviewI18nTestUtils";

const mockVscodeApi = vi.hoisted(() => ({
    postMessage: vi.fn(),
    getState: vi.fn((): unknown => undefined),
    setState: vi.fn(),
}));

vi.mock("vscode", () => ({ l10n: { t: (s: string) => s } }));

vi.mock("../../../src/webviews/react/shared/vscodeApi", () => ({
    getVsCodeApi: () => mockVscodeApi,
}));

initReactDomTestEnvironment();

const HASH = "a".repeat(40);
const P1 = "b".repeat(40);
const P2 = "c".repeat(40);
const P3 = "d".repeat(40);
const LOGICAL = "job\0CI\0test";
const LOADED = [
    { hash: HASH, parentHashes: [P1] },
    { hash: P1, parentHashes: [P2] },
    { hash: P2, parentHashes: [P3] },
    { hash: P3, parentHashes: [] },
];

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

function commit(): CommitDetail {
    return {
        hash: HASH,
        shortHash: HASH.slice(0, 7),
        message: "Commit",
        body: "",
        author: "Mahesh Kokare",
        email: "mahesh@example.com",
        date: "2026-11-07T12:00:00.000Z",
        parentHashes: [P1],
        refs: [],
        files: [],
    };
}

function job(name: string, state: CiJob["state"]): CiJob {
    return { id: name, logicalId: `job\0CI\0${name}`, name, checkName: name, state, steps: [] };
}

function detail(
    attemptHistory: boolean,
    attempts?: CiAttemptHistory[],
    state: CiJob["state"] = "failure",
): CommitCiDetail {
    return {
        hash: HASH,
        provider: "github",
        complete: true,
        outcome: state === "failure" ? "failure" : "success",
        runs: [
            {
                id: "1",
                name: "CI",
                state,
                jobs: [job("test", state)],
                jobsCoverage: "full",
            },
        ],
        runsCoverage: "full",
        otherChecks: [],
        otherChecksCoverage: "full",
        capabilities: { ...NO_CI_CAPABILITIES, runs: true, jobs: true, attemptHistory },
        ...(attempts && { attemptHistory: attempts }),
        repoKey: "/repo",
    };
}

// This commit's own re-runs: failed, then passed.
const FAILED_THEN_PASSED: CiAttemptHistory[] = [
    {
        runId: "1",
        logicalId: LOGICAL,
        coverage: "full",
        attempts: [
            { attempt: 1, executionId: "11", state: "failure" },
            { attempt: 2, executionId: "12", state: "success" },
        ],
    },
];

function item(state: CommitCheckItem["state"]): CommitCheckItem {
    return { name: "test", description: "", state, source: "check-run" };
}

function history(states: CommitCheckItem["state"][]): CiHistory {
    const hashes = [P1, P2, P3];
    return {
        parent: { hash: P1, items: [] },
        defaultBranch: null,
        line: states.map((state, index) => ({
            hash: hashes[index]!,
            items: [item(state)],
            attempts: [],
        })),
    };
}

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

function mountPane(): HTMLElement {
    return mount(
        <CommitInfoPane
            detail={commit()}
            ciRepoKey="/repo"
            commitChecksEnabled
            loadedCommits={LOADED}
        />,
    ).container;
}

function showDetail(_container: HTMLElement, build: CommitCiDetail): void {
    const request = posted<{ type: string; requestId: number; hash: string }>(
        "requestCommitCiDetail",
    ).at(-1)!;
    send({
        type: "commitCiDetail",
        requestId: request.requestId,
        repoKey: "/repo",
        hash: request.hash,
        detail: build,
    });
}

function answerHistory(line: CiHistory): void {
    const request = posted<{ type: string; requestId: number; hash: string }>(
        "requestCiHistory",
    ).at(-1)!;
    send({
        type: "ciHistory",
        requestId: request.requestId,
        repoKey: "/repo",
        hash: HASH,
        ...line,
    });
}

function flakyTag(container: HTMLElement): HTMLElement | null {
    return container.querySelector('[data-testid="ci-tag-flaky"]');
}

const EXPECTED_LOADED = LOADED.map((c) => ({ hash: c.hash, parents: c.parentHashes }));

describe("independent Phase 12 K34 review", () => {
    it.each(["pageBound", "rejectedNext"] as const)("own %s is text beside count", (reason) => {
        const container = mountPane();
        showDetail(
            container,
            detail(
                true,
                FAILED_THEN_PASSED.map((h) => ({ ...h, coverage: { reason, shown: 19 } })),
            ),
        );
        answerHistory(history(["success", "success", "success"]));
        const row = container.querySelector('[data-testid="ci-job-row"][data-name="test"]')!;
        expect(row.querySelector('[data-testid="ci-tag-flaky"]')?.textContent).toBe("flaky 1/4");
        expect(
            row.querySelector('[data-testid="ci-attempts-coverage-note"]')?.textContent,
        ).toContain(
            reason === "pageBound"
                ? "Showing the first 19 attempts — open the run in the browser for the rest"
                : "Showing the first 19 attempts — the provider's next-page link was refused",
        );
    });

    it.each(["pageBound", "rejectedNext"] as const)(
        "ancestor %s is text beside count",
        (reason) => {
            const container = mountPane();
            showDetail(container, detail(true));
            const answer = history(["success", "failure", "success"]);
            answer.line![0]!.attempts = FAILED_THEN_PASSED.map((h) => ({
                ...h,
                runId: "ancestor",
                coverage: { reason, shown: 23 },
            }));
            answerHistory(answer);
            const row = container.querySelector('[data-testid="ci-job-row"][data-name="test"]')!;
            expect(row.querySelector('[data-testid="ci-tag-flaky"]')?.textContent).toBe(
                "flaky 2/4",
            );
            const note = row.querySelector('[data-testid="ci-attempts-coverage-note"]');
            expect(note?.textContent).toContain(
                reason === "pageBound"
                    ? "Showing the first 23 attempts — open the run in the browser for the rest"
                    : "Showing the first 23 attempts — the provider's next-page link was refused",
            );
            expect(note?.querySelector("button")).toBeNull();
        },
    );

    it("discloses each own and ancestor partial history when reasons differ", () => {
        const container = mountPane();
        showDetail(
            container,
            detail(
                true,
                FAILED_THEN_PASSED.map((h) => ({
                    ...h,
                    coverage: { reason: "pageBound", shown: 19 },
                })),
            ),
        );
        const answer = history(["success", "failure", "success"]);
        answer.line![0]!.attempts = FAILED_THEN_PASSED.map((h) => ({
            ...h,
            runId: "ancestor",
            coverage: { reason: "rejectedNext", shown: 23 },
        }));
        answerHistory(answer);
        const row = container.querySelector('[data-testid="ci-job-row"][data-name="test"]')!;
        expect(row.querySelector('[data-testid="ci-tag-flaky"]')?.textContent).toBe("flaky 3/4");
        expect(
            row.textContent,
            "K34: the ancestor's refused continuation must not be hidden by the own run's page bound",
        ).toContain("Showing the first 23 attempts — the provider's next-page link was refused");
        expect(row.textContent).toContain(
            "Showing the first 19 attempts — open the run in the browser for the rest",
        );
    });

    it("a failed ancestor attempt page must not look like a fully counted history", async () => {
        const provider: CommitChecksProvider = {
            id: "github",
            capabilities: { ...NO_CI_CAPABILITIES, attemptHistory: true },
            match: () => ({ host: "github.com" }),
            keyFor: () => "github:review",
            getChecks: async (_ref, hash) => ({
                hash,
                state: hash === P2 ? "failure" : "success",
                summary: "",
                items: [{ ...item(hash === P2 ? "failure" : "success"), logicalId: LOGICAL }],
            }),
            getAttemptHistory: async (_ref, hash) => {
                if (hash === P1) throw new Error("ancestor attempt page offline");
                return [];
            },
        };
        const git = {
            getRemotes: async () => ["origin"],
            getRemoteUrl: async () => "https://github.com/o/r",
            readDefaultBranch: async () => null,
        } as unknown as GitOps;
        const coordinator = new CommitChecksCoordinator(git, [provider]);
        await Promise.all([P1, P2, P3].map((hash) => coordinator.getChecks(hash)));
        const answer = await coordinator.ciHistory([P1], { hash: HASH, loaded: EXPECTED_LOADED });
        const container = mountPane();
        showDetail(container, detail(true));
        answerHistory(answer);
        const tag = flakyTag(container);
        // An unavailable attempt page cannot justify the same unqualified count as a fully read list.
        const unqualified =
            tag?.textContent === "flaky 1/4" &&
            !tag?.getAttribute("title") &&
            !container.querySelector('[role="alert"]') &&
            !container.querySelector('[data-testid="ci-attempts-coverage-note"]');
        expect(
            unqualified,
            "provider page failure must be disclosed; unread attempts cannot become an empty fully counted history",
        ).toBe(false);
    });
});

describe("own run link", () => {
    it("an ancestor's note has no browser link, even when its run id equals this commit's", () => {
        const container = mountPane();
        const base = detail(true);
        showDetail(container, {
            ...base,
            runs: base.runs.map((run) => ({
                ...run,
                url: "https://github.com/o/r/actions/runs/1",
            })),
        });
        const answer = history(["success", "failure", "success"]);
        // Run ids are numbered per repository on some forges, so an id alone is not this run.
        answer.line![0]!.attempts = FAILED_THEN_PASSED.map((h) => ({
            ...h,
            coverage: { reason: "pageBound" as const, shown: 23 },
        }));
        answerHistory(answer);
        const note = container.querySelector('[data-testid="ci-attempts-coverage-note"]');
        expect(note?.textContent).toContain("Showing the first 23 attempts");
        expect(note?.querySelector("button"), "only this commit's own run opens").toBeNull();
    });
});

describe("unread ancestor attempt pages", () => {
    const UNREAD =
        "Re-runs on some loaded commits could not be read — the flaky count may be incomplete";

    function testRow(container: HTMLElement): HTMLElement {
        return container.querySelector('[data-testid="ci-job-row"][data-name="test"]')!;
    }

    function unreadAnswer(): CiHistory {
        const answer = history(["success", "failure", "success"]);
        answer.line![0]!.attemptsUnavailable = true;
        return answer;
    }

    it("Refresh on the note reads the line again; a read that succeeds clears the note", () => {
        const container = mountPane();
        const base = detail(true);
        // A failed job listed first takes the default selection, so "test" starts unselected.
        const build = {
            ...base,
            runs: base.runs.map((run) => ({ ...run, jobs: [job("lint", "failure"), ...run.jobs] })),
        };
        showDetail(container, build);
        answerHistory(unreadAnswer());
        expect(testRow(container).textContent).toContain(UNREAD);
        const refresh = [...testRow(container).querySelectorAll("button")].find(
            (button) => button.textContent === "Refresh",
        );
        expect(refresh, "the unread note offers Refresh").toBeDefined();

        const asked = posted("requestCommitCiDetail").length;
        act(() => refresh!.click());
        expect(
            testRow(container).getAttribute("aria-current"),
            "Refresh in the note does not select the job",
        ).toBeNull();
        expect(posted("requestCommitCiDetail").length, "Refresh asks for the detail again").toBe(
            asked + 1,
        );
        showDetail(container, { ...build });
        expect(posted("requestCiHistory"), "the new detail asks for the line again").toHaveLength(
            2,
        );
        answerHistory(history(["success", "failure", "success"]));
        expect(testRow(container).textContent).not.toContain(UNREAD);
    });

    it("an ancestor with no result for the job says nothing about its unread re-runs", () => {
        const container = mountPane();
        showDetail(container, detail(true));
        const answer = unreadAnswer();
        answer.line![0]!.items = [];
        answerHistory(answer);
        expect(testRow(container).textContent).not.toContain(UNREAD);
    });
});
