// @vitest-environment jsdom

import React, { act } from "react";
import type { ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { flush } from "../../helpers/reactDomTestUtils";
import { installWebviewI18n } from "../../helpers/webviewI18nTestUtils";

interface MockVsCodeApi {
    postMessage: ReturnType<typeof vi.fn>;
    getState: ReturnType<typeof vi.fn>;
    setState: ReturnType<typeof vi.fn>;
}

function createRootHost(): HTMLDivElement {
    const root = document.createElement("div");
    root.id = "root";
    document.body.appendChild(root);
    return root;
}

function fireClick(el: Element | null): void {
    if (!el) {
        throw new Error("expected button to exist for click");
    }
    act(() => {
        el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
}

/** Locates a button by accessible name (aria-label or visible text). */
function findButtonByName(name: string): HTMLButtonElement | null {
    return (
        Array.from(document.querySelectorAll("button")).find(
            (button) =>
                (button.getAttribute("aria-label") ?? button.textContent?.trim() ?? "") === name,
        ) ?? null
    );
}

function fireInput(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
    act(() => {
        el.value = value;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
    });
}

function installVsCodeMock(initialState: Record<string, unknown> = {}): MockVsCodeApi {
    const api: MockVsCodeApi = {
        postMessage: vi.fn(),
        getState: vi.fn(() => initialState),
        setState: vi.fn(),
    };
    Object.defineProperty(globalThis, "acquireVsCodeApi", {
        configurable: true,
        value: vi.fn(() => api),
    });
    installWebviewI18n();
    return api;
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

    class ResizeObserverMock {
        observe = vi.fn();
        unobserve = vi.fn();
        disconnect = vi.fn();
    }
    Object.defineProperty(globalThis, "ResizeObserver", {
        value: ResizeObserverMock,
        configurable: true,
    });

    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => {
        return {
            setTransform: vi.fn(),
            clearRect: vi.fn(),
            beginPath: vi.fn(),
            arc: vi.fn(),
            fill: vi.fn(),
            stroke: vi.fn(),
            moveTo: vi.fn(),
            lineTo: vi.fn(),
            bezierCurveTo: vi.fn(),
            set lineCap(_: string) {},
            set lineWidth(_: number) {},
            set strokeStyle(_: string) {},
            set fillStyle(_: string) {},
        } as unknown as CanvasRenderingContext2D;
    });
});

afterEach(() => {
    vi.useRealTimers();
    vi.doUnmock("../../../src/webviews/react/BranchColumn");
    vi.doUnmock("../../../src/webviews/react/CommitList");
    vi.doUnmock("../../../src/webviews/react/commit-info/CommitInfoPane");
    vi.doUnmock("../../../src/webviews/react/commit-panel/components/TabBar");
    vi.doUnmock("../../../src/webviews/react/commit-panel/components/CommitTab");
    vi.doUnmock("../../../src/webviews/react/commit-panel/components/StashTab");
    document.body.innerHTML = "";
    vi.clearAllMocks();
});

describe("CommitPanelApp integration", () => {
    it("handles extension messages and commit/stash interactions", async () => {
        vi.resetModules();
        const vscode = installVsCodeMock({ checked: [] });
        const rootHost = createRootHost();
        void rootHost;

        await import("../../../src/webviews/react/commit-panel/CommitPanelApp");
        await flush();
        expect(vscode.postMessage).toHaveBeenCalledWith({ type: "ready" });

        act(() => {
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: {
                        type: "update",
                        files: [
                            {
                                path: "src/webviews/react/CommitPanelApp.tsx",
                                status: "M",
                                staged: false,
                                additions: 3,
                                deletions: 1,
                            },
                            {
                                path: "package.json",
                                status: "?",
                                staged: false,
                                additions: 0,
                                deletions: 0,
                            },
                        ],
                        stashes: [
                            {
                                index: 0,
                                message: "On main: stash-work",
                                date: "2026-02-19T00:00:00Z",
                                hash: "stashhash",
                            },
                        ],
                        stashFiles: [
                            {
                                path: "src/webviews/react/CommitPanelApp.tsx",
                                status: "M",
                                staged: false,
                                additions: 3,
                                deletions: 1,
                            },
                        ],
                        selectedStashIndex: 0,
                    },
                }),
            );
        });
        await flush();

        const tabRow = document.querySelector('[data-testid="commit-panel-tab-row"]');
        expect(tabRow).not.toBeNull();
        const buttonLabels = Array.from(tabRow?.querySelectorAll("button") ?? []).map(
            (button) => button.getAttribute("aria-label") ?? button.textContent?.trim() ?? "",
        );
        const gitActionOrder = ["Commit", "Stash (1)", "Sync", "Fetch", "Pull", "Push"].map(
            (label) => buttonLabels.indexOf(label),
        );
        expect(gitActionOrder.every((index) => index >= 0)).toBe(true);
        expect(gitActionOrder).toEqual([...gitActionOrder].sort((a, b) => a - b));
        const tabListLabels = Array.from(tabRow?.querySelectorAll('[role="tab"]') ?? []).map(
            (tab) => tab.textContent?.trim() ?? "",
        );
        expect(tabListLabels).toEqual(["Commit", "Stash (1)"]);
        expect(findButtonByName("Abort Merge")).toBeNull();

        fireClick(document.querySelector('button[aria-label="Refresh"]'));
        fireClick(document.querySelector('button[aria-label="Rollback"]'));
        fireClick(document.querySelector('button[aria-label="View Options"]'));
        await flush();
        fireClick(
            Array.from(document.querySelectorAll('[role="menuitem"]')).find(
                (item) => item.textContent?.trim() === "Directory",
            ) ?? null,
        );
        fireClick(document.querySelector('button[aria-label="Show Diff Preview"]'));
        fireClick(document.querySelector('button[aria-label="Expand All"]'));
        fireClick(document.querySelector('button[aria-label="Collapse All"]'));
        expect(findButtonByName("Abort Merge")).toBeNull();
        act(() => {
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: {
                        type: "update",
                        files: [
                            {
                                path: "src/conflicted.ts",
                                status: "U",
                                staged: false,
                                additions: 1,
                                deletions: 1,
                            },
                        ],
                        stashes: [
                            {
                                index: 0,
                                message: "On main: stash-work",
                                date: "2026-02-19T00:00:00Z",
                                hash: "stashhash",
                            },
                        ],
                        stashFiles: [
                            {
                                path: "src/webviews/react/CommitPanelApp.tsx",
                                status: "M",
                                staged: false,
                                additions: 3,
                                deletions: 1,
                            },
                        ],
                        selectedStashIndex: 0,
                        currentBranchHasUpstream: true,
                        currentBranchAhead: 0,
                        currentBranchBehind: 0,
                    },
                }),
            );
        });
        await flush();
        fireClick(findButtonByName("Abort Merge"));
        fireClick(document.querySelector('button[aria-label="Sync"]'));
        fireClick(document.querySelector('button[aria-label="Fetch"]'));
        fireClick(document.querySelector('button[aria-label="Pull"]'));
        fireClick(document.querySelector('button[aria-label="Push"]'));

        const checkboxes = Array.from(
            document.querySelectorAll('input[type="checkbox"]'),
        ) as HTMLInputElement[];
        if (checkboxes.length > 0) {
            fireClick(checkboxes[0]);
        }

        const textarea = document.querySelector(
            'textarea[placeholder="Commit Message"]',
        ) as HTMLTextAreaElement;
        fireInput(textarea, "feat: integration");
        fireClick(
            Array.from(document.querySelectorAll("button")).find(
                (b) => b.textContent?.trim() === "Commit",
            ) ?? null,
        );

        fireClick(document.querySelector('[data-testid="amend-checkbox"]'));
        await flush();

        expect(vscode.postMessage).toHaveBeenCalledWith({ type: "getLastCommitMessage" });
        expect(vscode.postMessage).toHaveBeenCalledWith({ type: "getAmendBranchCommits" });

        act(() => {
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: {
                        type: "update",
                        files: [
                            {
                                path: "src/conflicted.ts",
                                status: "U",
                                staged: false,
                                additions: 1,
                                deletions: 1,
                            },
                        ],
                        stashes: [
                            {
                                index: 0,
                                message: "On main: stash-work",
                                date: "2026-02-19T00:00:00Z",
                                hash: "stashhash",
                            },
                        ],
                        stashFiles: [
                            {
                                path: "src/webviews/react/CommitPanelApp.tsx",
                                status: "M",
                                staged: false,
                                additions: 3,
                                deletions: 1,
                            },
                        ],
                        selectedStashIndex: 0,
                    },
                }),
            );
        });
        await flush();
        fireClick(findButtonByName("Abort Merge"));

        act(() => {
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: {
                        type: "amendBranchCommits",
                        commits: [
                            {
                                shortHash: "deadbeb",
                                subject: "feat: on branch",
                                date: "2026-02-19T12:00:00Z",
                            },
                        ],
                    },
                }),
            );
        });
        await flush();
        expect(document.body.textContent).toContain("Commits on this branch");
        expect(document.body.textContent).toContain("deadbeb");
        expect(document.body.textContent).toContain("Amend commit");

        act(() => {
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: { type: "lastCommitMessage", message: "last commit body" },
                }),
            );
        });
        await flush();
        expect((document.querySelector("textarea") as HTMLTextAreaElement).value).toContain(
            "last commit body",
        );

        act(() => {
            window.dispatchEvent(new MessageEvent("message", { data: { type: "committed" } }));
        });
        await flush();

        fireClick(
            Array.from(document.querySelectorAll("button")).find((b) =>
                b.textContent?.includes("Stash"),
            ),
        );
        fireClick(document.querySelector('[title="On main: stash-work"]'));
        fireClick(
            Array.from(document.querySelectorAll("button")).find(
                (b) => b.textContent?.trim() === "Apply",
            ),
        );
        fireClick(
            Array.from(document.querySelectorAll("button")).find(
                (b) => b.textContent?.trim() === "Pop",
            ),
        );
        const stashRow = document.querySelector('[title="On main: stash-work"]');
        act(() => {
            stashRow?.dispatchEvent(
                new MouseEvent("contextmenu", {
                    bubbles: true,
                    cancelable: true,
                    clientX: 160,
                    clientY: 120,
                }),
            );
        });
        await flush();
        const dropMenuItem = Array.from(document.querySelectorAll(".intelligit-context-item")).find(
            (el) => el.textContent?.includes("Drop"),
        );
        expect(dropMenuItem).toBeTruthy();
        fireClick(dropMenuItem);

        expect(vscode.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: "refresh" }),
        );
        expect(vscode.postMessage).toHaveBeenCalledWith({ type: "sync" });
        expect(vscode.postMessage).toHaveBeenCalledWith({ type: "fetch" });
        expect(vscode.postMessage).toHaveBeenCalledWith({ type: "pull" });
        expect(vscode.postMessage).toHaveBeenCalledWith({ type: "push" });
        expect(vscode.postMessage).toHaveBeenCalledWith({ type: "abortMerge" });
        expect(vscode.postMessage).toHaveBeenCalledWith({ type: "getLastCommitMessage" });
        expect(vscode.postMessage).toHaveBeenCalledWith({ type: "getAmendBranchCommits" });
        expect(vscode.postMessage).toHaveBeenCalledWith({ type: "abortMerge" });
        expect(vscode.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: "stashApply", index: 0 }),
        );
        expect(vscode.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: "stashPop", index: 0 }),
        );
        expect(vscode.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: "stashDelete", index: 0 }),
        );
        expect(vscode.setState).toHaveBeenCalled();
    });

    it("keeps toolbar refresh feedback visible when changed files are present", async () => {
        vi.resetModules();
        vi.useFakeTimers();
        const vscode = installVsCodeMock({ checked: [] });
        createRootHost();

        await act(async () => {
            await import("../../../src/webviews/react/commit-panel/CommitPanelApp");
        });
        await flush();

        const files = [
            {
                path: "README.md",
                status: "M",
                staged: false,
                additions: 4,
                deletions: 1,
            },
            {
                path: "package.json",
                status: "M",
                staged: false,
                additions: 1,
                deletions: 0,
            },
        ];

        act(() => {
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: {
                        type: "update",
                        files,
                        stashes: [],
                        stashFiles: [],
                        selectedStashIndex: null,
                        currentBranchHasUpstream: true,
                    },
                }),
            );
        });
        await flush();

        expect(document.body.textContent).toContain("Changes");
        expect(document.body.textContent).toContain("2 files");
        expect(document.querySelector('[title="README.md"]')).toBeTruthy();
        expect(document.querySelector('[title="package.json"]')).toBeTruthy();
        expect(document.querySelector('button[aria-label="Refresh"]')).toBeTruthy();

        fireClick(document.querySelector('button[aria-label="Refresh"]'));
        await flush();

        expect(vscode.postMessage).toHaveBeenCalledWith({ type: "refresh" });
        expect(document.querySelector('[title="README.md"]')).toBeTruthy();
        expect(document.querySelector('[title="package.json"]')).toBeTruthy();
        let refreshingButton = document.querySelector(
            'button[aria-label="Refreshing..."][data-refreshing="true"]',
        ) as HTMLButtonElement | null;
        expect(refreshingButton).toBeTruthy();
        expect(refreshingButton?.disabled).toBe(true);
        expect(refreshingButton?.querySelector("svg")?.getAttribute("style")).toContain(
            "intelligit-spin",
        );

        act(() => {
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: { type: "refreshing", active: false },
                }),
            );
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: {
                        type: "update",
                        files,
                        stashes: [],
                        stashFiles: [],
                        selectedStashIndex: null,
                        currentBranchHasUpstream: true,
                    },
                }),
            );
        });
        await flush();

        expect(document.querySelector('[title="README.md"]')).toBeTruthy();
        expect(document.querySelector('[title="package.json"]')).toBeTruthy();
        refreshingButton = document.querySelector(
            'button[aria-label="Refreshing..."][data-refreshing="true"]',
        ) as HTMLButtonElement | null;
        expect(refreshingButton).toBeTruthy();

        act(() => {
            vi.advanceTimersByTime(699);
        });
        await flush();
        expect(
            document.querySelector('button[aria-label="Refreshing..."][data-refreshing="true"]'),
        ).toBeTruthy();
        expect(document.querySelector('[title="README.md"]')).toBeTruthy();

        act(() => {
            vi.advanceTimersByTime(1);
        });
        await flush();

        expect(document.querySelector('button[aria-label="Refreshing..."]')).toBeNull();
        expect(document.querySelector('button[aria-label="Refresh"]')).toBeTruthy();
        expect(document.querySelector('[title="README.md"]')).toBeTruthy();
        expect(document.querySelector('[title="package.json"]')).toBeTruthy();
    });
});

