// @vitest-environment jsdom

import React, { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChakraProvider } from "@chakra-ui/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Branch, CommitChecksSnapshot } from "../../../src/types";
import theme from "../../../src/webviews/react/commit-panel/theme";
import { renderHighlightedLabel } from "../../../src/webviews/react/branch-column/highlight";
import { BranchSearchBar } from "../../../src/webviews/react/branch-column/components/BranchSearchBar";
import { BranchSectionHeader } from "../../../src/webviews/react/branch-column/components/BranchSectionHeader";
import { BranchTreeNodeRow } from "../../../src/webviews/react/branch-column/components/BranchTreeNodeRow";
import {
    FolderIcon,
    GitBranchIcon,
    RepoIcon,
    StarIcon,
    TagIcon,
} from "../../../src/webviews/react/branch-column/icons";
import { CommitArea } from "../../../src/webviews/react/commit-panel/components/CommitArea";
import { FileTypeIcon } from "../../../src/webviews/react/commit-panel/components/FileTypeIcon";
import { FolderRow } from "../../../src/webviews/react/commit-panel/components/FolderRow";
import { IndentGuides } from "../../../src/webviews/react/commit-panel/components/IndentGuides";
import { SectionHeader } from "../../../src/webviews/react/commit-panel/components/SectionHeader";
import { StashRow } from "../../../src/webviews/react/commit-panel/components/StashRow";
import { StatusBadge } from "../../../src/webviews/react/commit-panel/components/StatusBadge";
import { TabBar } from "../../../src/webviews/react/commit-panel/components/TabBar";
import { Toolbar } from "../../../src/webviews/react/commit-panel/components/Toolbar";
import { VscCheckbox } from "../../../src/webviews/react/commit-panel/components/VscCheckbox";
import { CommitChecksButton } from "../../../src/webviews/react/commit-list/CommitChecksPopover";
import { mount, unmount } from "../../helpers/reactDomTestUtils";
import { installWebviewI18n } from "../../helpers/webviewI18nTestUtils";

/** Renders Chakra-wrapped UI into static markup for smoke assertions. */
function renderUi(node: React.ReactElement): string {
    return renderToStaticMarkup(<ChakraProvider theme={theme}>{node}</ChakraProvider>);
}

/** Builds a branch fixture with defaults shared by branch-column smoke tests. */
function branch(overrides: Partial<Branch> = {}): Branch {
    return {
        name: "main",
        hash: "abc1234",
        isRemote: false,
        isCurrent: false,
        ahead: 0,
        behind: 0,
        ...overrides,
    };
}

