// Collapsible section header (Changes / Unversioned Files) with a
// chevron toggle, section-level checkbox, label, and file count badge.

import React from "react";
import { Flex, Box } from "@chakra-ui/react";
import { VscCheckbox } from "./VscCheckbox";
import { SYSTEM_FONT_STACK } from "../../../../utils/constants";
import { ChevronIcon } from "../../shared/components";
import { t } from "../../shared/i18n";

interface Props {
    label: string;
    count: number;
    isOpen: boolean;
    isAllChecked: boolean;
    isSomeChecked: boolean;
    onToggleOpen: () => void;
    onToggleCheck: () => void;
    onDragOver?: React.DragEventHandler<HTMLDivElement>;
    onDrop?: React.DragEventHandler<HTMLDivElement>;
}

/**
 * Renders a collapsible Changes or Unversioned Files section header.
 *
 * The header separates open/closed state from tri-state selection so clicking the
 * checkbox toggles every file in the section while clicking the row only expands
 * or collapses that section.
 */
export function SectionHeader({
    label,
    count,
    isOpen,
    isAllChecked,
    isSomeChecked,
    onToggleOpen,
    onToggleCheck,
    onDragOver,
    onDrop,
}: Props): React.ReactElement {
    return (
        <Flex
            align="center"
            gap="4px"
            px="5px"
            py="2px"
            mx="4px"
            my="1px"
            borderRadius="5px"
            cursor="pointer"
            userSelect="none"
            fontWeight={600}
            fontSize="12px"
            fontFamily={SYSTEM_FONT_STACK}
            lineHeight="22px"
            position="relative"
            color="var(--intelligit-pycharm-foreground)"
            bg="var(--intelligit-pycharm-selected)"
            _hover={{ bg: "var(--intelligit-pycharm-selected-hover)" }}
            onClick={(e) => {
                if ((e.target as HTMLElement).tagName === "INPUT") return;
                onToggleOpen();
            }}
            onDragOver={onDragOver}
            onDrop={onDrop}
        >
            <ChevronIcon expanded={isOpen} />
            <VscCheckbox
                isChecked={isAllChecked}
                isIndeterminate={isSomeChecked}
                onChange={onToggleCheck}
            />
            <Box as="span">{label}</Box>
            <Box
                as="span"
                color="var(--intelligit-pycharm-muted)"
                opacity={0.88}
                fontWeight="normal"
                fontSize="11px"
            >
                {t("common.fileCount", { count })}
            </Box>
        </Flex>
    );
}
