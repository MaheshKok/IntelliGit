// @vitest-environment jsdom

// "Find where CI broke" in the card and undocked Git Log: a row menu opened while the pane showed
// repository A keeps A's range, so a click after the pane moved to B must not start a bisect under
// B's key. The compact Git Log already snapshots the repository when the menu opens (fix round 1);
// both other layouts take the same snapshot through CommitList's `findCiBreakScope`.

import React, { act } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { flush } from "../../helpers/reactDomTestUtils";
import { installWebviewI18n } from "../../helpers/webviewI18nTestUtils";

type FindCiBreak = (commits: { hash: string; parents: string[] }[], scope?: string) => void;

interface CapturedCommitListProps {
    onFindCiBreak?: FindCiBreak;
    findCiBreakScope?: string;
}

const RANGE = [
    { hash: "a".repeat(40), parents: ["b".repeat(40)] },
    { hash: "b".repeat(40), parents: ["c".repeat(40)] },
];
const SHOWN = "a".repeat(40);

let lastProps: CapturedCommitListProps | null = null;
let api: { postMessage: ReturnType<typeof vi.fn>; getState: unknown; setState: unknown };

function installVsCodeMock(): void {
    api = { postMessage: vi.fn(), getState: vi.fn(() => ({})), setState: vi.fn() };
    Object.defineProperty(globalThis, "acquireVsCodeApi", {
        configurable: true,
        value: vi.fn(() => api),
    });
    installWebviewI18n();
}

function createRootHost(): void {
    const root = document.createElement("div");
    root.id = "root";
    document.body.appendChild(root);
}

function dispatch(data: Record<string, unknown>): void {
    act(() => {
        window.dispatchEvent(new MessageEvent("message", { data }));
    });
}

const startedBisects = (): unknown[] =>
    api.postMessage.mock.calls
        .map(([message]) => message as { type: string; repoKey?: string })
        .filter(({ type }) => type === "startCiBisect");

/** Opens A's menu, moves the pane to B, then clicks the way the stale A menu would. */
async function clickAMenuAfterMovingToB(moveToB: () => void, moveToA: () => void): Promise<void> {
    moveToA();
    await flush();
    const control = lastProps?.onFindCiBreak;
    const scopeOfA = lastProps?.findCiBreakScope;
    act(() => control?.(RANGE, scopeOfA));
    expect(startedBisects(), "control: a menu opened on A starts a bisect in A").toEqual([
        expect.objectContaining({ repoKey: "/A" }),
    ]);
    api.postMessage.mockClear();

    moveToB();
    await flush();
    // CommitList calls the latest `onFindCiBreak` with the scope its menu opened with.
    act(() => lastProps?.onFindCiBreak?.(RANGE, scopeOfA));
    expect(startedBisects(), "the A menu must never start a bisect in B").toEqual([]);
    expect(scopeOfA, "the layout names the repository a menu opens on").toBe("/A");
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
});

beforeEach(() => {
    lastProps = null;
    vi.resetModules();
    document.body.replaceChildren();
    vi.doMock("../../../src/webviews/react/CommitList", () => ({
        CommitList: (props: CapturedCommitListProps) => {
            lastProps = props;
            return <div data-testid="commit-list-stub">Graph</div>;
        },
    }));
    vi.doMock("../../../src/webviews/react/BranchColumn", () => ({
        BranchColumn: () => <div>Branches</div>,
    }));
    vi.doMock("../../../src/webviews/react/commit-info/CommitInfoPane", () => ({
        CommitInfoPane: () => <div>Info</div>,
    }));
    installVsCodeMock();
    createRootHost();
});

afterEach(() => {
    vi.clearAllMocks();
    vi.doUnmock("../../../src/webviews/react/CommitList");
    vi.doUnmock("../../../src/webviews/react/BranchColumn");
    vi.doUnmock("../../../src/webviews/react/commit-info/CommitInfoPane");
});

const setBranches = (): Record<string, unknown> => ({
    type: "setBranches",
    branches: [{ name: "main", hash: "a1", isRemote: false, isCurrent: true, ahead: 0, behind: 0 }],
    commitChecksEnabled: true,
});

describe("Find where CI broke: a menu opened on A in the card and undocked layouts", () => {
    it("card: a menu opened on A cannot start a bisect in B", async () => {
        const { createRoot } = await import("react-dom/client");
        const { CommitGraphPanel } = await import("../../../src/webviews/react/CommitGraphPanel");
        act(() => {
            createRoot(document.getElementById("root") as HTMLElement).render(
                <CommitGraphPanel
                    vscode={globalThis.acquireVsCodeApi() as never}
                    sendReady={false}
                />,
            );
        });
        await flush();
        dispatch(setBranches());
        const showIn = (repo: string): void =>
            dispatch({
                type: "setCommitDetail",
                detail: {
                    hash: SHOWN,
                    shortHash: SHOWN.slice(0, 7),
                    message: "Fix the build",
                    author: "Mahesh",
                    email: "m@example.com",
                    date: "2026-11-07T12:00:00.000Z",
                    parentHashes: [],
                    refs: [],
                    body: "",
                    files: [],
                },
                ciRepoKey: repo,
            });
        // The card's menu takes its repository from the page its rows came from.
        const pageIn = (repo: string): void =>
            dispatch({
                type: "loadCommits",
                commits: [],
                append: false,
                hasMore: false,
                unpushedHashes: [],
                repoKey: repo,
            });
        await clickAMenuAfterMovingToB(
            () => {
                showIn("/B");
                pageIn("/B");
            },
            () => {
                showIn("/A");
                pageIn("/A");
            },
        );
    });

    it("undocked: a menu opened on A cannot start a bisect in B", async () => {
        await import("../../../src/webviews/react/UndockedApp");
        await flush();
        dispatch(setBranches());
        const select = (repo: string): void =>
            dispatch({ type: "repositories", repositories: [], selectedRepositoryRoot: repo });
        await clickAMenuAfterMovingToB(
            () => select("/B"),
            () => select("/A"),
        );
    });
});
