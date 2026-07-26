// The Changed Files tree. One implementation shared by the commit-info pane and
// by the Shelf and Stash entry subtrees, so a file reads the same wherever it is
// listed. Callers supply per-row wiring; the rows own layout, indent guides and
// keyboard handling.

import React, { useCallback, useEffect, useRef } from "react";
import { Box, Flex } from "@chakra-ui/react";
import { SYSTEM_FONT_STACK } from "../../../../utils/constants";
import type { ThemeFolderIconMap, ThemeTreeIcon } from "../../../../types";
import { StatusBadge } from "./StatusBadge";
import { TreeFileIcon, TreeFolderIcon } from "./TreeIcons";
import { VscCheckbox } from "./VscCheckbox";
import { ChevronIcon } from "./Icons";
import { resolveFolderIcon } from "../utils/folderIcons";
import { getLeafName, getParentPath } from "../utils/path";
import { JETBRAINS_UI } from "../tokens";
import { t } from "../i18n";
import { countFiles, type TreeEntry, type TreeFolder } from "../fileTree";

/**
 * Tree geometry is expressed as metrics so callers can move the outer guide
 * without splitting row padding from its ancestor rules. The original derivation
 * remains: `TREE_INDENT_STEP = 14`, `CHEVRON_HALF = 8`, and
 * `GUIDE_STEP_FROM_PARENT = 10`. The default section guide is
 * `8 + CHEVRON_HALF = 16`; its depth-0 row indent is
 * `sectionGuideLeft + GUIDE_STEP_FROM_PARENT - CHEVRON_HALF = 18`; and the
 * first nested guide is `indentBase + CHEVRON_HALF = 26`.
 */
const DEFAULT_INDENT_METRICS = Object.freeze({
    indentStep: 14,
    indentBase: 18,
    guideBase: 26,
    sectionGuideLeft: 16,
});
const CHECKBOX_SLOT_SIZE = 14;
const GUIDE_COLOR = "var(--vscode-tree-indentGuidesStroke, rgba(154, 169, 198, 0.22))";

/** Host-themed guide color shared by the Commit tree and repository rail. */
export const COMMIT_PANEL_INDENT_GUIDE_COLOR =
    "var(--vscode-editorIndentGuide-background1, var(--vscode-tree-indentGuidesStroke, rgba(160, 168, 184, 0.28)))";

/** Immutable geometry values shared by tree row padding and indent guides. */
export interface TreeIndentMetrics {
    readonly indentStep: number;
    readonly indentBase: number;
    readonly guideBase: number;
    readonly sectionGuideLeft: number;
}

/**
 * Guide offset for a subtree beneath a Shelf or Stash entry row, whose chevron
 * sits one row margin (8px) plus one row padding (6px) from the tree's left
 * edge: `8 + 6 + CHEVRON_HALF = 22`.
 */
export const ENTRY_ROW_GUIDE_LEFT = 22;

/** Outer guide anchor shared by the repository chevron and commit-panel entry subtrees. */
export const COMMIT_PANEL_SECTION_GUIDE_LEFT = 17;
const ENTRY_ROW_INDENT_METRICS = Object.freeze({
    ...DEFAULT_INDENT_METRICS,
    indentBase:
        DEFAULT_INDENT_METRICS.indentBase +
        (ENTRY_ROW_GUIDE_LEFT - DEFAULT_INDENT_METRICS.sectionGuideLeft),
    guideBase:
        DEFAULT_INDENT_METRICS.guideBase +
        (ENTRY_ROW_GUIDE_LEFT - DEFAULT_INDENT_METRICS.sectionGuideLeft),
    sectionGuideLeft: ENTRY_ROW_GUIDE_LEFT,
});

/** The minimum a row needs; both `CommitFile` and `WorkingFile` satisfy it. */
export interface TreeRowFile {
    path: string;
    status: string;
    additions: number;
    deletions: number;
    icon?: ThemeTreeIcon;
}

