// @vitest-environment jsdom
import React, { act } from "react";
import { ChakraProvider } from "@chakra-ui/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChangelistGroups } from "../../../src/webviews/react/commit-panel/components/ChangelistGroups";
import { useChangelists } from "../../../src/webviews/react/commit-panel/hooks/useChangelists";
import type { CommitTabProps } from "../../../src/webviews/react/commit-panel/components/CommitTabController";
import type { ChangelistState } from "../../../src/webviews/protocol/changeSelection";
import type { WorkingFile } from "../../../src/types";
import theme from "../../../src/webviews/react/commit-panel/theme";
import { initReactDomTestEnvironment, mount, unmount } from "../../helpers/reactDomTestUtils";

const api = vi.hoisted(() => ({
    postMessage: vi.fn(),
    getState: vi.fn(() => ({})),
    setState: vi.fn(),
}));
vi.mock("../../../src/webviews/react/shared/vscodeApi", () => ({ getVsCodeApi: () => api }));
// The file rows are covered elsewhere; these tests exercise the list and selection actions.
vi.mock("../../../src/webviews/react/commit-panel/components/FileTree", () => ({
    FileTree: () => null,
}));
initReactDomTestEnvironment();

const root = "/repo";
const files = [{ path: "a.txt", status: "M" } as WorkingFile];
const state: ChangelistState = {
    revision: 3,
    activeId: "default",
    lists: [
        { id: "default", name: "Changes" },
        { id: "feature", name: "Feature" },
    ],
    files: { "a.txt": "feature" },
    changes: {},
};
let workflow: ReturnType<typeof useChangelists>;
let mounted: ReturnType<typeof mount>;

function Harness({ checked }: { checked: Set<string> }) {
    const props = {
        repositoryRoot: root,
        files,
        checkedPaths: checked,
        isAmend: false,
        commitMessage: "",
    } as unknown as CommitTabProps;
    workflow = useChangelists(props);
    return (
        <ChakraProvider theme={theme}>
            <ChangelistGroups workflow={workflow} files={files} tree={{} as never} />
            {workflow.error ? <div role="alert">{workflow.error}</div> : null}
        </ChakraProvider>
    );
}
function receive(data: unknown) {
    act(() => window.dispatchEvent(new MessageEvent("message", { data })));
}
function shelfPosts() {
    return api.postMessage.mock.calls
        .map(([value]) => value)
        .filter((value) => value.type === "saveChangelistShelf");
}
function openListMenu(id: string) {
    const header = mounted.container.querySelector(`[data-changelist-id="${id}"] > div`)!;
    act(() => {
        header.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    });
}
function menuItem(label: string) {
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
        (element) => element.textContent === label,
    );
    if (!item) throw new Error(`Menu item ${label} is missing.`);
    return item;
}
function button(label: string) {
    const found = [...mounted.container.querySelectorAll("button")].find(
        (element) => element.textContent === label,
    );
    if (!found) throw new Error(`Button ${label} is missing.`);
    return found;
}

beforeEach(() => {
    vi.clearAllMocks();
    mounted = mount(<Harness checked={new Set()} />);
    receive({ type: "setChangelists", repositoryRoot: root, state });
});
afterEach(() => unmount(mounted.root, mounted.container));

describe("changelist save, remove and rollback actions", () => {
    it("list Save to Shelf posts a plain save without a removal intent", () => {
        openListMenu("feature");
        act(() => menuItem("Save to Shelf").click());
        expect(shelfPosts(), "plain save carries no operation").toEqual([
            expect.not.objectContaining({ operation: expect.anything() }),
        ]);
        expect(shelfPosts()[0]).toMatchObject({ scope: "list", listId: "feature", revision: 3 });
    });

    it.each([
        ["Save and Remove…", "saveAndRemove"],
        ["Rollback…", "rollback"],
    ])("list %s posts its distinct intent with a request id", (label, operation) => {
        openListMenu("feature");
        act(() => menuItem(label).click());
        expect(shelfPosts()).toEqual([
            expect.objectContaining({
                repositoryRoot: root,
                scope: "list",
                listId: "feature",
                revision: 3,
                operation,
                requestId: expect.any(String),
            }),
        ]);
    });

    it("list actions are keyboard reachable and blocked while a request is pending", () => {
        openListMenu("feature");
        const item = menuItem("Rollback…");
        expect(item.tabIndex).toBe(0);
        act(() => {
            item.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        });
        openListMenu("feature");
        expect(menuItem("Save and Remove…").getAttribute("aria-disabled")).toBe("true");
        act(() => workflow.saveShelf("list", "feature", "saveAndRemove"));
        expect(shelfPosts(), "a pending request blocks a second removal").toHaveLength(1);
    });

    it("selected whole-file actions post the checked paths and stay hidden with nothing checked", () => {
        expect(
            [...mounted.container.querySelectorAll("button")].map((element) => element.textContent),
            "whole-file actions are hidden with nothing checked",
        ).not.toContain("Save and Remove Selected Whole Files…");
        act(() => mounted.root.render(<Harness checked={new Set(["a.txt"])} />));
        act(() => button("Save and Remove Selected Whole Files…").click());
        expect(shelfPosts()).toEqual([
            expect.objectContaining({
                scope: "files",
                paths: ["a.txt"],
                operation: "saveAndRemove",
            }),
        ]);
    });

    it("shows the host's exact failure and keeps a success notice across metadata updates", () => {
        openListMenu("feature");
        act(() => menuItem("Save and Remove…").click());
        const [first] = shelfPosts();
        const failure =
            "Shelf s1 is retained. Removed: a.txt. Not removed: b.txt. Do not repeat removal.";
        receive({
            type: "changelistShelfResult",
            repositoryRoot: root,
            requestId: first.requestId,
            error: failure,
            message: failure,
        });
        expect(mounted.container.querySelector('[role="alert"]')?.textContent).toBe(failure);
        expect(workflow.busy, "terminal result clears the busy flag").toBe(false);

        openListMenu("feature");
        act(() => menuItem("Rollback…").click());
        const success = "Removed: a.txt. Shelf s2 is retained.";
        receive({
            type: "changelistShelfResult",
            repositoryRoot: root,
            requestId: shelfPosts()[1].requestId,
            message: success,
        });
        receive({
            type: "setChangelists",
            repositoryRoot: root,
            state: { ...state, revision: 4 },
        });
        expect(
            mounted.container.querySelector('[role="status"]')?.textContent,
            "notice persists across a same-root metadata update",
        ).toBe(success);
    });
});