describe("CommitGraphApp integration", () => {
    it("handles host messages, filtering, branch actions, commit actions, and changed-file clicks", async () => {
        vi.resetModules();
        const vscode = installVsCodeMock();
        const rootHost = createRootHost();
        void rootHost;

        await import("../../../src/webviews/react/CommitGraphApp");
        await flush();
        expect(vscode.postMessage).toHaveBeenCalledWith({ type: "ready" });

        act(() => {
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: {
                        type: "setBranches",
                        branches: [
                            {
                                name: "main",
                                hash: "a1",
                                isRemote: false,
                                isCurrent: true,
                                ahead: 0,
                                behind: 0,
                            },
                            {
                                name: "features/right-click-context",
                                hash: "b2",
                                isRemote: false,
                                isCurrent: false,
                                ahead: 1,
                                behind: 0,
                            },
                        ],
                    },
                }),
            );
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: {
                        type: "loadCommits",
                        append: false,
                        hasMore: true,
                        unpushedHashes: ["aa11"],
                        commits: [
                            {
                                hash: "aa11",
                                shortHash: "aa11",
                                message: "feat: first commit",
                                author: "Mahesh",
                                email: "m@example.com",
                                date: "2026-02-19T00:00:00Z",
                                parentHashes: ["p1"],
                                refs: ["HEAD -> main"],
                            },
                            {
                                hash: "bb22",
                                shortHash: "bb22",
                                message: "Merge pull request #4",
                                author: "Mahesh",
                                email: "m@example.com",
                                date: "2026-02-18T00:00:00Z",
                                parentHashes: ["p1", "p2"],
                                refs: [],
                            },
                        ],
                    },
                }),
            );
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: {
                        type: "setSelectedBranch",
                        branch: "features/right-click-context",
                    },
                }),
            );
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: {
                        type: "loadCommits",
                        append: true,
                        hasMore: false,
                        unpushedHashes: ["aa11", "cc33"],
                        commits: [
                            {
                                hash: "cc33",
                                shortHash: "cc33",
                                message: "feat: appended",
                                author: "Mahesh",
                                email: "m@example.com",
                                date: "2026-02-19T01:00:00Z",
                                parentHashes: ["bb22"],
                                refs: [],
                            },
                        ],
                    },
                }),
            );
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: {
                        type: "setCommitDetail",
                        detail: {
                            hash: "aa11",
                            shortHash: "aa11",
                            message: "feat: first commit",
                            body: "",
                            author: "Mahesh",
                            email: "m@example.com",
                            date: "2026-02-19T00:00:00Z",
                            parentHashes: ["p1"],
                            refs: ["HEAD -> main"],
                            files: [
                                {
                                    path: "src/feature.ts",
                                    status: "M",
                                    additions: 3,
                                    deletions: 1,
                                },
                                {
                                    path: "src/keyboard.ts",
                                    status: "A",
                                    additions: 2,
                                    deletions: 0,
                                },
                            ],
                        },
                    },
                }),
            );
        });
        await flush();
        expect(document.body.textContent).toContain("Branch: features/right-click-context");

        const changedFileRow = document.querySelector(
            '[title="src/feature.ts"]',
        ) as HTMLElement | null;
        expect(changedFileRow).toBeTruthy();
        expect(changedFileRow?.getAttribute("aria-selected")).toBe("false");
        const openDiffMessagesBeforeClick = vscode.postMessage.mock.calls.filter(
            ([message]) =>
                (message as { type?: string }).type === "openCommitFileDiff" &&
                (message as { filePath?: string }).filePath === "src/feature.ts",
        ).length;
        act(() => {
            changedFileRow?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        await flush();
        expect(changedFileRow?.getAttribute("aria-selected")).toBe("true");
        const keyboardFileRow = document.querySelector(
            '[title="src/keyboard.ts"]',
        ) as HTMLElement | null;
        expect(keyboardFileRow?.getAttribute("aria-selected")).toBe("false");
        act(() => {
            keyboardFileRow?.dispatchEvent(
                new KeyboardEvent("keydown", { key: " ", code: "Space", bubbles: true }),
            );
        });
        await flush();
        expect(changedFileRow?.getAttribute("aria-selected")).toBe("false");
        expect(keyboardFileRow?.getAttribute("aria-selected")).toBe("true");
        expect(
            vscode.postMessage.mock.calls.filter(
                ([message]) =>
                    (message as { type?: string }).type === "openCommitFileDiff" &&
                    (message as { filePath?: string }).filePath === "src/feature.ts",
            ),
        ).toHaveLength(openDiffMessagesBeforeClick);
        act(() => {
            changedFileRow?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
        });

        const branchRow = Array.from(document.querySelectorAll(".branch-row")).find((row) =>
            row.textContent?.includes("HEAD (main)"),
        ) as HTMLElement;
        fireClick(branchRow);
        act(() => {
            branchRow.dispatchEvent(
                new MouseEvent("contextmenu", {
                    bubbles: true,
                    cancelable: true,
                    clientX: 120,
                    clientY: 40,
                }),
            );
        });
        fireClick(
            Array.from(document.querySelectorAll(".intelligit-context-item")).find((item) =>
                item.textContent?.includes("Rename"),
            ) ?? null,
        );

        const commitRow = Array.from(document.querySelectorAll("div")).find(
            (row) =>
                (row as HTMLDivElement).style.cursor === "pointer" &&
                row.textContent?.includes("feat: first commit"),
        ) as HTMLElement;
        expect(commitRow).toBeTruthy();
        act(() => {
            commitRow.dispatchEvent(
                new MouseEvent("contextmenu", {
                    bubbles: true,
                    cancelable: true,
                    clientX: 260,
                    clientY: 90,
                }),
            );
        });
        fireClick(
            Array.from(document.querySelectorAll(".intelligit-context-item")).find((item) =>
                item.textContent?.includes("Copy Revision Number"),
            ) ?? null,
        );

        expect(vscode.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: "filterBranch", branch: null }),
        );
        expect(vscode.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: "branchAction", action: "renameBranch" }),
        );
        expect(vscode.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: "selectCommit", hash: "aa11" }),
        );
        expect(vscode.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                type: "openCommitFileDiff",
                commitHash: "aa11",
                filePath: "src/feature.ts",
            }),
        );
    });

    it("preserves the selected commit when a full refresh still contains it", async () => {
        vi.resetModules();
        const vscode = installVsCodeMock();
        createRootHost();

        await import("../../../src/webviews/react/CommitGraphApp");
        await flush();

        const commits = [
            {
                hash: "aa11",
                shortHash: "aa11",
                message: "feat: first commit",
                author: "Mahesh",
                email: "m@example.com",
                date: "2026-02-19T00:00:00Z",
                parentHashes: ["p1"],
                refs: ["HEAD -> main"],
            },
            {
                hash: "bb22",
                shortHash: "bb22",
                message: "fix: selected commit",
                author: "Mahesh",
                email: "m@example.com",
                date: "2026-02-18T00:00:00Z",
                parentHashes: ["p1"],
                refs: [],
            },
        ];
        act(() => {
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: {
                        type: "loadCommits",
                        append: false,
                        hasMore: false,
                        unpushedHashes: [],
                        commits,
                    },
                }),
            );
        });
        await flush();
        expect(vscode.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: "selectCommit", hash: "aa11" }),
        );

        const selectedCommitRow = Array.from(document.querySelectorAll('[role="button"]')).find(
            (row) => row.textContent?.includes("fix: selected commit"),
        );
        fireClick(selectedCommitRow ?? null);
        await flush();
        expect(vscode.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: "selectCommit", hash: "bb22" }),
        );

        vscode.postMessage.mockClear();
        act(() => {
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: {
                        type: "loadCommits",
                        append: false,
                        hasMore: false,
                        unpushedHashes: [],
                        commits: commits.map((commit) => ({ ...commit })),
                    },
                }),
            );
        });
        await flush();

        const selectCommitMessages = vscode.postMessage.mock.calls.filter(
            ([message]) => (message as { type?: string }).type === "selectCommit",
        );
        expect(selectCommitMessages).toHaveLength(0);
        const selectedRowAfterRefresh = Array.from(
            document.querySelectorAll('[role="button"][aria-current="true"]'),
        ).find((row) => row.textContent?.includes("fix: selected commit"));
        expect(selectedRowAfterRefresh).toBeTruthy();
    });
});