/** Per-file wiring a caller supplies. Everything beyond selection is optional. */
interface TreeFileWiring {
    /** Whether this row is the tree's current file; the caller owns the identity. */
    isSelected: boolean;
    onSelect: () => void;
    /** Preserves the commit-panel callback contract, including the original click event. */
    onSelectWithEvent?: (event: React.MouseEvent<HTMLElement>) => void;
    onActivate?: () => void;
    onContextMenu?: (x: number, y: number, returnFocusTarget: HTMLElement) => void;
    /** Serialized VS Code context metadata; omit to leave the native menu alone. */
    vscodeContext?: string;
    /** Extra `data-*` attributes, keyed without the `data-` prefix. */
    dataAttributes?: Record<string, string>;
    draggable?: boolean;
    /** Preferred file drag-start callback; takes precedence over legacy `onDragStart`. */
    onFileDragStart?: (event: React.DragEvent<HTMLElement>) => void;
    /** Preferred file drag-end callback; takes precedence over legacy `onDragEnd`. */
    onFileDragEnd?: () => void;
    /** Legacy drag-start callback retained for existing callers. */
    onDragStart?: (event: React.DragEvent<HTMLElement>) => void;
    /** Legacy drag-end callback retained for existing callers. */
    onDragEnd?: () => void;
    /** Applies the drag-selection visual treatment without changing selection ownership. */
    isDragSelected?: boolean;
    /** Marks the active file for assistive technology independently of selection. */
    isCurrent?: boolean;
    /** Current checkbox state when a caller supplies file-check wiring. */
    isChecked?: boolean;
    /** Toggles this file's checked state; absent wiring leaves no checkbox control. */
    onToggleCheck?: (path: string) => void;
    /** Reserves, renders, or omits the checkbox slot without changing row layout. */
    checkboxVisibility?: "visible" | "hidden" | "none";
}

/** Per-folder checkbox wiring, supplied only by trees that support selection. */
interface TreeFolderWiring {
    isAllChecked: boolean;
    isSomeChecked: boolean;
    onToggleFolderCheck: (path: string) => void;
    checkboxVisibility?: "visible" | "hidden" | "none";
}

type TreeFolderWithDescendantFiles<F extends TreeRowFile> = TreeFolder<F> & {
    descendantFiles?: F[];
};

interface SharedTreeOptions<F extends TreeRowFile> {
    depth: number;
    isDirectoryExpanded: (path: string) => boolean;
    onToggleDirectory: (path: string) => void;
    fileWiring: (file: F, depth: number) => TreeFileWiring;
    /** Optional file-row identity; path remains the shared default for existing consumers. */
    fileRowKey?: (file: F) => React.Key;
    /** Optional folder-checkbox wiring for selectable trees. */
    folderWiring?: (folder: TreeFolderWithDescendantFiles<F>) => TreeFolderWiring;
    folderIcon?: ThemeTreeIcon;
    folderExpandedIcon?: ThemeTreeIcon;
    folderIconsByName?: ThemeFolderIconMap;
    /** Shows each file's parent directory beside its name; used by flat listings. */
    showParentPath?: boolean;
    /** Legacy guide offset for the row above this subtree; converted to indent metrics. */
    sectionGuideLeft?: number;
    /** Complete geometry for row padding and indent guides. */
    indentMetrics?: Readonly<TreeIndentMetrics>;
    /** `aria-level` of the outermost rows; omit outside a `role="tree"`. */
    ariaLevel?: number;
    /** Uses the legacy working-tree row DOM without changing the shared default rows. */
    rowVariant?: "default" | "commit-panel";
}

interface FileTreeRowsProps<F extends TreeRowFile> extends SharedTreeOptions<F> {
    entries: TreeEntry<F>[];
}

