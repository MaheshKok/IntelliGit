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

function result(
    requestId: number,
    jobs: CiBisectJob[],
    extra: Partial<CiBisectResultMessage> = {},
): CiBisectResultMessage {
    return {
        type: "ciBisectResult",
        requestId,
        repoKey: REPO,
        linear: true,
        commits: [C, B, A],
        jobs,
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

        reply({ type: "ciBisectProgress", requestId, done: 1, total: 3 });
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
        expect(rows[2]!.textContent).toContain(
            "flaky: 1 red in 3, no run of red → likely not yours",
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

        reply({ type: "ciBisectProgress", requestId: first, done: 2, total: 3 });
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

        it("grows past 72px only when more squares than the frame's six need the room", () => {
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
            // 8 px lead + 8 squares of 9 px + 7 gaps of 2 px.
            expect(sparklineOf(container).style.width).toBe("94px");
            unmount(root, container);
        });
    });
});
