// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useExtensionMessages } from "../../../src/webviews/react/commit-panel/hooks/useExtensionMessages";
import type {
    CommitPanelAction,
    MultiRepositoryCommitPanelState,
} from "../../../src/webviews/react/commit-panel/types";

const postMessage = vi.fn();
let latestState: MultiRepositoryCommitPanelState;
let latestDispatch: React.Dispatch<CommitPanelAction>;

vi.mock("../../../src/webviews/react/commit-panel/hooks/useVsCodeApi", () => ({
    getVsCodeApi: () => ({ postMessage }),
}));

function Harness(): null {
    [latestState, latestDispatch] = useExtensionMessages();
    return null;
}

beforeAll(() => {
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
        value: true,
        configurable: true,
    });
});

afterEach(() => {
    postMessage.mockReset();
    document.body.innerHTML = "";
});

function repository(
    root: string,
    label: string,
): {
    root: string;
    label: string;
    kind: "repository";
    changedFileCount: number;
} {
    return { root, label, kind: "repository", changedFileCount: 0 };
}

function stateFor(root: string): MultiRepositoryCommitPanelState["repositories"][number] {
    const state = latestState.repositories.find((candidate) => candidate.root === root);
    if (!state) throw new Error(`Missing repository state for ${root}`);
    return state;
}

function send(data: unknown): void {
    window.dispatchEvent(new MessageEvent("message", { data }));
}

async function renderHarness(): Promise<{ root: Root; host: HTMLDivElement }> {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
        root.render(<Harness />);
    });
    postMessage.mockClear();
    return { root, host };
}

