// @vitest-environment jsdom

import React, { act, useMemo, useRef } from "react";
import { createRoot } from "react-dom/client";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Commit } from "../../../src/types";
import type { InteractiveRebaseRangeCommit } from "../../../src/webviews/protocol/commitGraphTypes";
import { useCommitGraphMessages } from "../../../src/webviews/react/commit-graph/useCommitGraphMessages";
import type { CommitGraphPanelAction } from "../../../src/webviews/react/commit-graph/types";
import type { VsCodeApi } from "../../../src/webviews/react/shared/vscodeApi";

const checksTab = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("../../../src/webviews/react/commit-info/checks/checksTabState", () => ({
    openChecksTab: checksTab.open,
}));

function makeCommit(hash: string, message: string): Commit {
    return {
        hash,
        shortHash: hash,
        message,
        author: "Mahesh",
        email: "m@example.com",
        date: "2026-02-19T00:00:00Z",
        parentHashes: ["parent"],
        refs: [],
    };
}

function Harness({
    dispatch,
    postMessage,
    selectedHash,
    ciRepoKey,
    onShowRebaseDialog,
}: {
    dispatch: React.Dispatch<CommitGraphPanelAction>;
    postMessage: (message: unknown) => void;
    selectedHash: string | null;
    ciRepoKey?: string;
    onShowRebaseDialog?: (dialog: {
        requestId: string;
        commits: readonly InteractiveRebaseRangeCommit[];
        branch: string;
        hasPushed: boolean;
    }) => void;
}): React.ReactElement | null {
    const loadingMore = useRef(false);
    // Stable across re-renders: `vscode` is an effect dependency, so a fresh object literal here
    // would tear down and re-subscribe the message listener on every render and mask whether the
    // hook itself keeps a fixed subscription lifetime.
    const vscode = useMemo(() => ({ postMessage }) as unknown as VsCodeApi, [postMessage]);
    useCommitGraphMessages({
        vscode,
        dispatch,
        sendReady: false,
        loadingMore,
        selectedHash,
        ...(ciRepoKey !== undefined && { ciRepoKey }),
        onShowRebaseDialog,
    });
    return null;
}

function post(data: unknown): void {
    act(() => {
        window.dispatchEvent(new MessageEvent("message", { data }));
    });
}

beforeAll(() => {
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
        value: true,
        configurable: true,
    });
});

