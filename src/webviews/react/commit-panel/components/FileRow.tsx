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
import { getLeafName, getParentPath } from "../../shared/utils";

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
}: Props): React.ReactElement {
    const padLeft = INDENT_BASE + depth * INDENT_STEP;
    const fileName = getLeafName(file.path);
    const dir = getParentPath(file.path);

    return (
        <Flex
            align="center"
            gap="4px"
            pl={`${padLeft}px`}
            pr="6px"
            minH="22px"
            lineHeight="22px"
            fontSize="13px"
            fontFamily={SYSTEM_FONT_STACK}
            cursor="pointer"
            position="relative"
            color={
                isDragSelected
                    ? "var(--intelligit-pycharm-selected-foreground)"
                    : "var(--intelligit-pycharm-foreground)"
            }
            bg={isDragSelected ? "var(--intelligit-pycharm-selected)" : undefined}
            _hover={{
                bg: isDragSelected
                    ? "var(--intelligit-pycharm-selected)"
                    : "rgba(255,255,255,0.05)",
            }}
            aria-selected={isDragSelected}
            data-vscode-context={JSON.stringify({
                webviewSection: "file",
                filePath: file.path,
                preventDefaultContextMenuItems: true,
            })}
            onClick={(e) => {
                if ((e.target as HTMLElement).tagName === "INPUT") return;
                onClick(e, file);
            }}
            draggable={draggable}
            onDragStart={(event) => onDragStart?.(event, file)}
            onDragEnd={onDragEnd}
            title={file.path}
        >
            <IndentGuides treeDepth={depth} />
            <Box as="span" w={`${INDENT_STEP}px`} flexShrink={0} />
            <VscCheckbox isChecked={isChecked} onChange={() => onToggle(file.path)} />
            <FileTypeIcon status={file.status} icon={file.icon} />
            <Box
                as="span"
                flex={1}
                overflow="hidden"
                textOverflow="ellipsis"
                whiteSpace="nowrap"
                textDecoration={file.status === "D" ? "line-through" : undefined}
            >
                {fileName}
            </Box>
            {!groupByDir && dir && (
                <Box as="span" color="var(--intelligit-pycharm-muted)" fontSize="11px" ml="3px">
                    {dir}
                </Box>
            )}
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
 * hook, and shows parent directories only when directory grouping is disabled.
 */
export const FileRow = React.memo(FileRowInner);