describe("docked commit-message generation lifecycle", () => {
    it("keeps generation state root-scoped through synchronous host lifecycle replies", async () => {
        const { root, host } = await renderHarness();
        try {
            await act(async () => {
                send({
                    type: "setRepositories",
                    repositories: [
                        repository("/repo-a", "Repo A"),
                        repository("/repo-b", "Repo B"),
                    ],
                    activeRepositoryRoot: "/repo-a",
                });
            });
            expect(stateFor("/repo-a")).toMatchObject({
                hasCommits: false,
                generation: { status: "idle" },
            });

            await act(async () => {
                send({
                    type: "update",
                    repositoryRoot: "/repo-a",
                    files: [],
                    hasCommits: true,
                    wholeIndexOperationInProgress: false,
                    stashes: [],
                    stashFiles: [],
                    selectedStashIndex: null,
                    shelves: [],
                    catalogGeneration: 0,
                    selectedShelfId: null,
                    currentBranchHasUpstream: true,
                    currentBranchAhead: 0,
                    currentBranchBehind: 0,
                });
                send({
                    type: "update",
                    repositoryRoot: "/repo-b",
                    files: [],
                    hasCommits: false,
                    wholeIndexOperationInProgress: true,
                    stashes: [],
                    stashFiles: [],
                    selectedStashIndex: null,
                    shelves: [],
                    catalogGeneration: 0,
                    selectedShelfId: null,
                    currentBranchHasUpstream: true,
                    currentBranchAhead: 0,
                    currentBranchBehind: 0,
                });
                send({ type: "restoreCommitDraft", repositoryRoot: "/repo-a", message: "draft A" });
                send({ type: "restoreCommitDraft", repositoryRoot: "/repo-b", message: "draft B" });
            });

            expect(stateFor("/repo-b")).toMatchObject({
                hasCommits: false,
                wholeIndexOperationInProgress: true,
                generation: { status: "idle" },
            });

            await act(async () => {
                latestDispatch({
                    type: "REQUEST_COMMIT_MESSAGE_GENERATION",
                    repositoryRoot: "/repo-a",
                    requestId: "before-start-error",
                    snapshot: "draft A",
                } as CommitPanelAction);
                send({
                    type: "commitMessageGeneration",
                    repositoryRoot: "/repo-a",
                    requestId: "before-start-error",
                    kind: "error",
                });
            });
            expect(stateFor("/repo-a")).toMatchObject({
                commitMessage: "draft A",
                generation: { status: "idle" },
            });
            expect(postMessage).toHaveBeenLastCalledWith({
                type: "saveCommitDraft",
                repositoryRoot: "/repo-a",
                message: "draft A",
            });

            postMessage.mockClear();
            await act(async () => {
                latestDispatch({
                    type: "REQUEST_COMMIT_MESSAGE_GENERATION",
                    repositoryRoot: "/repo-a",
                    requestId: "winning-request",
                    snapshot: "draft A",
                } as CommitPanelAction);
                send({
                    type: "commitMessageGeneration",
                    repositoryRoot: "/repo-a",
                    requestId: "winning-request",
                    kind: "start",
                });
                send({
                    type: "restoreCommitDraft",
                    repositoryRoot: "/repo-a",
                    message: "delayed draft",
                });
                send({
                    type: "lastCommitMessage",
                    repositoryRoot: "/repo-a",
                    message: "delayed last commit",
                });
                send({
                    type: "commitMessageGeneration",
                    repositoryRoot: "/repo-a",
                    requestId: "winning-request",
                    kind: "chunk",
                    text: "feat: ",
                });
                send({
                    type: "commitMessageGeneration",
                    repositoryRoot: "/repo-a",
                    requestId: "winning-request",
                    kind: "chunk",
                    text: "generated",
                });
            });
            expect(stateFor("/repo-a")).toMatchObject({
                commitMessage: "draft A\nfeat: generated",
                generation: {
                    status: "running",
                    requestId: "winning-request",
                    snapshot: "draft A",
                },
            });
            expect(stateFor("/repo-b").commitMessage).toBe("draft B");

            await act(async () => {
                latestDispatch({
                    type: "SET_COMMIT_MESSAGE",
                    repositoryRoot: "/repo-a",
                    message: "blocked edit",
                });
                latestDispatch({ type: "SET_AMEND", repositoryRoot: "/repo-a", isAmend: true });
                send({
                    type: "commitMessageGeneration",
                    repositoryRoot: "/unknown",
                    requestId: "winning-request",
                    kind: "done",
                });
                send({
                    type: "commitMessageGeneration",
                    repositoryRoot: "/repo-a",
                    requestId: "stale-request",
                    kind: "done",
                });
                send({
                    type: "commitMessageGeneration",
                    repositoryRoot: "/repo-a",
                    requestId: "winning-request",
                    kind: "done",
                });
            });
            expect(stateFor("/repo-a")).toMatchObject({
                commitMessage: "draft A\nfeat: generated",
                isAmend: false,
                generation: { status: "idle" },
            });
            expect(postMessage).toHaveBeenLastCalledWith({
                type: "saveCommitDraft",
                repositoryRoot: "/repo-a",
                message: "draft A\nfeat: generated",
            });
            expect(latestState.repositories).toHaveLength(2);

            postMessage.mockClear();
            await act(async () => {
                latestDispatch({
                    type: "REQUEST_COMMIT_MESSAGE_GENERATION",
                    repositoryRoot: "/repo-a",
                    requestId: "cancelled-request",
                    snapshot: "feat: generated",
                } as CommitPanelAction);
                send({
                    type: "commitMessageGeneration",
                    repositoryRoot: "/repo-a",
                    requestId: "cancelled-request",
                    kind: "start",
                });
                send({
                    type: "commitMessageGeneration",
                    repositoryRoot: "/repo-a",
                    requestId: "cancelled-request",
                    kind: "cancelled",
                });
            });
            expect(stateFor("/repo-a")).toMatchObject({
                commitMessage: "feat: generated",
                generation: { status: "idle" },
            });
            expect(postMessage).toHaveBeenLastCalledWith({
                type: "saveCommitDraft",
                repositoryRoot: "/repo-a",
                message: "feat: generated",
            });

            postMessage.mockClear();
            await act(async () => {
                latestDispatch({
                    type: "REQUEST_COMMIT_MESSAGE_GENERATION",
                    repositoryRoot: "/repo-a",
                    requestId: "superseded-request",
                    snapshot: "feat: generated",
                } as CommitPanelAction);
                send({
                    type: "commitMessageGeneration",
                    repositoryRoot: "/repo-a",
                    requestId: "superseded-request",
                    kind: "start",
                });
                send({
                    type: "commitMessageGeneration",
                    repositoryRoot: "/repo-a",
                    requestId: "superseded-request",
                    kind: "chunk",
                    text: "temporary generated text",
                });
                send({
                    type: "commitMessageGeneration",
                    repositoryRoot: "/repo-a",
                    requestId: "superseded-request",
                    kind: "done",
                    superseded: true,
                });
            });
            expect(stateFor("/repo-a")).toMatchObject({
                commitMessage: "feat: generated",
                generation: { status: "idle" },
            });
            expect(postMessage).not.toHaveBeenCalled();
        } finally {
            await act(async () => {
                root.unmount();
            });
            host.remove();
        }
    });
});
