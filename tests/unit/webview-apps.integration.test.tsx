// @vitest-environment jsdom

import { act } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

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

function fireInput(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
    act(() => {
        el.value = value;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
    });
}

async function flush(): Promise<void> {
    await act(async () => {
        await Promise.resolve();
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
    document.body.innerHTML = "";
    vi.clearAllMocks();
});

describe("CommitPanelApp integration", () => {
    it("handles extension messages and commit/shelf interactions", async () => {
        vi.resetModules();
        const vscode = installVsCodeMock({ checked: [] });
        const rootHost = createRootHost();
        void rootHost;

        await import("../../src/webviews/react/commit-panel/CommitPanelApp");
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
                                message: "On main: shelf-work",
                                date: "2026-02-19T00:00:00Z",
                                hash: "stashhash",
                            },
                        ],
                        shelfFiles: [
                            {
                                path: "src/webviews/react/CommitPanelApp.tsx",
                                status: "M",
                                staged: false,
                                additions: 3,
                                deletions: 1,
                            },
                        ],
                        selectedShelfIndex: 0,
                    },
                }),
            );
        });
        await flush();

        fireClick(document.querySelector('button[aria-label="Refresh"]'));
        fireClick(document.querySelector('button[aria-label="Rollback"]'));
        fireClick(document.querySelector('button[aria-label="Group by Directory"]'));
        fireClick(document.querySelector('button[aria-label="Show Diff Preview"]'));
        fireClick(document.querySelector('button[aria-label="Expand All"]'));
        fireClick(document.querySelector('button[aria-label="Collapse All"]'));

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

        fireClick(
            Array.from(document.querySelectorAll("*")).find((el) =>
                el.textContent?.trim() === "Amend",
            )?.parentElement?.querySelector('input[type="checkbox"]') ?? null,
        );

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

        fireClick(Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.includes("Shelf")));
        fireClick(Array.from(document.querySelectorAll("*")).find((el) => el.textContent?.includes("shelf-work")));
        fireClick(Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Apply"));
        fireClick(Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Pop"));
        fireClick(Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Delete"));

        expect(vscode.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "refresh" }));
        expect(vscode.postMessage).toHaveBeenCalledWith({ type: "getLastCommitMessage" });
        expect(vscode.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: "shelfApply", index: 0 }),
        );
        expect(vscode.setState).toHaveBeenCalled();
    });
});

describe("CommitGraphApp integration", () => {
    it("handles host messages, filtering, branch actions, and commit actions", async () => {
        vi.resetModules();
        const vscode = installVsCodeMock();
        const rootHost = createRootHost();
        void rootHost;

        await import("../../src/webviews/react/CommitGraphApp");
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
        });
        await flush();

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
    });
});

describe("CommitInfoApp integration", () => {
    it("renders detail, supports resize/toggle, and clears", async () => {
        vi.resetModules();
        const vscode = installVsCodeMock();
        const rootHost = createRootHost();
        void rootHost;

        await import("../../src/webviews/react/CommitInfoApp");
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
                            refs: [],
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

        fireClick(Array.from(document.querySelectorAll("*")).find((el) => el.textContent?.includes("Commit Details")));
        fireClick(Array.from(document.querySelectorAll("*")).find((el) => el.textContent?.includes("Commit Details")));

        act(() => {
            window.dispatchEvent(new MessageEvent("message", { data: { type: "clear" } }));
        });
        await flush();
        expect(document.body.textContent).toContain("No commit selected");
    });
});
