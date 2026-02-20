// Directory row in the commit panel file tree. Shows a chevron toggle,
// checkbox (checked/indeterminate), folder icon, name, and file count.

import React from "react";
import { Flex, Box } from "@chakra-ui/react";
import type { ThemeFolderIconMap, ThemeTreeIcon } from "../../../../types";
import { VscCheckbox } from "./VscCheckbox";
import { IndentGuides, INDENT_BASE, INDENT_STEP } from "./IndentGuides";
import { TreeFolderIcon } from "./TreeIcons";
import { resolveFolderIcon } from "../../shared/utils";

interface Props {
    name: string;
    dirPath: string;
    depth: number;
    isExpanded: boolean;
    folderIcon?: ThemeTreeIcon;
    folderExpandedIcon?: ThemeTreeIcon;
    folderIconsByName?: ThemeFolderIconMap;
    fileCount: number;
    isAllChecked: boolean;
    isSomeChecked: boolean;
    onToggleExpand: (dirPath: string) => void;
    onToggleCheck: (dirPath: string) => void;
}

function FolderRowInner({
    name,
    dirPath,
    depth,
    isExpanded,
    folderIcon,
    folderExpandedIcon,
    folderIconsByName,
    fileCount,
    isAllChecked,
    isSomeChecked,
    onToggleExpand,
    onToggleCheck,
}: Props): React.ReactElement {
    const padLeft = INDENT_BASE + depth * INDENT_STEP;
    const resolvedIcon = resolveFolderIcon(
        dirPath || name,
        isExpanded,
        folderIconsByName,
        folderIcon,
        folderExpandedIcon,
    );

    return (
        <Flex
            align="center"
            gap="4px"
            pl={`${padLeft}px`}
            pr="6px"
            minH="22px"
            lineHeight="22px"
            fontSize="13px"
            fontFamily="var(--vscode-font-family)"
            cursor="pointer"
            position="relative"
            whiteSpace="nowrap"
            _hover={{ bg: "var(--vscode-list-hoverBackground)" }}
            onClick={(e) => {
                if ((e.target as HTMLElement).tagName === "INPUT") return;
                onToggleExpand(dirPath);
            }}
            title={dirPath}
        >
            <IndentGuides treeDepth={depth} />
            <Box
                as="span"
                fontSize="11px"
                w="14px"
                textAlign="center"
                flexShrink={0}
                opacity={0.7}
                transform={isExpanded ? "rotate(90deg)" : undefined}
                transition="transform 0.15s ease"
                display="inline-block"
            >
                &#9654;
            </Box>
            <VscCheckbox
                isChecked={isAllChecked}
                isIndeterminate={isSomeChecked}
                onChange={() => onToggleCheck(dirPath)}
            />
            <TreeFolderIcon isExpanded={isExpanded} icon={resolvedIcon} />
            <Box as="span" flex={1} minW={0} whiteSpace="nowrap" opacity={0.85}>
                {name}
            </Box>
            <Box
                as="span"
                ml="6px"
                flexShrink={0}
                whiteSpace="nowrap"
                fontSize="11px"
                color="var(--vscode-descriptionForeground)"
            >
                {fileCount} {fileCount === 1 ? "file" : "files"}
            </Box>
        </Flex>
    );
}

export const FolderRow = React.memo(FolderRowInner);
