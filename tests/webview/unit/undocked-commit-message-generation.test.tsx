// @vitest-environment jsdom

import React, { act, useReducer, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    commitPanelReducer,
    initialCommitPanelState,
} from "../../../src/webviews/react/undocked/commitPanelState";

let reactRoot: Root | undefined;

async function render(element: React.ReactElement): Promise<void> {
    const host = document.createElement("div");
    document.body.appendChild(host);
    await act(async () => {
        reactRoot = createRoot(host);
        reactRoot.render(element);
    });
}

function send(message: unknown): void {
    act(() => {
        window.dispatchEvent(new MessageEvent("message", { data: message }));
    });
}

beforeEach(() => {
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
        value: true,
        configurable: true,
    });
    vi.clearAllMocks();
    vi.resetModules();
});

afterEach(() => {
    act(() => reactRoot?.unmount());
    reactRoot = undefined;
    document.body.innerHTML = "";
});

describe("undocked commit-message generation lifecycle", () => {
    it("keeps only the winning request output and restores superseded or cancelled drafts", () => {
        const requested = commitPanelReducer(initialCommitPanelState, {
            type: "REQUEST_COMMIT_MESSAGE_GENERATION",
            requestId: "request-a",
            snapshot: "saved draft",
        });
        expect(requested.generation).toEqual({
            status: "requested",
            requestId: "request-a",
            snapshot: "saved draft",
        });

        const running = commitPanelReducer(requested, {
            type: "COMMIT_MESSAGE_GENERATION_EVENT",
            requestId: "request-a",
            kind: "start",
        });
        const streamed = commitPanelReducer(
            commitPanelReducer(running, {
                type: "COMMIT_MESSAGE_GENERATION_EVENT",
                requestId: "request-a",
                kind: "chunk",
                text: "feat: ",
            }),
            {
                type: "COMMIT_MESSAGE_GENERATION_EVENT",
                requestId: "request-a",
                kind: "chunk",
                text: "generated",
            },
        );
        expect(streamed.commitMessage).toBe("feat: generated");

        const winner = commitPanelReducer(streamed, {
            type: "COMMIT_MESSAGE_GENERATION_EVENT",
            requestId: "request-a",
            kind: "done",
        });
        expect(winner).toMatchObject({
            commitMessage: "feat: generated",
            generation: { status: "idle" },
        });

        const cancelled = commitPanelReducer(
            commitPanelReducer(winner, {
                type: "REQUEST_COMMIT_MESSAGE_GENERATION",
                requestId: "request-cancelled",
                snapshot: "feat: generated",
            }),
            {
                type: "COMMIT_MESSAGE_GENERATION_EVENT",
                requestId: "request-cancelled",
                kind: "cancelled",
            },
        );
        expect(cancelled).toMatchObject({
            commitMessage: "feat: generated",
            generation: { status: "idle" },
        });

        const superseded = commitPanelReducer(
            commitPanelReducer(cancelled, {
                type: "REQUEST_COMMIT_MESSAGE_GENERATION",
                requestId: "request-b",
                snapshot: "feat: generated",
            }),
            {
                type: "COMMIT_MESSAGE_GENERATION_EVENT",
                requestId: "request-b",
                kind: "done",
                superseded: true,
            },
        );
        expect(superseded).toMatchObject({
            commitMessage: "feat: generated",
            generation: { status: "idle" },
        });
    });

    it("defaults host snapshot flags safely and fences editor/amend mutations while active", () => {
        expect(initialCommitPanelState).toMatchObject({
            hasCommits: false,
            wholeIndexOperationInProgress: false,
            generation: { status: "idle" },
        });

        const active = commitPanelReducer(initialCommitPanelState, {
            type: "REQUEST_COMMIT_MESSAGE_GENERATION",
            requestId: "request-a",
            snapshot: "draft",
        });
        expect(
            commitPanelReducer(active, { type: "SET_COMMIT_MESSAGE", message: "blocked edit" }),
        ).toBe(active);
        expect(commitPanelReducer(active, { type: "SET_AMEND", isAmend: true })).toBe(active);
        expect(
            commitPanelReducer(active, { type: "RESTORE_COMMIT_DRAFT", message: "late draft" }),
        ).toBe(active);
    });

    it("posts a root-scoped request only after synchronously recording it and cancels its exact id", async () => {
        const postMessage = vi.fn();
        vi.doMock("../../../src/webviews/react/shared/vscodeApi", () => ({
            getVsCodeApi: () => ({ postMessage }),
        }));
        const { useUndockedActions } =
            await import("../../../src/webviews/react/undocked/useUndockedActions");
        let actions: ReturnType<typeof useUndockedActions> | undefined;
        const cpDispatch = vi.fn((action) => {
            expect(postMessage).not.toHaveBeenCalled();
            return action;
        });

        function Harness(): React.ReactElement {
            actions = useUndockedActions({
                graphDispatch: vi.fn(),
                cpDispatch,
                loadingMore: { current: false },
                commitMessage: "saved draft",
                isAmend: false,
                generation: { status: "idle" },
                hasCommits: false,
                wholeIndexOperationInProgress: false,
                checkedPaths: new Set(["src/index.ts"]),
                selectedRepositoryRoot: "/repo-a",
                shouldPublishBranch: false,
            });
            return <button type="button" onClick={() => actions?.handleGenerateMessage()} />;
        }

        await render(<Harness />);
        document.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

        expect(cpDispatch).toHaveBeenCalledTimes(1);
        const request = cpDispatch.mock.calls[0]?.[0];
        expect(request).toMatchObject({
            type: "REQUEST_COMMIT_MESSAGE_GENERATION",
            snapshot: "saved draft",
        });
        expect(request.requestId).toEqual(expect.any(String));
        expect(postMessage).toHaveBeenCalledWith({
            type: "generateCommitMessage",
            repositoryRoot: "/repo-a",
            requestId: request.requestId,
            paths: ["src/index.ts"],
            amend: false,
        });

        let cancelActions: ReturnType<typeof useUndockedActions> | undefined;
        function CancelHarness(): React.ReactElement {
            cancelActions = useUndockedActions({
                graphDispatch: vi.fn(),
                cpDispatch: vi.fn(),
                loadingMore: { current: false },
                commitMessage: "saved draft",
                isAmend: false,
                generation: { status: "running", requestId: "request-a", snapshot: "saved draft" },
                hasCommits: true,
                wholeIndexOperationInProgress: false,
                checkedPaths: new Set(),
                selectedRepositoryRoot: "/repo-a",
                shouldPublishBranch: false,
            });
            return <button type="button" onClick={() => cancelActions?.handleCancelGeneration()} />;
        }

        await act(async () => {
            reactRoot?.render(<CancelHarness />);
        });
        document.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        expect(postMessage).toHaveBeenLastCalledWith({
            type: "cancelCommitMessageGeneration",
            repositoryRoot: "/repo-a",
            requestId: "request-a",
        });

        function UnbornAmendHarness(): React.ReactElement {
            const unbornActions = useUndockedActions({
                graphDispatch: vi.fn(),
                cpDispatch: vi.fn(),
                loadingMore: { current: false },
                commitMessage: "draft",
                isAmend: true,
                generation: { status: "idle" },
                hasCommits: false,
                wholeIndexOperationInProgress: false,
                checkedPaths: new Set(["src/index.ts"]),
                selectedRepositoryRoot: "/repo-a",
                shouldPublishBranch: false,
            });
            return <button type="button" onClick={unbornActions.handleGenerateMessage} />;
        }

        const callsBeforeUnbornAmend = postMessage.mock.calls.length;
        await act(async () => {
            reactRoot?.render(<UnbornAmendHarness />);
        });
        document.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        expect(postMessage).toHaveBeenCalledTimes(callsBeforeUnbornAmend);
    });

    it("filters lifecycle events by selected root and request id, saving only non-superseded terminals", async () => {
        const postMessage = vi.fn();
        vi.doMock("../../../src/webviews/react/shared/vscodeApi", () => ({
            getVsCodeApi: () => ({ postMessage }),
        }));
        const { useUnifiedMessages } =
            await import("../../../src/webviews/react/undocked/useUnifiedMessages");
        let stateRef: React.MutableRefObject<typeof initialCommitPanelState> | undefined;
        let dispatch: React.Dispatch<Parameters<typeof commitPanelReducer>[1]> | undefined;

        function Harness(): React.ReactElement {
            const [, reactDispatch] = useReducer(commitPanelReducer, initialCommitPanelState);
            const currentStateRef = useRef(initialCommitPanelState);
            stateRef = currentStateRef;
            const applyCommitPanelAction = (action: Parameters<typeof commitPanelReducer>[1]) => {
                const nextState = commitPanelReducer(currentStateRef.current, action);
                currentStateRef.current = nextState;
                reactDispatch(action);
                return nextState;
            };
            dispatch = (action) => {
                applyCommitPanelAction(action);
            };
            useUnifiedMessages({
                graphDispatch: vi.fn(),
                cpDispatch: dispatch,
                applyCommitPanelAction,
                cpStateRef: currentStateRef,
                loadingMore: { current: false },
                selectedHash: null,
                selectedRepositoryRoot: "/repo-a",
                setRepositories: vi.fn(),
                setSelectedRepositoryRoot: vi.fn(),
                markWidthsHydrated: vi.fn(),
                setSectionWidths: vi.fn(),
                layoutRef: { current: null },
                setCommitPanelPosition: vi.fn(),
                setViewVisible: vi.fn(),
            });
            return <div />;
        }

        await render(<Harness />);
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
        expect(stateRef?.current).toMatchObject({
            hasCommits: true,
            wholeIndexOperationInProgress: false,
        });
        act(() => {
            dispatch?.({
                type: "REQUEST_COMMIT_MESSAGE_GENERATION",
                requestId: "winner",
                snapshot: "saved draft",
            });
        });
        send({
            type: "commitMessageGeneration",
            repositoryRoot: "/other-repo",
            requestId: "winner",
            kind: "start",
        });
        send({
            type: "commitMessageGeneration",
            repositoryRoot: "/repo-a",
            requestId: "stale",
            kind: "start",
        });
        expect(stateRef?.current.generation.status).toBe("requested");

        send({
            type: "commitMessageGeneration",
            repositoryRoot: "/repo-a",
            requestId: "winner",
            kind: "start",
        });
        send({
            type: "restoreCommitDraft",
            repositoryRoot: "/repo-a",
            message: "late draft",
        });
        send({
            type: "commitMessageGeneration",
            repositoryRoot: "/repo-a",
            requestId: "winner",
            kind: "chunk",
            text: "feat: generated",
        });
        send({
            type: "commitMessageGeneration",
            repositoryRoot: "/repo-a",
            requestId: "winner",
            kind: "done",
        });
        expect(stateRef?.current).toMatchObject({
            commitMessage: "feat: generated",
            generation: { status: "idle" },
        });
        const savedDraftMessages = () =>
            postMessage.mock.calls.filter(([message]) => message.type === "saveCommitDraft");
        expect(savedDraftMessages()).toEqual([
            [
                {
                    type: "saveCommitDraft",
                    repositoryRoot: "/repo-a",
                    message: "feat: generated",
                },
            ],
        ]);

        act(() => {
            dispatch?.({
                type: "REQUEST_COMMIT_MESSAGE_GENERATION",
                requestId: "superseded",
                snapshot: "feat: generated",
            });
        });
        send({
            type: "commitMessageGeneration",
            repositoryRoot: "/repo-a",
            requestId: "superseded",
            kind: "start",
        });
        send({
            type: "commitMessageGeneration",
            repositoryRoot: "/repo-a",
            requestId: "superseded",
            kind: "done",
            superseded: true,
        });
        expect(stateRef?.current).toMatchObject({
            commitMessage: "feat: generated",
            generation: { status: "idle" },
        });
        expect(savedDraftMessages()).toHaveLength(1);

        act(() => {
            dispatch?.({
                type: "REQUEST_COMMIT_MESSAGE_GENERATION",
                requestId: "switching-request",
                snapshot: "feat: generated",
            });
        });
        send({ type: "repositories", repositories: [], selectedRepositoryRoot: "/repo-b" });
        expect(stateRef?.current.generation).toEqual({ status: "idle" });
        send({
            type: "commitMessageGeneration",
            repositoryRoot: "/repo-a",
            requestId: "switching-request",
            kind: "done",
        });
        expect(savedDraftMessages()).toHaveLength(1);
    });

    it("saves the terminal generation message from the reduced next state", async () => {
        const postMessage = vi.fn();
        vi.doMock("../../../src/webviews/react/shared/vscodeApi", () => ({
            getVsCodeApi: () => ({ postMessage }),
        }));
        const { useUnifiedMessages } =
            await import("../../../src/webviews/react/undocked/useUnifiedMessages");
        let applyCommitPanelAction:
            | ((action: Parameters<typeof commitPanelReducer>[1]) => ReturnType<typeof commitPanelReducer>)
            | undefined;

        function Harness(): React.ReactElement {
            const [, reactDispatch] = useReducer(commitPanelReducer, initialCommitPanelState);
            const stateRef = useRef(initialCommitPanelState);
            applyCommitPanelAction = (action) => {
                const nextState = commitPanelReducer(stateRef.current, action);
                stateRef.current = nextState;
                reactDispatch(action);
                return nextState;
            };
            const cpDispatch: React.Dispatch<Parameters<typeof commitPanelReducer>[1]> = (action) => {
                reactDispatch(action);
            };
            useUnifiedMessages({
                graphDispatch: vi.fn(),
                cpDispatch,
                cpStateRef: stateRef,
                loadingMore: { current: false },
                selectedHash: null,
                selectedRepositoryRoot: "/repo-a",
                setRepositories: vi.fn(),
                setSelectedRepositoryRoot: vi.fn(),
                markWidthsHydrated: vi.fn(),
                setSectionWidths: vi.fn(),
                layoutRef: { current: null },
                setCommitPanelPosition: vi.fn(),
                setViewVisible: vi.fn(),
                applyCommitPanelAction: applyCommitPanelAction!,
            });
            return <div />;
        }

        await render(<Harness />);
        act(() => {
            applyCommitPanelAction?.({
                type: "REQUEST_COMMIT_MESSAGE_GENERATION",
                requestId: "terminal-message",
                snapshot: "saved draft",
            });
        });
        send({
            type: "commitMessageGeneration",
            repositoryRoot: "/repo-a",
            requestId: "terminal-message",
            kind: "cancelled",
        });

        expect(postMessage.mock.calls.filter(([message]) => message.type === "saveCommitDraft")).toEqual([
            [
                {
                    type: "saveCommitDraft",
                    repositoryRoot: "/repo-a",
                    message: "saved draft",
                },
            ],
        ]);
    });
});
