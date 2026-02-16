// Collapsible section header (Changes / Unversioned Files) with a
// chevron toggle, section-level checkbox, label, and file count badge.

import React from "react";
import { Flex, Box, Checkbox } from "@chakra-ui/react";

interface Props {
    label: string;
    count: number;
    isOpen: boolean;
    isAllChecked: boolean;
    isSomeChecked: boolean;
    onToggleOpen: () => void;
    onToggleCheck: () => void;
}

export function SectionHeader({
    label,
    count,
    isOpen,
    isAllChecked,
    isSomeChecked,
    onToggleOpen,
    onToggleCheck,
}: Props): React.ReactElement {
    return (
        <Flex
            align="center"
            gap="4px"
            px="6px"
            py="2px"
            cursor="pointer"
            userSelect="none"
            fontWeight={700}
            fontSize="11px"
            textTransform="uppercase"
            letterSpacing="0.3px"
            lineHeight="20px"
            position="relative"
            _hover={{ bg: "var(--vscode-list-hoverBackground)" }}
            onClick={(e) => {
                if ((e.target as HTMLElement).tagName === "INPUT") return;
                onToggleOpen();
            }}
        >
            <Box
                as="span"
                fontSize="11px"
                w="14px"
                textAlign="center"
                flexShrink={0}
                opacity={0.7}
                transform={isOpen ? "rotate(90deg)" : undefined}
                transition="transform 0.15s ease"
                display="inline-block"
            >
                &#9654;
            </Box>
            <Checkbox
                size="sm"
                isChecked={isAllChecked}
                isIndeterminate={isSomeChecked}
                onChange={onToggleCheck}
            />
            <Box as="span">{label}</Box>
            <Box
                as="span"
                ml="auto"
                color="var(--vscode-descriptionForeground)"
                fontWeight="normal"
                fontSize="11px"
            >
                {count}
            </Box>
        </Flex>
    );
}
