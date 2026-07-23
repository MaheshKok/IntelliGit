// Single file row in the commit panel file tree. Shows checkbox, file type
// icon, filename (colored by status), stats (+/-), and status badge.

import React from "react";
import { Flex, Box } from "@chakra-ui/react";
import { VscCheckbox } from "./VscCheckbox";
import { SYSTEM_FONT_STACK } from "../../../../utils/constants";
import { FileTypeIcon } from "./FileTypeIcon";
import { StatusBadge } from "./StatusBadge";
import { IndentGuides, INDENT_BASE, INDENT_STEP } from "./IndentGuides";
import type { WorkingFile } from "../../../../types";
import { getLeafName, getParentPath } from "../../shared/utils/path";

const CHECKBOX_SLOT_SIZE = 14;

/** Returns working-tree context metadata unless a row explicitly opts out of VS Code actions. */
function optionalContextMenuMetadata(
    enabled: boolean | undefined,
    metadata: string,
): string | undefined {
    return enabled === false ? undefined : metadata;
}

interface Props {
    file: WorkingFile;
    depth: number;
    isChecked: boolean;
    isDragSelected?: boolean;
    groupByDir: boolean;
    onToggle: (path: string) => void;
    onClick: (event: React.MouseEvent<HTMLElement>, file: WorkingFile) => void;
    draggable?: boolean;
    onDragStart?: (event: React.DragEvent<HTMLElement>, file: WorkingFile) => void;
    onDragEnd?: () => void;
    checkboxVisibility?: "visible" | "hidden" | "none";
    onActivate?: (path: string) => void;
    onOpenContextMenu?: (
        file: WorkingFile,
        x: number,
        y: number,
        returnFocusTarget: HTMLElement,
    ) => void;
    dataStashFile?: string;
    isCurrent?: boolean;
    contextMenuEnabled?: boolean;
}

/** Opens an opt-in custom row menu at pointer coordinates and suppresses the browser menu. */
function openFileRowContextMenu(
    event: React.MouseEvent<HTMLElement>,
    file: WorkingFile,
    onOpenContextMenu: Props["onOpenContextMenu"],
): void {
    if (!onOpenContextMenu) return;
    event.preventDefault();
    onOpenContextMenu(file, event.clientX, event.clientY, event.currentTarget);
}

/** Routes activation and context-menu keyboard gestures without changing working-tree row behavior. */
function handleFileRowKeyDown(
    event: React.KeyboardEvent<HTMLElement>,
    file: WorkingFile,
    onActivate: Props["onActivate"],
    onOpenContextMenu: Props["onOpenContextMenu"],
): void {
    if (event.key === "Enter" && onActivate) {
        event.preventDefault();
        onActivate(file.path);
        return;
    }
    if (
        !onOpenContextMenu ||
        (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10"))
    ) {
        return;
    }
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    onOpenContextMenu(file, rect.left, rect.bottom, event.currentTarget);
}

function FileRowInner({
    file,
    depth,
    isChecked,
    isDragSelected = false,
    groupByDir,
    onToggle,
    onClick,
    draggable,
    onDragStart,
    onDragEnd,
    checkboxVisibility = "visible",
    onActivate,
    onOpenContextMenu,
    dataStashFile,
    isCurrent = false,
    contextMenuEnabled,
}: Props): React.ReactElement {
    const padLeft = INDENT_BASE + depth * INDENT_STEP;
    const fileName = getLeafName(file.path);
    const dir = getParentPath(file.path);
    const isIgnoredFile = file.status === "!";

    return (
        <Flex
            as={onActivate ? "button" : undefined}
            type={onActivate ? "button" : undefined}
            align="center"
            gap="4px"
            pl={`${padLeft}px`}
            pr="6px"
            w={onActivate ? "100%" : undefined}
            minH="22px"
            lineHeight="22px"
            fontSize="13px"
            fontFamily={SYSTEM_FONT_STACK}
            cursor="pointer"
            position="relative"
            border={onActivate ? "0" : undefined}
            textAlign={onActivate ? "left" : undefined}
            color={
                isDragSelected
                    ? "var(--intelligit-pycharm-selected-foreground)"
                    : "var(--intelligit-pycharm-foreground)"
            }
            bg={
                isDragSelected
                    ? "var(--intelligit-pycharm-selected)"
                    : onActivate
                      ? "transparent"
                      : undefined
            }
            _hover={{
                bg: isDragSelected
                    ? "var(--intelligit-pycharm-selected)"
                    : "rgba(255,255,255,0.05)",
            }}
            aria-selected={isDragSelected}
            aria-current={isCurrent ? "true" : undefined}
            data-stash-file={dataStashFile}
            data-vscode-context={optionalContextMenuMetadata(
                contextMenuEnabled,
                JSON.stringify({
                    webviewSection: "file",
                    filePath: file.path,
                    webviewIgnoredFile: isIgnoredFile,
                    preventDefaultContextMenuItems: true,
                }),
            )}
            onClick={(e) => {
                if ((e.target as HTMLElement).tagName === "INPUT") return;
                onClick(e, file);
            }}
            draggable={draggable}
            onDragStart={(event) => onDragStart?.(event, file)}
            onDragEnd={onDragEnd}
            onDoubleClick={onActivate ? () => onActivate(file.path) : undefined}
            onContextMenu={(event) => openFileRowContextMenu(event, file, onOpenContextMenu)}
            onKeyDown={(event) => handleFileRowKeyDown(event, file, onActivate, onOpenContextMenu)}
            title={file.path}
        >
            <IndentGuides treeDepth={depth} />
            <Box as="span" w={`${INDENT_STEP}px`} flexShrink={0} />
            {checkboxVisibility === "hidden" ? (
                <Box
                    as="span"
                    w={`${CHECKBOX_SLOT_SIZE}px`}
                    h={`${CHECKBOX_SLOT_SIZE}px`}
                    flexShrink={0}
                />
            ) : checkboxVisibility === "visible" ? (
                <VscCheckbox
                    isChecked={isChecked}
                    onChange={() => onToggle(file.path)}
                    ariaLabel={file.path}
                />
            ) : null}
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
                    {fileName}
                </Box>
                {!groupByDir && dir && (
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
                        {dir}
                    </Box>
                )}
            </Flex>
            {(file.additions > 0 || file.deletions > 0) && (
                <Box as="span" ml="auto" fontSize="11px" flexShrink={0}>
                    {file.additions > 0 && (
                        <Box as="span" color="var(--intelligit-pycharm-added)" mr="3px">
                            +{file.additions}
                        </Box>
                    )}
                    {file.deletions > 0 && (
                        <Box as="span" color="var(--intelligit-pycharm-deleted)">
                            -{file.deletions}
                        </Box>
                    )}
                </Box>
            )}
            <StatusBadge status={file.status} />
        </Flex>
    );
}

/**
 * Memoized file row for working-tree entries.
 *
 * The row opens diffs when clicked, leaves checkbox changes to the selection
 * hook, and gives the leaf filename priority over its parent path. Optional
 * Activation turns the row into a keyboard-focusable stash-file control. An optional custom
 * context-menu callback uses browser or keyboard coordinates without enabling VS Code file actions.
 */
export const FileRow = React.memo(FileRowInner);
