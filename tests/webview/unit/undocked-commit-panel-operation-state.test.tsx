// @vitest-environment jsdom

import React, { act, useReducer, useRef } from "react";
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
    cpStateRef.current = cpState;
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

function renderPane(cpState: CommitPanelState) {
    return mount(
        <ChakraProvider theme={theme}>
            <CommitPanelPane
                width={320}
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
        </ChakraProvider>,
    );
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

    it("suppresses Abort Merge during a rebase exactly as the docked toolbar does", () => {
        const cpState = {
            ...initialCommitPanelState,
            files: [conflictedFile],
            activeOperation: "rebase",
            rebaseControl: "foreign",
        } as unknown as CommitPanelState;
        const mounted = renderPane(cpState);

        expect(mounted.container.textContent).not.toContain("Abort Merge");
        expect(mounted.container.textContent).toContain("Abort Rebase");
        unmount(mounted.root, mounted.container);
    });
});
