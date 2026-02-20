// Single file row in the commit panel file tree. Shows checkbox, file type
// icon, filename (colored by status), stats (+/-), and status badge.

import React from "react";
import { Flex, Box } from "@chakra-ui/react";
import { VscCheckbox } from "./VscCheckbox";
import { FileTypeIcon } from "./FileTypeIcon";
import { StatusBadge } from "./StatusBadge";
import { IndentGuides, INDENT_BASE, INDENT_STEP } from "./IndentGuides";
import type { WorkingFile } from "../../../../types";
import { GIT_STATUS_COLORS } from "../../shared/tokens";

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
    const fnColor =
        file.status === "D"
            ? "var(--vscode-disabledForeground)"
            : (GIT_STATUS_COLORS[file.status] ?? "var(--vscode-foreground)");

    return (
        <Flex
            align="center"
            gap="3px"
            pl={`${padLeft}px`}
            pr="5px"
            minH="20px"
            lineHeight="20px"
            fontSize="12px"
            fontFamily="var(--vscode-font-family)"
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
            <Box as="span" w="12px" flexShrink={0} />
            <VscCheckbox isChecked={isChecked} onChange={() => onToggle(file.path)} />
            <FileTypeIcon filename={fileName} status={file.status} icon={file.icon} />
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
                <Box
                    as="span"
                    color="var(--vscode-descriptionForeground)"
                    fontSize="10.5px"
                    ml="3px"
                >
                    {dir}
                </Box>
            )}
            {(file.additions > 0 || file.deletions > 0) && (
                <Box as="span" ml="auto" fontSize="10.5px" flexShrink={0}>
                    {file.additions > 0 && (
                        <Box
                            as="span"
                            color="var(--vscode-gitDecoration-addedResourceForeground, #2ea043)"
                            mr="3px"
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