const TREE_FOLDER_ROW_VARIANTS = {
    default: {
        as: "button" as const,
        type: "button",
        width: "100%",
        minHeight: undefined,
        border: "0",
        background: "transparent",
        textAlign: "left" as const,
        color: "inherit",
        whiteSpace: undefined,
        treeItem: true,
        hoverBackground: JETBRAINS_UI.color.hover,
        labelMinWidth: undefined,
        labelWhiteSpace: undefined,
        labelOpacity: 0.85,
        countMarginLeft: "auto",
        countFlexShrink: undefined,
        countWhiteSpace: undefined,
        countColor: "var(--vscode-descriptionForeground)",
    },
    "commit-panel": {
        as: undefined,
        type: undefined,
        width: undefined,
        minHeight: "22px",
        border: undefined,
        background: undefined,
        textAlign: undefined,
        color: "var(--intelligit-pycharm-foreground)",
        whiteSpace: "nowrap",
        treeItem: false,
        hoverBackground: "rgba(255,255,255,0.05)",
        labelMinWidth: 0,
        labelWhiteSpace: "nowrap",
        labelOpacity: 0.82,
        countMarginLeft: "6px",
        countFlexShrink: 0,
        countWhiteSpace: "nowrap",
        countColor: "var(--intelligit-pycharm-muted)",
    },
} as const;

function resolveIndentMetrics(
    metrics: Readonly<TreeIndentMetrics> | undefined,
    legacySectionGuideLeft: number | undefined,
): TreeIndentMetrics {
    if (metrics) return metrics;
    if (legacySectionGuideLeft === undefined) return DEFAULT_INDENT_METRICS;
    if (legacySectionGuideLeft === ENTRY_ROW_GUIDE_LEFT) return ENTRY_ROW_INDENT_METRICS;
    const offset = legacySectionGuideLeft - DEFAULT_INDENT_METRICS.sectionGuideLeft;
    return {
        ...DEFAULT_INDENT_METRICS,
        indentBase: DEFAULT_INDENT_METRICS.indentBase + offset,
        guideBase: DEFAULT_INDENT_METRICS.guideBase + offset,
        sectionGuideLeft: legacySectionGuideLeft,
    };
}

/** Recursively renders one file tree: folders first as the builder ordered them. */
export function FileTreeRows<F extends TreeRowFile>({
    entries,
    ...options
}: FileTreeRowsProps<F>): React.ReactElement {
    const { depth, isDirectoryExpanded, onToggleDirectory, fileWiring } = options;
    const indentMetrics = resolveIndentMetrics(options.indentMetrics, options.sectionGuideLeft);
    return (
        <>
            {entries.map((entry) => {
                if (entry.type === "file")
                    return (
                        <TreeFileRow
                            key={options.fileRowKey?.(entry.file) ?? entry.file.path}
                            file={entry.file}
                            depth={depth}
                            showParentPath={options.showParentPath}
                            ariaLevel={options.ariaLevel}
                            indentMetrics={indentMetrics}
                            rowVariant={options.rowVariant}
                            wiring={fileWiring(entry.file, depth)}
                        />
                    );
                const isExpanded = isDirectoryExpanded(entry.path);
                const folderWiring = options.folderWiring?.(entry);
                return (
                    <React.Fragment key={entry.path}>
                        <TreeFolderRow
                            folder={entry}
                            depth={depth}
                            isExpanded={isExpanded}
                            fileCount={countFiles(entry.children)}
                            folderIcon={options.folderIcon}
                            folderExpandedIcon={options.folderExpandedIcon}
                            folderIconsByName={options.folderIconsByName}
                            ariaLevel={options.ariaLevel}
                            indentMetrics={indentMetrics}
                            rowVariant={options.rowVariant}
                            onToggleDirectory={onToggleDirectory}
                            wiring={folderWiring}
                        />
                        {isExpanded ? (
                            <FileTreeRows
                                {...options}
                                entries={entry.children}
                                depth={depth + 1}
                                indentMetrics={indentMetrics}
                                sectionGuideLeft={undefined}
                                ariaLevel={
                                    options.ariaLevel === undefined
                                        ? undefined
                                        : options.ariaLevel + 1
                                }
                            />
                        ) : null}
                    </React.Fragment>
                );
            })}
        </>
    );
}

