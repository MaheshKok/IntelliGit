// @vitest-environment jsdom

import React, { act, useMemo, useRef } from "react";
import { createRoot } from "react-dom/client";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Commit } from "../../../src/types";
import type { InteractiveRebaseRangeCommit } from "../../../src/webviews/protocol/commitGraphTypes";
import { useCommitGraphMessages } from "../../../src/webviews/react/commit-graph/useCommitGraphMessages";
import type { CommitGraphPanelAction } from "../../../src/webviews/react/commit-graph/types";
import type { VsCodeApi } from "../../../src/webviews/react/shared/vscodeApi";

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
    onShowRebaseDialog,
}: {
    dispatch: React.Dispatch<CommitGraphPanelAction>;
    postMessage: (message: unknown) => void;
    selectedHash: string | null;
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
        onShowRebaseDialog,
    });
    return null;
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
});
