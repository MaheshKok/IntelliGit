// @vitest-environment jsdom
import React, { act } from "react";
import { ChakraProvider } from "@chakra-ui/react";
import { describe, expect, it, vi } from "vitest";
import type { WorkingFile } from "../../../src/types";
import { FileTree } from "../../../src/webviews/react/commit-panel/components/FileTree";
import { useVisibleFileStats } from "../../../src/webviews/react/commit-panel/hooks/useVisibleFileStats";
import theme from "../../../src/webviews/react/commit-panel/theme";
import { initReactDomTestEnvironment, mount, unmount } from "../../helpers/reactDomTestUtils";

const api = vi.hoisted(() => ({ postMessage: vi.fn() }));
vi.mock("../../../src/webviews/react/shared/vscodeApi", () => ({ getVsCodeApi: () => api }));
initReactDomTestEnvironment();

function Harness({ root, revision }: { root: string; revision: string }) {
    const visible = useVisibleFileStats(root);
    return (
        <button
            onClick={() => {
                for (let i = 0; i < 170; i++)
                    visible({
                        path: `file-${i % 150}.txt`,
                        status: "M",
                        staged: false,
                        additions: 0,
                        deletions: 0,
                        statsState: "pending",
                        statsRevision: revision,
                    });
            }}
        >
            Visible
        </button>
    );
}

const pendingFiles = (revision: string): WorkingFile[] =>
    Array.from({ length: 201 }, (_, i) => ({
        path: `file-${String(i).padStart(3, "0")}.txt`,
        status: "M",
        staged: false,
        additions: 0,
        deletions: 0,
        statsState: "pending",
        statsRevision: revision,
    }));
const ignore = (): void => undefined;
const unchecked = (): boolean => false;

function Tree({ files, checkedPaths }: { files: WorkingFile[]; checkedPaths: Set<string> }) {
    return (
        <ChakraProvider theme={theme}>
            <FileTree
                repositoryRoot="/repo"
                files={files}
                groupByDir={false}
                showIgnoredFiles={false}
                checkedPaths={checkedPaths}
                onToggleFile={ignore}
                onToggleFolder={ignore}
                onToggleSection={ignore}
                isAllChecked={unchecked}
                isSomeChecked={unchecked}
                onFileClick={ignore}
                expandAllSignal={0}
                collapseAllSignal={0}
            />
        </ChakraProvider>
    );
}

describe("visible file statistics batching", () => {
    it("deduplicates rows and caps every request at 128 literal paths", () => {
        vi.useFakeTimers();
        const mounted = mount(<Harness root="/repo" revision="one" />);
        try {
            act(() => mounted.container.querySelector("button")!.click());
            expect(api.postMessage).not.toHaveBeenCalled();
            act(() => vi.advanceTimersByTime(24));
            const messages = api.postMessage.mock.calls.map(([value]) => value);
            expect(messages).toHaveLength(2);
            expect(messages.flatMap((value) => value.paths)).toHaveLength(150);
            for (const value of messages) {
                expect(value).toMatchObject({
                    type: "requestWorkingFileStats",
                    repositoryRoot: "/repo",
                    revision: "one",
                });
                expect(value.paths.length).toBeLessThanOrEqual(128);
            }
        } finally {
            unmount(mounted.root, mounted.container);
            vi.useRealTimers();
        }
    });

    it("drops queued paths when the rendered repository changes", () => {
        vi.useFakeTimers();
        const mounted = mount(<Harness root="/old" revision="old" />);
        try {
            act(() => mounted.container.querySelector("button")!.click());
            act(() => mounted.root.render(<Harness root="/new" revision="new" />));
            act(() => mounted.container.querySelector("button")!.click());
            act(() => vi.advanceTimersByTime(24));
            expect(api.postMessage).toHaveBeenCalledTimes(2);
            for (const [value] of api.postMessage.mock.calls)
                expect(value).toMatchObject({ repositoryRoot: "/new", revision: "new" });
        } finally {
            unmount(mounted.root, mounted.container);
            vi.useRealTimers();
        }
    });

    it("asks once per visible row of a tree over 200 files until the row's file data changes", () => {
        vi.useFakeTimers();
        api.postMessage.mockClear();
        const requested = () => api.postMessage.mock.calls.flatMap(([value]) => value.paths);
        const files = pendingFiles("one");
        const ticked = new Set([files[0].path]);
        const mounted = mount(<Tree files={files} checkedPaths={new Set()} />);
        const shownPaths = () =>
            Array.from(
                mounted.container.querySelectorAll<HTMLElement>("[data-vscode-context]"),
                (row) => JSON.parse(row.dataset.vscodeContext!).filePath as string,
            );
        try {
            act(() => vi.advanceTimersByTime(24));
            const shown = shownPaths();
            expect(shown.length).toBeGreaterThan(0);
            expect(requested()).toEqual(expect.arrayContaining(shown));
            api.postMessage.mockClear();
            act(() => mounted.root.render(<Tree files={files} checkedPaths={ticked} />));
            act(() => vi.advanceTimersByTime(24));
            expect(requested(), "ticking a file re-requests visible rows").toEqual([]);
            act(() =>
                mounted.root.render(<Tree files={pendingFiles("two")} checkedPaths={ticked} />),
            );
            act(() => vi.advanceTimersByTime(24));
            expect(new Set(requested()), "a new revision re-requests visible rows").toEqual(
                new Set(shown),
            );
            for (const [value] of api.postMessage.mock.calls)
                expect(value).toMatchObject({ repositoryRoot: "/repo", revision: "two" });
        } finally {
            unmount(mounted.root, mounted.container);
            vi.useRealTimers();
        }
    });
});
