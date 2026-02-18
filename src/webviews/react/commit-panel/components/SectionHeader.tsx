// Collapsible section header (Changes / Unversioned Files) with a
// chevron toggle, section-level checkbox, label, and file count badge.

import React from "react";
import { Flex, Box } from "@chakra-ui/react";
import { VscCheckbox } from "./VscCheckbox";

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
            px="5px"
            py="2px"
            mx="4px"
            my="1px"
            borderRadius="5px"
            cursor="pointer"
            userSelect="none"
            fontWeight={700}
            fontSize="12px"
            lineHeight="20px"
            position="relative"
            color="var(--vscode-foreground)"
            bg="rgba(121, 140, 183, 0.26)"
            _hover={{ bg: "var(--vscode-list-hoverBackground)" }}
            onClick={(e) => {
                if ((e.target as HTMLElement).tagName === "INPUT") return;
                onToggleOpen();
            }}
        >
            <Box
                as="span"
                fontSize="10px"
                w="13px"
                textAlign="center"
                flexShrink={0}
                opacity={0.7}
                transform={isOpen ? "rotate(90deg)" : undefined}
                transition="transform 0.15s ease"
                display="inline-block"
            >
                &#9654;
            </Box>
            <VscCheckbox
                isChecked={isAllChecked}
                isIndeterminate={isSomeChecked}
                onChange={onToggleCheck}
            />
            <Box as="span">{label}</Box>
            <Box
                as="span"
                color="var(--vscode-descriptionForeground)"
                fontWeight="normal"
                fontSize="11px"
            >
                {count} {count === 1 ? "file" : "files"}
            </Box>
        </Flex>
    );
}
