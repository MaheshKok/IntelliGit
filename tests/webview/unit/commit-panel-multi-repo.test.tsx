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

type ShelfTabMockProps = {
    shelves: Array<{ id: string }>;
    selectedShelfId: string | null;
    outcome?: { status: string; entries: Array<{ kind: string }> };
};

type TabBarMockProps = {
    commitContent: React.ReactNode;
    stashContent: React.ReactNode;
    shelfContent?: React.ReactNode;
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
        shelves: [
            {
                id: `shelf-${root.endsWith("a") ? "a" : "b"}`,
                generation: 1,
                files: [],
                metadata: { name: `Shelf ${label}`, lifecycle: "shelved" },
            },
        ],
        catalogGeneration: root.endsWith("a") ? 3 : 4,
        selectedShelfId: `shelf-${root.endsWith("a") ? "a" : "b"}`,
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
    vi.doMock("../../../src/webviews/react/commit-panel/components/ShelfTab", () => ({
        ShelfTab: (props: ShelfTabMockProps) => (
            <div data-testid="shelf-tab" data-shelf-id={props.selectedShelfId}>
                {props.shelves.map((shelf) => shelf.id).join(",")}
                {props.outcome
                    ? ` ${props.outcome.status}:${props.outcome.entries.map((entry) => entry.kind).join(",")}`
                    : ""}
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
                <div>{props.shelfContent}</div>
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
            { root: "/repo-a", label: "Repo A", kind: "repository", changedFileCount: 1 },
            { root: "/repo-b", label: "Repo B", kind: "worktree", changedFileCount: 1 },
        ],
        activeRepositoryRoot: "/repo-a",
    });
    await sendHostMessage(snapshot("/repo-a", "Repo A", "src/a.ts"));
    await sendHostMessage(snapshot("/repo-b", "Repo B", "src/b.ts"));
}

async function hydrateOneRepository(): Promise<void> {
    await sendHostMessage({
        type: "setRepositories",
        repositories: [
            { root: "/repo-a", label: "Repo A", kind: "repository", changedFileCount: 1 },
        ],
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
        const { useCheckedFiles } =
            await import("../../../src/webviews/react/commit-panel/hooks/useCheckedFiles");
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
        expect(
            document.querySelectorAll('[data-testid="repository-accordion-content"]'),
        ).toHaveLength(0);
        expect(
            document.querySelectorAll('[data-testid="repository-accordion-guide"]'),
        ).toHaveLength(0);
        expect(document.querySelectorAll('[data-testid="repository-kind-icon"]')).toHaveLength(0);
        expect(document.querySelector('[data-testid="tabbar"]')).toBeTruthy();
        expect(
            document.querySelector('[data-testid="commit-files"][data-root="/repo-a"]')
                ?.textContent,
        ).toBe("src/a.ts");
    });

    it("keeps expanded tab content owned by each repository", async () => {
        await renderApp();
        await hydrateTwoRepositories();
        click(header("/repo-b"));
        await flush();

        const contents = Array.from(
            document.querySelectorAll<HTMLElement>('[data-testid="repository-accordion-content"]'),
        );
        expect(contents).toHaveLength(2);

        for (const root of ["/repo-a", "/repo-b"]) {
            const content = document.querySelector<HTMLElement>(
                `[data-testid="repository-accordion-content"][data-repository-root="${root}"]`,
            );
            expect(content).not.toBeNull();
            expect(content?.querySelectorAll('[data-testid="tabbar"]')).toHaveLength(1);
            expect(row(root).querySelector('[data-testid="repository-accordion-content"]')).toBe(
                content,
            );
            const guide = row(root).querySelector<HTMLElement>(
                '[data-testid="repository-accordion-guide"]',
            );
            expect(guide).not.toBeNull();
            expect(window.getComputedStyle(guide as HTMLElement).left).toBe("17px");
        }
    });

    it("tolerates a legacy snapshot without the additive shelf fields", async () => {
        await renderApp();
        await sendHostMessage({
            type: "setRepositories",
            repositories: [{ root: "/repo-a", label: "Repo A", changedFileCount: 1 }],
            activeRepositoryRoot: "/repo-a",
        });
        const legacySnapshot = snapshot("/repo-a", "Repo A", "src/a.ts") as Record<string, unknown>;
        delete legacySnapshot.shelves;
        delete legacySnapshot.catalogGeneration;
        delete legacySnapshot.selectedShelfId;
        await sendHostMessage(legacySnapshot);

        expect(document.querySelector('[data-testid="shelf-tab"]')?.textContent).toBe("");
    });

    it("renders two repository snapshots as two rows", async () => {
        await renderApp();
        await hydrateTwoRepositories();

        expect(document.querySelectorAll('[data-testid="repository-accordion"]')).toHaveLength(2);
        expect(row("/repo-a").textContent).toContain("Repo A");
        expect(row("/repo-b").textContent).toContain("Repo B");
    });

    it("renders a worktree's short name before its local branch", async () => {
        await renderApp();
        await sendHostMessage({
            type: "setRepositories",
            repositories: [
                { root: "/repo-a", label: "Repo A", kind: "repository", changedFileCount: 1 },
                {
                    root: "/repo-b",
                    label: ".claude/worktrees/dry-components",
                    kind: "worktree",
                    changedFileCount: 1,
                },
            ],
            activeRepositoryRoot: "/repo-a",
        });
        await sendHostMessage(snapshot("/repo-a", "Repo A", "src/a.ts"));
        const worktreeSnapshot = snapshot(
            "/repo-b",
            ".claude/worktrees/dry-components",
            "src/b.ts",
        ) as Record<string, unknown>;
        worktreeSnapshot.currentBranchAhead = 1;
        worktreeSnapshot.currentBranchBehind = 1;
        await sendHostMessage(worktreeSnapshot);

        const text = header("/repo-b").textContent ?? "";
        expect(text).toContain("dry-components");
        expect(text).not.toContain(".claude/worktrees/dry-components");
        expect(text.indexOf("dry-components")).toBeLessThan(text.indexOf("feature"));
        expect(text).not.toContain("origin/feature");
        expect(text).not.toContain("↑1");
        expect(text).not.toContain("↓1");
    });

    it("renders each native repository kind icon immediately after its chevron", async () => {
        await renderApp();
        await hydrateTwoRepositories();

        const repositoryIcon = header("/repo-a").querySelector<HTMLElement>(
            '[data-testid="repository-kind-icon"]',
        );
        const worktreeIcon = header("/repo-b").querySelector<HTMLElement>(
            '[data-testid="repository-kind-icon"]',
        );

        expect(repositoryIcon).not.toBeNull();
        expect(repositoryIcon?.getAttribute("data-repository-kind")).toBe("repository");
        expect(repositoryIcon?.previousElementSibling?.querySelector("svg")).not.toBeNull();
        expect(repositoryIcon?.querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 16 16");
        expect(worktreeIcon).not.toBeNull();
        expect(worktreeIcon?.getAttribute("data-repository-kind")).toBe("worktree");
        expect(worktreeIcon?.previousElementSibling?.querySelector("svg")).not.toBeNull();
        expect(worktreeIcon?.querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 10 10");
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
        expect(
            row("/repo-b")
                .querySelector('[data-testid="repository-kind-icon"]')
                ?.getAttribute("data-repository-kind"),
        ).toBe("worktree");
    });

    it("committed clears the matching repository draft by default and retains it when disabled", async () => {
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
        expect(messageText("/repo-b")).toBe("");
        expect(
            document.querySelector('[data-testid="amend-state"][data-root="/repo-b"]')?.textContent,
        ).toBe("false:0:false");

        await sendHostMessage({
            type: "restoreCommitDraft",
            repositoryRoot: "/repo-b",
            message: "draft B",
        });
        await sendHostMessage({
            type: "committed",
            repositoryRoot: "/repo-b",
            clearCommitMessage: false,
        });

        expect(messageText("/repo-a")).toBe("draft A");
        expect(messageText("/repo-b")).toBe("draft B");
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

    it("keeps shelf snapshots and mutation outcomes scoped to their repository reducer state", async () => {
        await renderApp();
        await hydrateTwoRepositories();
        click(header("/repo-b"));
        await sendHostMessage({
            type: "shelfMutationCompleted",
            repositoryRoot: "/repo-b",
            requestId: "shelf-result-b",
            status: "conflicts",
            entries: [{ kind: "conflicted", changeId: "change-b" }],
        });

        const shelfA = document.querySelector('[data-shelf-id="shelf-a"]') as HTMLElement;
        const shelfB = document.querySelector('[data-shelf-id="shelf-b"]') as HTMLElement;
        expect(shelfA.textContent).toContain("shelf-a");
        expect(shelfA.textContent).not.toContain("conflicts");
        expect(shelfB.textContent).toContain("conflicts:conflicted");
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
                { root: "/repo-a", label: "Repo A", kind: "repository", changedFileCount: 1 },
                { root: "/repo-b", label: "Repo B", kind: "worktree", changedFileCount: 1 },
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

        expect(
            row("/repo-b").querySelector('[data-testid="repository-action-toolbar"]'),
        ).toBeNull();
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
