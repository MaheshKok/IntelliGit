// The Changed Files tree. One implementation shared by the commit-info pane and
// by the Shelf and Stash entry subtrees, so a file reads the same wherever it is
// listed. Callers supply per-row wiring; the rows own layout, indent guides and
// keyboard handling.

import React, { useCallback, useEffect, useRef } from "react";
import { Box, Flex } from "@chakra-ui/react";
import { SYSTEM_FONT_STACK } from "../../../../utils/constants";
import type { ThemeFolderIconMap, ThemeTreeIcon } from "../../../../types";
import { FileTypeIcon } from "../../commit-panel/components/FileTypeIcon";
import { StatusBadge } from "../../commit-panel/components/StatusBadge";
import { TreeFolderIcon } from "./TreeIcons";
import { ChevronIcon } from "./Icons";
import { resolveFolderIcon } from "../utils/folderIcons";
import { getLeafName, getParentPath } from "../utils/path";
import { JETBRAINS_UI } from "../tokens";
import { t } from "../i18n";
import { countFiles, type TreeEntry, type TreeFolder } from "../fileTree";

/** Horizontal distance between nested tree levels. */
export const TREE_INDENT_STEP = 14;
/** Half a chevron, used to centre a guide line under the glyph above it. */
const CHEVRON_HALF = 8;
/**
 * Horizontal gap between the guide a parent row draws and its children's. Fixed
 * rather than folded into the child indent, so the two lines stay equally far
 * apart wherever the parent row's chevron sits.
 */
const GUIDE_STEP_FROM_PARENT = 10;
/** Default guide offset: centred under a `SectionHeader` chevron. */
const DEFAULT_SECTION_GUIDE = 8 + CHEVRON_HALF;
/**
 * Guide offset for a subtree under a Shelf or Stash entry row, whose chevron sits
 * one row margin (8px) plus one row padding (6px) from the tree's left edge.
 */
export const ENTRY_ROW_GUIDE_LEFT = 8 + 6 + CHEVRON_HALF;
/** Left padding of a depth-0 row whose parent draws its guide at `sectionGuideLeft`. */
function rowIndentBase(sectionGuideLeft: number): number {
    return sectionGuideLeft + GUIDE_STEP_FROM_PARENT - CHEVRON_HALF;
}
const GUIDE_COLOR = "var(--vscode-tree-indentGuidesStroke, rgba(154, 169, 198, 0.22))";

/** The minimum a row needs; both `CommitFile` and `WorkingFile` satisfy it. */
export interface TreeRowFile {
    path: string;
    status: string;
    additions: number;
    deletions: number;
    icon?: ThemeTreeIcon;
}

/** Per-file wiring a caller supplies. Everything beyond selection is optional. */
export interface TreeFileWiring {
    /** Whether this row is the tree's current file; the caller owns the identity. */
    isSelected: boolean;
    onSelect: () => void;
    onActivate?: () => void;
    onContextMenu?: (x: number, y: number, returnFocusTarget: HTMLElement) => void;
    /** Serialized VS Code context metadata; omit to leave the native menu alone. */
    vscodeContext?: string;
    /** Extra `data-*` attributes, keyed without the `data-` prefix. */
    dataAttributes?: Record<string, string>;
    draggable?: boolean;
    onDragStart?: (event: React.DragEvent<HTMLElement>) => void;
}

interface SharedTreeOptions<F extends TreeRowFile> {
    depth: number;
    isDirectoryExpanded: (path: string) => boolean;
    onToggleDirectory: (path: string) => void;
    fileWiring: (file: F) => TreeFileWiring;
    folderIcon?: ThemeTreeIcon;
    folderExpandedIcon?: ThemeTreeIcon;
    folderIconsByName?: ThemeFolderIconMap;
    /** Shows each file's parent directory beside its name; used by flat listings. */
    showParentPath?: boolean;
    /** Guide offset for the row above this subtree. Defaults to a section header. */
    sectionGuideLeft?: number;
    /** `aria-level` of the outermost rows; omit outside a `role="tree"`. */
    ariaLevel?: number;
}

interface FileTreeRowsProps<F extends TreeRowFile> extends SharedTreeOptions<F> {
    entries: TreeEntry<F>[];
}