describe("webview ui smoke", () => {
    beforeEach(() => {
        installWebviewI18n();
    });

    it("uses VS Code theme tokens for commit panel surfaces", () => {
        const rootStyles = theme.styles.global[":root"] as Record<string, string>;

        expect(rootStyles["--intelligit-pycharm-panel"]).toContain("--vscode-sideBar-background");
        expect(rootStyles["--intelligit-pycharm-header"]).toContain(
            "--vscode-sideBarSectionHeader-background",
        );
        expect(rootStyles["--intelligit-pycharm-border"]).toContain("--vscode-sideBar-border");
        expect(rootStyles["--intelligit-pycharm-foreground"]).toContain("--vscode-foreground");
    });

    it("renders branch controls and icons", () => {
        const onChange = vi.fn();
        const onClear = vi.fn();
        const onToggle = vi.fn();

        const searchHtml = renderUi(
            <BranchSearchBar value="feature" onChange={onChange} onClear={onClear} />,
        );
        expect(searchHtml).toContain("Search branches");
        expect(searchHtml).toContain("Clear branch search");

        const mountedSection = mount(
            <BranchSectionHeader label="Local" expanded={true} onToggle={onToggle} />,
        );
        const sectionElement = mountedSection.container.querySelector(
            '[role="button"]',
        ) as HTMLElement;
        expect(sectionElement.getAttribute("aria-expanded")).toBe("true");
        act(() => {
            sectionElement.dispatchEvent(
                new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
            );
            sectionElement.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
        });
        expect(onToggle).toHaveBeenCalledTimes(2);
        unmount(mountedSection.root, mountedSection.container);

        const iconsHtml = renderUi(
            <>
                <GitBranchIcon />
                <TagIcon />
                <StarIcon />
                <FolderIcon />
                <RepoIcon />
            </>,
        );
        expect(iconsHtml).toContain("svg");
    });

    it("renders branch tree rows for folder and leaf nodes", () => {
        const onSelectBranch = vi.fn();
        const onToggleFolder = vi.fn();
        const onContextMenu = vi.fn();

        const folderNode = {
            label: "features",
            children: [
                {
                    label: "demo",
                    fullName: "features/demo",
                    branch: branch({ name: "features/demo" }),
                    children: [],
                },
            ],
        };
        const leafNode = {
            label: "feature",
            fullName: "feature",
            branch: branch({
                name: "feature",
                isCheckedOutInWorktree: true,
                isCurrentWorktree: false,
                worktreePath: "/repo-feature",
            }),
            children: [],
        };

        const folderHtml = renderUi(
            <BranchTreeNodeRow
                node={folderNode}
                depth={1}
                selectedBranch={null}
                expandedFolders={new Set(["root/features"])}
                onSelectBranch={onSelectBranch}
                onToggleFolder={onToggleFolder}
                onContextMenu={onContextMenu}
                filterNeedle="fea"
                prefix="root"
            />,
        );
        expect(folderHtml).toContain("<mark");
        const highlighted = renderToStaticMarkup(<>{renderHighlightedLabel("features", "fea")}</>);
        const plainText = highlighted.replace(/<[^>]*>/g, "");
        expect(plainText).toContain("features");
        expect(highlighted.toLowerCase()).toContain(">fea<");

        const leafHtml = renderUi(
            <BranchTreeNodeRow
                node={leafNode}
                depth={1}
                selectedBranch={"feature"}
                expandedFolders={new Set()}
                onSelectBranch={onSelectBranch}
                onToggleFolder={onToggleFolder}
                onContextMenu={onContextMenu}
                filterNeedle=""
                prefix="root"
            />,
        );
        expect(leafHtml).toContain("feature");
        expect(leafHtml).toContain("Checked out in another worktree");
    });

    it("renders commit panel primitives", () => {
        const html = renderUi(
            <>
                <StatusBadge status="M" />
                <StatusBadge status="?" />
                <FileTypeIcon />
                <FileTypeIcon status="D" />
                <FileTypeIcon icon={{ glyph: "\uea60", fontFamily: "codicon" }} />
                <IndentGuides treeDepth={2} />
                <VscCheckbox isChecked={true} onChange={vi.fn()} />
                <VscCheckbox isChecked={false} isIndeterminate={true} onChange={vi.fn()} />
            </>,
        );
        expect(html).toContain('data-tree-icon="file"');
        expect(html).toContain("\uea60");
        expect(html).toContain("svg");
    });

    it("opens GitHub commit checks popover on click and closes on outside pointer", () => {
        const onRequestChecks = vi.fn();
        const onOpenCheckUrl = vi.fn();
        const snapshot: CommitChecksSnapshot = {
            hash: "abc1234",
            state: "success",
            summary: "All checks passed",
            items: [
                {
                    name: "GitGuardian Security Checks",
                    description: "No secrets detected",
                    state: "success",
                    source: "status",
                    url: "https://example.test/security",
                },
                {
                    name: "Code Review Skipped",
                    description: "Review skipped",
                    state: "skipped",
                    source: "check-run",
                },
            ],
        };

        const mounted = mount(
            <CommitChecksButton
                hash="abc1234"
                checks={snapshot}
                onRequestChecks={onRequestChecks}
                onOpenCheckUrl={onOpenCheckUrl}
            />,
        );

        expect(document.body.textContent).not.toContain("Commit Checks");
        const trigger = mounted.container.querySelector("button") as HTMLButtonElement;
        const previousInnerHeight = window.innerHeight;
        Object.defineProperty(window, "innerHeight", { configurable: true, value: 320 });
        const rectSpy = vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
            bottom: 104,
            height: 24,
            left: 300,
            right: 324,
            top: 80,
            width: 24,
            x: 300,
            y: 80,
            toJSON: () => ({}),
        } as DOMRect);
        act(() => {
            trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
        });
        expect(document.body.textContent).not.toContain("Commit Checks");

        act(() => {
            trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });

        expect(document.body.textContent).toContain("Commit Checks");
        expect(document.body.textContent).toContain("GitGuardian Security Checks");
        expect(document.body.textContent).toContain("Code Review Skipped");
        expect(document.body.textContent).not.toContain("All checks passed");
        const panel = Array.from(document.body.querySelectorAll("div")).find(
            (node): node is HTMLDivElement =>
                node.style.position === "fixed" &&
                (node.textContent?.includes("Commit Checks") ?? false),
        );
        expect(panel?.style.transform).toBe("translateY(-100%)");
        expect(panel?.style.width).toBe("max-content");
        expect(Number.parseFloat(panel?.style.top ?? "0")).toBeGreaterThanOrEqual(312);
        const description = Array.from(document.querySelectorAll("span")).find(
            (node) => node.textContent === "No secrets detected",
        );
        expect(description?.style.overflowWrap).toBe("anywhere");

        const link = Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent === "GitGuardian Security Checks",
        );
        act(() => {
            link?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });

        expect(onRequestChecks).not.toHaveBeenCalled();
        expect(onOpenCheckUrl).toHaveBeenCalledWith("https://example.test/security");

        act(() => {
            document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
        });
        expect(document.body.textContent).not.toContain("Commit Checks");

        act(() => {
            trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        expect(document.body.textContent).toContain("Commit Checks");

        act(() => {
            window.dispatchEvent(new Event("blur"));
        });
        expect(document.body.textContent).not.toContain("Commit Checks");

        act(() => {
            trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        expect(document.body.textContent).toContain("Commit Checks");

        act(() => {
            trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        expect(document.body.textContent).not.toContain("Commit Checks");
        rectSpy.mockRestore();
        Object.defineProperty(window, "innerHeight", {
            configurable: true,
            value: previousInnerHeight,
        });
        unmount(mounted.root, mounted.container);

        const emptyMounted = mount(
            <CommitChecksButton
                hash="empty123"
                checks={{
                    hash: "empty123",
                    state: "none",
                    summary: "No checks found",
                    items: [],
                }}
                onRequestChecks={onRequestChecks}
                onOpenCheckUrl={onOpenCheckUrl}
            />,
        );
        expect(emptyMounted.container.querySelector("button")).toBeNull();
        unmount(emptyMounted.root, emptyMounted.container);

        const unavailableMounted = mount(
            <CommitChecksButton
                hash="unavailable123"
                checks={{
                    hash: "unavailable123",
                    state: "unavailable",
                    summary: "Checks unavailable",
                    items: [],
                    error: "Sign in to gitlab.example.com to view commit checks.",
                }}
                onRequestChecks={onRequestChecks}
                onOpenCheckUrl={onOpenCheckUrl}
            />,
        );
        expect(unavailableMounted.container.querySelector("button")).not.toBeNull();
        unmount(unavailableMounted.root, unavailableMounted.container);

        const pendingMounted = mount(
            <CommitChecksButton
                hash="pending123"
                onRequestChecks={onRequestChecks}
                onOpenCheckUrl={onOpenCheckUrl}
            />,
        );
        const pendingIcon = pendingMounted.container.querySelector("svg") as SVGElement;
        const spinnerAnimation = pendingIcon.querySelector("animateTransform");
        expect(spinnerAnimation?.getAttribute("type")).toBe("rotate");
        expect(spinnerAnimation?.getAttribute("repeatCount")).toBe("indefinite");
        unmount(pendingMounted.root, pendingMounted.container);
    });

    it("offers a host-targeted Sign in button only for a recoverable unavailable snapshot", () => {
        const onRequestChecks = vi.fn();
        const onOpenCheckUrl = vi.fn();
        const onSignIn = vi.fn();

        const openPanel = (container: HTMLElement): void => {
            const trigger = container.querySelector("button") as HTMLButtonElement;
            act(() => {
                trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            });
        };
        const signInButton = (): HTMLButtonElement | undefined =>
            Array.from(document.body.querySelectorAll("button")).find(
                (button) => button.textContent === "Sign in",
            );

        // 1) unavailable + signInHost -> Sign in button targets that exact host.
        const recoverable = mount(
            <CommitChecksButton
                hash="needauth1"
                checks={{
                    hash: "needauth1",
                    state: "unavailable",
                    summary: "Sign in required",
                    items: [],
                    error: "No token stored for gitlab.acme.com.",
                    signInHost: "gitlab.acme.com",
                }}
                onRequestChecks={onRequestChecks}
                onOpenCheckUrl={onOpenCheckUrl}
                onSignIn={onSignIn}
            />,
        );
        openPanel(recoverable.container);
        const button = signInButton();
        expect(button).toBeDefined();
        act(() => {
            button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        expect(onSignIn).toHaveBeenCalledWith("gitlab.acme.com");
        expect(onOpenCheckUrl).not.toHaveBeenCalled();
        unmount(recoverable.root, recoverable.container);

        // 2) unavailable WITHOUT signInHost (network error) -> no Sign in button.
        onSignIn.mockClear();
        const networkError = mount(
            <CommitChecksButton
                hash="neterr1"
                checks={{
                    hash: "neterr1",
                    state: "unavailable",
                    summary: "Checks unavailable",
                    items: [],
                    error: "Network request failed.",
                }}
                onRequestChecks={onRequestChecks}
                onOpenCheckUrl={onOpenCheckUrl}
                onSignIn={onSignIn}
            />,
        );
        openPanel(networkError.container);
        expect(signInButton()).toBeUndefined();
        unmount(networkError.root, networkError.container);

        // 3) terminal success (even if a stray signInHost leaks in) -> no Sign in button.
        const terminal = mount(
            <CommitChecksButton
                hash="ok1"
                checks={{
                    hash: "ok1",
                    state: "success",
                    summary: "All checks passed",
                    items: [],
                    signInHost: "gitlab.acme.com",
                }}
                onRequestChecks={onRequestChecks}
                onOpenCheckUrl={onOpenCheckUrl}
                onSignIn={onSignIn}
            />,
        );
        openPanel(terminal.container);
        expect(signInButton()).toBeUndefined();
        unmount(terminal.root, terminal.container);
    });

    it("renders section/folder/shelf/toolbar/tab and commit area layouts", () => {
        const noop = vi.fn();
        const stash = {
            index: 1,
            message: "On feature/test: save work",
            date: "2026-02-19T00:00:00Z",
            hash: "abc123",
        };

        const html = renderUi(
            <>
                <SectionHeader
                    label="Changes"
                    count={2}
                    isOpen={true}
                    isAllChecked={true}
                    isSomeChecked={false}
                    onToggleOpen={noop}
                    onToggleCheck={noop}
                />
                <FolderRow
                    name="src"
                    dirPath="src"
                    depth={1}
                    isExpanded={true}
                    fileCount={3}
                    isAllChecked={false}
                    isSomeChecked={true}
                    onToggleExpand={noop}
                    onToggleCheck={noop}
                />
                <StashRow stash={stash} onApply={noop} onPop={noop} onDrop={noop} />
                <Toolbar
                    onRefresh={noop}
                    onRollback={noop}
                    onToggleGroupBy={noop}
                    onShelve={noop}
                    onShowDiff={noop}
                    onExpandAll={noop}
                    onCollapseAll={noop}
                />
                <CommitArea
                    commitMessage="feat: message"
                    isAmend={false}
                    onMessageChange={noop}
                    onAmendChange={noop}
                    onCommit={noop}
                    onPush={noop}
                    canCommit={true}
                    canPush={true}
                    pushLabel="common.push"
                    currentBranchName="main"
                    currentBranchUpstream="origin/main"
                />
                <TabBar
                    stashCount={2}
                    commitContent={<div>Commit tab</div>}
                    shelfContent={<div>Shelf tab</div>}
                />
            </>,
        );

        expect(html).toContain("Changes");
        expect(html).toContain("Apply");
        expect(html).toContain("Refresh");
        expect(html).toContain("Branch: main -&gt; origin/main");
        expect(html).not.toContain("Commit and Push");
        const commitActionIndex = html.indexOf("Commit");
        const pushActionIndex = html.indexOf("Push");
        expect(commitActionIndex).toBeGreaterThanOrEqual(0);
        expect(pushActionIndex).toBeGreaterThanOrEqual(0);
        expect(commitActionIndex).toBeLessThan(pushActionIndex);
        expect(html).toContain("Stash (2)");

        const disabledCommitHtml = renderToStaticMarkup(
            <ChakraProvider theme={theme}>
                <CommitArea
                    commitMessage=""
                    isAmend={false}
                    onMessageChange={noop}
                    onAmendChange={noop}
                    onCommit={noop}
                    onPush={noop}
                    canCommit={false}
                    canPush={false}
                    pushLabel="common.push"
                    currentBranchName="main"
                    currentBranchUpstream="origin/main"
                />
            </ChakraProvider>,
        );
        expect(disabledCommitHtml).toContain("disabled");

        const localOnlyCommitHtml = renderUi(
            <CommitArea
                commitMessage=""
                isAmend={false}
                onMessageChange={noop}
                onAmendChange={noop}
                onCommit={noop}
                onPush={noop}
                canCommit={false}
                canPush={false}
                pushLabel="common.push"
                currentBranchName="main"
                currentBranchUpstream={null}
            />,
        );
        expect(localOnlyCommitHtml).toContain("Branch: main");

        const upstreamCommitHtml = renderUi(
            <CommitArea
                commitMessage=""
                isAmend={false}
                onMessageChange={noop}
                onAmendChange={noop}
                onCommit={noop}
                onPush={noop}
                canCommit={false}
                canPush={false}
                pushLabel="common.push"
                currentBranchName="master"
                currentBranchUpstream="origin/main"
            />,
        );
        expect(upstreamCommitHtml).toContain("Branch: master -&gt; origin/main");

        const refreshingToolbarHtml = renderUi(
            <Toolbar
                isRefreshing={true}
                onRefresh={noop}
                onRollback={noop}
                onToggleGroupBy={noop}
                onShelve={noop}
                onShowDiff={noop}
                onExpandAll={noop}
                onCollapseAll={noop}
            />,
        );
        expect(refreshingToolbarHtml).toContain('data-refreshing="true"');
        expect(refreshingToolbarHtml).toContain("intelligit-spin");
    });
});
