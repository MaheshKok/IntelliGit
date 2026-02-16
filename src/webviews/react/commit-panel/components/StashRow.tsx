// Single stash entry row in the Shelf tab. Shows the stash message,
// date, and action buttons (apply, pop, delete).

import React from "react";
import { Flex, Box, IconButton, Tooltip } from "@chakra-ui/react";
import type { StashEntry } from "../../../../types";

interface Props {
    stash: StashEntry;
    onApply: (index: number) => void;
    onPop: (index: number) => void;
    onDrop: (index: number) => void;
}

function formatDate(iso: string): string {
    if (!iso) return "";
    const d = new Date(iso);
    const m = d.getMonth() + 1;
    const day = d.getDate();
    const yr = d.getFullYear().toString().slice(-2);
    let hr = d.getHours();
    const ampm = hr >= 12 ? "PM" : "AM";
    hr = hr % 12 || 12;
    const min = d.getMinutes().toString().padStart(2, "0");
    return `${m}/${day}/${yr} ${hr}:${min} ${ampm}`;
}

function StashRowInner({ stash, onApply, onPop, onDrop }: Props): React.ReactElement {
    return (
        <Flex
            align="center"
            gap="6px"
            px="8px"
            py="4px"
            lineHeight="22px"
            fontSize="12px"
            _hover={{ bg: "var(--vscode-list-hoverBackground)" }}
        >
            <Box as="svg" w="16px" h="16px" flexShrink={0} opacity={0.7} viewBox="0 0 16 16">
                <path
                    fill="currentColor"
                    d="M14.5 1h-13A1.5 1.5 0 0 0 0 2.5v2A1.5 1.5 0 0 0 1 5.95V13.5A1.5 1.5 0 0 0 2.5 15h11a1.5 1.5 0 0 0 1.5-1.5V5.95A1.5 1.5 0 0 0 16 4.5v-2A1.5 1.5 0 0 0 14.5 1zM14 13.5a.5.5 0 0 1-.5.5h-11a.5.5 0 0 1-.5-.5V6h12v7.5zm1-9a.5.5 0 0 1-.5.5h-13a.5.5 0 0 1-.5-.5v-2a.5.5 0 0 1 .5-.5h13a.5.5 0 0 1 .5.5v2z"
                />
            </Box>
            <Box flex={1} overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap">
                {stash.message}
            </Box>
            <Box color="var(--vscode-descriptionForeground)" fontSize="11px" flexShrink={0}>
                {formatDate(stash.date)}
            </Box>
            <Tooltip label="Apply" fontSize="11px">
                <IconButton
                    aria-label="Apply"
                    variant="toolbarGhost"
                    size="xs"
                    onClick={() => onApply(stash.index)}
                    icon={
                        <svg width="12" height="12" viewBox="0 0 16 16">
                            <path
                                fill="currentColor"
                                d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0z"
                            />
                        </svg>
                    }
                />
            </Tooltip>
            <Tooltip label="Pop (apply and remove)" fontSize="11px">
                <IconButton
                    aria-label="Pop"
                    variant="toolbarGhost"
                    size="xs"
                    onClick={() => onPop(stash.index)}
                    icon={
                        <svg width="12" height="12" viewBox="0 0 16 16">
                            <path
                                fill="currentColor"
                                d="M8 1a.75.75 0 0 1 .75.75v6.19l1.72-1.72a.75.75 0 1 1 1.06 1.06l-3 3a.75.75 0 0 1-1.06 0l-3-3a.75.75 0 0 1 1.06-1.06l1.72 1.72V1.75A.75.75 0 0 1 8 1z"
                                transform="rotate(180 8 8)"
                            />
                        </svg>
                    }
                />
            </Tooltip>
            <Tooltip label="Delete" fontSize="11px">
                <IconButton
                    aria-label="Delete"
                    variant="toolbarGhost"
                    size="xs"
                    onClick={() => onDrop(stash.index)}
                    icon={
                        <svg width="12" height="12" viewBox="0 0 16 16">
                            <path
                                fill="currentColor"
                                d="M7.116 8l-4.558 4.558.884.884L8 8.884l4.558 4.558.884-.884L8.884 8l4.558-4.558-.884-.884L8 7.116 3.442 2.558l-.884.884L7.116 8z"
                            />
                        </svg>
                    }
                />
            </Tooltip>
        </Flex>
    );
}

export const StashRow = React.memo(StashRowInner);
