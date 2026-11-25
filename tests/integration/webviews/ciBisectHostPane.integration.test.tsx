// @vitest-environment jsdom
// "Find where CI broke" in the card and undocked Git Log (PLAN.md rule 9, "Nothing publishes after
// sign-out, disable or repository change"): the host aborts a run when the repository changes, so
// the webview's one bisect slot must go with it, even while the Checks tab is unmounted. Returning to
// the first repository restores neither the run's progress nor its late replies.

import React, { act, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    closeCiBisect,
    startCiBisect,
    useCiBisect,
} from "../../../src/webviews/react/commit-info/checks/ciBisect";
import { useCommitGraphMessages } from "../../../src/webviews/react/commit-graph/useCommitGraphMessages";
import type { VsCodeApi } from "../../../src/webviews/react/shared/vscodeApi";
import { useUnifiedMessages } from "../../../src/webviews/react/undocked/useUnifiedMessages";
import { initReactDomTestEnvironment, mount, unmount } from "../../helpers/reactDomTestUtils";

const mockVscodeApi = vi.hoisted(() => ({
    postMessage: vi.fn(),
    getState: vi.fn((): unknown => undefined),
    setState: vi.fn(),
}));

vi.mock("../../../src/webviews/react/shared/vscodeApi", () => ({
    getVsCodeApi: () => mockVscodeApi,
}));

initReactDomTestEnvironment();

const [A, B] = ["a", "b"].map((letter) => letter.repeat(40));
const RANGE = [
    { hash: A, parents: [B] },
    { hash: B, parents: [] },
];
const noop = (): void => undefined;
const dispatch = vi.fn();

/** Shows the bisect of "/A" the way a mounted Checks tab would. */
function Probe(): React.ReactElement {
    const view = useCiBisect("/A");
    return <p data-testid="probe">{view ? `${view.status}` : "none"}</p>;
}

function GitLogHost(): null {
    const loadingMore = useRef(false);
    useCommitGraphMessages({
        vscode: mockVscodeApi as unknown as VsCodeApi,
        dispatch,
        sendReady: false,
        loadingMore,
        selectedHash: A,
        ciRepoKey: "/A",
        setViewVisible: noop,
        onShowRebaseDialog: noop,
        onShowReviewPrompt: noop,
    });
    return null;
}

const loadingMore = { current: false };
const cpStateRef = { current: {} } as never;
const layoutRef = { current: null };

function UndockedHost(): null {
    useUnifiedMessages({
        graphDispatch: dispatch,
        cpDispatch: noop,
        applyCommitPanelAction: noop as never,
        cpStateRef,
        loadingMore,
        selectedHash: A,
        selectedRepositoryRoot: "/A",
        setRepositories: noop,
        setSelectedRepositoryRoot: noop,
        markWidthsHydrated: noop,
        setSectionWidths: noop,
        layoutRef,
        setCommitPanelPosition: noop,
        setViewVisible: noop,
        onShowRebaseDialog: noop,
    });
    return null;
}

const send = (data: unknown): void =>
    act(() => {
        window.dispatchEvent(new MessageEvent("message", { data }));
    });

const probeText = (container: HTMLElement): string | null | undefined =>
    container.querySelector('[data-testid="probe"]')?.textContent;

function startInA(): number {
    mockVscodeApi.postMessage.mockClear();
    act(() => startCiBisect("/A", RANGE));
    const start = mockVscodeApi.postMessage.mock.calls
        .map(([message]) => message as { type: string; requestId: number })
        .find(({ type }) => type === "startCiBisect");
    if (!start) throw new Error("No startCiBisect was posted");
    return start.requestId;
}

beforeEach(() => {
    dispatch.mockReset();
    mockVscodeApi.postMessage.mockReset();
    window.intelligitE2E = true;
});

afterEach(() => {
    act(() => closeCiBisect());
    delete window.intelligitE2E;
});

describe("CI bisect across a repository switch in the Git Log hosts", () => {
    it("review: card A-B-A with a cleared detail must not restore retired progress or replies", () => {
        const { root, container } = mount(
            <>
                <GitLogHost />
                <Probe />
            </>,
        );
        const requestId = startInA();
        expect(probeText(container), "control: A's run is on screen").toBe("running");

        // The switch clears the detail twice and no commit is shown in B.
        send({ type: "clearCommitDetail", loading: true, ciRepoKey: "/B" });
        send({ type: "clearCommitDetail", loading: true, ciRepoKey: "/A" });
        expect(probeText(container), "A must not restore the retired run's progress").toBe("none");

        send({ type: "ciBisectProgress", requestId, repoKey: "/A", done: 1, total: 2 });
        expect(probeText(container), "a late reply of the retired run is dropped").toBe("none");
        unmount(root, container);
    });

    it("keeps the card's run through a clear that stays in the same repository", () => {
        const { root, container } = mount(
            <>
                <GitLogHost />
                <Probe />
            </>,
        );
        startInA();
        // A branch filter clears the detail while the repository stays A.
        send({ type: "clearCommitDetail", loading: true, ciRepoKey: "/A" });
        expect(probeText(container)).toBe("running");
        unmount(root, container);
    });

    it("review: undocked A-B-A with a cleared detail must not restore retired progress or replies", () => {
        const { root, container } = mount(
            <>
                <UndockedHost />
                <Probe />
            </>,
        );
        const requestId = startInA();
        expect(probeText(container), "control: A's run is on screen").toBe("running");

        send({ type: "repositories", repositories: [], selectedRepositoryRoot: "/B" });
        send({ type: "repositories", repositories: [], selectedRepositoryRoot: "/A" });
        expect(probeText(container), "A must not restore the retired run's progress").toBe("none");

        send({ type: "ciBisectProgress", requestId, repoKey: "/A", done: 1, total: 2 });
        expect(probeText(container), "a late reply of the retired run is dropped").toBe("none");
        unmount(root, container);
    });

    it("keeps the undocked run when the same repository is announced again", () => {
        const { root, container } = mount(
            <>
                <UndockedHost />
                <Probe />
            </>,
        );
        send({ type: "repositories", repositories: [], selectedRepositoryRoot: "/A" });
        startInA();
        send({ type: "repositories", repositories: [], selectedRepositoryRoot: "/A" });
        expect(probeText(container)).toBe("running");
        unmount(root, container);
    });
});
