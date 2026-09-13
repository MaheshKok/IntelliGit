// @vitest-environment jsdom

import React, { act, useLayoutEffect, useReducer, useRef } from "react";
import { ChakraProvider } from "@chakra-ui/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CommitPanelPane } from "../../../src/webviews/react/undocked/CommitPanelPane";
import {
    commitPanelReducer,
    initialCommitPanelState,
    type CommitPanelState,
} from "../../../src/webviews/react/undocked/commitPanelState";
import { useUnifiedMessages } from "../../../src/webviews/react/undocked/useUnifiedMessages";
import type { WorkingFile } from "../../../src/types";
import theme from "../../../src/webviews/react/commit-panel/theme";
import { initReactDomTestEnvironment, mount, unmount } from "../../helpers/reactDomTestUtils";
import { installWebviewI18n } from "../../helpers/webviewI18nTestUtils";

vi.mock("../../../src/webviews/react/shared/vscodeApi", () => ({
    getVsCodeApi: () => ({ postMessage: vi.fn(), getState: vi.fn(), setState: vi.fn() }),
}));

initReactDomTestEnvironment();

const conflictedFile = { path: "conflicted.ts", status: "U" } as WorkingFile;
let latestState = initialCommitPanelState;

function MessageHarness(): null {
    const [cpState, cpDispatch] = useReducer(commitPanelReducer, initialCommitPanelState);
    const cpStateRef = useRef(cpState);
    useLayoutEffect(() => {
        cpStateRef.current = cpState;
    }, [cpState]);
    latestState = cpState;
    useUnifiedMessages({
        graphDispatch: vi.fn(),
        cpDispatch,
        applyCommitPanelAction: (action) => commitPanelReducer(cpStateRef.current, action),
        cpStateRef,
        loadingMore: { current: false },
        selectedHash: null,
        selectedRepositoryRoot: "/repo",
        setRepositories: vi.fn(),
        setSelectedRepositoryRoot: vi.fn(),
        markWidthsHydrated: vi.fn(),
        setSectionWidths: vi.fn(),
        layoutRef: { current: null },
        setCommitPanelPosition: vi.fn(),
        setViewVisible: vi.fn(),
        onShowRebaseDialog: vi.fn(),
    });
    return null;
}

function pane(cpState: CommitPanelState, repositoryRoot?: string): React.ReactElement {
    return (
        <ChakraProvider theme={theme}>
            <CommitPanelPane
                width={320}
                repositoryRoot={repositoryRoot}
                cpState={cpState}
                checkedPaths={new Set()}
                onToggleFile={vi.fn()}
                onToggleFolder={vi.fn()}
                onToggleSection={vi.fn()}
                isAllChecked={() => false}
                isSomeChecked={() => false}
                onMessageChange={vi.fn()}
                onAmendChange={vi.fn()}
                onGenerateMessage={vi.fn()}
                onCancelGeneration={vi.fn()}
                onCommit={vi.fn()}
                canCommit={false}
                onSync={vi.fn()}
                onFetch={vi.fn()}
                onPull={vi.fn()}
                onPush={vi.fn()}
                canPush={false}
                pushLabel="Push"
                groupByDir={false}
                showIgnoredFiles={false}
                onToggleGroupBy={vi.fn()}
                onToggleShowIgnoredFiles={vi.fn()}
                onDock={vi.fn()}
            />
        </ChakraProvider>
    );
}

function renderPane(cpState: CommitPanelState, repositoryRoot?: string) {
    return mount(pane(cpState, repositoryRoot));
}

beforeEach(() => {
    latestState = initialCommitPanelState;
    installWebviewI18n();
    window.intelligitSettings = {
        hoverDelay: 300,
        tooltipsEnabled: true,
        iconStyle: "standard",
        commitWindowPosition: "left",
    };
});