describe("UndockedApp integration", () => {
    function mockUndockedChildren(): void {
        vi.doMock("../../../src/webviews/react/BranchColumn", () => ({
            BranchColumn: () => <div>Branches</div>,
        }));
        vi.doMock("../../../src/webviews/react/CommitList", () => ({
            CommitList: () => <div>Graph</div>,
        }));
        vi.doMock("../../../src/webviews/react/commit-info/CommitInfoPane", () => ({
            CommitInfoPane: () => <div>Info</div>,
        }));
        vi.doMock("../../../src/webviews/react/commit-panel/components/TabBar", () => ({
            TabBar: ({ commitContent }: { commitContent: ReactNode }) => <div>{commitContent}</div>,
        }));
        vi.doMock("../../../src/webviews/react/commit-panel/components/CommitTab", () => ({
            CommitTab: () => <div>Commit</div>,
        }));
        vi.doMock("../../../src/webviews/react/commit-panel/components/StashTab", () => ({
            StashTab: () => <div>Stash</div>,
        }));
    }

    it("uses equal first-open section widths, preserves total width while dragging, and persists resized widths", async () => {
        vi.resetModules();
        vi.useFakeTimers();
        Object.defineProperty(window, "innerWidth", {
            configurable: true,
            value: 1200,
        });

        const vscode = installVsCodeMock();
        createRootHost();

        mockUndockedChildren();

        await import("../../../src/webviews/react/UndockedApp");
        await flush();

        const widthOf = (testId: string): number => {
            const element = document.querySelector(`[data-testid="${testId}"]`) as HTMLElement;
            if (!element) throw new Error(`missing ${testId}`);
            return Number.parseFloat(element.style.width);
        };
        const sectionIds = [
            "undocked-commit-panel-section",
            "undocked-branch-section",
            "undocked-graph-section",
            "undocked-info-section",
        ];
        const initialWidths = sectionIds.map(widthOf);

        expect(initialWidths).toEqual(initialWidths.map(() => 297));
        expect(initialWidths.reduce((total, width) => total + width, 0)).toBe(1188);
        expect(vscode.postMessage).toHaveBeenCalledWith({ type: "ready" });

        Object.defineProperty(window, "innerWidth", {
            configurable: true,
            value: 1800,
        });
        act(() => {
            window.dispatchEvent(new Event("resize"));
        });
        await flush();

        expect(sectionIds.map(widthOf)).toEqual(sectionIds.map(() => 447));
        expect(sectionIds.map(widthOf).reduce((total, width) => total + width, 0)).toBe(1788);

        act(() => {
            document.querySelector('[data-testid="undocked-branch-divider"]')?.dispatchEvent(
                new MouseEvent("mousedown", {
                    bubbles: true,
                    cancelable: true,
                    clientX: 400,
                }),
            );
            document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 450 }));
            document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        });

        expect(widthOf("undocked-branch-section")).toBe(497);
        expect(widthOf("undocked-graph-section")).toBe(397);
        expect(sectionIds.map(widthOf).reduce((total, width) => total + width, 0)).toBe(1788);

        act(() => {
            vi.advanceTimersByTime(350);
        });

        expect(vscode.postMessage).toHaveBeenCalledWith({
            type: "columnWidths",
            branchWidth: 497,
            graphWidth: 397,
            infoWidth: 447,
            commitPanelWidth: 447,
        });
        vi.useRealTimers();
    });

    it("migrates legacy persisted section widths without graphWidth", async () => {
        vi.resetModules();
        vi.useFakeTimers();
        Object.defineProperty(window, "innerWidth", {
            configurable: true,
            value: 1200,
        });

        const vscode = installVsCodeMock({
            branchWidth: 400,
            infoWidth: 300,
            commitPanelWidth: 200,
        });
        createRootHost();
        mockUndockedChildren();

        await import("../../../src/webviews/react/UndockedApp");
        await flush();

        const widthOf = (testId: string): number => {
            const element = document.querySelector(`[data-testid="${testId}"]`) as HTMLElement;
            if (!element) throw new Error(`missing ${testId}`);
            return Number.parseFloat(element.style.width);
        };
        const sectionIds = [
            "undocked-commit-panel-section",
            "undocked-branch-section",
            "undocked-graph-section",
            "undocked-info-section",
        ];

        expect(widthOf("undocked-branch-section")).toBeCloseTo(384.27, 2);
        expect(widthOf("undocked-graph-section")).toBeCloseTo(291.87, 2);
        expect(widthOf("undocked-info-section")).toBeCloseTo(291.87, 2);
        expect(widthOf("undocked-commit-panel-section")).toBe(220);
        expect(sectionIds.map(widthOf).reduce((total, width) => total + width, 0)).toBeCloseTo(
            1188,
            5,
        );

        act(() => {
            document.querySelector('[data-testid="undocked-branch-divider"]')?.dispatchEvent(
                new MouseEvent("mousedown", {
                    bubbles: true,
                    cancelable: true,
                    clientX: 400,
                }),
            );
            document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 450 }));
            document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        });
        await flush();
        act(() => {
            vi.advanceTimersByTime(350);
        });

        const columnWidthMessage = vscode.postMessage.mock.calls
            .map(([message]) => message as { type?: string })
            .find((message) => message.type === "columnWidths") as
            | {
                  branchWidth: number;
                  graphWidth: number;
                  infoWidth: number;
                  commitPanelWidth: number;
              }
            | undefined;

        expect(columnWidthMessage?.branchWidth).toBeCloseTo(434.27, 2);
        expect(columnWidthMessage?.graphWidth).toBeCloseTo(241.87, 2);
        expect(columnWidthMessage?.infoWidth).toBeCloseTo(291.87, 2);
        expect(columnWidthMessage?.commitPanelWidth).toBe(220);
        vi.useRealTimers();
    });
});

