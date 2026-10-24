// @vitest-environment jsdom
import React from "react";
import { act } from "react";
import { ChakraProvider } from "@chakra-ui/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChangelistGroups } from "../../../src/webviews/react/commit-panel/components/ChangelistGroups";
import { useChangelists } from "../../../src/webviews/react/commit-panel/hooks/useChangelists";
import type { CommitTabProps } from "../../../src/webviews/react/commit-panel/components/CommitTabController";
import type { ChangelistState } from "../../../src/webviews/protocol/changeSelection";
import type { WorkingFile } from "../../../src/types";
import theme from "../../../src/webviews/react/commit-panel/theme";
import { initReactDomTestEnvironment, mount, unmount } from "../../helpers/reactDomTestUtils";

const api = vi.hoisted(() => ({
    postMessage: vi.fn(),
    getState: vi.fn((): Record<string, unknown> => ({})),
    setState: vi.fn(),
}));
vi.mock("../../../src/webviews/react/shared/vscodeApi", () => ({ getVsCodeApi: () => api }));
initReactDomTestEnvironment();

const root = "/repo";
const onFileClick = vi.fn();
// Each list stays under the per-tree virtualization cutoff while the repository is above it.
const FILES_PER_LIST = 30;
let mounted: ReturnType<typeof mount> | undefined;

afterEach(() => {
    if (mounted) unmount(mounted.root, mounted.container);
    mounted = undefined;
    vi.restoreAllMocks();
});

function Harness({ files }: { files: WorkingFile[] }) {
    const workflow = useChangelists({
        repositoryRoot: root,
        files,
        checkedPaths: new Set<string>(),
        isAmend: false,
        commitMessage: "",
    } as unknown as CommitTabProps);
    return (
        <ChakraProvider theme={theme}>
            <ChangelistGroups
                workflow={workflow}
                files={files}
                tree={{
                    repositoryRoot: root,
                    files: workflow.files,
                    groupByDir: false,
                    showIgnoredFiles: false,
                    checkedPaths: workflow.checkedPaths,
                    partialPaths: workflow.partialPaths,
                    onToggleFile: workflow.toggleFile,
                    onToggleFolder: workflow.toggleFolder,
                    onToggleSection: workflow.toggleSection,
                    isAllChecked: workflow.allChecked,
                    isSomeChecked: workflow.someChecked,
                    onFileClick,
                    expandAllSignal: 0,
                    collapseAllSignal: 0,
                }}
            />
        </ChakraProvider>
    );
}

/** Opens every list (the state Expand All leaves) and counts the "..." rows actually drawn. */
function drawnPendingRows(lists: number): number {
    const ids = Array.from({ length: lists }, (_, index) => `list-${index}`);
    const files: WorkingFile[] = ids.flatMap((id) =>
        Array.from({ length: FILES_PER_LIST }, (_, index) => ({
            path: `${id}-file-${index}.txt`,
            status: "M",
            staged: false,
            additions: 0,
            deletions: 0,
            statsState: "pending",
            statsRevision: "r1",
        })),
    );
    const state: ChangelistState = {
        revision: 1,
        activeId: ids[0]!,
        lists: ids.map((id) => ({ id, name: id })),
        files: Object.fromEntries(files.map((file) => [file.path, file.path.split("-file-")[0]!])),
        changes: {},
    };
    api.getState.mockReturnValue({
        changelistExpansion: Object.fromEntries(
            ids.map((id) => [JSON.stringify([root, id]), true]),
        ),
    });
    // jsdom has no layout: place each list's tree one far-apart band down the page, so only the
    // first list is inside the viewport the tree measures against.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
        this: HTMLElement,
    ) {
        const trees = [...document.querySelectorAll('[data-testid="virtual-commit-tree"]')];
        const top = Math.max(0, trees.indexOf(this)) * 100_000;
        return { top, bottom: top, left: 0, right: 0, width: 0, height: 0 } as DOMRect;
    });
    mounted = mount(<Harness files={files} />);
    act(() =>
        window.dispatchEvent(
            new MessageEvent("message", {
                data: { type: "setChangelists", repositoryRoot: root, state },
            }),
        ),
    );
    const drawn = [...mounted.container.querySelectorAll('[role="status"]')].filter(
        (status) => status.textContent === "...",
    ).length;
    unmount(mounted.root, mounted.container);
    mounted = undefined;
    vi.restoreAllMocks();
    return drawn;
}

describe("open changelists draw rows for the viewport, not for every list", () => {
    it("doubling the number of small open lists does not double the drawn rows", () => {
        const ten = drawnPendingRows(10);
        const twenty = drawnPendingRows(20);
        expect(ten, "the first list's visible rows are drawn").toBeGreaterThan(0);
        expect(ten, "fewer rows are drawn than the open lists hold").toBeLessThan(
            10 * FILES_PER_LIST,
        );
        expect(twenty, "drawn rows follow the viewport, not the list count").toBe(ten);
    });
});

describe("an open changelist names its files once", () => {
    it("draws its rows and line totals under the list header, and a row click opens the diff", () => {
        const files: WorkingFile[] = [
            { path: "a.ts", status: "M", staged: false, additions: 1, deletions: 0 },
            { path: "b.ts", status: "M", staged: false, additions: 2, deletions: 1 },
        ];
        const state: ChangelistState = {
            revision: 1,
            activeId: "default",
            lists: [
                { id: "default", name: "Default" },
                { id: "feature", name: "Feature" },
            ],
            files: { "a.ts": "default", "b.ts": "feature" },
            changes: {},
        };
        api.getState.mockReturnValue({
            changelistExpansion: {
                [JSON.stringify([root, "default"])]: true,
                [JSON.stringify([root, "feature"])]: true,
            },
        });
        mounted = mount(<Harness files={files} />);
        act(() =>
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: { type: "setChangelists", repositoryRoot: root, state },
                }),
            ),
        );
        const groups = [...mounted.container.querySelectorAll('[role="group"]')];
        expect(groups.map((group) => group.getAttribute("aria-label"))).toEqual([
            "Default",
            "Feature",
        ]);
        for (const [group, file] of groups.map((group, index) => [group, files[index]!] as const)) {
            expect(group.textContent, "the list's own file row is drawn").toContain(file.path);
            expect(group.textContent, "no nested Changes header").not.toContain("Changes");
        }
        const headerText = (id: string) =>
            mounted!.container.querySelector(`[data-changelist-id="${id}"] > div`)?.textContent;
        expect(headerText("default"), "Default list header total").toContain("+1");
        expect(headerText("feature"), "Feature list header total").toContain("+2-1");

        const row = [...groups[1]!.querySelectorAll("*")].find(
            (element) => element.children.length === 0 && element.textContent === "b.ts",
        ) as HTMLElement;
        act(() => row.click());
        expect(onFileClick, "a list row click takes the plain diff route").toHaveBeenCalledWith(
            "b.ts",
        );
        expect(
            api.postMessage.mock.calls.filter(([message]) => message?.type === "openPartialChanges"),
            "a row click does not open Selected changes",
        ).toEqual([]);
    });
});
