// @vitest-environment jsdom

import React, { act } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { BranchAction } from "../../src/webviews/react/commitGraphTypes";

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

        vi.doMock("../../src/webviews/react/shared/vscodeApi", () => ({
            getVsCodeApi: () => ({ postMessage }),
        }));
        vi.doMock("../../src/webviews/react/BranchColumn", () => ({
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
        vi.doMock("../../src/webviews/react/CommitList", () => ({
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

        await import("../../src/webviews/react/CommitGraphApp");
        await flush();

        act(() => {
            document.getElementById("branch-main")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            document.getElementById("branch-null")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            document.getElementById("branch-action")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            document.getElementById("filter-short")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            document.getElementById("filter-long")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            document.getElementById("filter-empty")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            document.getElementById("commit-select")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            document.getElementById("commit-action")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            document.getElementById("load-more")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            document.getElementById("load-more")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });

        const divider = document.querySelector('[data-testid="commit-graph-divider"]') as HTMLElement;
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

    it("CommitPanelApp executes amend/message/commit handlers", async () => {
        const postMessage = vi.fn();
        const dispatch = vi.fn();

        vi.doMock("../../src/webviews/react/commit-panel/hooks/useExtensionMessages", () => ({
            useExtensionMessages: () => [
                {
                    files: [{ path: "src/a.ts", status: "M", staged: false, additions: 1, deletions: 0 }],
                    stashes: [],
                    shelfFiles: [],
                    selectedShelfIndex: null,
                    commitMessage: "feat: message",
                    isAmend: false,
                    error: null,
                },
                dispatch,
            ],
        }));
        vi.doMock("../../src/webviews/react/commit-panel/hooks/useCheckedFiles", () => ({
            useCheckedFiles: () => ({
                checkedPaths: new Set(["src/a.ts"]),
                toggleFile: vi.fn(),
                toggleFolder: vi.fn(),
                toggleSection: vi.fn(),
                isAllChecked: () => false,
                isSomeChecked: () => true,
            }),
        }));
        vi.doMock("../../src/webviews/react/commit-panel/hooks/useVsCodeApi", () => ({
            getVsCodeApi: () => ({ postMessage }),
        }));
        vi.doMock("../../src/webviews/react/commit-panel/components/CommitTab", () => ({
            CommitTab: (props: {
                onMessageChange: (value: string) => void;
                onAmendChange: (value: boolean) => void;
                onCommit: () => void;
                onCommitAndPush: () => void;
            }) => (
                <div>
                    <button id="msg" onClick={() => props.onMessageChange("next message")} />
                    <button id="amend" onClick={() => props.onAmendChange(true)} />
                    <button id="commit" onClick={() => props.onCommit()} />
                    <button id="commit-push" onClick={() => props.onCommitAndPush()} />
                </div>
            ),
        }));
        vi.doMock("../../src/webviews/react/commit-panel/components/ShelfTab", () => ({
            ShelfTab: () => <div>Shelf</div>,
        }));
        vi.doMock("../../src/webviews/react/commit-panel/components/TabBar", () => ({
            TabBar: (props: { commitContent: React.ReactNode; shelfContent: React.ReactNode }) => (
                <div>
                    <div>{props.commitContent}</div>
                    <div>{props.shelfContent}</div>
                </div>
            ),
        }));

        await import("../../src/webviews/react/commit-panel/CommitPanelApp");
        await flush();

        const msg = document.getElementById("msg");
        const amend = document.getElementById("amend");
        const commit = document.getElementById("commit");
        const commitPush = document.getElementById("commit-push");
        expect(msg).toBeTruthy();
        expect(amend).toBeTruthy();
        expect(commit).toBeTruthy();
        expect(commitPush).toBeTruthy();

        act(() => {
            msg?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            amend?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            commit?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            commitPush?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });

        expect(dispatch).toHaveBeenCalledWith({ type: "SET_COMMIT_MESSAGE", message: "next message" });
        expect(dispatch).toHaveBeenCalledWith({ type: "SET_AMEND", isAmend: true });
        expect(postMessage).toHaveBeenCalledWith({ type: "getLastCommitMessage" });
        expect(postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: "commitSelected", push: false }),
        );
        expect(postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: "commitSelected", push: true }),
        );
    });

    it("CommitPanelApp forwards empty commit attempts for extension-side validation", async () => {
        const postMessage = vi.fn();

        vi.doMock("../../src/webviews/react/commit-panel/hooks/useExtensionMessages", () => ({
            useExtensionMessages: () => [
                {
                    files: [{ path: "src/a.ts", status: "M", staged: false, additions: 1, deletions: 0 }],
                    stashes: [],
                    shelfFiles: [],
                    selectedShelfIndex: null,
                    commitMessage: "   ",
                    isAmend: false,
                    error: null,
                },
                vi.fn(),
            ],
        }));
        vi.doMock("../../src/webviews/react/commit-panel/hooks/useCheckedFiles", () => ({
            useCheckedFiles: () => ({
                checkedPaths: new Set<string>(),
                toggleFile: vi.fn(),
                toggleFolder: vi.fn(),
                toggleSection: vi.fn(),
                isAllChecked: () => false,
                isSomeChecked: () => false,
            }),
        }));
        vi.doMock("../../src/webviews/react/commit-panel/hooks/useVsCodeApi", () => ({
            getVsCodeApi: () => ({ postMessage }),
        }));
        vi.doMock("../../src/webviews/react/commit-panel/components/CommitTab", () => ({
            CommitTab: (props: { onCommit: () => void }) => (
                <div>
                    <button id="commit" onClick={() => props.onCommit()} />
                </div>
            ),
        }));
        vi.doMock("../../src/webviews/react/commit-panel/components/ShelfTab", () => ({
            ShelfTab: () => <div>Shelf</div>,
        }));
        vi.doMock("../../src/webviews/react/commit-panel/components/TabBar", () => ({
            TabBar: (props: { commitContent: React.ReactNode; shelfContent: React.ReactNode }) => (
                <div>
                    <div>{props.commitContent}</div>
                    <div>{props.shelfContent}</div>
                </div>
            ),
        }));

        await import("../../src/webviews/react/commit-panel/CommitPanelApp");
        await flush();

        act(() => {
            document.getElementById("commit")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });

        expect(postMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                type: "commitSelected",
                message: "",
                amend: false,
                push: false,
                paths: [],
            }),
        );
    });

});