function TreeFolderRowImpl<F extends TreeRowFile>({
    folder,
    depth,
    isExpanded,
    fileCount,
    folderIcon,
    folderExpandedIcon,
    folderIconsByName,
    ariaLevel,
    indentMetrics = DEFAULT_INDENT_METRICS,
    rowVariant = "default",
    onToggle,
    onToggleDirectory,
    wiring,
}: {
    folder: TreeFolder<F>;
    depth: number;
    isExpanded: boolean;
    fileCount: number;
    folderIcon?: ThemeTreeIcon;
    folderExpandedIcon?: ThemeTreeIcon;
    folderIconsByName?: ThemeFolderIconMap;
    ariaLevel?: number;
    indentMetrics?: Readonly<TreeIndentMetrics>;
    rowVariant?: "default" | "commit-panel";
    /** Direct-row compatibility callback. */
    onToggle?: () => void;
    /** Stable recursive-tree callback; the row supplies its own folder path. */
    onToggleDirectory?: (path: string) => void;
    wiring?: TreeFolderWiring;
}): React.ReactElement {
    const resolvedIcon = resolveFolderIcon(
        folder.path || folder.name,
        isExpanded,
        folderIconsByName,
        folderIcon,
        folderExpandedIcon,
    );
    const visibility = wiring?.checkboxVisibility ?? "visible";
    const variant = TREE_FOLDER_ROW_VARIANTS[rowVariant];
    const toggleFolder = useCallback(() => {
        if (onToggleDirectory) onToggleDirectory(folder.path);
        else onToggle?.();
    }, [folder.path, onToggle, onToggleDirectory]);
    return (
        <Flex
            as={variant.as}
            type={variant.type}
            align="center"
            gap="4px"
            w={variant.width}
            pl={`${indentMetrics.indentBase + depth * indentMetrics.indentStep}px`}
            pr="6px"
            minH={variant.minHeight}
            border={variant.border}
            bg={variant.background}
            textAlign={variant.textAlign}
            lineHeight="22px"
            fontSize="13px"
            fontFamily={SYSTEM_FONT_STACK}
            color={variant.color}
            cursor="pointer"
            position="relative"
            whiteSpace={variant.whiteSpace}
            role={variant.treeItem ? "treeitem" : undefined}
            aria-expanded={variant.treeItem ? isExpanded : undefined}
            aria-level={variant.treeItem ? ariaLevel : undefined}
            _hover={{ bg: variant.hoverBackground }}
            onClick={(event) => {
                if (!isCheckboxInput(event.target)) toggleFolder();
            }}
            title={folder.path}
        >
            <TreeIndentGuides
                treeDepth={depth}
                indentMetrics={indentMetrics}
                rowVariant={rowVariant}
            />
            <ChevronIcon expanded={isExpanded} />
            {wiring && visibility === "hidden" ? (
                <Box
                    as="span"
                    w={`${CHECKBOX_SLOT_SIZE}px`}
                    h={`${CHECKBOX_SLOT_SIZE}px`}
                    flexShrink={0}
                />
            ) : null}
            {wiring && visibility === "visible" ? (
                <VscCheckbox
                    isChecked={wiring.isAllChecked}
                    isIndeterminate={wiring.isSomeChecked}
                    onChange={() => wiring.onToggleFolderCheck(folder.path)}
                    ariaLabel={folder.path}
                />
            ) : null}
            <TreeFolderIcon isExpanded={isExpanded} icon={resolvedIcon} />
            <Box
                as="span"
                flex={1}
                minW={variant.labelMinWidth}
                whiteSpace={variant.labelWhiteSpace}
                opacity={variant.labelOpacity}
            >
                {folder.name}
            </Box>
            <Box
                as="span"
                ml={variant.countMarginLeft}
                flexShrink={variant.countFlexShrink}
                whiteSpace={variant.countWhiteSpace}
                fontSize="11px"
                color={variant.countColor}
            >
                {t("common.fileCount", { count: fileCount })}
            </Box>
        </Flex>
    );
}