describe("useCommitGraphMessages", () => {
    it("keeps an existing selected commit on full refresh", async () => {
        const host = document.createElement("div");
        document.body.appendChild(host);
        const root = createRoot(host);
        const dispatch = vi.fn();
        const postMessage = vi.fn();

        try {
            await act(async () => {
                root.render(
                    <Harness dispatch={dispatch} postMessage={postMessage} selectedHash="bb22" />,
                );
            });

            act(() => {
                window.dispatchEvent(
                    new MessageEvent("message", {
                        data: {
                            type: "loadCommits",
                            append: false,
                            hasMore: false,
                            commits: [
                                makeCommit("aa11", "feat: first commit"),
                                makeCommit("bb22", "fix: selected commit"),
                            ],
                        },
                    }),
                );
            });

            expect(dispatch).toHaveBeenCalledWith(
                expect.objectContaining({
                    type: "loadCommits",
                    selectedHash: "bb22",
                }),
            );
            expect(postMessage).not.toHaveBeenCalledWith(
                expect.objectContaining({ type: "selectCommit" }),
            );
        } finally {
            await act(async () => {
                root.unmount();
            });
            host.remove();
        }
    });

    it("selects the first commit after a branch change", async () => {
        const host = document.createElement("div");
        document.body.appendChild(host);
        const root = createRoot(host);
        const dispatch = vi.fn();
        const postMessage = vi.fn();

        try {
            await act(async () => {
                root.render(
                    <Harness dispatch={dispatch} postMessage={postMessage} selectedHash="bb22" />,
                );
            });

            act(() => {
                window.dispatchEvent(
                    new MessageEvent("message", {
                        data: {
                            type: "setSelectedBranch",
                            branch: "main",
                        },
                    }),
                );
            });
            act(() => {
                window.dispatchEvent(
                    new MessageEvent("message", {
                        data: {
                            type: "loadCommits",
                            append: false,
                            hasMore: false,
                            commits: [
                                makeCommit("aa11", "feat: first commit"),
                                makeCommit("bb22", "fix: previously selected commit"),
                            ],
                        },
                    }),
                );
            });

            expect(dispatch).toHaveBeenCalledWith(
                expect.objectContaining({
                    type: "loadCommits",
                    selectedHash: "aa11",
                }),
            );
            expect(postMessage).toHaveBeenCalledWith({
                type: "selectCommit",
                hash: "aa11",
            });
        } finally {
            await act(async () => {
                root.unmount();
            });
            host.remove();
        }
    });

    it("reposts the first commit after a branch change when the hash is unchanged", async () => {
        const host = document.createElement("div");
        document.body.appendChild(host);
        const root = createRoot(host);
        const dispatch = vi.fn();
        const postMessage = vi.fn();

        try {
            await act(async () => {
                root.render(
                    <Harness dispatch={dispatch} postMessage={postMessage} selectedHash="aa11" />,
                );
            });

            act(() => {
                window.dispatchEvent(
                    new MessageEvent("message", {
                        data: {
                            type: "setSelectedBranch",
                            branch: "main",
                        },
                    }),
                );
            });
            act(() => {
                window.dispatchEvent(
                    new MessageEvent("message", {
                        data: {
                            type: "loadCommits",
                            append: false,
                            hasMore: false,
                            commits: [makeCommit("aa11", "feat: first commit")],
                        },
                    }),
                );
            });

            expect(dispatch).toHaveBeenCalledWith(
                expect.objectContaining({
                    type: "loadCommits",
                    selectedHash: "aa11",
                }),
            );
            expect(postMessage).toHaveBeenCalledWith({
                type: "selectCommit",
                hash: "aa11",
            });
        } finally {
            await act(async () => {
                root.unmount();
            });
            host.remove();
        }
    });

    it("applies host text-filter resets", async () => {
        const host = document.createElement("div");
        document.body.appendChild(host);
        const root = createRoot(host);
        const dispatch = vi.fn();
        const postMessage = vi.fn();

        try {
            await act(async () => {
                root.render(
                    <Harness dispatch={dispatch} postMessage={postMessage} selectedHash={null} />,
                );
            });

            act(() => {
                window.dispatchEvent(
                    new MessageEvent("message", {
                        data: {
                            type: "setFilterText",
                            text: "",
                        },
                    }),
                );
            });

            expect(dispatch).toHaveBeenCalledWith({ type: "setFilterText", text: "" });
        } finally {
            await act(async () => {
                root.unmount();
            });
            host.remove();
        }
    });

    it("delivers an interactive-rebase offer only to the docked graph host", async () => {
        const host = document.createElement("div");
        document.body.appendChild(host);
        const root = createRoot(host);
        const dispatch = vi.fn();
        const postMessage = vi.fn();
        const onShowRebaseDialog = vi.fn();

        try {
            await act(async () => {
                root.render(
                    <Harness
                        dispatch={dispatch}
                        postMessage={postMessage}
                        selectedHash={null}
                        onShowRebaseDialog={onShowRebaseDialog}
                    />,
                );
            });

            const commits: InteractiveRebaseRangeCommit[] = [
                {
                    hash: "a".repeat(40),
                    authorName: "Ada",
                    authoredAt: "2026-01-01",
                    body: "Subject",
                    isPushed: true,
                },
            ];
            act(() => {
                window.dispatchEvent(
                    new MessageEvent("message", {
                        data: {
                            type: "showRebaseDialog",
                            requestId: "docked-request",
                            commits,
                            branch: "main",
                            hasPushed: true,
                        },
                    }),
                );
            });

            expect(onShowRebaseDialog).toHaveBeenCalledWith({
                type: "showRebaseDialog",
                requestId: "docked-request",
                commits,
                branch: "main",
                hasPushed: true,
            });
            expect(dispatch).not.toHaveBeenCalled();
        } finally {
            await act(async () => {
                root.unmount();
            });
            host.remove();
        }
    });

    it("delivers offers to the newest handler without resubscribing the message listener", async () => {
        const host = document.createElement("div");
        document.body.appendChild(host);
        const root = createRoot(host);
        const postMessage = vi.fn();
        const first = vi.fn();
        const second = vi.fn();
        const addEventListener = vi.spyOn(window, "addEventListener");

        function offer(requestId: string): void {
            act(() => {
                window.dispatchEvent(
                    new MessageEvent("message", {
                        data: {
                            type: "showRebaseDialog",
                            requestId,
                            commits: [],
                            branch: "main",
                            hasPushed: false,
                        },
                    }),
                );
            });
        }

        try {
            await act(async () => {
                root.render(
                    <Harness
                        dispatch={vi.fn()}
                        postMessage={postMessage}
                        selectedHash={null}
                        onShowRebaseDialog={first}
                    />,
                );
            });
            const subscriptionsAfterMount = addEventListener.mock.calls.filter(
                ([type]) => type === "message",
            ).length;
            offer("first-request");

            // A host that re-creates its handler must not strand offers on the stale one.
            await act(async () => {
                root.render(
                    <Harness
                        dispatch={vi.fn()}
                        postMessage={postMessage}
                        selectedHash={null}
                        onShowRebaseDialog={second}
                    />,
                );
            });
            offer("second-request");

            expect(first).toHaveBeenCalledTimes(1);
            expect(first.mock.calls[0][0]).toMatchObject({ requestId: "first-request" });
            expect(second).toHaveBeenCalledTimes(1);
            expect(second.mock.calls[0][0]).toMatchObject({ requestId: "second-request" });
            // The effect owns the single `ready` post, so a new handler must not re-subscribe it.
            expect(addEventListener.mock.calls.filter(([type]) => type === "message").length).toBe(
                subscriptionsAfterMount,
            );
        } finally {
            addEventListener.mockRestore();
            await act(async () => {
                root.unmount();
            });
            host.remove();
        }
    });

    describe("an Open Checks request that arrives before any commit detail", () => {
        const HEAD = "c".repeat(40);
        const FIRST = "d".repeat(40);

        async function mountWithoutDetail(postMessage = vi.fn(), dispatch = vi.fn()) {
            const host = document.createElement("div");
            document.body.appendChild(host);
            const root = createRoot(host);
            checksTab.open.mockClear();
            await act(async () => {
                root.render(
                    <Harness dispatch={dispatch} postMessage={postMessage} selectedHash={null} />,
                );
            });
            return async () => {
                await act(async () => {
                    root.unmount();
                });
                host.remove();
            };
        }

        it("opens the Checks tab once the first detail shows the same repository", async () => {
            const postMessage = vi.fn();
            const dispatch = vi.fn();
            const unmount = await mountWithoutDetail(postMessage, dispatch);
            try {
                // The host's ready handler posts no detail, then the held request (journey 4).
                post({ type: "clearCommitDetail" });
                post({ type: "openChecksTab", repoKey: "/repo", hash: HEAD });
                post({ type: "setCommitDetail", detail: { hash: FIRST }, ciRepoKey: "/repo" });
                expect(postMessage).toHaveBeenCalledWith({ type: "selectCommit", hash: HEAD });
                expect(
                    dispatch,
                    "the held request must select its commit in the list",
                ).toHaveBeenCalledWith({ type: "selectCommit", hash: HEAD });
                // A later detail must not fire the request again.
                post({ type: "setCommitDetail", detail: { hash: HEAD }, ciRepoKey: "/repo" });

                expect(
                    checksTab.open,
                    "a request held until the first detail must open the Checks tab once",
                ).toHaveBeenCalledTimes(1);
            } finally {
                await unmount();
            }
        });

        it("applies a request posted right after a detail, before React re-renders", async () => {
            const unmount = await mountWithoutDetail();
            try {
                // A reload with a detail cached: the host posts both back to back.
                act(() => {
                    window.dispatchEvent(
                        new MessageEvent("message", {
                            data: {
                                type: "setCommitDetail",
                                detail: { hash: HEAD },
                                ciRepoKey: "/repo",
                            },
                        }),
                    );
                    window.dispatchEvent(
                        new MessageEvent("message", {
                            data: { type: "openChecksTab", repoKey: "/repo", hash: HEAD },
                        }),
                    );
                });

                expect(
                    checksTab.open,
                    "the detail's repository must count before the next render",
                ).toHaveBeenCalledTimes(1);
            } finally {
                await unmount();
            }
        });

        it("opens at once for the shown repository and drops another one", async () => {
            const unmount = await mountWithoutDetail();
            try {
                post({ type: "setCommitDetail", detail: { hash: FIRST }, ciRepoKey: "/repo" });
                post({ type: "openChecksTab", repoKey: "/other-repo", hash: HEAD });
                expect(
                    checksTab.open,
                    "a request for a repository other than the shown one must be dropped",
                ).not.toHaveBeenCalled();
                post({ type: "openChecksTab", repoKey: "/repo", hash: HEAD });
                expect(
                    checksTab.open,
                    "a request for the shown repository must open the Checks tab at once",
                ).toHaveBeenCalledTimes(1);
            } finally {
                await unmount();
            }
        });

        it("drops the held request when the first detail shows another repository", async () => {
            const postMessage = vi.fn();
            const unmount = await mountWithoutDetail(postMessage);
            try {
                post({ type: "openChecksTab", repoKey: "/old-repo", hash: HEAD });
                post({ type: "setCommitDetail", detail: { hash: FIRST }, ciRepoKey: "/repo" });
                post({ type: "setCommitDetail", detail: { hash: FIRST }, ciRepoKey: "/old-repo" });

                expect(
                    checksTab.open,
                    "a held request for another repository must not open the Checks tab",
                ).not.toHaveBeenCalled();
                expect(postMessage).not.toHaveBeenCalledWith(
                    expect.objectContaining({ type: "selectCommit" }),
                );
            } finally {
                await unmount();
            }
        });
    });
});
