// @vitest-environment jsdom

import React, { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChakraProvider } from "@chakra-ui/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Branch, CommitChecksSnapshot, WorkingFile } from "../../../src/types";
import theme from "../../../src/webviews/react/commit-panel/theme";
import { renderHighlightedLabel } from "../../../src/webviews/react/branch-column/highlight";
import { BranchColumnSections } from "../../../src/webviews/react/branch-column/BranchColumnSections";
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
import { FileTree } from "../../../src/webviews/react/commit-panel/components/FileTree";
import { TabBar } from "../../../src/webviews/react/commit-panel/components/TabBar";
import { Toolbar } from "../../../src/webviews/react/commit-panel/components/Toolbar";
import { SectionHeader } from "../../../src/webviews/react/shared/components/SectionHeader";
import {
    FileTreeRows,
    TreeFileRow,
    TreeFolderRow,
    TreeIndentGuides,
} from "../../../src/webviews/react/shared/components/FileTreeRows";
import { VscCheckbox } from "../../../src/webviews/react/shared/components/VscCheckbox";
import { CommitChecksButton } from "../../../src/webviews/react/commit-list/CommitChecksPopover";
import { StatusBadge } from "../../../src/webviews/react/shared/components/StatusBadge";
import { TreeFileIcon } from "../../../src/webviews/react/shared/components/TreeIcons";
import { buildFileTree } from "../../../src/webviews/react/shared/fileTree";
import { initReactDomTestEnvironment, mount, unmount } from "../../helpers/reactDomTestUtils";
import { installWebviewI18n } from "../../helpers/webviewI18nTestUtils";

initReactDomTestEnvironment();

/** Renders Chakra-wrapped UI into static markup for smoke assertions. */
function renderUi(node: React.ReactElement): string {
    return renderToStaticMarkup(<ChakraProvider theme={theme}>{node}</ChakraProvider>);
}

