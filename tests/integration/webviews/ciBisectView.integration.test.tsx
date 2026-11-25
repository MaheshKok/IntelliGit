// @vitest-environment jsdom
// "Find where CI broke" in the webview (PLAN.md Phase 16, section 13): the bisect store posts the
// range to the host, keeps only the newest run's replies, and the bisect view draws the progress,
// one sparkline per job, the break point or why there is none, the flaky tag and the cap note.

import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CiBisectJob } from "../../../src/shared/ci/history";
import type { CiBisectResultMessage } from "../../../src/webviews/protocol/commitCiMessages";
import { BisectView } from "../../../src/webviews/react/commit-info/checks/BisectView";
import {
    closeCiBisect,
    startCiBisect,
    useCiBisect,
} from "../../../src/webviews/react/commit-info/checks/ciBisect";
import { OPEN_CHECKS_TAB_EVENT } from "../../../src/webviews/react/commit-info/checks/checksTabState";
import { initReactDomTestEnvironment, mount, unmount } from "../../helpers/reactDomTestUtils";
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

const REPO = "/repo";
const [A, B, C] = ["a", "b", "c"].map((letter) => letter.repeat(40));
const RANGE = [
    { hash: A, parents: [B] },
    { hash: B, parents: [C] },
    { hash: C, parents: ["d".repeat(40)] },
];

function Harness({ repoKey = REPO }: { repoKey?: string }): React.ReactElement | null {
    const view = useCiBisect(repoKey);
    return view ? <BisectView view={view} /> : null;
}

function lastStartRequestId(): number {
    const start = mockVscodeApi.postMessage.mock.calls
        .map(([message]) => message as { type: string; requestId: number })
        .filter((message) => message.type === "startCiBisect")
        .at(-1);
    if (!start) throw new Error("No startCiBisect was posted");
    return start.requestId;
}

function reply(message: object): void {
    act(() => {
        window.dispatchEvent(new MessageEvent("message", { data: message }));
    });
}

/** A job as the host sends it; `isolated` defaults to no red the flaky tag counted as isolated. */
type JobFixture = Omit<CiBisectJob, "isolated"> & { isolated?: boolean[] };

function result(
    requestId: number,
    jobs: JobFixture[],
    extra: Partial<CiBisectResultMessage> = {},
): CiBisectResultMessage {
    return {
        type: "ciBisectResult",
        requestId,
        repoKey: REPO,
        linear: true,
        commits: [C, B, A],
        jobs: jobs.map((job) => ({
            ...job,
            isolated: job.isolated ?? job.states.map(() => false),
        })),
        ...extra,
    };
}

const text = (container: HTMLElement): string => container.textContent ?? "";

beforeEach(() => {
    installWebviewI18n();
    mockVscodeApi.postMessage.mockReset();
    window.intelligitE2E = true;
});

afterEach(() => {
    act(() => closeCiBisect());
    delete window.intelligitE2E;
});

