// Directory row in the commit panel file tree. Shows a chevron toggle,
// checkbox (checked/indeterminate), folder icon, name, and file count.

import React from "react";
import { Flex, Box } from "@chakra-ui/react";
import { VscCheckbox } from "./VscCheckbox";
import { IndentGuides, INDENT_BASE, INDENT_STEP } from "./IndentGuides";

interface Props {
    name: string;
    dirPath: string;
    depth: number;
    isExpanded: boolean;
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
    fileCount,
    isAllChecked,
    isSomeChecked,
    onToggleExpand,
    onToggleCheck,
}: Props): React.ReactElement {
    const padLeft = INDENT_BASE + depth * INDENT_STEP;

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
            <Box as="svg" w="16px" h="16px" flexShrink={0} viewBox="0 0 16 16">
                <path
                    fill="#c09553"
                    d="M14.5 4H7.71l-.85-.85A.5.5 0 0 0 6.5 3H1.5a.5.5 0 0 0-.5.5v9a.5.5 0 0 0 .5.5h13a.5.5 0 0 0 .5-.5V4.5a.5.5 0 0 0-.5-.5z"
                />
            </Box>
            <Box as="span" flex={1} opacity={0.85}>
                {name}
            </Box>
            <Box as="span" ml="auto" fontSize="11px" color="var(--vscode-descriptionForeground)">
                {fileCount}
            </Box>
        </Flex>
    );
}

export const FolderRow = React.memo(FolderRowInner);
