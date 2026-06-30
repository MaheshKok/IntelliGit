// @vitest-environment jsdom

import React, { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Commit } from "../../../src/types";
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
}: {
    dispatch: React.Dispatch<CommitGraphPanelAction>;
    postMessage: (message: unknown) => void;
    selectedHash: string | null;
}): React.ReactElement | null {
    const loadingMore = useRef(false);
    useCommitGraphMessages({
        vscode: { postMessage } as unknown as VsCodeApi,
        dispatch,
        sendReady: false,
        loadingMore,
        selectedHash,
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
});