function getButtonByText(html: string, text: string): HTMLButtonElement {
    const container = document.createElement("div");
    container.innerHTML = html;
    const button = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent === text,
    );
    expect(button).toBeDefined();
    return button as HTMLButtonElement;
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
            "button[aria-expanded]",
        ) as HTMLButtonElement;
        expect(sectionElement.getAttribute("aria-expanded")).toBe("true");
        act(() => {
            sectionElement.click();
            sectionElement.click();
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
        expect(leafHtml).not.toContain("Checked out in another worktree");
    });

    it("aligns nested branch tree guides to the chevron center", () => {
        const html = renderUi(
            <BranchTreeNodeRow
                node={{
                    label: "nested",
                    fullName: "nested",
                    branch: branch({ name: "nested" }),
                    children: [],
                }}
                depth={2}
                selectedBranch={null}
                expandedFolders={new Set()}
                onSelectBranch={vi.fn()}
                onToggleFolder={vi.fn()}
                onContextMenu={vi.fn()}
                filterNeedle=""
                prefix="root"
            />,
        );
        const container = document.createElement("div");
        container.innerHTML = html;

        expect(
            Array.from(container.querySelectorAll<HTMLElement>('[aria-hidden="true"]'))
                .map((guide) => guide.style.left)
                .filter(Boolean),
        ).toEqual(["26px", "40px"]);
    });

    it("aligns local and remote branch tree guides with their ancestor chevrons", () => {
        const localRoot = {
            label: "local-root",
            children: [
                {
                    label: "local-child",
                    fullName: "local-root/local-child",
                    branch: branch({ name: "local-root/local-child" }),
                    children: [],
                },
            ],
        };
        const remoteRoot = {
            label: "remote-root",
            children: [
                {
                    label: "remote-folder",
                    children: [
                        {
                            label: "remote-child",
                            fullName: "origin/remote-root/remote-folder/remote-child",
                            branch: branch({
                                name: "origin/remote-root/remote-folder/remote-child",
                            }),
                            children: [],
                        },
                    ],
                },
            ],
        };
        const html = renderUi(
            <BranchColumnSections
                selectedBranch={null}
                expandedSections={new Set(["local", "remote"])}
                expandedFolders={
                    new Set([
                        "local/local-root",
                        "remote-origin",
                        "remote/origin/remote-root",
                        "remote/origin/remote-root/remote-folder",
                    ])
                }
                localTree={[localRoot]}
                remoteGroups={new Map([["origin", { branches: [], tree: [remoteRoot] }]])}
                worktrees={[]}
                filteredWorktrees={[]}
                filterNeedle=""
                locals={[]}
                remotes={[]}
                selectedBranchNames={new Set()}
                onSelectBranch={vi.fn()}
                onClearSelectedBranches={vi.fn()}
                onToggleSection={vi.fn()}
                onToggleFolder={vi.fn()}
                onBranchClick={vi.fn()}
                onBranchContextMenu={vi.fn()}
                onOpenBranchContextMenuFromRow={vi.fn()}
                onWorktreeContextMenu={vi.fn()}
                onOpenWorktreeContextMenuFromRow={vi.fn()}
            />,
        );
        const container = document.createElement("div");
        container.innerHTML = html;
        const buttonByText = (text: string): HTMLButtonElement => {
            const button = Array.from(container.querySelectorAll("button")).find(
                (candidate) => candidate.textContent === text,
            );
            expect(button).toBeDefined();
            return button as HTMLButtonElement;
        };
        const guideOffsets = (button: HTMLButtonElement): string[] =>
            Array.from(button.children)
                .filter(
                    (child): child is HTMLSpanElement =>
                        child instanceof HTMLSpanElement &&
                        child.getAttribute("aria-hidden") === "true",
                )
                .map((guide) => guide.style.left);
        const pixelStyle = (element: HTMLElement, property: string): number => {
            const match = new RegExp(`${property}:([0-9]+)px`).exec(
                element.getAttribute("style") ?? "",
            );
            if (!match) throw new Error(`Missing ${property} pixel style`);
            return Number(match[1]);
        };

        const localRootButton = buttonByText("local-root");
        const localChildButton = buttonByText("local-child");
        const localTreeWrapper = localRootButton.parentElement as HTMLDivElement;
        const localSectionGuide = container.querySelector(
            '[data-branch-section-guide="local"]',
        ) as HTMLSpanElement;
        expect(localSectionGuide.style.left).toBe("16px");
        expect(localSectionGuide.style.pointerEvents).toBe("none");
        expect(localSectionGuide.getAttribute("aria-hidden")).toBe("true");
        expect(pixelStyle(localRootButton, "padding-left")).toBe(18);
        expect(guideOffsets(localRootButton)).toEqual([]);
        expect(guideOffsets(localChildButton)).toEqual(["26px"]);
        expect(
            pixelStyle(localTreeWrapper, "padding-left") +
                pixelStyle(localRootButton, "padding-left") +
                8,
        ).toBe(
            pixelStyle(localTreeWrapper, "padding-left") +
                Number.parseInt(guideOffsets(localChildButton)[0]!, 10),
        );

        const remoteProviderButton = buttonByText("origin");
        const remoteRootButton = buttonByText("remote-root");
        const remoteFolderButton = buttonByText("remote-folder");
        const remoteProviderIndent = remoteProviderButton.parentElement as HTMLDivElement;
        const remoteTreeWrapper = remoteRootButton.parentElement as HTMLDivElement;
        const remoteSectionGuide = container.querySelector(
            '[data-branch-section-guide="remote-origin"]',
        ) as HTMLSpanElement;
        expect(remoteSectionGuide.style.left).toBe("16px");
        expect(remoteSectionGuide.style.pointerEvents).toBe("none");
        expect(remoteSectionGuide.getAttribute("aria-hidden")).toBe("true");
        expect(pixelStyle(remoteProviderIndent, "padding-left")).toBe(14);
        expect(remoteProviderIndent.parentElement?.getAttribute("style") ?? "").not.toContain(
            "padding-left:4px",
        );
        expect(pixelStyle(remoteTreeWrapper, "padding-left")).toBe(4);
        expect(pixelStyle(remoteRootButton, "padding-left")).toBe(32);
        expect(guideOffsets(remoteRootButton)).toEqual(["26px"]);
        expect(guideOffsets(remoteFolderButton)).toEqual(["26px", "40px"]);
        expect(
            pixelStyle(remoteProviderIndent, "padding-left") +
                pixelStyle(remoteProviderButton, "padding-left") +
                8,
        ).toBe(
            pixelStyle(remoteTreeWrapper, "padding-left") +
                Number.parseInt(guideOffsets(remoteRootButton)[0]!, 10),
        );
    });

    it("hides outer branch rails for collapsed or empty sections", () => {
        const renderSections = (
            expandedSections: Set<string>,
            localTree: React.ComponentProps<typeof BranchColumnSections>["localTree"],
            remoteTree: React.ComponentProps<typeof BranchColumnSections>["localTree"],
        ): HTMLElement => {
            const container = document.createElement("div");
            container.innerHTML = renderUi(
                <BranchColumnSections
                    selectedBranch={null}
                    expandedSections={expandedSections}
                    expandedFolders={new Set(["remote-origin"])}
                    localTree={localTree}
                    remoteGroups={new Map([["origin", { branches: [], tree: remoteTree }]])}
                    worktrees={[]}
                    filteredWorktrees={[]}
                    filterNeedle=""
                    locals={[]}
                    remotes={[]}
                    selectedBranchNames={new Set()}
                    onSelectBranch={vi.fn()}
                    onClearSelectedBranches={vi.fn()}
                    onToggleSection={vi.fn()}
                    onToggleFolder={vi.fn()}
                    onBranchClick={vi.fn()}
                    onBranchContextMenu={vi.fn()}
                    onOpenBranchContextMenuFromRow={vi.fn()}
                    onWorktreeContextMenu={vi.fn()}
                    onOpenWorktreeContextMenuFromRow={vi.fn()}
                />,
            );
            return container;
        };
        const leaf = {
            label: "leaf",
            fullName: "leaf",
            branch: branch({ name: "leaf" }),
            children: [],
        };

        expect(
            renderSections(new Set(), [leaf], [leaf]).querySelectorAll(
                "[data-branch-section-guide]",
            ),
        ).toHaveLength(0);
        expect(
            renderSections(new Set(["local", "remote"]), [], []).querySelectorAll(
                "[data-branch-section-guide]",
            ),
        ).toHaveLength(0);
    });

    it("renders commit panel primitives", () => {
        const html = renderUi(
            <>
                <StatusBadge status="M" />
                <StatusBadge status="?" />
                <TreeFileIcon />
                <TreeFileIcon status="D" />
                <TreeFileIcon icon={{ glyph: "\uea60", fontFamily: "codicon" }} />
                <TreeIndentGuides
                    treeDepth={2}
                    indentMetrics={{
                        indentStep: 18,
                        indentBase: 20,
                        guideBase: 28,
                        sectionGuideLeft: 17,
                    }}
                />
                <VscCheckbox isChecked={true} onChange={vi.fn()} />
                <VscCheckbox isChecked={false} isIndeterminate={true} onChange={vi.fn()} />
            </>,
        );
        expect(html).toContain('data-tree-icon="file"');
        expect(html).toContain("\uea60");
        expect(html).toContain("svg");
    });

    it("makes commit-panel section headers keyboard-operable without toggling from their checkbox", () => {
        const onToggleOpen = vi.fn();
        const checkboxToggle = vi.fn();
        const mounted = mount(
            <ChakraProvider theme={theme}>
                <SectionHeader
                    label="Changes"
                    isOpen={true}
                    onToggleOpen={onToggleOpen}
                    checkbox={{
                        isAllChecked: false,
                        isSomeChecked: false,
                        onToggle: checkboxToggle,
                    }}
                />
            </ChakraProvider>,
        );
        const header = mounted.container.querySelector('[role="button"]') as HTMLElement;
        const input = header.querySelector("input") as HTMLInputElement;

        expect(header.tabIndex).toBe(0);
        expect(header.getAttribute("aria-expanded")).toBe("true");
        act(() => header.click());
        act(() =>
            header.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
        );
        const space = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
        act(() => header.dispatchEvent(space));
        expect(space.defaultPrevented).toBe(true);
        expect(onToggleOpen).toHaveBeenCalledTimes(3);

        act(() => input.click());
        act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true })));
        expect(onToggleOpen).toHaveBeenCalledTimes(3);
        expect(checkboxToggle).toHaveBeenCalledOnce();
        unmount(mounted.root, mounted.container);

        const closed = mount(
            <ChakraProvider theme={theme}>
                <SectionHeader label="Changes" isOpen={false} onToggleOpen={vi.fn()} />
            </ChakraProvider>,
        );
        expect(
            closed.container.querySelector('[role="button"]')?.getAttribute("aria-expanded"),
        ).toBe("false");
        unmount(closed.root, closed.container);
    });

    it("mirrors checkbox focus on the visual shell while preserving native input behavior", () => {
        const onChange = vi.fn();
        const mounted = mount(
            <VscCheckbox
                isChecked={true}
                isIndeterminate={true}
                onChange={onChange}
                ariaLabel="Changes"
            />,
        );
        const input = mounted.container.querySelector("input") as HTMLInputElement;
        const shell = input.nextElementSibling as HTMLElement;

        expect(input.checked).toBe(true);
        expect(input.indeterminate).toBe(true);
        expect(shell.getAttribute("data-focused")).toBeNull();
        act(() => input.focus());
        expect(shell.getAttribute("data-focused")).toBe("true");
        expect(shell.style.outline).toContain("solid");
        act(() => input.blur());
        expect(shell.getAttribute("data-focused")).toBeNull();
        expect(shell.style.outline).toBe("");
        act(() => input.click());
        expect(onChange).toHaveBeenCalledOnce();
        unmount(mounted.root, mounted.container);
    });

    it("does not invoke disabled checkbox changes", () => {
        const onChange = vi.fn();
        const mounted = mount(
            <VscCheckbox isChecked={false} onChange={onChange} disabled={true} ariaLabel="Amend" />,
        );
        const input = mounted.container.querySelector("input") as HTMLInputElement;

        expect(input.disabled).toBe(true);
        act(() => input.click());
        expect(onChange).not.toHaveBeenCalled();
        unmount(mounted.root, mounted.container);
    });

    it("uses commit history and checked paths to gate amend and idle generation", () => {
        const onGenerate = vi.fn();
        const noop = vi.fn();
        const detached = mount(
            <ChakraProvider theme={theme}>
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
                    currentBranchName={null}
                    currentBranchUpstream={null}
                    hasCommits={true}
                    hasCheckedPaths={true}
                    onGenerateMessage={onGenerate}
                />
            </ChakraProvider>,
        );
        const detachedAmend = detached.container.querySelector(
            '[data-testid="amend-checkbox"]',
        ) as HTMLInputElement;
        const generate = detached.container.querySelector(
            'button[aria-label="Generate commit message"]',
        ) as HTMLButtonElement;

        expect(detachedAmend.disabled).toBe(false);
        expect(generate.disabled).toBe(false);
        act(() => generate.click());
        expect(onGenerate).toHaveBeenCalledOnce();
        unmount(detached.root, detached.container);

        const noPaths = mount(
            <ChakraProvider theme={theme}>
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
                    hasCommits={true}
                    hasCheckedPaths={false}
                    wholeIndexOperationInProgress={false}
                />
            </ChakraProvider>,
        );
        const noPathsGenerate = noPaths.container.querySelector(
            'button[aria-label="Generate commit message"]',
        ) as HTMLButtonElement;

        expect(noPathsGenerate.disabled).toBe(true);
        unmount(noPaths.root, noPaths.container);

        const zeroPathAmend = mount(
            <ChakraProvider theme={theme}>
                <CommitArea
                    commitMessage="feat: message"
                    isAmend={true}
                    onMessageChange={noop}
                    onAmendChange={noop}
                    onCommit={noop}
                    onPush={noop}
                    canCommit={true}
                    canPush={true}
                    pushLabel="common.push"
                    currentBranchName="main"
                    currentBranchUpstream="origin/main"
                    hasCommits={true}
                    hasCheckedPaths={false}
                    wholeIndexOperationInProgress={false}
                />
            </ChakraProvider>,
        );
        const zeroPathAmendGenerate = zeroPathAmend.container.querySelector(
            'button[aria-label="Generate commit message"]',
        ) as HTMLButtonElement;

        expect(zeroPathAmendGenerate.disabled).toBe(false);
        unmount(zeroPathAmend.root, zeroPathAmend.container);

        const wholeIndex = mount(
            <ChakraProvider theme={theme}>
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
                    hasCommits={true}
                    hasCheckedPaths={true}
                    wholeIndexOperationInProgress={true}
                />
            </ChakraProvider>,
        );
        const wholeIndexGenerate = wholeIndex.container.querySelector(
            'button[aria-label="Generate commit message"]',
        ) as HTMLButtonElement;

        expect(wholeIndexGenerate.disabled).toBe(true);
        unmount(wholeIndex.root, wholeIndex.container);

        const unborn = mount(
            <ChakraProvider theme={theme}>
                <CommitArea
                    commitMessage="feat: message"
                    isAmend={true}
                    onMessageChange={noop}
                    onAmendChange={noop}
                    onCommit={noop}
                    onPush={noop}
                    canCommit={true}
                    canPush={true}
                    pushLabel="common.push"
                    currentBranchName={null}
                    currentBranchUpstream={null}
                    hasCommits={false}
                    hasCheckedPaths={true}
                    wholeIndexOperationInProgress={false}
                />
            </ChakraProvider>,
        );
        const unbornAmend = unborn.container.querySelector(
            '[data-testid="amend-checkbox"]',
        ) as HTMLInputElement;
        const amendLabel = unbornAmend.closest("label") as HTMLLabelElement;
        const blockedGenerate = unborn.container.querySelector(
            'button[aria-label="Generate commit message"]',
        ) as HTMLButtonElement;

        expect(unbornAmend.disabled).toBe(true);
        expect(amendLabel.getAttribute("aria-disabled")).toBe("true");
        expect(blockedGenerate.disabled).toBe(true);
        unmount(unborn.root, unborn.container);
    });

    it.each(["requested", "running"] as const)(
        "fences editing and committing while generation is %s but keeps stop available",
        (generationStatus) => {
            const onCancel = vi.fn();
            const onCommit = vi.fn();
            const noop = vi.fn();
            const mounted = mount(
                <ChakraProvider theme={theme}>
                    <CommitArea
                        commitMessage="feat: message"
                        isAmend={false}
                        onMessageChange={noop}
                        onAmendChange={noop}
                        onCommit={onCommit}
                        onPush={noop}
                        canCommit={true}
                        canPush={true}
                        pushLabel="common.push"
                        currentBranchName="main"
                        currentBranchUpstream="origin/main"
                        generationStatus={generationStatus}
                        hasCommits={true}
                        hasCheckedPaths={true}
                        onCancelGeneration={onCancel}
                    />
                </ChakraProvider>,
            );
            const textarea = mounted.container.querySelector("textarea") as HTMLTextAreaElement;
            const amend = mounted.container.querySelector(
                '[data-testid="amend-checkbox"]',
            ) as HTMLInputElement;
            const stop = mounted.container.querySelector(
                'button[aria-label="Stop commit message generation"]',
            ) as HTMLButtonElement;
            const commit = Array.from(mounted.container.querySelectorAll("button")).find(
                (button) => button.textContent === "Commit",
            ) as HTMLButtonElement;

            expect(textarea.readOnly).toBe(true);
            expect(textarea.style.paddingRight).toBe("");
            expect(textarea.getAttribute("aria-busy")).toBe("true");
            expect(amend.disabled).toBe(true);
            expect(stop.disabled).toBe(false);
            expect(commit.disabled).toBe(true);
            act(() => stop.click());
            act(() => commit.click());
            expect(onCancel).toHaveBeenCalledOnce();
            expect(onCommit).not.toHaveBeenCalled();
            unmount(mounted.root, mounted.container);
        },
    );

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
        const previousInnerWidth = window.innerWidth;
        Object.defineProperty(window, "innerWidth", { configurable: true, value: 800 });
        const rectSpy = vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
            bottom: 324,
            height: 24,
            left: 430,
            right: 454,
            top: 300,
            width: 24,
            x: 430,
            y: 300,
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
        expect(document.body.textContent).toContain("abc1234");
        expect(document.body.textContent).toContain("GitGuardian Security Checks");
        expect(document.body.textContent).toContain("Code Review Skipped");
        expect(document.body.textContent).not.toContain("All checks passed");
        const popover = document.body.querySelector('[data-testid="commit-checks-popover"]');
        const panel = popover?.querySelector("div");
        const caretBorder = document.body.querySelector(
            '[data-testid="commit-checks-popover-caret-border"]',
        ) as HTMLElement;
        const caretFill = document.body.querySelector(
            '[data-testid="commit-checks-popover-caret-fill"]',
        ) as HTMLElement;
        expect(popover?.style.transform).toBe("translateX(-100%) translateY(-50%)");
        expect(popover?.style.position).toBe("fixed");
        expect(popover?.style.left).toBe("422px");
        expect(popover?.style.top).toBe("312px");
        expect(trigger.getAttribute("aria-expanded")).toBe("true");
        expect(panel?.style.width).toBe("max-content");
        expect(panel?.style.minWidth).toBe("310px");
        expect(panel?.style.minHeight).toBe("190px");
        expect(caretBorder.getAttribute("aria-hidden")).toBe("true");
        expect(caretBorder.style.right).toBe("-12px");
        expect(caretBorder.style.borderLeftWidth).toBe("12px");
        expect(caretBorder.style.borderLeftColor).toBeTruthy();
        expect(caretFill.style.right).toBe("-10px");
        expect(caretFill.style.borderLeftWidth).toBe("10px");
        expect(caretFill.style.borderLeftColor).toBeTruthy();
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
        expect(trigger.getAttribute("aria-expanded")).toBe("false");

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
        Object.defineProperty(window, "innerWidth", {
            configurable: true,
            value: previousInnerWidth,
        });
        unmount(mounted.root, mounted.container);

        const firstMounted = mount(
            <CommitChecksButton
                hash="first123"
                checks={snapshot}
                onRequestChecks={onRequestChecks}
                onOpenCheckUrl={onOpenCheckUrl}
            />,
        );
        const firstTrigger = firstMounted.container.querySelector("button") as HTMLButtonElement;
        const firstRectSpy = vi.spyOn(firstTrigger, "getBoundingClientRect").mockReturnValue({
            bottom: 44,
            height: 24,
            left: 500,
            right: 524,
            top: 20,
            width: 24,
            x: 500,
            y: 20,
            toJSON: () => ({}),
        } as DOMRect);
        act(() => {
            firstTrigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        const firstPopover = document.body.querySelector('[data-testid="commit-checks-popover"]');
        const firstCaret = document.body.querySelector(
            '[data-testid="commit-checks-popover-caret-border"]',
        ) as HTMLElement;
        expect(firstPopover?.style.top).toBe("20px");
        expect(firstPopover?.style.transform).toBe("translateX(-100%)");
        expect(firstCaret.style.top).toBe("12px");
        firstRectSpy.mockRestore();
        unmount(firstMounted.root, firstMounted.container);

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
        const emptySlot = emptyMounted.container.querySelector(
            '[data-testid="commit-checks-slot-empty123"]',
        ) as HTMLSpanElement;
        expect(emptySlot.style.width).toBe("24px");
        expect(emptySlot.style.marginLeft).toBe("4px");
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

    it("renders section/folder/stash/toolbar/tab and commit area layouts", () => {
        const noop = vi.fn();
        const html = renderUi(
            <>
                <SectionHeader
                    label="Changes"
                    count={2}
                    stats={{ additions: 5, deletions: 1 }}
                    isOpen={true}
                    onToggleOpen={noop}
                    checkbox={{ isAllChecked: true, isSomeChecked: false, onToggle: noop }}
                />
                <TreeFolderRow
                    folder={
                        buildFileTree([
                            { path: "src/example.ts", status: "M", additions: 0, deletions: 0 },
                        ])[0]!
                    }
                    depth={1}
                    isExpanded={true}
                    fileCount={3}
                    onToggle={noop}
                    rowVariant="commit-panel"
                    wiring={{
                        isAllChecked: false,
                        isSomeChecked: true,
                        onToggleFolderCheck: noop,
                    }}
                />
                <Toolbar
                    onRefresh={noop}
                    onRollback={noop}
                    groupByDir={true}
                    showIgnoredFiles={false}
                    onToggleGroupBy={noop}
                    onToggleShowIgnoredFiles={noop}
                    onStash={noop}
                    onShowDiff={noop}
                    onExpandAll={noop}
                    onCollapseAll={noop}
                    showAbortMerge={true}
                    onAbortMerge={noop}
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
                    onSync={noop}
                    onFetch={noop}
                    onPull={noop}
                    onPush={noop}
                    commitContent={<div>Commit tab</div>}
                    stashContent={<div>Stash tab</div>}
                />
            </>,
        );

        expect(html).toContain("Changes");
        expect(html).toContain("+5");
        expect(html).toContain("-1");
        expect(html).toContain('type="checkbox"');
        expect(html).toContain("Refresh");
        expect(html).toContain("View Options");
        expect(html).toContain("Abort Merge");
        expect(html).toContain("Branch: main -&gt; origin/main");
        expect(html).not.toContain("Commit and Push");
        const commitActionIndex = html.indexOf("Commit");
        const pushActionIndex = html.indexOf("Push");
        expect(commitActionIndex).toBeGreaterThanOrEqual(0);
        expect(pushActionIndex).toBeGreaterThanOrEqual(0);
        expect(commitActionIndex).toBeLessThan(pushActionIndex);
        expect(html).toContain("Stash (2)");
        expect(html).not.toContain('aria-disabled="true"');

        const hiddenSectionHtml = renderToStaticMarkup(
            <ChakraProvider theme={theme}>
                <SectionHeader
                    label="Ignored Files"
                    count={1}
                    isOpen={true}
                    onToggleOpen={noop}
                    checkbox={{
                        isAllChecked: false,
                        isSomeChecked: false,
                        onToggle: noop,
                        visibility: "hidden",
                    }}
                />
            </ChakraProvider>,
        );
        expect(hiddenSectionHtml).not.toContain('type="checkbox"');
        expect(hiddenSectionHtml).toContain('aria-hidden="true"');

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

        const blockedUnavailablePushHtml = renderToStaticMarkup(
            <ChakraProvider theme={theme}>
                <CommitArea
                    commitMessage=""
                    isAmend={false}
                    onMessageChange={noop}
                    onAmendChange={noop}
                    onCommit={noop}
                    onPush={noop}
                    canCommit={true}
                    canPush={false}
                    pushLabel="common.push"
                    currentBranchName="main"
                    currentBranchUpstream="origin/main"
                />
            </ChakraProvider>,
        );
        expect(getButtonByText(blockedUnavailablePushHtml, "Push").disabled).toBe(true);

        const dirtyPushableHtml = renderToStaticMarkup(
            <ChakraProvider theme={theme}>
                <CommitArea
                    commitMessage=""
                    isAmend={false}
                    onMessageChange={noop}
                    onAmendChange={noop}
                    onCommit={noop}
                    onPush={noop}
                    canCommit={true}
                    canPush={true}
                    pushLabel="common.push"
                    currentBranchAhead={3}
                    currentBranchName="main"
                    currentBranchUpstream="origin/main"
                />
            </ChakraProvider>,
        );
        const dirtyPushButton = getButtonByText(dirtyPushableHtml, "Push↑3");
        expect(dirtyPushButton.disabled).toBe(false);
        expect(dirtyPushButton.getAttribute("aria-disabled")).toBeNull();
        expect(dirtyPushableHtml).toContain('data-testid="push-ahead-count"');
        expect(dirtyPushableHtml).toContain("↑3");

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
                groupByDir={true}
                showIgnoredFiles={false}
                onToggleGroupBy={noop}
                onToggleShowIgnoredFiles={noop}
                onStash={noop}
                onShowDiff={noop}
                onExpandAll={noop}
                onCollapseAll={noop}
                showAbortMerge={false}
                onAbortMerge={noop}
            />,
        );
        expect(refreshingToolbarHtml).toContain('data-refreshing="true"');
        expect(refreshingToolbarHtml).toContain("intelligit-spin");
    });

    it("shows aggregate change counts in file section headers", () => {
        const noop = vi.fn();
        const files: WorkingFile[] = [
            { path: "src/a.ts", status: "M", staged: false, additions: 2, deletions: 1 },
            { path: "src/b.ts", status: "A", staged: false, additions: 3, deletions: 0 },
            { path: "notes.txt", status: "?", staged: false, additions: 4, deletions: 0 },
            { path: "todo.txt", status: "?", staged: false, additions: 5, deletions: 0 },
        ];
        const html = renderUi(
            <FileTree
                files={files}
                groupByDir={false}
                showIgnoredFiles={false}
                checkedPaths={new Set()}
                onToggleFile={noop}
                onToggleFolder={noop}
                onToggleSection={noop}
                isAllChecked={() => false}
                isSomeChecked={() => false}
                onFileClick={noop}
                onTrackUnversionedFiles={noop}
                expandAllSignal={0}
                collapseAllSignal={0}
            />,
        );
        const container = document.createElement("div");
        container.innerHTML = html;
        const headerText = (label: string): string | undefined =>
            Array.from(container.querySelectorAll("div"))
                .filter((node) => node.textContent?.includes(label) ?? false)
                .sort((a, b) => (a.textContent ?? "").length - (b.textContent ?? "").length)[0]
                ?.textContent;

        expect(headerText("Changes")).toContain("+5");
        expect(headerText("Changes")).toContain("-1");
        expect(headerText("Unversioned Files")).toContain("+9");
        expect(headerText("Unversioned Files")).not.toContain("-");
    });

    it("shows ignored files only when view option is enabled", () => {
        const noop = vi.fn();
        const files: WorkingFile[] = [
            { path: "src/a.ts", status: "M", staged: false, additions: 1, deletions: 0 },
            { path: "dist/bundle.js", status: "!", staged: false, additions: 0, deletions: 0 },
        ];
        const renderTree = (showIgnoredFiles: boolean) =>
            renderUi(
                <FileTree
                    files={files}
                    groupByDir={false}
                    showIgnoredFiles={showIgnoredFiles}
                    checkedPaths={new Set()}
                    onToggleFile={noop}
                    onToggleFolder={noop}
                    onToggleSection={noop}
                    isAllChecked={() => false}
                    isSomeChecked={() => false}
                    onFileClick={noop}
                    onTrackUnversionedFiles={noop}
                    expandAllSignal={0}
                    collapseAllSignal={0}
                />,
            );

        const hiddenHtml = renderTree(false);
        expect(hiddenHtml).not.toContain("Ignored Files");
        expect(hiddenHtml).not.toContain("bundle.js");

        const shownHtml = renderTree(true);
        expect(shownHtml).toContain("Ignored Files");
        expect(shownHtml).toContain("bundle.js");
        expect(shownHtml).toContain("Ignored");
        const container = document.createElement("div");
        container.innerHTML = shownHtml;
        expect(container.querySelector('input[aria-label="dist/bundle.js"]')).toBeNull();
        expect(container.querySelector('input[aria-label="Ignored Files"]')).toBeNull();
        const contexts = Array.from(
            container.querySelectorAll<HTMLElement>("[data-vscode-context]"),
        ).map((row) => JSON.parse(row.dataset.vscodeContext ?? "{}") as Record<string, unknown>);
        expect(contexts).toContainEqual(
            expect.objectContaining({
                filePath: "src/a.ts",
                webviewIgnoredFile: false,
            }),
        );
        expect(contexts).toContainEqual(
            expect.objectContaining({
                filePath: "dist/bundle.js",
                webviewIgnoredFile: true,
            }),
        );
    });

    it("shows parent paths after prioritized file names in flat file rows", () => {
        const noop = vi.fn();
        const fullPath =
            "client/modules/invoices/templates/jasper-templates-debt-collection-auto-processor.md";
        const fileName = "jasper-templates-debt-collection-auto-processor.md";
        const parentPath = "client/modules/invoices/templates";
        const html = renderUi(
            <FileTree
                files={[{ path: fullPath, status: "?", staged: false, additions: 0, deletions: 0 }]}
                groupByDir={false}
                showIgnoredFiles={false}
                checkedPaths={new Set()}
                onToggleFile={noop}
                onToggleFolder={noop}
                onToggleSection={noop}
                isAllChecked={() => false}
                isSomeChecked={() => false}
                onFileClick={noop}
                onTrackUnversionedFiles={noop}
                expandAllSignal={0}
                collapseAllSignal={0}
            />,
        );
        const container = document.createElement("div");
        container.innerHTML = html;
        const row = container.querySelector(`[title="${fullPath}"]`);
        const rowText = row?.textContent ?? "";

        expect(rowText).toContain(fileName);
        expect(rowText).toContain(parentPath);
        expect(rowText.indexOf(fileName)).toBeLessThan(rowText.indexOf(parentPath));
    });

    it("keeps commit-panel row DOM and click events in the shared compatibility variant", () => {
        const onSelectWithEvent = vi.fn();
        const mounted = mount(
            <ChakraProvider theme={theme}>
                <TreeFileRow
                    file={{ path: "src/compat.ts", status: "M", additions: 2, deletions: 1 }}
                    depth={1}
                    rowVariant="commit-panel"
                    indentMetrics={{
                        indentStep: 18,
                        indentBase: 20,
                        guideBase: 28,
                        sectionGuideLeft: 17,
                    }}
                    wiring={{
                        isSelected: false,
                        onSelect: vi.fn(),
                        onSelectWithEvent,
                        isChecked: true,
                        onToggleCheck: vi.fn(),
                        vscodeContext: JSON.stringify({ webviewSection: "file" }),
                    }}
                />
            </ChakraProvider>,
        );
        const row = mounted.container.querySelector('[title="src/compat.ts"]') as HTMLElement;

        expect(row.getAttribute("role")).toBeNull();
        expect(row.getAttribute("tabindex")).toBeNull();
        expect(row.getAttribute("aria-selected")).toBeNull();
        expect(row.getAttribute("data-vscode-context")).toContain('"webviewSection":"file"');
        expect(getComputedStyle(row).paddingLeft).toBe("38px");
        act(() => row.dispatchEvent(new MouseEvent("click", { bubbles: true })));
        expect(onSelectWithEvent).toHaveBeenCalledOnce();
        unmount(mounted.root, mounted.container);
    });

    it("limits shelf drag wiring to root rows while retaining nested unversioned native drag", () => {
        const onShelfFileDragStart = vi.fn();
        const dataTransfer = {
            effectAllowed: "",
            setData: vi.fn(),
            setDragImage: vi.fn(),
        } as unknown as DataTransfer;
        const mounted = mount(
            <FileTree
                files={[
                    { path: "root.ts", status: "M", staged: false, additions: 0, deletions: 0 },
                    {
                        path: "folder/tracked.ts",
                        status: "M",
                        staged: false,
                        additions: 0,
                        deletions: 0,
                    },
                    {
                        path: "folder/new.ts",
                        status: "?",
                        staged: false,
                        additions: 0,
                        deletions: 0,
                    },
                ]}
                groupByDir={true}
                showIgnoredFiles={false}
                checkedPaths={new Set()}
                onToggleFile={vi.fn()}
                onToggleFolder={vi.fn()}
                onToggleSection={vi.fn()}
                isAllChecked={() => false}
                isSomeChecked={() => false}
                onFileClick={vi.fn()}
                onShelfFileDragStart={onShelfFileDragStart}
                expandAllSignal={0}
                collapseAllSignal={0}
            />,
        );
        const rootRow = mounted.container.querySelector('[title="root.ts"]') as HTMLElement;
        const nestedTrackedRow = mounted.container.querySelector(
            '[title="folder/tracked.ts"]',
        ) as HTMLElement;
        const nestedUnversionedRow = mounted.container.querySelector(
            '[title="folder/new.ts"]',
        ) as HTMLElement;
        const dragStart = (row: HTMLElement) => {
            const event = new Event("dragstart", { bubbles: true, cancelable: true });
            Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
            act(() => row.dispatchEvent(event));
        };

        expect(rootRow.draggable).toBe(true);
        dragStart(rootRow);
        expect(onShelfFileDragStart).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ path: "root.ts" }),
            expect.any(Set),
        );
        expect(nestedTrackedRow.draggable).toBe(false);
        expect(onShelfFileDragStart).toHaveBeenCalledTimes(1);
        expect(nestedUnversionedRow.draggable).toBe(true);
        dragStart(nestedUnversionedRow);
        // Root shelf handler fires; nested tracked is draggable=false/calls=0; nested unversioned shelf calls=0.
        expect(onShelfFileDragStart).toHaveBeenCalledTimes(1);
        unmount(mounted.root, mounted.container);
    });

    it("uses a staged row-key discriminator without changing the shared path-key default", () => {
        const onConsoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const samePathFiles: WorkingFile[] = [
            { path: "src/shared.ts", status: "M", staged: true, additions: 1, deletions: 0 },
            { path: "src/shared.ts", status: "M", staged: false, additions: 0, deletions: 1 },
        ];
        const mountedTree = mount(
            <FileTree
                files={samePathFiles}
                groupByDir={false}
                showIgnoredFiles={false}
                checkedPaths={new Set()}
                onToggleFile={vi.fn()}
                onToggleFolder={vi.fn()}
                onToggleSection={vi.fn()}
                isAllChecked={() => false}
                isSomeChecked={() => false}
                onFileClick={vi.fn()}
                expandAllSignal={0}
                collapseAllSignal={0}
            />,
        );
        const duplicateKeyErrors = () =>
            onConsoleError.mock.calls.filter((call) =>
                call.some(
                    (value) =>
                        typeof value === "string" &&
                        value.includes("Encountered two children with the same key"),
                ),
            );

        // A staged/unstaged same-path pair must emit zero duplicate-key console errors.
        expect(duplicateKeyErrors()).toHaveLength(0);
        unmount(mountedTree.root, mountedTree.container);

        const mountedSharedRows = mount(
            <ChakraProvider theme={theme}>
                <FileTreeRows
                    entries={[
                        {
                            type: "file",
                            file: { path: "src/one.ts", status: "M", additions: 0, deletions: 0 },
                        },
                        {
                            type: "file",
                            file: { path: "src/two.ts", status: "M", additions: 0, deletions: 0 },
                        },
                    ]}
                    depth={0}
                    isDirectoryExpanded={() => true}
                    onToggleDirectory={vi.fn()}
                    fileWiring={() => ({ isSelected: false, onSelect: vi.fn() })}
                />
            </ChakraProvider>,
        );
        expect(mountedSharedRows.container.querySelector('[title="src/one.ts"]')).not.toBeNull();
        expect(duplicateKeyErrors()).toHaveLength(0);
        unmount(mountedSharedRows.root, mountedSharedRows.container);
        onConsoleError.mockRestore();
    });
});