describe("CommitInfoApp integration", () => {
    it("renders detail, supports resize/toggle, and clears", async () => {
        vi.resetModules();
        const vscode = installVsCodeMock();
        const rootHost = createRootHost();
        void rootHost;

        await import("../../../src/webviews/react/CommitInfoApp");
        await flush();
        expect(vscode.postMessage).toHaveBeenCalledWith({ type: "ready" });

        act(() => {
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: {
                        type: "setCommitDetail",
                        detail: {
                            hash: "abc123",
                            shortHash: "abc123",
                            message: "feat: commit info",
                            body: "body line",
                            author: "Mahesh",
                            email: "m@example.com",
                            date: "2026-02-19T00:00:00Z",
                            parentHashes: ["p1"],
                            refs: ["HEAD -> main", "tag:v0.3.1"],
                            files: [
                                { path: "src/a.ts", status: "M", additions: 3, deletions: 1 },
                                { path: "src/b.ts", status: "A", additions: 4, deletions: 0 },
                            ],
                        },
                    },
                }),
            );
        });
        await flush();
        expect(document.body.textContent).toContain("feat: commit info");
        expect(document.body.textContent).toContain("2 files changed");
        expect(document.body.textContent).toContain("Branches");
        expect(document.body.textContent).toContain("Tags");
        expect(document.body.textContent).toContain("HEAD -> main");

        // Toggle "Commit Details" collapse/expand via its role="button" element
        const detailsToggle = document.querySelector('[role="button"][aria-expanded]');
        fireClick(detailsToggle);
        fireClick(detailsToggle);

        act(() => {
            window.dispatchEvent(new MessageEvent("message", { data: { type: "clear" } }));
        });
        await flush();
        expect(document.body.textContent).toContain("No commit selected");

        act(() => {
            window.dispatchEvent(
                new MessageEvent("message", { data: { type: "clear", loading: true } }),
            );
        });
        await flush();
        expect(document.body.textContent).not.toContain("No commit selected");
        expect(document.body.textContent).toContain("Changed Files");
        expect(document.body.textContent).toContain("Commit Details");
        const loadingSpinners = Array.from(document.querySelectorAll("svg")).filter((svg) =>
            svg.style.animation.includes("intelligit-spin"),
        );
        expect(loadingSpinners).toHaveLength(2);
        const loadingStatuses = Array.from(document.querySelectorAll('[role="status"]'));
        expect(loadingStatuses).toHaveLength(2);
        expect(loadingStatuses[0].textContent).toContain("Loading...");
        expect(loadingStatuses[0].textContent).toContain("Changed Files");
        expect(loadingStatuses[1].textContent).toContain("Loading...");
        expect(loadingStatuses[1].textContent).toContain("Commit Details");
    });
});