describe("undocked commit-panel operation state", () => {
    it("stores the operation snapshot sent by the unified host message", () => {
        const mounted = mount(<MessageHarness />);
        act(() => {
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: {
                        type: "update",
                        repositoryRoot: "/repo",
                        files: [],
                        stashes: [],
                        stashFiles: [],
                        selectedStashIndex: null,
                        shelves: [],
                        catalogGeneration: 0,
                        selectedShelfId: null,
                        currentBranchHasUpstream: true,
                        currentBranchAhead: 0,
                        currentBranchBehind: 0,
                        currentBranchName: "main",
                        currentBranchUpstream: "origin/main",
                        hasCommits: true,
                        wholeIndexOperationInProgress: true,
                        activeOperation: "rebase",
                        rebaseControl: "foreign",
                    },
                }),
            );
        });

        expect(latestState).toMatchObject({
            activeOperation: "rebase",
            rebaseControl: "foreign",
        });
        unmount(mounted.root, mounted.container);
    });

    it("suppresses rebase controls during a foreign rebase exactly as the docked toolbar does", () => {
        const cpState = {
            ...initialCommitPanelState,
            files: [conflictedFile],
            activeOperation: "rebase",
            rebaseControl: "foreign",
        } as unknown as CommitPanelState;
        const mounted = renderPane(cpState);

        expect(mounted.container.textContent).not.toContain("Abort Merge");
        expect(mounted.container.textContent).not.toContain("Abort Rebase");
        expect(mounted.container.textContent).not.toContain("Continue Rebase");
        unmount(mounted.root, mounted.container);
    });

    // The undocked half of the same seam the accordion covers: `TabBar` renders whatever behind
    // count it is given, so the way to lose the pull count here is for this pane to stop reading
    // it off `cpState`. Rendering the real `TabBar` is what makes that deletion visible.
    it("hands the undocked pane's behind count to the pull button", () => {
        const cpState = {
            ...initialCommitPanelState,
            currentBranchBehind: 6,
        } as unknown as CommitPanelState;
        const mounted = renderPane(cpState);

        const badge = mounted.container.querySelector('[data-testid="pull-behind-count"]');
        expect(badge?.textContent, "the undocked pane must forward currentBranchBehind").toBe("↓6");
        unmount(mounted.root, mounted.container);
    });

    it("forwards the undocked repository root into unversioned file context", () => {
        const cpState = {
            ...initialCommitPanelState,
            files: [{ path: "new.ts", status: "?", staged: false, additions: 0, deletions: 0 }],
        } as CommitPanelState;
        const mounted = renderPane(cpState, "/repo/undocked");
        const row = Array.from(
            mounted.container.querySelectorAll<HTMLElement>("[data-vscode-context]"),
        ).find((element) => {
            const context = JSON.parse(element.dataset.vscodeContext ?? "{}") as Record<
                string,
                unknown
            >;
            return context.filePath === "new.ts";
        });

        expect(JSON.parse(row?.dataset.vscodeContext ?? "{}")).toMatchObject({
            repositoryRoot: "/repo/undocked",
            filePaths: ["new.ts"],
            webviewUnversionedFile: true,
        });
        unmount(mounted.root, mounted.container);
    });

    it("scopes unversioned command selection to the undocked repository root", () => {
        const cpState = {
            ...initialCommitPanelState,
            files: [
                { path: "first.ts", status: "?", staged: false, additions: 0, deletions: 0 },
                { path: "second.ts", status: "?", staged: false, additions: 0, deletions: 0 },
            ],
        } as CommitPanelState;
        const mounted = renderPane(cpState, "/repo/a");
        const rowFor = (path: string): HTMLElement =>
            Array.from(
                mounted.container.querySelectorAll<HTMLElement>("[data-vscode-context]"),
            ).find((element) => {
                const context = JSON.parse(element.dataset.vscodeContext ?? "{}") as Record<
                    string,
                    unknown
                >;
                return context.filePath === path;
            })!;

        act(() => {
            rowFor("first.ts").dispatchEvent(
                new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true }),
            );
            rowFor("second.ts").dispatchEvent(
                new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true }),
            );
            mounted.root.render(pane(cpState, "/repo/b"));
            rowFor("first.ts").dispatchEvent(
                new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
            );
        });

        expect(JSON.parse(rowFor("first.ts").dataset.vscodeContext ?? "{}")).toMatchObject({
            repositoryRoot: "/repo/b",
            filePaths: ["first.ts"],
        });
        unmount(mounted.root, mounted.container);
    });
});