export const TreeFolderRow = React.memo(TreeFolderRowImpl) as typeof TreeFolderRowImpl;

function useTreeFileRowInteractions(
    onSelect: () => void,
    onActivate: (() => void) | undefined,
    onContextMenu: ((x: number, y: number, returnFocusTarget: HTMLElement) => void) | undefined,
    keyboardEnabled: boolean,
): {
    rowRef: React.RefObject<HTMLDivElement>;
    openContextMenu: (event: React.MouseEvent<HTMLElement>) => void;
} {
    const rowRef = useRef<HTMLDivElement>(null);
    const openContextMenu = useCallback(
        (event: React.MouseEvent<HTMLElement>) => {
            if (!onContextMenu) return;
            event.preventDefault();
            onContextMenu(event.clientX, event.clientY, event.currentTarget);
        },
        [onContextMenu],
    );
    useEffect(() => {
        if (!keyboardEnabled) return;
        const element = rowRef.current;
        if (!element) return;
        const handleKeyDown = (event: KeyboardEvent): void => {
            if (event.key === "Enter") {
                event.preventDefault();
                (onActivate ?? onSelect)();
                return;
            }
            if (event.key === " " || event.code === "Space") {
                // Only Space is ceded to the checkbox input's native toggle; Enter and
                // the context-menu keys stay row-level from any target, like FileRow.
                if (isCheckboxInput(event.target)) return;
                event.preventDefault();
                onSelect();
                return;
            }
            if (
                !onContextMenu ||
                (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10"))
            )
                return;
            event.preventDefault();
            const rect = element.getBoundingClientRect();
            onContextMenu(rect.left, rect.bottom, element);
        };
        element.addEventListener("keydown", handleKeyDown);
        return () => element.removeEventListener("keydown", handleKeyDown);
    }, [keyboardEnabled, onActivate, onSelect, onContextMenu]);
    return { rowRef, openContextMenu };
}

function treeFileVisuals(isSelected: boolean, isDragSelected: boolean) {
    const hasHighlight = isSelected || isDragSelected;
    return {
        background: isSelected
            ? JETBRAINS_UI.color.selected
            : hasHighlight
              ? "var(--intelligit-pycharm-selected)"
              : undefined,
        color: isSelected
            ? JETBRAINS_UI.color.selectedForeground
            : hasHighlight
              ? "var(--intelligit-pycharm-selected-foreground)"
              : undefined,
        hoverBackground: hasHighlight
            ? isSelected
                ? JETBRAINS_UI.color.selected
                : "var(--intelligit-pycharm-selected)"
            : JETBRAINS_UI.color.hover,
    };
}

function TreeFileCheckbox({
    file,
    wiring,
}: {
    file: TreeRowFile;
    wiring: TreeFileWiring;
}): React.ReactElement | null {
    if (wiring.checkboxVisibility === "none") return null;
    if (
        wiring.checkboxVisibility === "hidden" ||
        (wiring.checkboxVisibility === "visible" && !wiring.onToggleCheck)
    ) {
        return (
            <Box
                as="span"
                w={`${CHECKBOX_SLOT_SIZE}px`}
                h={`${CHECKBOX_SLOT_SIZE}px`}
                flexShrink={0}
            />
        );
    }
    if (!wiring.onToggleCheck) return null;
    return (
        <VscCheckbox
            isChecked={wiring.isChecked ?? false}
            onChange={() => wiring.onToggleCheck?.(file.path)}
            ariaLabel={file.path}
        />
    );
}

function TreeFileLabel({
    file,
    parentPath,
    showParentPath,
}: {
    file: TreeRowFile;
    parentPath: string;
    showParentPath?: boolean;
}): React.ReactElement {
    return (
        <Flex as="span" align="baseline" gap="4px" flex={1} minW={0} overflow="hidden">
            <Box
                as="span"
                flexShrink={0}
                maxW="100%"
                overflow="hidden"
                textOverflow="ellipsis"
                whiteSpace="nowrap"
                textDecoration={file.status === "D" ? "line-through" : undefined}
            >
                {getLeafName(file.path)}
            </Box>
            {showParentPath && parentPath ? (
                <Box
                    as="span"
                    color="var(--intelligit-pycharm-muted)"
                    fontSize="11px"
                    flex={1}
                    minW={0}
                    overflow="hidden"
                    textOverflow="ellipsis"
                    whiteSpace="nowrap"
                >
                    {parentPath}
                </Box>
            ) : null}
        </Flex>
    );
}

function TreeFileStats({
    file,
    rowVariant = "default",
}: {
    file: TreeRowFile;
    rowVariant?: "default" | "commit-panel";
}): React.ReactElement | null {
    if (file.additions <= 0 && file.deletions <= 0) return null;
    return (
        <Box as="span" ml="auto" fontSize="11px" flexShrink={0}>
            {file.additions > 0 ? (
                <Box
                    as="span"
                    color={
                        rowVariant === "commit-panel"
                            ? "var(--intelligit-pycharm-added)"
                            : "var(--vscode-gitDecoration-addedResourceForeground, #8bcf7b)"
                    }
                    mr={rowVariant === "commit-panel" ? "3px" : "4px"}
                >
                    +{file.additions}
                </Box>
            ) : null}
            {file.deletions > 0 ? (
                <Box
                    as="span"
                    color={
                        rowVariant === "commit-panel"
                            ? "var(--intelligit-pycharm-deleted)"
                            : "var(--vscode-gitDecoration-deletedResourceForeground, #d76f6f)"
                    }
                >
                    -{file.deletions}
                </Box>
            ) : null}
        </Box>
    );
}

function TreeFileRowImpl({
    file,
    depth,
    showParentPath,
    ariaLevel,
    indentMetrics = DEFAULT_INDENT_METRICS,
    rowVariant = "default",
    wiring,
}: {
    file: TreeRowFile;
    depth: number;
    showParentPath?: boolean;
    ariaLevel?: number;
    indentMetrics?: Readonly<TreeIndentMetrics>;
    rowVariant?: "default" | "commit-panel";
    wiring: TreeFileWiring;
}): React.ReactElement {
    const { isSelected, onSelect, onActivate, onContextMenu } = wiring;
    const parentPath = getParentPath(file.path);
    const isCurrent = wiring.isCurrent ?? false;
    const isDragSelected = wiring.isDragSelected ?? false;
    const isCommitPanel = rowVariant === "commit-panel";
    const visuals = treeFileVisuals(isSelected, isDragSelected);
    const { rowRef, openContextMenu } = useTreeFileRowInteractions(
        onSelect,
        onActivate,
        onContextMenu,
        !isCommitPanel,
    );
    return (
        <Flex
            ref={rowRef}
            align="center"
            gap="4px"
            pl={`${indentMetrics.indentBase + depth * indentMetrics.indentStep}px`}
            pr="6px"
            minH={isCommitPanel ? "22px" : undefined}
            lineHeight="22px"
            fontSize="13px"
            fontFamily={SYSTEM_FONT_STACK}
            cursor="pointer"
            position="relative"
            tabIndex={isCommitPanel ? undefined : 0}
            role={isCommitPanel ? undefined : "treeitem"}
            aria-selected={isCommitPanel ? undefined : isSelected}
            aria-level={isCommitPanel ? undefined : ariaLevel}
            aria-current={
                isCommitPanel
                    ? isCurrent
                        ? "true"
                        : undefined
                    : isSelected || isCurrent
                      ? "true"
                      : undefined
            }
            bg={visuals.background}
            color={
                isCommitPanel
                    ? isDragSelected
                        ? "var(--intelligit-pycharm-selected-foreground)"
                        : "var(--intelligit-pycharm-foreground)"
                    : visuals.color
            }
            boxShadow={
                isCommitPanel
                    ? undefined
                    : isSelected
                      ? `inset 2px 0 0 ${JETBRAINS_UI.color.focus}`
                      : undefined
            }
            _hover={{
                bg: isCommitPanel
                    ? isDragSelected
                        ? "var(--intelligit-pycharm-selected)"
                        : "rgba(255,255,255,0.05)"
                    : visuals.hoverBackground,
            }}
            _focusVisible={
                isCommitPanel
                    ? undefined
                    : {
                          outline: `1px solid ${JETBRAINS_UI.color.focus}`,
                          outlineOffset: "-1px",
                      }
            }
            data-vscode-context={wiring.vscodeContext}
            {...dataAttributeProps(wiring.dataAttributes)}
            draggable={wiring.draggable}
            onDragStart={wiring.onFileDragStart ?? wiring.onDragStart}
            onDragEnd={wiring.onFileDragEnd ?? wiring.onDragEnd}
            onClick={(event) => {
                if (isCheckboxInput(event.target)) return;
                if (isCommitPanel) wiring.onSelectWithEvent?.(event);
                else onSelect();
            }}
            onDoubleClick={isCommitPanel ? undefined : onActivate}
            onContextMenu={isCommitPanel ? undefined : openContextMenu}
            title={file.path}
        >
            <TreeIndentGuides
                treeDepth={depth}
                indentMetrics={indentMetrics}
                rowVariant={rowVariant}
            />
            <Box as="span" w={`${indentMetrics.indentStep}px`} flexShrink={0} />
            <TreeFileCheckbox file={file} wiring={wiring} />
            <TreeFileIcon status={file.status} icon={file.icon} />
            <TreeFileLabel file={file} parentPath={parentPath} showParentPath={showParentPath} />
            <TreeFileStats file={file} rowVariant={rowVariant} />
            <StatusBadge status={file.status} />
        </Flex>
    );
}

export const TreeFileRow = React.memo(TreeFileRowImpl);

/** Expands `{key: value}` into the `data-key={value}` props a row spreads. */
function dataAttributeProps(attributes?: Record<string, string>): Record<string, string> {
    return attributes
        ? Object.fromEntries(
              Object.entries(attributes).map(([key, value]) => [`data-${key}`, value]),
          )
        : {};
}

/**
 * Vertical rules marking each ancestor level, absolutely positioned inside a row.
 *
 * The first rule belongs to the row *above* this subtree — a section header in
 * the commit-info pane or an entry row in the Shelf and Stash trees. Its offset
 * and the derived child-rule positions travel together in `TreeIndentMetrics`.
 */
function TreeIndentGuidesImpl({
    treeDepth,
    indentMetrics = DEFAULT_INDENT_METRICS,
    rowVariant = "default",
}: {
    treeDepth: number;
    indentMetrics?: Readonly<TreeIndentMetrics>;
    rowVariant?: "default" | "commit-panel";
}): React.ReactElement {
    const guideColor =
        rowVariant === "commit-panel" ? COMMIT_PANEL_INDENT_GUIDE_COLOR : GUIDE_COLOR;
    return (
        <>
            <Box
                as="span"
                position="absolute"
                top={0}
                bottom={0}
                w="1px"
                bg={guideColor}
                left={`${indentMetrics.sectionGuideLeft}px`}
            />
            {Array.from({ length: treeDepth }, (_, level) => (
                <Box
                    key={level}
                    as="span"
                    position="absolute"
                    top={0}
                    bottom={0}
                    w="1px"
                    bg={guideColor}
                    left={`${indentMetrics.guideBase + level * indentMetrics.indentStep}px`}
                />
            ))}
        </>
    );
}

export const TreeIndentGuides = React.memo(TreeIndentGuidesImpl);

/** Avoid `instanceof` so checkbox guards work across browser and JSDOM realms. */
function isCheckboxInput(target: EventTarget | null): boolean {
    return (target as { tagName?: string } | null)?.tagName === "INPUT";
}
