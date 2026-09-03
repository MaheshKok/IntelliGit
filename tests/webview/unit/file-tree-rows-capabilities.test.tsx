// @vitest-environment jsdom

import React, { act } from "react";
import { ChakraProvider } from "@chakra-ui/react";
import { describe, expect, it, vi } from "vitest";
import {
    FileTreeRows,
    TreeFileRow,
    TreeFolderRow,
    TreeIndentGuides,
} from "../../../src/webviews/react/shared/components/FileTreeRows";
import { buildFileTree, type TreeFolder } from "../../../src/webviews/react/shared/fileTree";
import theme from "../../../src/webviews/react/commit-panel/theme";
import { initReactDomTestEnvironment, mount, unmount } from "../../helpers/reactDomTestUtils";
import { installWebviewI18n } from "../../helpers/webviewI18nTestUtils";

initReactDomTestEnvironment();

type TestFile = {
    path: string;
    status: string;
    additions: number;
    deletions: number;
};

const file: TestFile = { path: "src/app.ts", status: "M", additions: 2, deletions: 1 };
const rootFile: TestFile = { path: "README.md", status: "A", additions: 0, deletions: 0 };
const noop = (): void => undefined;

function renderRows(overrides: Partial<React.ComponentProps<typeof FileTreeRows<TestFile>>> = {}) {
    return mount(
        <ChakraProvider theme={theme}>
            <FileTreeRows
                entries={buildFileTree([file, rootFile])}
                depth={0}
                isDirectoryExpanded={() => true}
                onToggleDirectory={noop}
                fileWiring={() => ({ isSelected: false, onSelect: noop })}
                {...overrides}
            />
        </ChakraProvider>,
    );
}