/** Recursively renders one file tree: folders first as the builder ordered them. */
export function FileTreeRows<F extends TreeRowFile>({
    entries,
    ...options
}: FileTreeRowsProps<F>): React.ReactElement {
    const { depth, isDirectoryExpanded, onToggleDirectory, fileWiring } = options;
    return (
        <>
            {entries.map((entry) => {
                if (entry.type === "file") {
                    return (
                        <TreeFileRow
                            key={entry.file.path}
                            file={entry.file}
                            depth={depth}
                            showParentPath={options.showParentPath}
                            sectionGuideLeft={options.sectionGuideLeft}
                            ariaLevel={options.ariaLevel}
                            wiring={fileWiring(entry.file)}
                        />
                    );
                }
                const isExpanded = isDirectoryExpanded(entry.path);
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
                            sectionGuideLeft={options.sectionGuideLeft}
                            ariaLevel={options.ariaLevel}
                            onToggle={() => onToggleDirectory(entry.path)}
                        />
                        {isExpanded ? (
                            <FileTreeRows
                                {...options}
                                entries={entry.children}
                                depth={depth + 1}
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

function TreeFolderRow<F extends TreeRowFile>({
    folder,
    depth,
    isExpanded,
    fileCount,
    folderIcon,
    folderExpandedIcon,
    folderIconsByName,
    sectionGuideLeft = DEFAULT_SECTION_GUIDE,
    ariaLevel,
    onToggle,
}: {
    folder: TreeFolder<F>;
    depth: number;
    isExpanded: boolean;
    fileCount: number;
    folderIcon?: ThemeTreeIcon;
    folderExpandedIcon?: ThemeTreeIcon;
    folderIconsByName?: ThemeFolderIconMap;
    sectionGuideLeft?: number;
    ariaLevel?: number;
    onToggle: () => void;
}): React.ReactElement {
    const resolvedIcon = resolveFolderIcon(
        folder.path || folder.name,
        isExpanded,
        folderIconsByName,
        folderIcon,
        folderExpandedIcon,
    );
    return (
        <Flex
            as="button"
            type="button"
            align="center"
            gap="4px"
            w="100%"
            pl={`${rowIndentBase(sectionGuideLeft) + depth * TREE_INDENT_STEP}px`}
            pr="6px"
            border="0"
            bg="transparent"
            textAlign="left"
            lineHeight="22px"
            fontSize="13px"
            fontFamily={SYSTEM_FONT_STACK}
            color="inherit"
            cursor="pointer"
            position="relative"
            role="treeitem"
            aria-expanded={isExpanded}
            aria-level={ariaLevel}
            _hover={{ bg: JETBRAINS_UI.color.hover }}
            onClick={onToggle}
            title={folder.path}
        >
            <TreeIndentGuides treeDepth={depth} sectionGuideLeft={sectionGuideLeft} />
            <ChevronIcon expanded={isExpanded} />
            <TreeFolderIcon isExpanded={isExpanded} icon={resolvedIcon} />
            <Box as="span" flex={1} opacity={0.85}>
                {folder.name}
            </Box>
            <Box as="span" ml="auto" fontSize="11px" color="var(--vscode-descriptionForeground)">
                {t("common.fileCount", { count: fileCount })}
            </Box>
        </Flex>
    );
}

function TreeFileRow({
    file,
    depth,
    showParentPath,
    sectionGuideLeft = DEFAULT_SECTION_GUIDE,
    ariaLevel,
    wiring,
}: {
    file: TreeRowFile;
    depth: number;
    showParentPath?: boolean;
    sectionGuideLeft?: number;
    ariaLevel?: number;
    wiring: TreeFileWiring;
}): React.ReactElement {
    const rowRef = useRef<HTMLDivElement>(null);
    const { isSelected, onSelect, onActivate, onContextMenu } = wiring;
    const parentPath = getParentPath(file.path);

    const openContextMenu = useCallback(
        (event: React.MouseEvent<HTMLElement>) => {
            if (!onContextMenu) return;
            event.preventDefault();
            onContextMenu(event.clientX, event.clientY, event.currentTarget);
        },
        [onContextMenu],
    );

    useEffect(() => {
        const el = rowRef.current;
        if (!el) return;
        const handleKeyDown = (event: KeyboardEvent): void => {
            if (event.key === "Enter") {
                event.preventDefault();
                (onActivate ?? onSelect)();
                return;
            }
            if (event.key === " " || event.code === "Space") {
                event.preventDefault();
                onSelect();
                return;
            }
            if (!onContextMenu) return;
            if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
            event.preventDefault();
            const rect = el.getBoundingClientRect();
            onContextMenu(rect.left, rect.bottom, el);
        };
        el.addEventListener("keydown", handleKeyDown);
        return () => el.removeEventListener("keydown", handleKeyDown);
    }, [onActivate, onSelect, onContextMenu]);

    return (
        <Flex
            ref={rowRef}
            align="center"
            gap="4px"
            pl={`${rowIndentBase(sectionGuideLeft) + depth * TREE_INDENT_STEP}px`}
            pr="6px"
            lineHeight="22px"
            fontSize="13px"
            fontFamily={SYSTEM_FONT_STACK}
            cursor="pointer"
            position="relative"
            tabIndex={0}
            role="treeitem"
            aria-selected={isSelected}
            aria-level={ariaLevel}
            aria-current={isSelected ? "true" : undefined}
            bg={isSelected ? JETBRAINS_UI.color.selected : undefined}
            color={isSelected ? JETBRAINS_UI.color.selectedForeground : undefined}
            boxShadow={isSelected ? `inset 2px 0 0 ${JETBRAINS_UI.color.focus}` : undefined}
            _hover={{ bg: isSelected ? JETBRAINS_UI.color.selected : JETBRAINS_UI.color.hover }}
            _focusVisible={{
                outline: `1px solid ${JETBRAINS_UI.color.focus}`,
                outlineOffset: "-1px",
            }}
            data-vscode-context={wiring.vscodeContext}
            {...dataAttributeProps(wiring.dataAttributes)}
            draggable={wiring.draggable}
            onDragStart={wiring.onDragStart}
            onClick={onSelect}
            onDoubleClick={onActivate}
            onContextMenu={openContextMenu}
            title={file.path}
        >
            <TreeIndentGuides treeDepth={depth} sectionGuideLeft={sectionGuideLeft} />
            <Box as="span" w={`${TREE_INDENT_STEP}px`} flexShrink={0} />
            <FileTypeIcon status={file.status} icon={file.icon} />
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
            {file.additions > 0 || file.deletions > 0 ? (
                <Box as="span" ml="auto" fontSize="11px" flexShrink={0}>
                    {file.additions > 0 ? (
                        <Box
                            as="span"
                            color="var(--vscode-gitDecoration-addedResourceForeground, #8bcf7b)"
                            mr="4px"
                        >
                            +{file.additions}
                        </Box>
                    ) : null}
                    {file.deletions > 0 ? (
                        <Box
                            as="span"
                            color="var(--vscode-gitDecoration-deletedResourceForeground, #d76f6f)"
                        >
                            -{file.deletions}
                        </Box>
                    ) : null}
                </Box>
            ) : null}
            <StatusBadge status={file.status} />
        </Flex>
    );
}

/** Expands `{key: value}` into the `data-key={value}` props a row spreads. */
function dataAttributeProps(attributes?: Record<string, string>): Record<string, string> {
    if (!attributes) return {};
    return Object.fromEntries(
        Object.entries(attributes).map(([key, value]) => [`data-${key}`, value]),
    );
}

/**
 * Vertical rules marking each ancestor level, absolutely positioned inside a row.
 *
 * The first rule belongs to the row *above* this subtree — a section header in
 * the commit-info pane, an entry row in the Shelf and Stash trees — so its
 * offset is the caller's to set.
 */
function TreeIndentGuides({
    treeDepth,
    sectionGuideLeft = DEFAULT_SECTION_GUIDE,
}: {
    treeDepth: number;
    sectionGuideLeft?: number;
}): React.ReactElement {
    return (
        <>
            <Box
                as="span"
                position="absolute"
                top={0}
                bottom={0}
                w="1px"
                bg={GUIDE_COLOR}
                left={`${sectionGuideLeft}px`}
            />
            {Array.from({ length: treeDepth }, (_, level) => (
                <Box
                    key={level}
                    as="span"
                    position="absolute"
                    top={0}
                    bottom={0}
                    w="1px"
                    bg={GUIDE_COLOR}
                    left={`${rowIndentBase(sectionGuideLeft) + CHEVRON_HALF + level * TREE_INDENT_STEP}px`}
                />
            ))}
        </>
    );
}
