// @vitest-environment jsdom

import React, { act } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type CommitTabMockProps = {
    repositoryRoot: string;
    files: Array<{ path: string }>;
    commitMessage: string;
    isAmend: boolean;
    amendBranchCommits: Array<{ shortHash: string }>;
    amendBranchHistoryLoaded: boolean;
    onAmendChange: (isAmend: boolean) => void;
    onCommit: () => void;
};

type StashTabMockProps = {
    repositoryRoot: string;
};

type TabBarMockProps = {
    commitContent: React.ReactNode;
    stashContent: React.ReactNode;
    onSync?: () => void;
    onFetch?: () => void;
    onPull?: () => void;
    onPush?: () => void;
};

let postMessage: ReturnType<typeof vi.fn>;
let webviewState: Record<string, unknown>;

function setupRoot(): void {
    document.body.innerHTML = "";
    const root = document.createElement("div");
    root.id = "root";
    document.body.appendChild(root);
}

async function flush(): Promise<void> {
    await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
    });
}

function workingFile(path: string): {
    path: string;
    status: "M";
    staged: false;
    additions: number;
    deletions: number;
} {
    return { path, status: "M", staged: false, additions: 1, deletions: 0 };
}

function snapshot(root: string, label: string, path: string): object {
    return {
        type: "update",
        repositoryRoot: root,
        repositoryLabel: label,
        changedFileCount: 1,
        files: [workingFile(path)],
        stashes: [],
        stashFiles: [],
        selectedStashIndex: null,
        currentBranchHasUpstream: true,
        hasRemotes: true,
        currentBranchAhead: 0,
        currentBranchBehind: 0,
        currentBranchName: root.endsWith("a") ? "main" : "feature",
        currentBranchUpstream: root.endsWith("a") ? "origin/main" : "origin/feature",
    };
}

async function sendHostMessage(data: object): Promise<void> {
    act(() => {
        window.dispatchEvent(new MessageEvent("message", { data }));
    });
    await flush();
}

function row(root: string): HTMLElement {
    const element = document.querySelector<HTMLElement>(
        `[data-testid="repository-accordion"][data-repository-root="${root}"]`,
    );
    if (!element) throw new Error(`Missing repository row ${root}`);
    return element;
}

function header(root: string): HTMLElement {
    const element = row(root).querySelector<HTMLElement>(
        '[data-testid="repository-accordion-header"]',
    );
    if (!element) throw new Error(`Missing repository header ${root}`);
    return element;
}

function messageText(root: string): string {
    return (
        document.querySelector<HTMLElement>(`[data-testid="commit-message"][data-root="${root}"]`)
            ?.textContent ?? ""
    );
}