function click(element: Element): void {
    act(() => element.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

function pressSpace(element: Element): KeyboardEvent {
    const event = new KeyboardEvent("keydown", {
        key: " ",
        code: "Space",
        bubbles: true,
        cancelable: true,
    });
    act(() => {
        const defaultAllowed = element.dispatchEvent(event);
        // JSDOM dispatches the key event but does not execute the native checkbox
        // Space default action, so emulate that action only when it was allowed.
        if (defaultAllowed && element instanceof HTMLInputElement && element.type === "checkbox")
            element.click();
    });
    return event;
}

function guideOffsets(row: HTMLElement): number[] {
    return Array.from(row.querySelectorAll("span"))
        .filter((span) => getComputedStyle(span).position === "absolute")
        .map((span) => Number.parseFloat(getComputedStyle(span).left));
}

describe("FileTreeRows additive capabilities", () => {
    it("preserves the pre-extension markup when no optional wiring is supplied", () => {
        installWebviewI18n();
        const { root, container } = renderRows();

        // Captured from the pre-extension renderer: this fixture has one expanded folder and two files.
        expect(container.innerHTML).toBe(
            `<button type="button" role="treeitem" aria-expanded="true" title="src" class="css-1r9cu12"><span class="css-ascv5p"></span><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false" style="flex-shrink: 0; margin-right: 2px; opacity: 0.78; transform: rotate(90deg); transform-origin: center; transition: transform 100ms cubic-bezier(0.25, 1, 0.5, 1); vertical-align: text-bottom;"><path d="M6 4.5 9.5 8 6 11.5" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8"></path></svg><span data-tree-icon="folder" class="css-80guky"><svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" focusable="false" style="flex-shrink: 0; margin-right: 4px; opacity: 0.92;" data-branch-icon="true"><path fill="var(--vscode-symbolIcon-folderOpenedForeground, var(--vscode-symbolIcon-folderForeground, var(--vscode-icon-foreground, currentColor)))" d="M1.5 2A1.5 1.5 0 0 0 0 3.5v9A1.5 1.5 0 0 0 1.5 14h13a1.5 1.5 0 0 0 1.5-1.5V5.5A1.5 1.5 0 0 0 14.5 4H7.71L6.85 2.85A.5.5 0 0 0 6.5 2.5H1.5z"></path></svg></span><span class="css-qx4qqv">src</span><span class="css-13zw8fb">1 file</span></button><div tabindex="0" role="treeitem" aria-selected="false" title="src/app.ts" class="css-1w6cibx"><span class="css-ascv5p"></span><span class="css-1hbh4n9"></span><span class="css-1fbp8m9"></span><span data-tree-icon="file" class="css-18tt4wj"><svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" style="color: var(--vscode-symbolIcon-fileForeground, var(--vscode-icon-foreground, currentColor));"><path fill="currentColor" fill-rule="evenodd" d="M4 1h5.586a1 1 0 0 1 .707.293l2.414 2.414A1 1 0 0 1 13 4.414V14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1zm0 1v12h8V4.414L9.586 2H4zm5 .5V5h2.5z"></path></svg></span><span class="css-18m2s3i"><span class="css-1r3ay21">app.ts</span></span><span class="css-18l8dcy"><span class="css-199i7oh">+2</span><span class="css-c21r7x">-1</span></span><span title="Modified" class="css-1fza0ia">M</span></div><div tabindex="0" role="treeitem" aria-selected="false" title="README.md" class="css-ry5khs"><span class="css-ascv5p"></span><span class="css-1fbp8m9"></span><span data-tree-icon="file" class="css-18tt4wj"><svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" style="color: var(--vscode-symbolIcon-fileForeground, var(--vscode-icon-foreground, currentColor));"><path fill="currentColor" fill-rule="evenodd" d="M4 1h5.586a1 1 0 0 1 .707.293l2.414 2.414A1 1 0 0 1 13 4.414V14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1zm0 1v12h8V4.414L9.586 2H4zm5 .5V5h2.5z"></path></svg></span><span class="css-18m2s3i"><span class="css-1r3ay21">README.md</span></span><span title="Added" class="css-1fza0ia">A</span></div><span id="__chakra_env" hidden=""></span>`,
        );
        unmount(root, container);
    });

    it("renders file and folder checkbox wiring across all visibility modes", () => {
        installWebviewI18n();
        const onFileCheck = vi.fn();
        const onFolderCheck = vi.fn();
        const { root, container } = renderRows({
            fileWiring: (entry) => ({
                isSelected: false,
                onSelect: noop,
                isChecked: entry.path === file.path,
                onToggleCheck: onFileCheck,
                checkboxVisibility: "visible",
            }),
            folderWiring: () => ({
                isAllChecked: false,
                isSomeChecked: true,
                onToggleFolderCheck: onFolderCheck,
                checkboxVisibility: "visible",
            }),
        });
        const inputs = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');

        expect(inputs).toHaveLength(3);
        expect(inputs[0]?.indeterminate).toBe(true);
        click(inputs[0]!);
        click(inputs[1]!);
        expect(onFolderCheck).toHaveBeenCalledWith("src");
        expect(onFileCheck).toHaveBeenCalledWith(file.path);

        unmount(root, container);
        for (const visibility of ["hidden", "none"] as const) {
            const rendered = renderRows({
                fileWiring: () => ({
                    isSelected: false,
                    onSelect: noop,
                    isChecked: false,
                    onToggleCheck: noop,
                    checkboxVisibility: visibility,
                }),
                folderWiring: () => ({
                    isAllChecked: false,
                    isSomeChecked: false,
                    onToggleFolderCheck: noop,
                    checkboxVisibility: visibility,
                }),
            });
            expect(rendered.container.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
            expect(rendered.container.querySelectorAll('span[aria-hidden="true"]')).toHaveLength(0);
            unmount(rendered.root, rendered.container);
        }
    });

    it("reserves the hidden file checkbox slot without toggle wiring", () => {
        installWebviewI18n();
        const { root, container } = renderRows({
            fileWiring: () => ({
                isSelected: false,
                onSelect: noop,
                checkboxVisibility: "hidden",
            }),
        });
        const fileRow = container.querySelector('[title="src/app.ts"]') as HTMLElement;
        const fileIcon = fileRow.querySelector('[data-tree-icon="file"]') as HTMLElement;
        const checkboxSlot = fileIcon.previousElementSibling as HTMLElement;

        expect(getComputedStyle(checkboxSlot).width).toBe("14px");
        expect(getComputedStyle(checkboxSlot).height).toBe("14px");
        expect(checkboxSlot.getAttribute("aria-hidden")).toBeNull();
        unmount(root, container);
    });

    it("reserves the visible file checkbox slot when toggle wiring is absent", () => {
        installWebviewI18n();
        const { root, container } = renderRows({
            fileWiring: () => ({
                isSelected: false,
                onSelect: noop,
                checkboxVisibility: "visible",
            }),
        });
        const fileRow = container.querySelector('[title="src/app.ts"]') as HTMLElement;
        const fileIcon = fileRow.querySelector('[data-tree-icon="file"]') as HTMLElement;
        const checkboxSlot = fileIcon.previousElementSibling as HTMLElement;
        const indentSlot = checkboxSlot.previousElementSibling as HTMLElement;

        expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
        expect(getComputedStyle(checkboxSlot).width).toBe("14px");
        expect(getComputedStyle(checkboxSlot).height).toBe("14px");
        expect(getComputedStyle(indentSlot).width).toBe("14px");
        unmount(root, container);
    });

    it("reserves the hidden folder checkbox slot", () => {
        installWebviewI18n();
        const { root, container } = renderRows({
            folderWiring: () => ({
                isAllChecked: false,
                isSomeChecked: false,
                onToggleFolderCheck: noop,
                checkboxVisibility: "hidden",
            }),
        });
        const folderRow = container.querySelector('[title="src"]') as HTMLElement;
        const folderIcon = folderRow.querySelector('[data-tree-icon="folder"]') as HTMLElement;
        const folderSlot = folderIcon.previousElementSibling as HTMLElement;

        expect(getComputedStyle(folderSlot).width).toBe("14px");
        expect(getComputedStyle(folderSlot).height).toBe("14px");
        expect(folderSlot.getAttribute("aria-hidden")).toBeNull();
        unmount(root, container);
    });

    it("keeps checkbox clicks and Space independent from tree row selection", () => {
        installWebviewI18n();
        const onFileCheck = vi.fn();
        const onFileSelect = vi.fn();
        const onFolderCheck = vi.fn();
        const onToggleDirectory = vi.fn();
        const { root, container } = renderRows({
            onToggleDirectory,
            fileWiring: () => ({
                isSelected: false,
                onSelect: onFileSelect,
                isChecked: false,
                onToggleCheck: onFileCheck,
            }),
            folderWiring: () => ({
                isAllChecked: false,
                isSomeChecked: false,
                onToggleFolderCheck: onFolderCheck,
            }),
        });
        const [folderCheckbox, fileCheckbox] =
            container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
        const fileRow = container.querySelector('[title="src/app.ts"]') as HTMLElement;

        click(fileCheckbox!);
        expect(onFileCheck).toHaveBeenCalledWith(file.path);
        expect(onFileSelect).not.toHaveBeenCalled();

        click(folderCheckbox!);
        expect(onFolderCheck).toHaveBeenCalledWith("src");
        expect(onToggleDirectory).not.toHaveBeenCalled();

        onFileCheck.mockClear();
        const checkboxSpace = pressSpace(fileCheckbox!);
        expect(checkboxSpace.defaultPrevented).toBe(false);
        expect(onFileCheck).toHaveBeenCalledWith(file.path);
        expect(onFileSelect).not.toHaveBeenCalled();

        pressSpace(fileRow);
        expect(onFileSelect).toHaveBeenCalledOnce();
        unmount(root, container);
    });

    it("routes Enter from the checkbox to row activation, matching FileRow", () => {
        installWebviewI18n();
        const onFileActivate = vi.fn();
        const onFileSelect = vi.fn();
        const { root, container } = renderRows({
            fileWiring: () => ({
                isSelected: false,
                onSelect: onFileSelect,
                onActivate: onFileActivate,
                isChecked: false,
                onToggleCheck: noop,
            }),
        });
        const fileCheckbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
        const enter = new KeyboardEvent("keydown", {
            key: "Enter",
            bubbles: true,
            cancelable: true,
        });
        act(() => fileCheckbox.dispatchEvent(enter));

        expect(enter.defaultPrevented).toBe(true);
        expect(onFileActivate).toHaveBeenCalledOnce();
        expect(onFileSelect).not.toHaveBeenCalled();
        unmount(root, container);
    });

    it("forwards named drag wiring and keeps current state independent from drag visuals", () => {
        installWebviewI18n();
        const onFileDragStart = vi.fn();
        const onFileDragEnd = vi.fn();
        const onLegacyDragStart = vi.fn();
        const onLegacyDragEnd = vi.fn();
        const { root, container } = renderRows({
            fileWiring: () => ({
                isSelected: false,
                isCurrent: true,
                onSelect: noop,
                draggable: true,
                dataAttributes: { "shelf-file": "change-a" },
                onFileDragStart,
                onFileDragEnd,
                onDragStart: onLegacyDragStart,
                onDragEnd: onLegacyDragEnd,
            }),
        });
        const row = container.querySelector('[data-shelf-file="change-a"]') as HTMLElement;
        const baseline = renderRows();
        const baselineRow = baseline.container.querySelector('[title="src/app.ts"]') as HTMLElement;

        expect(row.getAttribute("aria-selected")).toBe("false");
        expect(row.getAttribute("aria-current")).toBe("true");
        expect(row.draggable).toBe(true);
        expect(row.className).toBe(baselineRow.className);
        act(() => row.dispatchEvent(new Event("dragstart", { bubbles: true })));
        act(() => row.dispatchEvent(new Event("dragend", { bubbles: true })));
        expect(onFileDragStart).toHaveBeenCalledOnce();
        expect(onFileDragEnd).toHaveBeenCalledOnce();
        expect(onLegacyDragStart).not.toHaveBeenCalled();
        expect(onLegacyDragEnd).not.toHaveBeenCalled();
        unmount(root, container);
        unmount(baseline.root, baseline.container);
    });

    it("falls back to legacy drag callbacks when named callbacks are absent", () => {
        installWebviewI18n();
        const onDragStart = vi.fn();
        const onDragEnd = vi.fn();
        const { root, container } = renderRows({
            fileWiring: () => ({
                isSelected: false,
                onSelect: noop,
                draggable: true,
                dataAttributes: { "shelf-file": "legacy-change" },
                onDragStart,
                onDragEnd,
            }),
        });
        const row = container.querySelector('[data-shelf-file="legacy-change"]') as HTMLElement;

        act(() => row.dispatchEvent(new Event("dragstart", { bubbles: true })));
        act(() => row.dispatchEvent(new Event("dragend", { bubbles: true })));
        expect(onDragStart).toHaveBeenCalledOnce();
        expect(onDragEnd).toHaveBeenCalledOnce();
        unmount(root, container);
    });

    it("uses default and commit indent metrics, including exported row subcomponents", () => {
        installWebviewI18n();
        const defaultRows = renderRows();
        const defaultRow = defaultRows.container.querySelector(
            '[title="src/app.ts"]',
        ) as HTMLElement;
        expect(guideOffsets(defaultRow)).toEqual([16, 26]);
        unmount(defaultRows.root, defaultRows.container);

        const commitRows = renderRows({
            indentMetrics: { indentStep: 18, indentBase: 20, guideBase: 28, sectionGuideLeft: 17 },
        });
        const commitRow = commitRows.container.querySelector('[title="src/app.ts"]') as HTMLElement;
        expect(guideOffsets(commitRow)).toEqual([17, 28]);
        expect(getComputedStyle(commitRow).paddingLeft).toBe("38px");
        unmount(commitRows.root, commitRows.container);

        const folder = buildFileTree([file])[0] as TreeFolder<TestFile>;
        const direct = mount(
            <ChakraProvider theme={theme}>
                <TreeIndentGuides treeDepth={0} />
                <TreeFolderRow
                    folder={folder}
                    depth={0}
                    isExpanded={true}
                    fileCount={1}
                    onToggle={noop}
                />
                <TreeFileRow
                    file={rootFile}
                    depth={0}
                    wiring={{ isSelected: false, onSelect: noop }}
                />
            </ChakraProvider>,
        );
        expect(direct.container.querySelector('[title="src"]')).not.toBeNull();
        expect(direct.container.querySelector('[title="README.md"]')).not.toBeNull();
        unmount(direct.root, direct.container);
    });
});