describe("CI bisect view", () => {
    it("bisect view shows cap note, not-a-straight-line note and flaky tag", () => {
        const { root, container } = mount(<Harness />);
        act(() => startCiBisect(REPO, RANGE));
        const requestId = lastStartRequestId();
        expect(mockVscodeApi.postMessage).toHaveBeenCalledWith({
            type: "startCiBisect",
            requestId,
            repoKey: REPO,
            commits: RANGE,
        });

        reply({ type: "ciBisectProgress", requestId, repoKey: REPO, done: 1, total: 3 });
        expect(text(container)).toContain("1 / 3 commits");
        expect(container.querySelector('[data-testid="ci-bisect-cancel"]')).not.toBeNull();

        reply(
            result(
                requestId,
                [
                    {
                        checkName: "unit",
                        states: ["success", "failure", "failure"],
                        brokeAt: null,
                        flaky: { n: 1, m: 2, attemptsCounted: false },
                    },
                ],
                { linear: false, limitedTo: 2, commits: [C, B, A] },
            ),
        );
        const row = container.querySelector<HTMLElement>('[data-testid="ci-bisect-job"]');
        expect(row?.textContent).toContain("unit");
        expect(row?.textContent).toContain("not a straight line — no break point");
        const tag = container.querySelector<HTMLElement>('[data-testid="ci-bisect-flaky"]');
        expect(tag?.textContent).toBe("flaky 1/2 (estimated)");
        expect(tag?.title).toBe(
            "estimated from loaded commits; re-runs not counted for this provider",
        );
        expect(text(container)).toContain("Limited to the 2 loaded commits");
        expect(container.querySelector('[data-testid="ci-bisect-cancel"]')).toBeNull();
        // A flaky job's run of reds is not isolated: those reds stay red, only a lone one is amber.
        expect(
            Array.from(row!.querySelectorAll<HTMLElement>('[data-testid="ci-bisect-square"]')).map(
                (square) => square.dataset.tone,
            ),
            "a flaky job's run of reds stays red",
        ).toEqual(["red", "red", "green"]);

        unmount(root, container);
    });

    it("review: a flaky re-run does not erase a visible run of red commits", () => {
        const { root, container } = mount(<Harness />);
        act(() => startCiBisect(REPO, RANGE));
        reply(
            result(lastStartRequestId(), [
                {
                    checkName: "unit",
                    // Two consecutive reds with no green under them: no qualifying baseline.
                    states: ["failure", "failure", "failure"],
                    brokeAt: null,
                    // The attempt-aware count: a failed-then-passed re-run, not a red commit.
                    flaky: { n: 1, m: 3, attemptsCounted: true },
                },
            ]),
        );
        const row = container.querySelector<HTMLElement>('[data-testid="ci-bisect-job"]');
        expect(
            row?.textContent,
            "two consecutive red commits cannot be described as no run of red",
        ).not.toContain("no run of red");
        expect(row?.textContent).toContain("no break point in this range");
        expect(row?.querySelector('[data-testid="ci-bisect-flaky"]')?.textContent).toBe(
            "flaky 1/3",
        );
        unmount(root, container);
    });

    it("an isolated red of a job that is not flaky stays red", () => {
        const { root, container } = mount(<Harness />);
        act(() => startCiBisect(REPO, RANGE));
        reply(
            result(lastStartRequestId(), [
                {
                    checkName: "unit",
                    states: ["success", "failure", "success"],
                    brokeAt: null,
                    flaky: null,
                },
            ]),
        );
        expect(
            Array.from(
                container.querySelectorAll<HTMLElement>('[data-testid="ci-bisect-square"]'),
            ).map((square) => square.dataset.tone),
            "amber needs the job to be flaky too",
        ).toEqual(["green", "red", "green"]);

        unmount(root, container);
    });

    it("draws one square per commit, newest left, and names the break point", () => {
        const { root, container } = mount(<Harness />);
        act(() => startCiBisect(REPO, RANGE));
        const requestId = lastStartRequestId();
        reply(
            result(requestId, [
                {
                    checkName: "unit",
                    states: ["success", "failure", "failure"],
                    brokeAt: B,
                    flaky: null,
                },
                {
                    checkName: "lint",
                    states: ["success", "success", "failure"],
                    brokeAt: A,
                    flaky: null,
                },
                {
                    checkName: "e2e",
                    states: ["success", "failure", "success"],
                    isolated: [false, true, false],
                    brokeAt: null,
                    flaky: { n: 1, m: 3, attemptsCounted: true },
                },
            ]),
        );
        const rows = Array.from(
            container.querySelectorAll<HTMLElement>('[data-testid="ci-bisect-job"]'),
        );
        expect(rows.map((row) => row.dataset.job)).toEqual(["unit", "lint", "e2e"]);
        const squares = Array.from(
            rows[0]!.querySelectorAll<HTMLElement>('[data-testid="ci-bisect-square"]'),
        );
        expect(
            squares.map((square) => square.dataset.hash),
            "newest on the left",
        ).toEqual([A, B, C]);
        expect(squares.map((square) => square.dataset.state)).toEqual([
            "failure",
            "failure",
            "success",
        ]);
        expect(rows[0]!.textContent).toContain(`broke at ${B.slice(0, 7)} · 1 commit ago`);
        expect(rows[1]!.textContent).toContain(`broke at ${A.slice(0, 7)} · this commit`);
        // The owner dropped the blame phrase (#453): the flaky tag says what was seen, not whose.
        expect(rows[2]!.textContent).toContain("no break point in this range");
        expect(rows[2]!.textContent, "no judgement of whose fault it is").not.toContain(
            "likely not yours",
        );
        expect(rows[2]!.querySelector('[data-testid="ci-bisect-flaky"]')?.textContent).toBe(
            "flaky 1/3",
        );
        // The isolated red of a flaky job is drawn amber, not red.
        expect(
            Array.from(
                rows[2]!.querySelectorAll<HTMLElement>('[data-testid="ci-bisect-square"]'),
            ).map((square) => square.dataset.tone),
        ).toEqual(["green", "amber", "green"]);

        unmount(root, container);
    });

    it("drops a reply for an older bisect or another repository", () => {
        const { root, container } = mount(<Harness />);
        act(() => startCiBisect(REPO, RANGE));
        const first = lastStartRequestId();
        act(() => startCiBisect(REPO, RANGE));
        const second = lastStartRequestId();
        expect(second).not.toBe(first);

        reply({ type: "ciBisectProgress", requestId: first, repoKey: REPO, done: 2, total: 3 });
        expect(text(container)).not.toContain("2 / 3 commits");
        reply(result(second, [], { repoKey: "/other" }));
        expect(container.querySelector('[data-testid="ci-bisect-cancel"]')).not.toBeNull();
        reply(result(first, []));
        expect(container.querySelector('[data-testid="ci-bisect-cancel"]')).not.toBeNull();
        reply(result(second, []));
        expect(text(container)).toContain("No CI jobs found for these commits");

        unmount(root, container);
    });

    it("shows nothing for another repository's pane", () => {
        const { root, container } = mount(<Harness repoKey="/other" />);
        act(() => startCiBisect(REPO, RANGE));
        expect(container.querySelector('[data-testid="ci-bisect"]')).toBeNull();
        unmount(root, container);
    });

    it("Cancel tells the host and closes the view; Close after the result sends nothing", () => {
        const { root, container } = mount(<Harness />);
        act(() => startCiBisect(REPO, RANGE));
        const requestId = lastStartRequestId();
        act(() => {
            container
                .querySelector<HTMLElement>('[data-testid="ci-bisect-cancel"]')!
                .dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        expect(mockVscodeApi.postMessage).toHaveBeenLastCalledWith({
            type: "cancelCiBisect",
            requestId,
        });
        expect(container.querySelector('[data-testid="ci-bisect"]')).toBeNull();
        // A late reply to the cancelled bisect does not bring the view back.
        reply(result(requestId, []));
        expect(container.querySelector('[data-testid="ci-bisect"]')).toBeNull();

        act(() => startCiBisect(REPO, RANGE));
        reply(result(lastStartRequestId(), []));
        mockVscodeApi.postMessage.mockClear();
        act(() => {
            container
                .querySelector<HTMLElement>('[data-testid="ci-bisect-close"]')!
                .dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        expect(mockVscodeApi.postMessage).not.toHaveBeenCalled();
        expect(container.querySelector('[data-testid="ci-bisect"]')).toBeNull();

        unmount(root, container);
    });

    it("starting a bisect opens the Checks tab", () => {
        const opened = vi.fn();
        window.addEventListener(OPEN_CHECKS_TAB_EVENT, opened);
        try {
            act(() => startCiBisect(REPO, RANGE));
            expect(opened).toHaveBeenCalledTimes(1);
        } finally {
            window.removeEventListener(OPEN_CHECKS_TAB_EVENT, opened);
        }
    });

    describe("sparkline width", () => {
        const sparklineOf = (container: HTMLElement): HTMLElement =>
            container.querySelector<HTMLElement>('[data-testid="ci-bisect-square"]')!
                .parentElement!;

        it("keeps the sparkline at the frozen 72px width (Figma frame 4:2)", () => {
            const { root, container } = mount(<Harness />);
            act(() => startCiBisect(REPO, RANGE));
            reply(
                result(lastStartRequestId(), [
                    {
                        checkName: "unit",
                        states: ["success", "failure", "failure"],
                        brokeAt: B,
                        flaky: null,
                    },
                ]),
            );
            expect(sparklineOf(container).style.width, "frame 4:2 sparkline width").toBe("72px");
            unmount(root, container);
        });

        it("keeps 72px for a longer range and still draws every commit's square", () => {
            const { root, container } = mount(<Harness />);
            act(() => startCiBisect(REPO, RANGE));
            const states = Array.from({ length: 8 }, () => "success" as const);
            reply(
                result(
                    lastStartRequestId(),
                    [{ checkName: "unit", states, brokeAt: null, flaky: null }],
                    { commits: states.map((_, index) => String(index).repeat(40)) },
                ),
            );
            expect(sparklineOf(container).style.width, "locked frame 4:2 width").toBe("72px");
            expect(container.querySelectorAll('[data-testid="ci-bisect-square"]')).toHaveLength(8);
            unmount(root, container);
        });

        it("keeps the six squares of the frame at 9px with a 2px gap", () => {
            const { root, container } = mount(<Harness />);
            act(() => startCiBisect(REPO, RANGE));
            const states = Array.from({ length: 6 }, () => "success" as const);
            reply(
                result(
                    lastStartRequestId(),
                    [{ checkName: "unit", states, brokeAt: null, flaky: null }],
                    { commits: states.map((_, index) => String(index).repeat(40)) },
                ),
            );
            expect(sparklineOf(container).style.gap).toBe("2px");
            const square = container.querySelector<HTMLElement>(
                '[data-testid="ci-bisect-square"]',
            )!;
            expect(square.style.flexBasis).toBe("9px");
            unmount(root, container);
        });

        it("keeps the frame's 9px squares and 2px gap in a 72px strip that scrolls for a long range", () => {
            const { root, container } = mount(<Harness />);
            act(() => startCiBisect(REPO, RANGE));
            const states = Array.from({ length: 40 }, () => "success" as const);
            reply(
                result(
                    lastStartRequestId(),
                    [{ checkName: "unit", states, brokeAt: null, flaky: null }],
                    { commits: states.map((_, index) => String(index).padStart(40, "0")) },
                ),
            );
            const strip = sparklineOf(container);
            expect(strip.style.width).toBe("72px");
            expect(strip.style.gap, "frame 4:2 requires a 2px square gap").toBe("2px");
            expect(strip.style.overflowX, "the older squares scroll into view").toBe("auto");
            const squares = container.querySelectorAll<HTMLElement>(
                '[data-testid="ci-bisect-square"]',
            );
            expect(squares).toHaveLength(40);
            for (const square of squares) {
                expect(square.style.flexBasis, "frame 4:2 square size").toBe("9px");
                expect(square.style.flexShrink, "a square never shrinks").toBe("0");
            }
            unmount(root, container);
        });
    });

    it("keeps the note line at the frame's 16px, with no extra vertical padding", () => {
        const { root, container } = mount(<Harness />);
        act(() => startCiBisect(REPO, RANGE));
        reply(result(lastStartRequestId(), []));
        const note = container.querySelector<HTMLElement>(
            '[data-testid="ci-bisect-close"]',
        )!.parentElement!;
        expect(note.style.paddingTop, "frame 4:2 note line").toBe("0px");
        expect(note.style.paddingBottom).toBe("0px");
        unmount(root, container);
    });

    describe("failed provider reads", () => {
        it("shows an error with a retry, not 'no CI jobs', when every read failed", () => {
            const { root, container } = mount(<Harness />);
            act(() => startCiBisect(REPO, RANGE));
            reply(result(lastStartRequestId(), [], { failedReads: 3 }));
            expect(text(container), "a failed read is not an empty one").not.toContain(
                "No CI jobs found",
            );
            expect(container.querySelector('[role="alert"]')?.textContent).toContain("3");
            expect(container.querySelector('[data-testid="ci-bisect-retry"]')).not.toBeNull();
            unmount(root, container);
        });

        it("retry asks the host again for the same range", () => {
            const { root, container } = mount(<Harness />);
            act(() => startCiBisect(REPO, RANGE));
            const first = lastStartRequestId();
            reply(result(first, [], { failedReads: 3 }));
            mockVscodeApi.postMessage.mockClear();
            act(() => {
                container
                    .querySelector<HTMLButtonElement>('[data-testid="ci-bisect-retry"]')!
                    .click();
            });
            expect(
                mockVscodeApi.postMessage,
                "Retry asks to refresh failed reads",
            ).toHaveBeenCalledWith({
                type: "startCiBisect",
                requestId: first + 1,
                repoKey: REPO,
                commits: RANGE,
                retry: true,
            });
            unmount(root, container);
        });

        it("still shows the jobs it read, with the error and retry above the close link", () => {
            const { root, container } = mount(<Harness />);
            act(() => startCiBisect(REPO, RANGE));
            reply(
                result(
                    lastStartRequestId(),
                    [
                        {
                            checkName: "unit",
                            states: ["success", "success", "success"],
                            brokeAt: null,
                            flaky: null,
                        },
                    ],
                    { failedReads: 1 },
                ),
            );
            expect(container.querySelectorAll('[data-testid="ci-bisect-job"]')).toHaveLength(1);
            expect(container.querySelector('[role="alert"]')).not.toBeNull();
            unmount(root, container);
        });

        it("a successful empty read still says no CI jobs", () => {
            const { root, container } = mount(<Harness />);
            act(() => startCiBisect(REPO, RANGE));
            reply(result(lastStartRequestId(), []));
            expect(text(container)).toContain("No CI jobs found");
            expect(container.querySelector('[role="alert"]')).toBeNull();
            unmount(root, container);
        });
    });

    // Owner 2026-11-24, finding 5 answer B.
    describe("a bisect the host stopped because sign-in or CI settings changed", () => {
        const cancel = (container: HTMLElement) =>
            container.querySelector('[data-testid="ci-bisect-cancel"]');

        it("leaves the progress state, says why and offers to run it again", () => {
            const { root, container } = mount(<Harness />);
            act(() => startCiBisect(REPO, RANGE));
            const first = lastStartRequestId();
            reply({ type: "ciBisectProgress", requestId: first, repoKey: REPO, done: 1, total: 3 });
            expect(cancel(container), "control: running shows Cancel").not.toBeNull();

            reply({
                type: "ciBisectProgress",
                requestId: first,
                repoKey: REPO,
                done: 1,
                total: 3,
                stopped: true,
            });
            expect(cancel(container), "no Cancel once stopped").toBeNull();
            expect(text(container), "the progress line is gone").not.toContain("1 / 3 commits");
            expect(container.querySelector('[role="alert"]')?.textContent).toContain(
                "The check stopped because sign-in or CI settings changed.",
            );

            mockVscodeApi.postMessage.mockClear();
            act(() => {
                container
                    .querySelector<HTMLButtonElement>('[data-testid="ci-bisect-run-again"]')!
                    .click();
            });
            expect(
                mockVscodeApi.postMessage,
                "Run again asks for the same range",
            ).toHaveBeenCalledWith(
                expect.objectContaining({
                    type: "startCiBisect",
                    requestId: first + 1,
                    repoKey: REPO,
                    commits: RANGE,
                }),
            );
            expect(cancel(container), "running again").not.toBeNull();
            unmount(root, container);
        });

        it("Close after a stop sends no cancel", () => {
            const { root, container } = mount(<Harness />);
            act(() => startCiBisect(REPO, RANGE));
            reply({
                type: "ciBisectProgress",
                requestId: lastStartRequestId(),
                repoKey: REPO,
                done: 0,
                total: 3,
                stopped: true,
            });
            mockVscodeApi.postMessage.mockClear();
            act(() => {
                container
                    .querySelector<HTMLButtonElement>('[data-testid="ci-bisect-close"]')!
                    .click();
            });
            expect(mockVscodeApi.postMessage).not.toHaveBeenCalled();
            expect(container.querySelector('[data-testid="ci-bisect"]')).toBeNull();
            unmount(root, container);
        });

        it("ignores a stopped reply for an older bisect", () => {
            const { root, container } = mount(<Harness />);
            act(() => startCiBisect(REPO, RANGE));
            const first = lastStartRequestId();
            act(() => startCiBisect(REPO, RANGE));
            reply({
                type: "ciBisectProgress",
                requestId: first,
                repoKey: REPO,
                done: 0,
                total: 3,
                stopped: true,
            });
            expect(cancel(container)).not.toBeNull();
            expect(container.querySelector('[role="alert"]')).toBeNull();
            unmount(root, container);
        });
    });
});
