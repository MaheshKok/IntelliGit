// Single file row in the commit panel file tree. Shows checkbox, file type
// icon, filename (colored by status), stats (+/-), and status badge.

import React from "react";
import { Flex, Box } from "@chakra-ui/react";
import { VscCheckbox } from "./VscCheckbox";
import { FileTypeIcon } from "./FileTypeIcon";
import { StatusBadge } from "./StatusBadge";
import { IndentGuides, INDENT_BASE, INDENT_STEP } from "./IndentGuides";
import type { WorkingFile } from "../../../../types";

const STATUS_COLORS: Record<string, string> = {
    M: "var(--vscode-gitDecoration-modifiedResourceForeground, #d19a66)",
    A: "var(--vscode-gitDecoration-addedResourceForeground, #73c991)",
    D: "var(--vscode-gitDecoration-deletedResourceForeground, #c74e39)",
    R: "var(--vscode-gitDecoration-renamedResourceForeground, #a371f7)",
    U: "var(--vscode-gitDecoration-conflictingResourceForeground, #e5c07b)",
    "?": "var(--vscode-gitDecoration-untrackedResourceForeground, #73c991)",
};

interface Props {
    file: WorkingFile;
    depth: number;
    isChecked: boolean;
    groupByDir: boolean;
    onToggle: (path: string) => void;
    onClick: (path: string) => void;
}

function FileRowInner({
    file,
    depth,
    isChecked,
    groupByDir,
    onToggle,
    onClick,
}: Props): React.ReactElement {
    const padLeft = INDENT_BASE + depth * INDENT_STEP;
    const fileName = file.path.split("/").pop() ?? file.path;
    const dir = file.path.split("/").slice(0, -1).join("/");
    const fnColor = STATUS_COLORS[file.status] ?? "var(--vscode-foreground)";

    return (
        <Flex
            align="center"
            gap="4px"
            pl={`${padLeft}px`}
            pr="6px"
            lineHeight="20px"
            fontSize="13px"
            cursor="pointer"
            position="relative"
            _hover={{ bg: "var(--vscode-list-hoverBackground)" }}
            data-vscode-context={JSON.stringify({
                webviewSection: "file",
                filePath: file.path,
                preventDefaultContextMenuItems: true,
            })}
            onClick={(e) => {
                if ((e.target as HTMLElement).tagName === "INPUT") return;
                onClick(file.path);
            }}
            title={file.path}
        >
            <IndentGuides treeDepth={depth} />
            <Box as="span" w="13px" flexShrink={0} />
            <VscCheckbox isChecked={isChecked} onChange={() => onToggle(file.path)} />
            <FileTypeIcon filename={fileName} status={file.status} />
            <Box
                as="span"
                flex={1}
                overflow="hidden"
                textOverflow="ellipsis"
                whiteSpace="nowrap"
                color={fnColor}
                textDecoration={file.status === "D" ? "line-through" : undefined}
            >
                {fileName}
            </Box>
            {!groupByDir && dir && (
                <Box as="span" color="var(--vscode-descriptionForeground)" fontSize="11px" ml="4px">
                    {dir}
                </Box>
            )}
            {(file.additions > 0 || file.deletions > 0) && (
                <Box as="span" ml="auto" fontSize="11px" flexShrink={0}>
                    {file.additions > 0 && (
                        <Box
                            as="span"
                            color="var(--vscode-gitDecoration-addedResourceForeground, #2ea043)"
                            mr="4px"
                        >
                            +{file.additions}
                        </Box>
                    )}
                    {file.deletions > 0 && (
                        <Box
                            as="span"
                            color="var(--vscode-gitDecoration-deletedResourceForeground, #f85149)"
                        >
                            -{file.deletions}
                        </Box>
                    )}
                </Box>
            )}
            <StatusBadge status={file.status} />
        </Flex>
    );
}

export const FileRow = React.memo(FileRowInner);
