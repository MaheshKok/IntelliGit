// @vitest-environment jsdom

import React, { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChakraProvider } from "@chakra-ui/react";
import { describe, expect, it, vi } from "vitest";
import type { Branch } from "../../src/types";
import theme from "../../src/webviews/react/commit-panel/theme";
import { renderHighlightedLabel } from "../../src/webviews/react/branch-column/highlight";
import { BranchSearchBar } from "../../src/webviews/react/branch-column/components/BranchSearchBar";
import { BranchSectionHeader } from "../../src/webviews/react/branch-column/components/BranchSectionHeader";
import { BranchTreeNodeRow } from "../../src/webviews/react/branch-column/components/BranchTreeNodeRow";
import { FolderIcon, GitBranchIcon, RepoIcon, StarIcon, TagIcon } from "../../src/webviews/react/branch-column/icons";
import { CommitArea } from "../../src/webviews/react/commit-panel/components/CommitArea";
import { FileTypeIcon } from "../../src/webviews/react/commit-panel/components/FileTypeIcon";
import { FolderRow } from "../../src/webviews/react/commit-panel/components/FolderRow";
import { IndentGuides } from "../../src/webviews/react/commit-panel/components/IndentGuides";
import { SectionHeader } from "../../src/webviews/react/commit-panel/components/SectionHeader";
import { StashRow } from "../../src/webviews/react/commit-panel/components/StashRow";
import { StatusBadge } from "../../src/webviews/react/commit-panel/components/StatusBadge";
import { TabBar } from "../../src/webviews/react/commit-panel/components/TabBar";
import { Toolbar } from "../../src/webviews/react/commit-panel/components/Toolbar";
import { VscCheckbox } from "../../src/webviews/react/commit-panel/components/VscCheckbox";
import { mount, unmount } from "./utils/reactDomTestUtils";

function renderUi(node: React.ReactElement): string {
    return renderToStaticMarkup(<ChakraProvider theme={theme}>{node}</ChakraProvider>);
}

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
        const sectionElement = mountedSection.container.querySelector('[role="button"]') as HTMLElement;
        expect(sectionElement.getAttribute("aria-expanded")).toBe("true");
        act(() => {
            sectionElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
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
            children: [{ label: "demo", fullName: "features/demo", branch: branch({ name: "features/demo" }), children: [] }],
        };
        const leafNode = {
            label: "main",
            fullName: "origin/main",
            branch: branch({ name: "origin/main", isCurrent: true }),
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
        const highlighted = renderToStaticMarkup(
            <>{renderHighlightedLabel("features", "fea")}</>,
        );
        const plainText = highlighted.replace(/<[^>]*>/g, "");
        expect(plainText).toContain("features");
        expect(highlighted.toLowerCase()).toContain(">fea<");

        const leafHtml = renderUi(
            <BranchTreeNodeRow
                node={leafNode}
                depth={1}
                selectedBranch={"origin/main"}
                expandedFolders={new Set()}
                onSelectBranch={onSelectBranch}
                onToggleFolder={onToggleFolder}
                onContextMenu={onContextMenu}
                filterNeedle=""
                prefix="root"
            />,
        );
        expect(leafHtml).toContain("main");
    });

    it("renders commit panel primitives", () => {
        const html = renderUi(
            <>
                <StatusBadge status="M" />
                <StatusBadge status="?" />
                <FileTypeIcon filename=".eslintrc.json" />
                <FileTypeIcon filename="unknown.xyz" status="D" />
                <IndentGuides treeDepth={2} />
                <VscCheckbox isChecked={true} onChange={vi.fn()} />
                <VscCheckbox isChecked={false} isIndeterminate={true} onChange={vi.fn()} />
            </>,
        );
        expect(html).toContain('data-tree-icon="file"');
        expect(html).toContain("svg");
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
                    onCommitAndPush={noop}
                />
                <TabBar stashCount={2} commitContent={<div>Commit tab</div>} shelfContent={<div>Shelf tab</div>} />
            </>,
        );

        expect(html).toContain("Changes");
        expect(html).toContain("Apply");
        expect(html).toContain("Commit and Push");
        expect(html).toContain("Shelf (2)");
    });
});
