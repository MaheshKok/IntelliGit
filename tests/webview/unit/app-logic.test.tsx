// @vitest-environment jsdom

import React, { act } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { BranchAction } from "../../../src/webviews/protocol/commitGraphTypes";

function setupRoot(): void {
    document.body.innerHTML = "";
    const root = document.createElement("div");
    root.id = "root";
    document.body.appendChild(root);
}

async function flush(): Promise<void> {
    await act(async () => {
        await Promise.resolve();
    });
}

beforeAll(() => {
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
        value: true,
        configurable: true,
    });
    Object.defineProperty(window, "matchMedia", {
        value: vi.fn().mockImplementation((query: string) => ({
            matches: false,
            media: query,
            onchange: null,
            addListener: vi.fn(),
            removeListener: vi.fn(),
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            dispatchEvent: vi.fn(),
        })),
        configurable: true,
    });
});

beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    setupRoot();
});

describe("app logic coverage", () => {
    it("CommitGraphApp handles callback and drag branches", async () => {
        const postMessage = vi.fn();
        type BranchColumnMockProps = {
            onSelectBranch: (branch: string | null) => void;
            onBranchAction: (action: BranchAction, branch: string) => void;
        };
        type CommitListMockProps = {
            onSelectCommit: (hash: string) => void;
            onFilterText: (text: string) => void;
            onLoadMore: () => void;
            onCommitAction: (action: string, hash: string) => void;
        };

        vi.doMock("../../../src/webviews/react/shared/vscodeApi", () => ({
            getVsCodeApi: () => ({ postMessage }),
        }));
        vi.doMock("../../../src/webviews/react/BranchColumn", () => ({
            BranchColumn: (props: BranchColumnMockProps) => (
                <div>
                    <button id="branch-main" onClick={() => props.onSelectBranch("main")} />
                    <button id="branch-null" onClick={() => props.onSelectBranch(null)} />
                    <button
                        id="branch-action"
                        onClick={() => props.onBranchAction("checkout", "main")}
                    />
                </div>
            ),
        }));
        vi.doMock("../../../src/webviews/react/CommitList", () => ({
            CommitList: (props: CommitListMockProps) => (
                <div>
                    <button id="commit-select" onClick={() => props.onSelectCommit("abc1234")} />
                    <button id="filter-short" onClick={() => props.onFilterText("ab")} />
                    <button id="filter-long" onClick={() => props.onFilterText("abcd")} />
                    <button id="filter-empty" onClick={() => props.onFilterText("")} />
                    <button id="load-more" onClick={() => props.onLoadMore()} />
                    <button
                        id="commit-action"
                        onClick={() => props.onCommitAction("newTag", "abc1234")}
                    />
                </div>
            ),
        }));

        await import("../../../src/webviews/react/CommitGraphApp");
        await flush();

        act(() => {
            document
                .getElementById("branch-main")
                ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            document
                .getElementById("branch-null")
                ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            document
                .getElementById("branch-action")
                ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            document
                .getElementById("filter-short")
                ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            document
                .getElementById("filter-long")
                ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            document
                .getElementById("filter-empty")
                ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            document
                .getElementById("commit-select")
                ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            document
                .getElementById("commit-action")
                ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            document
                .getElementById("load-more")
                ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            document
                .getElementById("load-more")
                ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });

        const divider = document.querySelector(
            '[data-testid="commit-graph-divider"]',
        ) as HTMLElement;
        expect(divider).toBeTruthy();
        act(() => {
            divider.dispatchEvent(
                new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: 180 }),
            );
            document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 240 }));
            document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        });

        const types = postMessage.mock.calls.map((c) => c[0]?.type);
        expect(types).toContain("ready");
        expect(types).toContain("filterBranch");
        expect(types).toContain("branchAction");
        expect(types).toContain("commitAction");
        expect(types.filter((t) => t === "loadMore")).toHaveLength(1);
        expect(types).toContain("filterText");
    });

    it("CompactCommitGraphApp renders the old commit-panel graph without branch controls", async () => {
        const postMessage = vi.fn();
        type CommitListMockProps = {
            selectedBranch: string | null;
            showSearch?: boolean;
            showAuthorDate?: boolean;
            headerLabel?: string;
            onSelectCommit: (hash: string) => void;
            onFilterText: (text: string) => void;
            onLoadMore: () => void;
            onCommitAction: (action: string, hash: string) => void;
        };

        vi.doMock("../../../src/webviews/react/shared/vscodeApi", () => ({
            getVsCodeApi: () => ({ postMessage }),
        }));
        vi.doMock("../../../src/webviews/react/CommitList", () => ({
            CommitList: (props: CommitListMockProps) => (
                <div data-testid="compact-graph">
                    <span id="branch-scope">{props.selectedBranch ?? "all"}</span>
                    <span id="compact-search">{String(props.showSearch)}</span>
                    <span id="compact-author-date">{String(props.showAuthorDate)}</span>
                    <span id="compact-header">{props.headerLabel}</span>
                    <button id="compact-select" onClick={() => props.onSelectCommit("abc1234")} />
                    <button id="compact-filter-short" onClick={() => props.onFilterText("ab")} />
                    <button id="compact-filter-long" onClick={() => props.onFilterText("abcd")} />
                    <button id="compact-load-more" onClick={() => props.onLoadMore()} />
                    <button
                        id="compact-commit-action"
                        onClick={() => props.onCommitAction("copyRevision", "abc1234")}
                    />
                </div>
            ),
        }));

        await import("../../../src/webviews/react/CompactCommitGraphApp");
        await flush();

        act(() => {
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: { type: "setSelectedBranch", branch: "main" },
                }),
            );
        });

        act(() => {
            document
                .getElementById("compact-select")
                ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            document
                .getElementById("compact-filter-short")
                ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            document
                .getElementById("compact-filter-long")
                ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            document
                .getElementById("compact-load-more")
                ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            document
                .getElementById("compact-commit-action")
                ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });

        expect(document.querySelector('[data-testid="compact-graph"]')).toBeTruthy();
        expect(document.getElementById("branch-main")).toBeNull();
        expect(document.getElementById("compact-search")?.textContent).toBe("false");
        expect(document.getElementById("compact-author-date")?.textContent).toBe("false");
        expect(document.getElementById("compact-header")?.textContent).toBe("Graph");
        expect(document.getElementById("branch-scope")?.textContent).toBe("main");

        const types = postMessage.mock.calls.map((c) => c[0]?.type);
        expect(types).toContain("ready");
        expect(types).toContain("selectCommit");
        expect(types).toContain("filterText");
        expect(types).toContain("loadMore");
        expect(types).toContain("commitAction");
        expect(types).not.toContain("filterBranch");
        expect(types).not.toContain("branchAction");
    });

    it("CommitPanelApp executes amend/message/commit handlers", async () => {
        const postMessage = vi.fn();
        const dispatch = vi.fn();

        vi.doMock("../../../src/webviews/react/commit-panel/hooks/useExtensionMessages", () => ({
            useExtensionMessages: () => [
                {
                    files: [
                        {
                            path: "src/a.ts",
                            status: "M",
                            staged: false,
                            additions: 1,
                            deletions: 0,
                        },
                    ],
                    stashes: [],
                    shelfFiles: [],
                    selectedShelfIndex: null,
                    commitMessage: "feat: message",
                    isAmend: false,
                    amendBranchCommits: [],
                    amendBranchHistoryLoaded: false,
                    iconFonts: [],
                    isRefreshing: false,
                            error: null,
                            currentBranchHasUpstream: true,
                            currentBranchAhead: 1,
                            currentBranchBehind: 0,
                        },
                dispatch,
            ],
        }));
        vi.doMock("../../../src/webviews/react/commit-panel/hooks/useCheckedFiles", () => ({
            useCheckedFiles: () => ({
                checkedPaths: new Set(["src/a.ts"]),
                toggleFile: vi.fn(),
                toggleFolder: vi.fn(),
                toggleSection: vi.fn(),
                isAllChecked: () => false,
                isSomeChecked: () => true,
            }),
        }));
        vi.doMock("../../../src/webviews/react/commit-panel/hooks/useVsCodeApi", () => ({
            getVsCodeApi: () => ({ postMessage, getState: () => ({}), setState: vi.fn() }),
        }));
        vi.doMock("../../../src/webviews/react/commit-panel/components/CommitTab", () => ({
            CommitTab: (props: {
                onMessageChange: (value: string) => void;
                onAmendChange: (value: boolean) => void;
                onCommit: () => void;
                canCommit: boolean;
                onFetch: () => void;
                onPull: () => void;
                onPush: () => void;
                onSync: () => void;
                canFetch: boolean;
                canPull: boolean;
                canPush: boolean;
                canSync: boolean;
            }) => (
                <div>
                    <button id="msg" onClick={() => props.onMessageChange("next message")} />
                    <button id="amend" onClick={() => props.onAmendChange(true)} />
                    <button
                        id="commit"
                        disabled={!props.canCommit}
                        onClick={() => props.onCommit()}
                    />
                    <button
                        id="fetch"
                        disabled={!props.canFetch}
                        onClick={() => props.onFetch()}
                    />
                    <button id="pull" disabled={!props.canPull} onClick={() => props.onPull()} />
                    <button id="push" disabled={!props.canPush} onClick={() => props.onPush()} />
                    <button id="sync" disabled={!props.canSync} onClick={() => props.onSync()} />
                </div>
            ),
        }));
        vi.doMock("../../../src/webviews/react/commit-panel/components/ShelfTab", () => ({
            ShelfTab: () => <div>Shelf</div>,
        }));
        vi.doMock("../../../src/webviews/react/commit-panel/components/TabBar", () => ({
            TabBar: (props: { commitContent: React.ReactNode; shelfContent: React.ReactNode }) => (
                <div>
                    <div>{props.commitContent}</div>
                    <div>{props.shelfContent}</div>
                </div>
            ),
        }));

        await import("../../../src/webviews/react/commit-panel/CommitPanelApp");
        await flush();

        expect(document.querySelector('[data-testid="commit-panel-changes-body"]')).toBeNull();
        expect(document.querySelector('[data-testid="commit-panel-resize-handle"]')).toBeNull();
        expect(document.querySelector('[data-testid="commit-panel-graph-body"]')).toBeNull();
        expect(document.body.textContent).toContain("Shelf");

        const msg = document.getElementById("msg");
        const amend = document.getElementById("amend");
        const commit = document.getElementById("commit");
        const fetch = document.getElementById("fetch");
        const pull = document.getElementById("pull");
        const push = document.getElementById("push");
        const sync = document.getElementById("sync");
        expect(msg).toBeTruthy();
        expect(amend).toBeTruthy();
        expect(commit).toBeTruthy();
        expect(fetch).toBeTruthy();
        expect(pull).toBeTruthy();
        expect(push).toBeTruthy();
        expect(sync).toBeTruthy();

        act(() => {
            msg?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            amend?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            commit?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            fetch?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            pull?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            push?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            sync?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });

        expect(dispatch).toHaveBeenCalledWith({
            type: "SET_COMMIT_MESSAGE",
            message: "next message",
        });
        expect(dispatch).toHaveBeenCalledWith({ type: "SET_AMEND", isAmend: true });
        expect(postMessage).toHaveBeenCalledWith({ type: "getLastCommitMessage" });
        expect(postMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                type: "commitSelected",
                message: "feat: message",
                amend: false,
                push: false,
                paths: ["src/a.ts"],
            }),
        );
        expect(postMessage).toHaveBeenCalledWith({ type: "fetch" });
        expect(postMessage).not.toHaveBeenCalledWith({ type: "pull" });
        expect(postMessage).toHaveBeenCalledWith({ type: "push" });
        expect(postMessage).toHaveBeenCalledWith({ type: "sync" });
    });

    it("CommitPanelApp defaults groupByDir to true when getState returns undefined", async () => {
        const postMessage = vi.fn();
        let capturedGroupByDir: boolean | undefined;

        vi.doMock("../../../src/webviews/react/commit-panel/hooks/useExtensionMessages", () => ({
            useExtensionMessages: () => [
                {
                    files: [],
                    stashes: [],
                    shelfFiles: [],
                    selectedShelfIndex: null,
                    commitMessage: "",
                    isAmend: false,
                    amendBranchCommits: [],
                    amendBranchHistoryLoaded: false,
                    iconFonts: [],
                    isRefreshing: false,
                    error: null,
                },
                vi.fn(),
            ],
        }));
        vi.doMock("../../../src/webviews/react/commit-panel/hooks/useCheckedFiles", () => ({
            useCheckedFiles: () => ({
                checkedPaths: new Set<string>(),
                toggleFile: vi.fn(),
                toggleFolder: vi.fn(),
                toggleSection: vi.fn(),
                isAllChecked: () => false,
                isSomeChecked: () => false,
            }),
        }));
        vi.doMock("../../../src/webviews/react/commit-panel/hooks/useVsCodeApi", () => ({
            getVsCodeApi: () => ({ postMessage, getState: () => undefined, setState: vi.fn() }),
        }));
        vi.doMock("../../../src/webviews/react/commit-panel/components/CommitTab", () => ({
            CommitTab: (props: { groupByDir: boolean }) => {
                capturedGroupByDir = props.groupByDir;
                return <div>CommitTab</div>;
            },
        }));
        vi.doMock("../../../src/webviews/react/commit-panel/components/ShelfTab", () => ({
            ShelfTab: () => <div>Shelf</div>,
        }));
        vi.doMock("../../../src/webviews/react/commit-panel/components/TabBar", () => ({
            TabBar: (props: { commitContent: React.ReactNode; shelfContent: React.ReactNode }) => (
                <div>
                    <div>{props.commitContent}</div>
                    <div>{props.shelfContent}</div>
                </div>
            ),
        }));

        await import("../../../src/webviews/react/commit-panel/CommitPanelApp");
        await flush();

        expect(capturedGroupByDir).toBe(true);
    });

    it("CommitPanelApp disables commit when no files are checked", async () => {
        const postMessage = vi.fn();

        vi.doMock("../../../src/webviews/react/commit-panel/hooks/useExtensionMessages", () => ({
            useExtensionMessages: () => [
                {
                    files: [
                        {
                            path: "src/a.ts",
                            status: "M",
                            staged: false,
                            additions: 1,
                            deletions: 0,
                        },
                    ],
                    stashes: [],
                    shelfFiles: [],
                    selectedShelfIndex: null,
                    commitMessage: "   ",
                    isAmend: false,
                    amendBranchCommits: [],
                    amendBranchHistoryLoaded: false,
                    iconFonts: [],
                    isRefreshing: false,
                    error: null,
                },
                vi.fn(),
            ],
        }));
        vi.doMock("../../../src/webviews/react/commit-panel/hooks/useCheckedFiles", () => ({
            useCheckedFiles: () => ({
                checkedPaths: new Set<string>(),
                toggleFile: vi.fn(),
                toggleFolder: vi.fn(),
                toggleSection: vi.fn(),
                isAllChecked: () => false,
                isSomeChecked: () => false,
            }),
        }));
        vi.doMock("../../../src/webviews/react/commit-panel/hooks/useVsCodeApi", () => ({
            getVsCodeApi: () => ({ postMessage, getState: () => ({}), setState: vi.fn() }),
        }));
        vi.doMock("../../../src/webviews/react/commit-panel/components/CommitTab", () => ({
            CommitTab: (props: { onCommit: () => void; canCommit: boolean }) => (
                <div>
                    <button
                        id="commit"
                        disabled={!props.canCommit}
                        onClick={() => props.onCommit()}
                    />
                </div>
            ),
        }));
        vi.doMock("../../../src/webviews/react/commit-panel/components/ShelfTab", () => ({
            ShelfTab: () => <div>Shelf</div>,
        }));
        vi.doMock("../../../src/webviews/react/commit-panel/components/TabBar", () => ({
            TabBar: (props: { commitContent: React.ReactNode; shelfContent: React.ReactNode }) => (
                <div>
                    <div>{props.commitContent}</div>
                    <div>{props.shelfContent}</div>
                </div>
            ),
        }));

        await import("../../../src/webviews/react/commit-panel/CommitPanelApp");
        await flush();

        act(() => {
            document
                .getElementById("commit")
                ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });

        expect(document.getElementById("commit")?.hasAttribute("disabled")).toBe(true);
        expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "commit" }));
        expect(postMessage).not.toHaveBeenCalledWith(
            expect.objectContaining({ type: "commitSelected" }),
        );
    });
});
