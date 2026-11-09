// @vitest-environment jsdom
// The Git Log and the undocked window handle the host's `openChecksTab` message (PLAN.md Phase 4,
// message table): a message for the repository the webview shows selects the commit and switches
// the details pane to its Checks tab; a message for another repository changes nothing.

import React, { act, useRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommitDetail } from "../../../src/types";
import { CommitInfoPane } from "../../../src/webviews/react/commit-info/CommitInfoPane";
import { useCommitGraphMessages } from "../../../src/webviews/react/commit-graph/useCommitGraphMessages";
import type { VsCodeApi } from "../../../src/webviews/react/shared/vscodeApi";
import { useUnifiedMessages } from "../../../src/webviews/react/undocked/useUnifiedMessages";
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

const SHOWN = "a".repeat(40);
const TARGET = "b".repeat(40);
const REPO = "/repo";

const detail: CommitDetail = {
    hash: SHOWN,
    shortHash: SHOWN.slice(0, 7),
    message: "Fix the build",
    author: "Mahesh Kokare",
    email: "mahesh@example.com",
    date: "2026-11-07T12:00:00.000Z",
    parentHashes: [],
    refs: [],
    body: "",
    files: [],
};

const dispatch = vi.fn();
const noop = (): void => undefined;

function GitLogHost(): null {
    const loadingMore = useRef(false);
    useCommitGraphMessages({
        vscode: mockVscodeApi as unknown as VsCodeApi,
        dispatch,
        sendReady: false,
        loadingMore,
        selectedHash: SHOWN,
        ciRepoKey: REPO,
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
        selectedHash: SHOWN,
        selectedRepositoryRoot: REPO,
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

const hosts = [
    { name: "Git Log", Host: GitLogHost },
    { name: "undocked window", Host: UndockedHost },
];

function post(repoKey: string): void {
    act(() => {
        window.dispatchEvent(
            new MessageEvent("message", { data: { type: "openChecksTab", repoKey, hash: TARGET } }),
        );
    });
}

beforeEach(() => {
    installWebviewI18n();
    dispatch.mockReset();
    mockVscodeApi.postMessage.mockReset();
    mockVscodeApi.getState.mockReset();
    mockVscodeApi.setState.mockReset();
});

describe("openChecksTab host message", () => {
    it.each(hosts)(
        "$name selects the commit and switches to Checks for its repository",
        ({ Host }) => {
            const { root, container } = mount(
                <>
                    <Host />
                    <CommitInfoPane detail={detail} ciRepoKey={REPO} commitChecksEnabled />
                </>,
            );
            const selectedTab = (): string | null | undefined =>
                container.querySelector('[role="tab"][aria-selected="true"]')?.textContent;
            expect(selectedTab(), "Files is the default tab").toBe("Files");

            post(REPO);

            expect(selectedTab(), "the details pane switched to Checks").toBe("Checks");
            expect(dispatch, "the row is selected").toHaveBeenCalledWith({
                type: "selectCommit",
                hash: TARGET,
            });
            expect(
                mockVscodeApi.postMessage,
                "the host loads the commit's detail",
            ).toHaveBeenCalledWith({ type: "selectCommit", hash: TARGET });
            unmount(root, container);
        },
    );

    it.each(hosts)("$name ignores a message for another repository", ({ Host }) => {
        const { root, container } = mount(
            <>
                <Host />
                <CommitInfoPane detail={detail} ciRepoKey={REPO} commitChecksEnabled />
            </>,
        );

        post("/other-repo");

        expect(
            container.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
            "another repository's message leaves the tab alone",
        ).toBe("Files");
        expect(dispatch, "another repository's message selects nothing").not.toHaveBeenCalled();
        expect(mockVscodeApi.postMessage).not.toHaveBeenCalledWith(
            expect.objectContaining({ type: "selectCommit" }),
        );
        unmount(root, container);
    });
});

// Last in the file: the app renders into #root when imported and stays mounted until the file ends.
describe("openChecksTab in the standalone Changed Files view", () => {
    it("switches to Checks only for the repository it shows", async () => {
        const host = document.createElement("div");
        host.id = "root";
        document.body.appendChild(host);
        vi.resetModules();
        await act(async () => {
            await import("../../../src/webviews/react/CommitInfoApp");
        });
        const send = (data: unknown): void =>
            act(() => {
                window.dispatchEvent(new MessageEvent("message", { data }));
            });
        const selectedTab = (): string | null | undefined =>
            host.querySelector('[role="tab"][aria-selected="true"]')?.textContent;

        // A request made in another repository, received before any detail: the detail that
        // follows is this view's repository, so the request is refused once it is known.
        send({ type: "clear", loading: true });
        send({ type: "openChecksTab", repoKey: "/other-repo", hash: SHOWN });
        send({ type: "setCommitDetail", detail, ciRepoKey: REPO, commitChecksEnabled: true });
        expect(
            selectedTab(),
            "another repository's request received while loading leaves Files selected",
        ).toBe("Files");

        // The host holds the request until the view is ready, which can be before any detail arrives.
        send({ type: "clear", loading: true });
        send({ type: "openChecksTab", repoKey: REPO, hash: SHOWN });
        send({ type: "setCommitDetail", detail, ciRepoKey: REPO, commitChecksEnabled: true });
        expect(selectedTab(), "a request received while loading shows Checks").toBe("Checks");

        const filesTab = Array.from(host.querySelectorAll<HTMLElement>('[role="tab"]')).find(
            (tab) => tab.textContent === "Files",
        );
        act(() => filesTab?.click());
        expect(selectedTab(), "back on Files").toBe("Files");

        send({ type: "openChecksTab", repoKey: "/other-repo", hash: SHOWN });
        expect(selectedTab(), "another repository's open request leaves Files selected").toBe(
            "Files",
        );

        send({ type: "openChecksTab", repoKey: REPO, hash: SHOWN });
        expect(selectedTab(), "its own repository's open request switches to Checks").toBe(
            "Checks",
        );
    });
});
