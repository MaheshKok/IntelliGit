// Directory row in the commit panel file tree. Shows a chevron toggle,
// checkbox (checked/indeterminate), folder icon, name, and file count.

import React from "react";
import { Flex, Box } from "@chakra-ui/react";
import { SYSTEM_FONT_STACK } from "../../../../utils/constants";
import type { ThemeFolderIconMap, ThemeTreeIcon } from "../../../../types";
import { VscCheckbox } from "./VscCheckbox";
import { IndentGuides, INDENT_BASE, INDENT_STEP } from "./IndentGuides";
import { TreeFolderIcon } from "./TreeIcons";
import { resolveFolderIcon } from "../../shared/utils";
import { ChevronIcon } from "../../shared/components";
import { t } from "../../shared/i18n";

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
            fontFamily={SYSTEM_FONT_STACK}
            cursor="pointer"
            position="relative"
            whiteSpace="nowrap"
            color="var(--intelligit-pycharm-foreground)"
            _hover={{ bg: "rgba(255,255,255,0.05)" }}
            onClick={(e) => {
                if ((e.target as HTMLElement).tagName === "INPUT") return;
                onToggleExpand(dirPath);
            }}
            title={dirPath}
        >
            <IndentGuides treeDepth={depth} />
            <ChevronIcon expanded={isExpanded} />
            <VscCheckbox
                isChecked={isAllChecked}
                isIndeterminate={isSomeChecked}
                onChange={() => onToggleCheck(dirPath)}
            />
            <TreeFolderIcon isExpanded={isExpanded} icon={resolvedIcon} />
            <Box as="span" flex={1} minW={0} whiteSpace="nowrap" opacity={0.82}>
                {name}
            </Box>
            <Box
                as="span"
                ml="6px"
                flexShrink={0}
                whiteSpace="nowrap"
                fontSize="11px"
                color="var(--intelligit-pycharm-muted)"
            >
                {t("common.fileCount", { count: fileCount })}
            </Box>
        </Flex>
    );
}

export const FolderRow = React.memo(FolderRowInner);
