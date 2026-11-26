// @vitest-environment jsdom
// "Find where CI broke" in the webview (PLAN.md section 4, 9 and frame 4:2): a progress or stopped
// reply counts only for the repository it was started in, and a sparkline square is amber when the
// flaky tag counted its red as isolated, whatever skipped check lies between it and the green.

import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BisectView } from "../../../src/webviews/react/commit-info/checks/BisectView";
import {
    closeCiBisect,
    startCiBisect,
    useCiBisect,
} from "../../../src/webviews/react/commit-info/checks/ciBisect";
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

function Harness(): React.ReactElement | null {
    const view = useCiBisect(REPO);
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

beforeEach(() => {
    installWebviewI18n();
    mockVscodeApi.postMessage.mockReset();
    window.intelligitE2E = true;
});

afterEach(() => {
    act(() => closeCiBisect());
    delete window.intelligitE2E;
});

describe("CI bisect replies", () => {
    it("ignores another repository's progress or stopped reply for the current request id", () => {
        const { root, container } = mount(<Harness />);
        act(() => startCiBisect(REPO, RANGE));
        const requestId = lastStartRequestId();
        const cancel = (): Element | null =>
            container.querySelector('[data-testid="ci-bisect-cancel"]');

        reply({ type: "ciBisectProgress", requestId, repoKey: "/other", done: 2, total: 3 });
        expect(container.textContent).not.toContain("2 / 3 commits");
        reply({
            type: "ciBisectProgress",
            requestId,
            repoKey: "/other",
            done: 0,
            total: 3,
            stopped: true,
        });
        expect(cancel(), "foreign progress must leave the run active").not.toBeNull();

        reply({ type: "ciBisectProgress", requestId, repoKey: REPO, done: 1, total: 3 });
        expect(container.textContent, "control: this repository's progress counts").toContain(
            "1 / 3 commits",
        );
        unmount(root, container);
    });

    it("uses amber for an isolated red separated from a green by a skipped check", () => {
        const { root, container } = mount(<Harness />);
        act(() => startCiBisect(REPO, RANGE));
        const requestId = lastStartRequestId();
        reply({
            type: "ciBisectResult",
            requestId,
            repoKey: REPO,
            linear: true,
            commits: [C, B, A],
            jobs: [
                {
                    checkName: "unit",
                    // Oldest first: green, red, skipped, green.
                    states: ["success", "failure", "skipped", "success"],
                    isolated: [false, true, false, false],
                    brokeAt: null,
                    flaky: { n: 1, m: 3, attemptsCounted: true },
                },
            ],
        });
        const tones = Array.from(
            container.querySelectorAll<HTMLElement>('[data-testid="ci-bisect-square"]'),
        ).map((square) => [square.dataset.state, square.dataset.tone]);
        // Newest on the left.
        expect(tones[2]?.[0]).toBe("failure");
        expect(tones[2]?.[1], "nearest complete greens make this flaky red amber").toBe("amber");
        unmount(root, container);
    });

    it("colors an isolated red amber across a fully read commit where the job did not run", () => {
        const { root, container } = mount(<Harness />);
        const D = "d".repeat(40);
        act(() => startCiBisect(REPO, [...RANGE, { hash: D, parents: [] }]));
        reply({
            type: "ciBisectResult",
            requestId: lastStartRequestId(),
            repoKey: REPO,
            linear: true,
            commits: [D, C, B, A],
            jobs: [
                {
                    checkName: "build",
                    states: ["success", "failure", null, "success"],
                    isolated: [false, true, false, false],
                    brokeAt: C,
                    flaky: { n: 1, m: 3, attemptsCounted: false },
                },
            ],
        });
        const red = container.querySelector<HTMLElement>('[data-state="failure"]');
        expect(
            red?.dataset.tone,
            "the job's one isolated red must use its flaky tag's decision",
        ).toBe("amber");
        unmount(root, container);
    });

    it("control: a red the host did not count as isolated stays red beside a no-result commit", () => {
        const { root, container } = mount(<Harness />);
        const D = "d".repeat(40);
        act(() => startCiBisect(REPO, [...RANGE, { hash: D, parents: [] }]));
        reply({
            type: "ciBisectResult",
            requestId: lastStartRequestId(),
            repoKey: REPO,
            linear: true,
            commits: [D, C, B, A],
            jobs: [
                {
                    checkName: "build",
                    states: ["success", "failure", null, "success"],
                    isolated: [false, false, false, false],
                    brokeAt: C,
                    flaky: null,
                },
            ],
        });
        const red = container.querySelector<HTMLElement>('[data-state="failure"]');
        expect(red?.dataset.tone).toBe("red");
        unmount(root, container);
    });
});

describe("CI bisect across a repository switch", () => {
    function RepoPane({ repoKey }: { repoKey: string }): React.ReactElement | null {
        const view = useCiBisect(repoKey);
        return view ? <BisectView view={view} /> : null;
    }

    it("returning to a repository does not restore a run the host abandoned", () => {
        const { root, container } = mount(<RepoPane repoKey={REPO} />);
        act(() => startCiBisect(REPO, RANGE));
        const requestId = lastStartRequestId();
        expect(container.textContent).toContain("0 / 3 commits");
        act(() => root.render(<RepoPane repoKey="/other" />));
        act(() => root.render(<RepoPane repoKey={REPO} />));
        expect(
            container.textContent,
            "returning to a repo cannot restore a run the host abandoned",
        ).not.toContain("0 / 3 commits");
        expect(
            mockVscodeApi.postMessage,
            "the host's run is cancelled, even though the user came back before its read ended",
        ).toHaveBeenCalledWith({ type: "cancelCiBisect", requestId });
        unmount(root, container);
    });

    it("control: a pane that stays on its repository keeps its run", () => {
        const { root, container } = mount(<RepoPane repoKey={REPO} />);
        act(() => startCiBisect(REPO, RANGE));
        act(() => root.render(<RepoPane repoKey={REPO} />));
        expect(container.textContent).toContain("0 / 3 commits");
        expect(mockVscodeApi.postMessage).not.toHaveBeenCalledWith(
            expect.objectContaining({ type: "cancelCiBisect" }),
        );
        unmount(root, container);
    });
});
