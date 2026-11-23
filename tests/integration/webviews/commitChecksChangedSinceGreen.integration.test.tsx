// @vitest-environment jsdom
// The Checks tab's "flaky n/m" tag and a failed job's "Changed since last green" list
// (PLAN.md journeys 10 and 11, Phase 12): the tab sends the graph's loaded commits with its
// history request and its changed-since-green request, tags a job that flaked on the loaded
// first-parent line, and lists the files changed since the job last passed, each opening a
// diff of the two versions.

import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { TreeFileRow } from "../../../src/webviews/react/shared/components/FileTreeRows";
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

function showDetail(container: HTMLElement, build: CommitCiDetail): void {
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

describe("Checks tab flaky tag", () => {
    it("sends the graph's loaded commits with the history request", () => {
        const container = mountPane();
        showDetail(container, detail(true));
        expect(posted("requestCiHistory").at(-1)).toMatchObject({ loaded: EXPECTED_LOADED });
    });

    it("counts an isolated red and this commit's fail-then-pass, out of the commits with a result", () => {
        const container = mountPane();
        showDetail(container, detail(true, FAILED_THEN_PASSED));
        answerHistory(history(["success", "failure", "success"]));
        const tag = flakyTag(container);
        expect(tag?.textContent).toBe("flaky 2/4");
        expect(tag?.getAttribute("title")).toBeNull();
    });

    it("a provider without attempt history shows an estimate with its tooltip", () => {
        const container = mountPane();
        showDetail(container, detail(false));
        answerHistory(history(["success", "failure", "success"]));
        const tag = flakyTag(container);
        expect(tag?.textContent).toBe("flaky 1/4 (estimated)");
        expect(tag?.getAttribute("title")).toBe(
            "estimated from loaded commits; re-runs not counted for this provider",
        );
    });

    it("a commit whose run list was read in part shows no tag", () => {
        const container = mountPane();
        showDetail(container, {
            ...detail(true, FAILED_THEN_PASSED),
            runsCoverage: { reason: "pageBound", shown: 1 },
        });
        answerHistory(history(["success", "failure", "success"]));
        expect(container.querySelector('[data-testid="ci-job-row"]')).not.toBeNull();
        expect(flakyTag(container)).toBeNull();
    });

    it("shows no tag when nothing flaked", () => {
        const container = mountPane();
        showDetail(container, detail(true));
        answerHistory(history(["failure", "failure", "success"]));
        expect(flakyTag(container)).toBeNull();
    });

    // K34: every attempt history carries its coverage, and banners read it.
    it.each([
        ["pageBound", "Showing the first 1000 attempts — open the run in the browser for the rest"],
        [
            "rejectedNext",
            "Showing the first 1000 attempts — the provider's next-page link was refused",
        ],
    ] as const)(
        "this commit's %s attempt list is disclosed beside the flaky tag",
        (reason, text) => {
            const container = mountPane();
            const base = detail(
                true,
                FAILED_THEN_PASSED.map((entry) => ({
                    ...entry,
                    coverage: { reason, shown: 1000 },
                })),
            );
            showDetail(container, {
                ...base,
                runs: base.runs.map((run) => ({
                    ...run,
                    url: "https://github.com/o/r/actions/runs/1",
                    // A failed job listed first takes the default selection.
                    jobs: [job("lint", "failure"), ...run.jobs],
                })),
            });
            answerHistory(history(["success", "success", "success"]));
            expect(flakyTag(container)?.textContent).toBe("flaky 1/4");
            const testRow = container.querySelector(
                '[data-testid="ci-job-row"][data-name="test"]',
            )!;
            expect(testRow.getAttribute("aria-current")).toBeNull();
            const note = attemptsNote(container);
            expect(note?.textContent ?? "no attempts note").toContain(text);
            const open = note!.querySelector<HTMLButtonElement>("button");
            expect(open?.textContent, "the note opens the run in the browser").toBe(
                "Open in browser",
            );
            act(() => open!.click());
            expect(posted("openCommitCheckUrl")).toEqual([
                { type: "openCommitCheckUrl", url: "https://github.com/o/r/actions/runs/1" },
            ]);
            expect(
                testRow.getAttribute("aria-current"),
                "opening the run does not select the job",
            ).toBeNull();
        },
    );

    it("an attempt list read in part is disclosed even when nothing flaked", () => {
        const container = mountPane();
        showDetail(
            container,
            detail(true, [
                {
                    runId: "1",
                    logicalId: LOGICAL,
                    coverage: { reason: "pageBound", shown: 1000 },
                    attempts: [{ attempt: 1, executionId: "11", state: "success" }],
                },
            ]),
        );
        answerHistory(history(["success", "success", "success"]));
        expect(flakyTag(container)).toBeNull();
        expect(attemptsNote(container)?.textContent ?? "no attempts note").toContain(
            "Showing the first 1000 attempts",
        );
    });

    it("an ancestor's attempt list read in part is disclosed; another job's is not", () => {
        const container = mountPane();
        showDetail(container, detail(true));
        const answer = history(["success", "failure", "success"]);
        answer.line![0]!.attempts = [
            {
                runId: "7",
                logicalId: LOGICAL,
                coverage: "full",
                attempts: [{ attempt: 1, executionId: "71", state: "success" }],
            },
        ];
        answer.line![1]!.attempts = [
            {
                runId: "9",
                logicalId: "job\0CI\0other",
                coverage: { reason: "rejectedNext", shown: 7 },
                attempts: [],
            },
        ];
        answerHistory(answer);
        expect(flakyTag(container)?.textContent).toBe("flaky 1/4");
        expect(attemptsNote(container), "another job's attempt list says nothing").toBeNull();

        answer.line![2]!.attempts = [
            {
                runId: "8",
                logicalId: LOGICAL,
                coverage: { reason: "pageBound", shown: 1000 },
                attempts: [{ attempt: 1, executionId: "81", state: "success" }],
            },
        ];
        answerHistory(answer);
        const note = attemptsNote(container);
        expect(note?.textContent ?? "no attempts note").toContain(
            "Showing the first 1000 attempts — open the run in the browser for the rest",
        );
        expect(note?.querySelector("button"), "an ancestor's run link is not known").toBeNull();
    });
});

function attemptsNote(container: HTMLElement): HTMLElement | null {
    return container.querySelector('[data-testid="ci-attempts-coverage-note"]');
}

interface ChangedRequest {
    type: "requestChangedSinceGreen";
    requestId: number;
    hash: string;
}

function lastChangedRequest(): ChangedRequest {
    const requests = posted<ChangedRequest>("requestChangedSinceGreen");
    expect(requests.length, "a changed-since-green request was posted").toBeGreaterThan(0);
    return requests.at(-1)!;
}

function answerChanged(request: ChangedRequest, answer: Record<string, unknown>): void {
    send({
        type: "changedSinceGreen",
        requestId: request.requestId,
        repoKey: "/repo",
        hash: HASH,
        logicalCheckId: LOGICAL,
        scopeName: "CI",
        checkName: "test",
        files: [],
        ...answer,
    });
}

function section(container: HTMLElement): HTMLElement | null {
    return container.querySelector('[data-testid="ci-changed-since-green"]');
}

describe("Checks tab changed since last green", () => {
    it("asks for the failed job by its identity, with the loaded commits", () => {
        const container = mountPane();
        showDetail(container, detail(true));
        expect(lastChangedRequest()).toMatchObject({
            repoKey: "/repo",
            hash: HASH,
            logicalCheckId: LOGICAL,
            scopeName: "CI",
            checkName: "test",
            loaded: EXPECTED_LOADED,
        });
    });

    it("a passing job asks nothing", () => {
        const container = mountPane();
        showDetail(container, detail(true, undefined, "success"));
        expect(posted("requestChangedSinceGreen")).toHaveLength(0);
    });

    it("picking a passing job beside the failed one asks nothing more", () => {
        const container = mountPane();
        const build = detail(true);
        build.runs[0]!.jobs.push(job("lint", "success"));
        showDetail(container, build);
        expect(posted("requestChangedSinceGreen")).toHaveLength(1);
        const lint = container.querySelector<HTMLElement>(
            '[data-testid="ci-job-row"][data-name="lint"]',
        );
        act(() => lint!.click());
        expect(lint!.getAttribute("aria-current")).toBe("true");
        expect(posted("requestChangedSinceGreen")).toHaveLength(1);
        expect(container.textContent).not.toContain("Looking for the last passing run");
    });

    it("lists the files and a click opens the two-revision diff", () => {
        const container = mountPane();
        showDetail(container, detail(true));
        answerChanged(lastChangedRequest(), {
            lastGreen: P2,
            files: [
                { path: "src/new name.ts", oldPath: "src/old.ts", status: "R" },
                { path: "gone.ts", status: "D" },
            ],
        });
        expect(section(container)?.textContent).toContain(
            `Changed since last green (${P2.slice(0, 7)})`,
        );
        const rows = Array.from(
            container.querySelectorAll<HTMLElement>('[data-testid="ci-changed-file"]'),
        );
        expect(rows.map((row) => row.getAttribute("title"))).toEqual([
            "src/old.ts → src/new name.ts",
            "gone.ts",
        ]);
        act(() => rows[0]!.click());
        expect(posted("openCiRangeDiff").at(-1)).toMatchObject({
            repoKey: "/repo",
            fromRev: P2,
            toRev: HASH,
            path: "src/new name.ts",
            oldPath: "src/old.ts",
            status: "R",
        });
    });

    it("each file is the commit pane's shared changed-files row", () => {
        const container = mountPane();
        showDetail(container, detail(true));
        const file = {
            path: "src/new name.ts",
            oldPath: "src/old.ts",
            status: "R",
            additions: 4,
            deletions: 2,
        } as const;
        answerChanged(lastChangedRequest(), { lastGreen: P2, files: [file] });
        const shared = mount(
            <TreeFileRow
                file={file}
                depth={0}
                showParentPath
                wiring={{
                    isSelected: false,
                    onSelect: () => {},
                    dataAttributes: { testid: "ci-changed-file" },
                }}
            />,
        ).container.firstElementChild;
        expect(
            container.querySelector('[data-testid="ci-changed-file"]')?.outerHTML,
            "Phase 12 step 5: the list reuses CommitChangedFilesPanel's row",
        ).toBe(shared?.outerHTML);
    });

    it.each([
        [{ lastGreen: null }, "No passing run of this job in the loaded history"],
        [{ lastGreen: null, unknownReason: "ambiguous" }, "Cannot match this job in older commits"],
        [{ lastGreen: null, error: "bad object" }, "Could not compare: bad object"],
    ])("says why there is no list: %o", (answer, text) => {
        const container = mountPane();
        showDetail(container, detail(true));
        answerChanged(lastChangedRequest(), answer);
        expect(section(container)?.textContent).toBe(text);
        expect(container.querySelector('[data-testid="ci-changed-file"]')).toBeNull();
    });

    it("ignores a reply to an older request", () => {
        const container = mountPane();
        showDetail(container, detail(true));
        const request = lastChangedRequest();
        answerChanged({ ...request, requestId: request.requestId - 1 }, { lastGreen: P2 });
        expect(section(container)).toBeNull();
    });
});

describe("Checks tab changed since last green: request identity and Refresh", () => {
    it.each([
        ["repository", { repoKey: "/other" }],
        ["hash", { hash: "e".repeat(40) }],
        ["job identity", { logicalCheckId: "job\0CI\0other" }],
        ["check name", { checkName: "other" }],
        ["workflow name", { scopeName: "Deploy" }],
    ])("a matching request id with the wrong %s is rejected", (_what, wrong) => {
        const container = mountPane();
        showDetail(container, detail(true));
        answerChanged(lastChangedRequest(), { lastGreen: P2, ...wrong });
        expect(section(container)).toBeNull();
        expect(container.textContent).toContain("Looking for the last passing run");
    });

    it("Refresh retries changed-since-green after a Git failure", () => {
        const container = mountPane();
        showDetail(container, detail(true));
        answerChanged(lastChangedRequest(), { lastGreen: null, error: "bad object" });
        expect(section(container)?.textContent).toBe("Could not compare: bad object");

        act(() =>
            container.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]')!.click(),
        );
        showDetail(container, detail(true));

        expect(posted("requestChangedSinceGreen")).toHaveLength(2);
        answerChanged(lastChangedRequest(), {
            lastGreen: P2,
            files: [{ path: "a.ts", status: "M" }],
        });
        expect(section(container)?.textContent).toContain(
            `Changed since last green (${P2.slice(0, 7)})`,
        );
    });
});
