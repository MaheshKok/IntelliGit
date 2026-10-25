// @vitest-environment jsdom
import React, { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { useChangelists } from "../../../src/webviews/react/commit-panel/hooks/useChangelists";
import type { CommitTabProps } from "../../../src/webviews/react/commit-panel/components/CommitTabController";
import type { ChangelistState } from "../../../src/webviews/protocol/changeSelection";
import type { WorkingFile } from "../../../src/types";
import { initReactDomTestEnvironment, mount, unmount } from "../../helpers/reactDomTestUtils";

const root = "/repo";
const api = vi.hoisted(() => ({
    postMessage: vi.fn(),
    // A view saved while a second list existed still names the remaining list.
    getState: vi.fn(() => ({ changelistViews: { "/repo": { filter: "default", checked: {} } } })),
    setState: vi.fn(),
}));
vi.mock("../../../src/webviews/react/shared/vscodeApi", () => ({ getVsCodeApi: () => api }));
initReactDomTestEnvironment();

const files = [
    { path: "a.txt", status: "M" },
    { path: "b.txt", status: "M" },
] as WorkingFile[];
// One list and no line selections is plain mode; b.txt still points at a deleted list.
const plain: ChangelistState = {
    revision: 1,
    activeId: "default",
    lists: [{ id: "default", name: "Changes" }],
    files: { "b.txt": "gone" },
    changes: {},
};

describe("plain changelist mode", () => {
    it("shows every file from the first render even when a list-scoped view was saved", () => {
        let workflow!: ReturnType<typeof useChangelists>;
        function Harness() {
            workflow = useChangelists({
                repositoryRoot: root,
                files,
                checkedPaths: new Set<string>(),
                isAmend: false,
                commitMessage: "",
            } as unknown as CommitTabProps);
            return null;
        }
        const mounted = mount(<Harness />);
        try {
            act(() =>
                window.dispatchEvent(
                    new MessageEvent("message", {
                        data: { type: "setChangelists", repositoryRoot: root, state: plain },
                    }),
                ),
            );
            expect(workflow.filter, "plain mode is never scoped to one list").toBe("all");
            expect(workflow.files.map((file) => file.path)).toEqual(["a.txt", "b.txt"]);
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });
});
