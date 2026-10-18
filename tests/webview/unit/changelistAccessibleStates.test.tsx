// @vitest-environment jsdom
import React, { act } from "react";
import { ChakraProvider } from "@chakra-ui/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChangelistGroups } from "../../../src/webviews/react/commit-panel/components/ChangelistGroups";
import { useChangelists } from "../../../src/webviews/react/commit-panel/hooks/useChangelists";
import type { CommitTabProps } from "../../../src/webviews/react/commit-panel/components/CommitTabController";
import { CommitRow } from "../../../src/webviews/react/commit-list/CommitRow";
import { TreeFileRow } from "../../../src/webviews/react/shared/components/FileTreeRows";
import type { ChangelistState } from "../../../src/webviews/protocol/changeSelection";
import type { Commit, WorkingFile } from "../../../src/types";
import en from "../../../src/webviews/i18n/en.json";
import theme from "../../../src/webviews/react/commit-panel/theme";
import { initReactDomTestEnvironment, mount, unmount } from "../../helpers/reactDomTestUtils";

const api = vi.hoisted(() => ({
    postMessage: vi.fn(),
    getState: vi.fn(() => ({})),
    setState: vi.fn(),
}));
vi.mock("../../../src/webviews/react/shared/vscodeApi", () => ({ getVsCodeApi: () => api }));
vi.mock("../../../src/webviews/react/commit-panel/components/FileTree", () => ({
    FileTree: () => null,
}));
initReactDomTestEnvironment();

const root = "/repo";
const files = [{ path: "a.txt", status: "M" } as WorkingFile];
const base: ChangelistState = {
    revision: 3,
    activeId: "default",
    lists: [
        { id: "default", name: "Changes" },
        { id: "feature", name: "Feature" },
    ],
    files: { "a.txt": "default" },
    changes: {},
};
let mounted: ReturnType<typeof mount> | undefined;

function Harness({ checked }: { checked: Set<string> }) {
    const props = {
        repositoryRoot: root,
        files,
        checkedPaths: checked,
        isAmend: false,
        commitMessage: "",
    } as unknown as CommitTabProps;
    const workflow = useChangelists(props);
    return (
        <ChakraProvider theme={theme}>
            <ChangelistGroups workflow={workflow} files={files} tree={{} as never} />
        </ChakraProvider>
    );
}
function receive(data: unknown) {
    act(() => window.dispatchEvent(new MessageEvent("message", { data })));
}
function render(state: ChangelistState, checked = new Set(["a.txt"])) {
    mounted = mount(<Harness checked={checked} />);
    receive({ type: "setChangelists", repositoryRoot: root, state });
}
const header = (id: string) =>
    mounted!.container.querySelector<HTMLElement>(`[data-changelist-id="${id}"]`)!;

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
    if (mounted) unmount(mounted.root, mounted.container);
    mounted = undefined;
});

describe("changelist states carry text, not only a mixed checkbox", () => {
    it("a partially included list says Partial next to its mixed checkbox", () => {
        render({
            ...base,
            changes: {
                "a.txt": {
                    contentId: "c1",
                    lines: {},
                    selections: { all: { contentId: "c1", lineIds: ["l1"], total: 2 } },
                },
            },
        });
        const box = header("default").querySelector<HTMLInputElement>('input[type="checkbox"]')!;
        expect(box.indeterminate, "the group checkbox is mixed").toBe(true);
        expect(header("default").textContent, "mixed list has a Partial label").toContain(
            en["changes.partialInclusion"],
        );
        expect(header("default").textContent).not.toContain(en["changes.reviewRequired"]);
        expect(header("feature").textContent).not.toContain(en["changes.partialInclusion"]);
    });

    it("a fully included list has no Partial label", () => {
        render(base);
        expect(header("default").textContent).not.toContain(en["changes.partialInclusion"]);
    });

    it("a selection that needs review says Review required", () => {
        render({
            ...base,
            changes: {
                "a.txt": {
                    contentId: "c1",
                    lines: {},
                    selections: {
                        all: { contentId: "c1", lineIds: ["l1"], total: 1, reviewRequired: true },
                    },
                },
            },
        });
        expect(header("default").textContent, "review state is named").toContain(
            en["changes.reviewRequired"],
        );
    });

    it("the destination of a pending operation awaiting review says Review required", () => {
        render(
            {
                ...base,
                targetOperationSummary: {
                    id: "op1",
                    kind: "undoCommit",
                    phase: "reviewRequired",
                    destinationId: "feature",
                } as ChangelistState["targetOperationSummary"],
            },
            new Set(),
        );
        expect(header("feature").textContent, "pending review names its list").toContain(
            en["changes.reviewRequired"],
        );
        expect(header("default").textContent).not.toContain(en["changes.reviewRequired"]);
    });

    it("a partially included file row says Partial", () => {
        const row = (isIndeterminate: boolean) =>
            mount(
                <TreeFileRow
                    file={{ path: "a.txt", status: "M", additions: 1, deletions: 0 }}
                    depth={0}
                    rowVariant="commit-panel"
                    wiring={{
                        isSelected: false,
                        onSelect: vi.fn(),
                        isChecked: true,
                        isIndeterminate,
                        onToggleCheck: vi.fn(),
                    }}
                />,
            );
        const partial = row(true);
        expect(partial.container.textContent, "mixed file row has a Partial label").toContain(
            en["changes.partialInclusion"],
        );
        unmount(partial.root, partial.container);
        const whole = row(false);
        expect(whole.container.textContent).not.toContain(en["changes.partialInclusion"]);
        unmount(whole.root, whole.container);
    });
});

