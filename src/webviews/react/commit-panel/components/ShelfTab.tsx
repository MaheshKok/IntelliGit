// Shelf (stash) tab showing the list of stashed changes with a
// refresh toolbar and per-stash action buttons.

import React, { useCallback } from "react";
import { Flex, Box, IconButton, Tooltip } from "@chakra-ui/react";
import { StashRow } from "./StashRow";
import { getVsCodeApi } from "../hooks/useVsCodeApi";
import type { StashEntry } from "../../../../types";

interface Props {
    stashes: StashEntry[];
}

export function ShelfTab({ stashes }: Props): React.ReactElement {
    const vscode = getVsCodeApi();

    const handleRefresh = useCallback(() => {
        vscode.postMessage({ type: "refresh" });
    }, [vscode]);

    const handleApply = useCallback(
        (index: number) => {
            vscode.postMessage({ type: "stashApply", index });
        },
        [vscode],
    );

    const handlePop = useCallback(
        (index: number) => {
            vscode.postMessage({ type: "stashPop", index });
        },
        [vscode],
    );

    const handleDrop = useCallback(
        (index: number) => {
            vscode.postMessage({ type: "stashDrop", index });
        },
        [vscode],
    );

    return (
        <Flex direction="column" flex={1} overflow="hidden">
            <Flex
                align="center"
                gap="2px"
                px="6px"
                py="2px"
                minH="24px"
                borderBottom="1px solid var(--vscode-panel-border, #444)"
                flexShrink={0}
            >
                <Tooltip label="Refresh" fontSize="11px" placement="bottom" openDelay={300}>
                    <IconButton
                        aria-label="Refresh"
                        variant="toolbarGhost"
                        size="sm"
                        onClick={handleRefresh}
                        icon={
                            <svg width="14" height="14" viewBox="0 0 16 16">
                                <path
                                    fill="currentColor"
                                    d="M13.451 5.609l-.579-.939-1.068.812-.076.094c.335.57.528 1.236.528 1.949a4.093 4.093 0 0 1-4.09 4.09 4.093 4.093 0 0 1-4.09-4.09 4.088 4.088 0 0 1 3.354-4.027v1.938l4.308-2.906L7.43.002v1.906a5.593 5.593 0 0 0-4.856 5.617A5.594 5.594 0 0 0 8.166 13.1a5.594 5.594 0 0 0 5.592-5.575c0-1.755-.461-2.381-1.307-3.416l1-.5z"
                                />
                            </svg>
                        }
                    />
                </Tooltip>
            </Flex>

            <Box flex="1 1 auto" overflowY="auto">
                {stashes.length === 0 ? (
                    <Box
                        color="var(--vscode-descriptionForeground)"
                        fontSize="12px"
                        p="16px"
                        textAlign="center"
                    >
                        No shelved changes
                    </Box>
                ) : (
                    stashes.map((stash) => (
                        <StashRow
                            key={stash.index}
                            stash={stash}
                            onApply={handleApply}
                            onPop={handlePop}
                            onDrop={handleDrop}
                        />
                    ))
                )}
            </Box>
        </Flex>
    );
}