function click(element: Element | null): void {
    if (!element) throw new Error("Missing clickable element");
    act(() => {
        element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
}

async function renderApp(): Promise<void> {
    vi.doMock("../../../src/webviews/react/commit-panel/hooks/useVsCodeApi", () => ({
        getVsCodeApi: () => ({
            postMessage,
            getState: () => webviewState,
            setState: (state: Record<string, unknown>) => {
                webviewState = state;
            },
        }),
    }));
    vi.doMock("../../../src/webviews/react/commit-panel/components/CommitTab", () => ({
        CommitTab: (props: CommitTabMockProps) => (
            <div data-testid="commit-tab" data-root={props.repositoryRoot}>
                <span data-testid="commit-files" data-root={props.repositoryRoot}>
                    {props.files.map((file) => file.path).join(",")}
                </span>
                <span data-testid="commit-message" data-root={props.repositoryRoot}>
                    {props.commitMessage}
                </span>
                <span data-testid="amend-state" data-root={props.repositoryRoot}>
                    {`${props.isAmend}:${props.amendBranchCommits.length}:${props.amendBranchHistoryLoaded}`}
                </span>
                <button
                    data-testid="amend-toggle"
                    data-root={props.repositoryRoot}
                    onClick={() => props.onAmendChange(true)}
                />
                <button
                    data-testid="commit-action"
                    data-root={props.repositoryRoot}
                    onClick={props.onCommit}
                />
            </div>
        ),
    }));
    vi.doMock("../../../src/webviews/react/commit-panel/components/StashTab", () => ({
        StashTab: (props: StashTabMockProps) => (
            <div data-testid="stash-tab" data-root={props.repositoryRoot}>
                stash
            </div>
        ),
    }));
    vi.doMock("../../../src/webviews/react/commit-panel/components/TabBar", () => ({
        TabBar: (props: TabBarMockProps) => (
            <div data-testid="tabbar">
                <div data-testid="tabbar-actions">
                    <button aria-label="common.sync" onClick={props.onSync} />
                    <button aria-label="common.fetch" onClick={props.onFetch} />
                    <button aria-label="common.pull" onClick={props.onPull} />
                    <button aria-label="common.push" onClick={props.onPush} />
                </div>
                <div>{props.commitContent}</div>
                <div>{props.stashContent}</div>
            </div>
        ),
    }));

    await act(async () => {
        await import("../../../src/webviews/react/commit-panel/CommitPanelApp");
        await Promise.resolve();
    });
    await flush();
}

async function hydrateTwoRepositories(): Promise<void> {
    await sendHostMessage({
        type: "setRepositories",
        repositories: [
            { root: "/repo-a", label: "Repo A", changedFileCount: 1 },
            { root: "/repo-b", label: "Repo B", changedFileCount: 1 },
        ],
        activeRepositoryRoot: "/repo-a",
    });
    await sendHostMessage(snapshot("/repo-a", "Repo A", "src/a.ts"));
    await sendHostMessage(snapshot("/repo-b", "Repo B", "src/b.ts"));
}

async function hydrateOneRepository(): Promise<void> {
    await sendHostMessage({
        type: "setRepositories",
        repositories: [{ root: "/repo-a", label: "Repo A", changedFileCount: 1 }],
        activeRepositoryRoot: "/repo-a",
    });
    await sendHostMessage(snapshot("/repo-a", "Repo A", "src/a.ts"));
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
    postMessage = vi.fn();
    webviewState = {};
});

describe("commit panel multi-repository view", () => {
    it("preserves repository checked paths until files hydrate", async () => {
        vi.doMock("../../../src/webviews/react/commit-panel/hooks/useVsCodeApi", () => ({
            getVsCodeApi: () => ({
                postMessage,
                getState: () => webviewState,
                setState: (state: Record<string, unknown>) => {
                    webviewState = state;
                },
            }),
        }));
        const { createRoot } = await import("react-dom/client");
        const { useCheckedFiles } = await import(
            "../../../src/webviews/react/commit-panel/hooks/useCheckedFiles"
        );
        const host = document.createElement("div");
        document.body.appendChild(host);
        const root = createRoot(host);
        const snapshots: string[][] = [];
        webviewState = { checkedByRepository: { "/repo-a": ["src/a.ts"] } };

        function Harness({ files }: { files: ReturnType<typeof workingFile>[] }): null {
            const { checkedPaths } = useCheckedFiles(files, "/repo-a");
            React.useEffect(() => {
                snapshots.push(Array.from(checkedPaths));
            }, [checkedPaths]);
            return null;
        }

        try {
            await act(async () => {
                root.render(<Harness files={[]} />);
            });
            await flush();

            expect(webviewState).toEqual({ checkedByRepository: { "/repo-a": ["src/a.ts"] } });

            await act(async () => {
                root.render(<Harness files={[workingFile("src/a.ts")]} />);
            });
            await flush();

            expect(snapshots.at(-1)).toEqual(["src/a.ts"]);
            expect(webviewState).toEqual({ checkedByRepository: { "/repo-a": ["src/a.ts"] } });
        } finally {
            act(() => {
                root.unmount();
            });
            host.remove();
        }
    });

    it("keeps a single repository on the direct tab layout", async () => {
        await renderApp();
        await hydrateOneRepository();

        expect(document.querySelectorAll('[data-testid="repository-accordion"]')).toHaveLength(0);
        expect(document.querySelector('[data-testid="tabbar"]')).toBeTruthy();
        expect(
            document.querySelector('[data-testid="commit-files"][data-root="/repo-a"]')
                ?.textContent,
        ).toBe("src/a.ts");
    });

    it("renders two repository snapshots as two rows", async () => {
        await renderApp();
        await hydrateTwoRepositories();

        expect(document.querySelectorAll('[data-testid="repository-accordion"]')).toHaveLength(2);
        expect(row("/repo-a").textContent).toContain("Repo A");
        expect(row("/repo-b").textContent).toContain("Repo B");
    });

    it("updates repository B without overwriting repository A", async () => {
        await renderApp();
        await hydrateTwoRepositories();
        click(header("/repo-b"));
        await flush();

        await sendHostMessage(snapshot("/repo-b", "Repo B", "src/b2.ts"));

        expect(row("/repo-a").textContent).toContain("src/a.ts");
        expect(row("/repo-b").textContent).toContain("src/b2.ts");
        expect(row("/repo-b").textContent).not.toContain("src/a.ts");
    });

    it("committed preserves the matching repository draft and resets its amend state", async () => {
        await renderApp();
        await hydrateTwoRepositories();
        click(header("/repo-b"));
        await sendHostMessage({
            type: "restoreCommitDraft",
            repositoryRoot: "/repo-a",
            message: "draft A",
        });
        await sendHostMessage({
            type: "restoreCommitDraft",
            repositoryRoot: "/repo-b",
            message: "draft B",
        });
        click(document.querySelector('[data-testid="amend-toggle"][data-root="/repo-b"]'));
        await flush();
        await sendHostMessage({
            type: "amendBranchCommits",
            repositoryRoot: "/repo-b",
            commits: [
                {
                    shortHash: "deadbee",
                    subject: "feat: amend",
                    date: "2026-07-23T00:00:00Z",
                },
            ],
        });
        expect(
            document.querySelector('[data-testid="amend-state"][data-root="/repo-b"]')?.textContent,
        ).toBe("true:1:true");

        await sendHostMessage({ type: "committed", repositoryRoot: "/repo-b" });

        expect(messageText("/repo-a")).toBe("draft A");
        expect(messageText("/repo-b")).toBe("draft B");
        expect(
            document.querySelector('[data-testid="amend-state"][data-root="/repo-b"]')?.textContent,
        ).toBe("false:0:false");
    });

    it("draft restore updates only the matching repository", async () => {
        await renderApp();
        await hydrateTwoRepositories();
        click(header("/repo-b"));

        await sendHostMessage({
            type: "restoreCommitDraft",
            repositoryRoot: "/repo-b",
            message: "draft B",
        });

        expect(messageText("/repo-a")).toBe("");
        expect(messageText("/repo-b")).toBe("draft B");
    });

    it("expanding and collapsing posts setExpandedRepositories", async () => {
        await renderApp();
        await hydrateTwoRepositories();
        postMessage.mockClear();

        click(header("/repo-a"));
        await flush();
        expect(postMessage).toHaveBeenCalledWith({
            type: "setExpandedRepositories",
            repositoryRoots: [],
        });
        expect(row("/repo-a").textContent).not.toContain("src/a.ts");

        await sendHostMessage({
            type: "setRepositories",
            repositories: [
                { root: "/repo-a", label: "Repo A", changedFileCount: 1 },
                { root: "/repo-b", label: "Repo B", changedFileCount: 1 },
            ],
            activeRepositoryRoot: "/repo-a",
        });
        expect(row("/repo-a").textContent).not.toContain("src/a.ts");
        await sendHostMessage(snapshot("/repo-a", "Repo A", "src/a2.ts"));
        expect(row("/repo-a").textContent).not.toContain("src/a2.ts");

        click(header("/repo-b"));
        await flush();
        expect(postMessage).toHaveBeenCalledWith({
            type: "setExpandedRepositories",
            repositoryRoots: ["/repo-b"],
        });
    });

    it("row actions include repositoryRoot", async () => {
        await renderApp();
        await hydrateTwoRepositories();
        click(header("/repo-b"));
        await sendHostMessage({
            type: "restoreCommitDraft",
            repositoryRoot: "/repo-b",
            message: "feat: b",
        });
        postMessage.mockClear();

        expect(row("/repo-b").querySelector('[data-testid="repository-action-toolbar"]')).toBeNull();
        click(row("/repo-b").querySelector('[aria-label="common.fetch"]'));
        click(row("/repo-b").querySelector('[data-testid="commit-action"][data-root="/repo-b"]'));

        expect(postMessage).toHaveBeenCalledWith({ type: "fetch", repositoryRoot: "/repo-b" });
        expect(postMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                type: "commitSelected",
                repositoryRoot: "/repo-b",
                message: "feat: b",
            }),
        );
    });
});