describe("focus after a host prompt", () => {
    it("returns to the Save button once the host answers a cancelled save", () => {
        render(base);
        const save = [...mounted!.container.querySelectorAll("button")].find(
            (element) => element.textContent === en["changes.saveSelectedWholeFiles"],
        )!;
        save.focus();
        act(() => save.click());
        expect(save.disabled, "the button is disabled while the host prompts").toBe(true);
        // Browsers move focus off a control once it is disabled; jsdom does not (and ignores
        // blur() on a disabled element), so park focus on a node that then disappears.
        const parked = document.createElement("input");
        document.body.append(parked);
        parked.focus();
        parked.remove();
        expect(document.activeElement, "precondition: the disabled button lost focus").toBe(
            document.body,
        );
        const [request] = api.postMessage.mock.calls
            .map(([value]) => value)
            .filter((value) => value.type === "saveChangelistShelf");
        receive({
            type: "changelistShelfResult",
            repositoryRoot: root,
            requestId: request.requestId,
            message: "Save cancelled.",
        });
        expect(document.activeElement, "focus returns to the control that opened the prompt").toBe(
            save,
        );
    });

    it("waits for the webview to regain focus before restoring, so an open prompt keeps it", () => {
        render(base);
        const save = [...mounted!.container.querySelectorAll("button")].find(
            (element) => element.textContent === en["changes.saveSelectedWholeFiles"],
        )!;
        save.focus();
        act(() => save.click());
        const parked = document.createElement("input");
        document.body.append(parked);
        parked.focus();
        parked.remove();
        const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
        const [request] = api.postMessage.mock.calls
            .map(([value]) => value)
            .filter((value) => value.type === "saveChangelistShelf");
        receive({
            type: "changelistShelfResult",
            repositoryRoot: root,
            requestId: request.requestId,
            message: "Save cancelled.",
        });
        expect(document.activeElement, "no focus change while the workbench holds it").toBe(
            document.body,
        );
        hasFocus.mockReturnValue(true);
        act(() => window.dispatchEvent(new FocusEvent("focus")));
        expect(document.activeElement, "the host's refocus lands on the opener").toBe(save);
        hasFocus.mockRestore();
    });

    it("leaves focus alone when the user already moved it", () => {
        render(base);
        const save = [...mounted!.container.querySelectorAll("button")].find(
            (element) => element.textContent === en["changes.saveSelectedWholeFiles"],
        )!;
        const elsewhere = document.createElement("button");
        document.body.append(elsewhere);
        save.focus();
        act(() => save.click());
        elsewhere.focus();
        expect(save.disabled, "precondition: the save is still pending").toBe(true);
        const [request] = api.postMessage.mock.calls
            .map(([value]) => value)
            .filter((value) => value.type === "saveChangelistShelf");
        receive({
            type: "changelistShelfResult",
            repositoryRoot: root,
            requestId: request.requestId,
            message: "Save cancelled.",
        });
        expect(save.disabled, "the host's answer was received").toBe(false);
        expect(document.activeElement, "focus the user moved stays put").toBe(elsewhere);
        elsewhere.remove();
    });
});

describe("Git Log commit row keyboard menu", () => {
    const commit: Commit = {
        hash: "a1b2c3d4",
        shortHash: "a1b2c3d",
        message: "Keyboard target",
        author: "Mahesh",
        email: "m@example.com",
        date: "2026-02-19T00:00:00Z",
        parentHashes: ["p1"],
        refs: [],
    };
    it.each([
        ["the ContextMenu key", { key: "ContextMenu" }, 1],
        ["Shift+F10", { key: "F10", shiftKey: true }, 1],
        ["plain F10", { key: "F10" }, 0],
    ])("%s opens the commit menu at the row", (_name, init, calls) => {
        const onContextMenu = vi.fn();
        const view = mount(
            <CommitRow
                commit={commit}
                graphWidth={0}
                isSelected={false}
                isUnpushed={false}
                onSelect={vi.fn()}
                onContextMenu={onContextMenu}
            />,
        );
        const row = view.container.querySelector<HTMLElement>('[role="button"]')!;
        row.getBoundingClientRect = () => ({ left: 12, bottom: 34 }) as DOMRect;
        act(() => {
            row.dispatchEvent(new KeyboardEvent("keydown", { ...init, bubbles: true }));
        });
        expect(
            onContextMenu,
            "keyboard opens the same menu as a right-click",
        ).toHaveBeenCalledTimes(calls);
        if (calls)
            expect(onContextMenu.mock.calls[0]![0]).toMatchObject({ clientX: 12, clientY: 34 });
        unmount(view.root, view.container);
    });
});
