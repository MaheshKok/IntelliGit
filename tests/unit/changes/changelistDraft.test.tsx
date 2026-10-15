// @vitest-environment jsdom
import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChangelistDraft } from "../../../src/webviews/react/commit-panel/hooks/useChangelistDraft";
import type { CommitTabProps } from "../../../src/webviews/react/commit-panel/components/CommitTabController";
import type { ChangelistState } from "../../../src/webviews/protocol/changeSelection";
import { mount, unmount, initReactDomTestEnvironment } from "../../helpers/reactDomTestUtils";

const api = vi.hoisted(() => ({
    postMessage: vi.fn(),
    getState: vi.fn(() => ({})),
    setState: vi.fn(),
}));
vi.mock("../../../src/webviews/react/shared/vscodeApi", () => ({ getVsCodeApi: () => api }));
initReactDomTestEnvironment();
let draft: ReturnType<typeof useChangelistDraft>;
let mounted: ReturnType<typeof mount>;
const props = { repositoryRoot: "/one", commitMessage: "legacy", isAmend: false } as CommitTabProps;
const state: ChangelistState = {
    revision: 1,
    activeId: "default",
    allDraft: "aggregate",
    lists: [
        { id: "default", name: "Changes", draft: "original" },
        { id: "feature", name: "Feature", draft: "feature text" },
    ],
    files: {},
    changes: {},
};
function Harness({ scope = "default", root = "/one", snapshot = state }) {
    draft = useChangelistDraft(
        { ...props, repositoryRoot: root },
        snapshot,
        scope,
        new Set(["file.txt"]),
    );
    return <output>{draft.message}</output>;
}
function receive(data: unknown) {
    act(() => window.dispatchEvent(new MessageEvent("message", { data })));
}
beforeEach(() => {
    vi.clearAllMocks();
    mounted = mount(<Harness />);
});
afterEach(() => unmount(mounted.root, mounted.container));

describe("captured changelist composer", () => {
    it("keeps explicit empty text and queued edits with their root and list while switching", () => {
        act(() => draft.change(""));
        act(() => draft.change("new text"));
        const saves = api.postMessage.mock.calls
            .map(([value]) => value)
            .filter((value) => value.action === "save");
        expect(
            saves.map(({ repositoryRoot, listId, expected, message }) => ({
                repositoryRoot,
                listId,
                expected,
                message,
            })),
        ).toEqual([
            { repositoryRoot: "/one", listId: "default", expected: "original", message: "" },
            { repositoryRoot: "/one", listId: "default", expected: "", message: "new text" },
        ]);
        act(() => mounted.root.render(<Harness scope="feature" />));
        expect(draft.message).toBe("feature text");
        receive({
            type: "changelistDraftResult",
            repositoryRoot: "/one",
            listId: "default",
            requestId: saves[0].requestId,
            message: "",
        });
        act(() =>
            mounted.root.render(
                <Harness
                    scope="all"
                    root="/two"
                    snapshot={{ ...state, allDraft: "second checkout" }}
                />,
            ),
        );
        receive({
            type: "changelistDraftResult",
            repositoryRoot: "/one",
            listId: "default",
            requestId: saves[1].requestId,
            message: "new text",
        });
        expect(draft.message).toBe("second checkout");
        act(() =>
            mounted.root.render(
                <Harness
                    snapshot={{
                        ...state,
                        lists: [{ ...state.lists[0], draft: "new text" }, state.lists[1]],
                    }}
                />,
            ),
        );
        expect(draft.message).toBe("new text");
        expect(draft.pending).toBe(false);
    });

    it("retains the user's text after a competing pane wins and requires a deliberate retry", () => {
        act(() => draft.change("local edit"));
        const save = api.postMessage.mock.calls.at(-1)![0];
        receive({
            type: "changelistDraftResult",
            repositoryRoot: "/one",
            listId: "default",
            requestId: save.requestId,
            message: "remote edit",
            error: "Review the latest text",
        });
        expect(draft.message).toBe("local edit");
        expect(draft.error).toContain("Review");
        act(() => draft.change("reviewed local edit"));
        expect(api.postMessage).toHaveBeenLastCalledWith(
            expect.objectContaining({ expected: "remote edit", message: "reviewed local edit" }),
        );
    });

    it("cancels streamed generation when switching scope and ignores its late completion", () => {
        act(() => draft.generate());
        const request = api.postMessage.mock.calls.at(-1)![0];
        receive({
            type: "commitMessageGeneration",
            repositoryRoot: "/one",
            requestId: request.requestId,
            kind: "start",
        });
        receive({
            type: "commitMessageGeneration",
            repositoryRoot: "/one",
            requestId: request.requestId,
            kind: "chunk",
            text: "AI result",
        });
        act(() => mounted.root.render(<Harness scope="all" />));
        expect(api.postMessage).toHaveBeenCalledWith({
            type: "cancelCommitMessageGeneration",
            repositoryRoot: "/one",
            requestId: request.requestId,
        });
        receive({
            type: "commitMessageGeneration",
            repositoryRoot: "/one",
            requestId: request.requestId,
            kind: "done",
        });
        expect(draft.message).toBe("aggregate");
        expect(api.postMessage.mock.calls.some(([message]) => message.action === "save")).toBe(
            false,
        );
    });
});
