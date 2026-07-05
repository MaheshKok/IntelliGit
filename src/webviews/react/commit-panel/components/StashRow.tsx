// Single stash entry row in the Stash tab. Shows the stash message,
// date, and action buttons (apply, pop, delete).

import React from "react";
import { Flex, Box, Button, Tooltip } from "@chakra-ui/react";
import { getSettings, resolveIconColor } from "../../shared/settings";
import type { StashEntry } from "../../../../types";
import { formatDateTime } from "../../shared/date";
import { t } from "../../shared/i18n";

interface Props {
    stash: StashEntry;
    onApply: (index: number) => void;
    onPop: (index: number) => void;
    onDrop: (index: number) => void;
}

const STANDARD_STASH_ICON_COLOR = "var(--vscode-icon-foreground)";

const stashIconColor = (color: string): string =>
    resolveIconColor(color, STANDARD_STASH_ICON_COLOR);

function StashRowInner({ stash, onApply, onPop, onDrop }: Props): React.ReactElement {
    const { hoverDelay, tooltipsEnabled } = getSettings();

    return (
        <Flex
            align="center"
            gap="4px"
            px="6px"
            py="2px"
            lineHeight="18px"
            fontSize="11.5px"
            _hover={{ bg: "var(--vscode-list-hoverBackground)" }}
        >
            <Box
                as="svg"
                w="14px"
                h="14px"
                flexShrink={0}
                opacity={0.7}
                viewBox="0 0 16 16"
                color={stashIconColor("#c8a2ff")}
            >
                <path
                    fill="currentColor"
                    d="M14.5 1h-13A1.5 1.5 0 0 0 0 2.5v2A1.5 1.5 0 0 0 1 5.95V13.5A1.5 1.5 0 0 0 2.5 15h11a1.5 1.5 0 0 0 1.5-1.5V5.95A1.5 1.5 0 0 0 16 4.5v-2A1.5 1.5 0 0 0 14.5 1zM14 13.5a.5.5 0 0 1-.5.5h-11a.5.5 0 0 1-.5-.5V6h12v7.5zm1-9a.5.5 0 0 1-.5.5h-13a.5.5 0 0 1-.5-.5v-2a.5.5 0 0 1 .5-.5h13a.5.5 0 0 1 .5.5v2z"
                />
            </Box>
            <Box flex={1} overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap">
                {stash.message}
            </Box>
            <Box color="var(--vscode-descriptionForeground)" fontSize="10.5px" flexShrink={0}>
                {formatDateTime(stash.date)}
            </Box>
            <Tooltip
                label={t("common.apply")}
                fontSize="11px"
                openDelay={hoverDelay}
                isDisabled={!tooltipsEnabled}
            >
                <Button
                    aria-label={t("common.apply")}
                    variant="toolbarGhost"
                    size="xs"
                    onClick={() => onApply(stash.index)}
                    leftIcon={
                        <svg
                            width="12"
                            height="12"
                            viewBox="0 0 16 16"
                            style={{ color: stashIconColor("#a6e3a1") }}
                        >
                            <path
                                fill="currentColor"
                                d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0z"
                            />
                        </svg>
                    }
                    minW="48px"
                    h="18px"
                    px="6px"
                >
                    {t("common.apply")}
                </Button>
            </Tooltip>
            <Tooltip
                label={t("stash.action.popDescription")}
                fontSize="11px"
                openDelay={hoverDelay}
                isDisabled={!tooltipsEnabled}
            >
                <Button
                    aria-label={t("common.pop")}
                    variant="toolbarGhost"
                    size="xs"
                    onClick={() => onPop(stash.index)}
                    leftIcon={
                        <svg
                            width="12"
                            height="12"
                            viewBox="0 0 16 16"
                            style={{ color: stashIconColor("#8fd5ff") }}
                        >
                            <path
                                fill="currentColor"
                                d="M8 1a.75.75 0 0 1 .75.75v6.19l1.72-1.72a.75.75 0 1 1 1.06 1.06l-3 3a.75.75 0 0 1-1.06 0l-3-3a.75.75 0 0 1 1.06-1.06l1.72 1.72V1.75A.75.75 0 0 1 8 1z"
                                transform="rotate(180 8 8)"
                            />
                        </svg>
                    }
                    minW="42px"
                    h="18px"
                    px="6px"
                >
                    {t("common.pop")}
                </Button>
            </Tooltip>
            <Tooltip
                label={t("common.delete")}
                fontSize="11px"
                openDelay={hoverDelay}
                isDisabled={!tooltipsEnabled}
            >
                <Button
                    aria-label={t("common.delete")}
                    variant="toolbarGhost"
                    size="xs"
                    onClick={() => onDrop(stash.index)}
                    leftIcon={
                        <svg
                            width="12"
                            height="12"
                            viewBox="0 0 16 16"
                            style={{ color: stashIconColor("#ff736d") }}
                        >
                            <path
                                fill="currentColor"
                                d="M7.116 8l-4.558 4.558.884.884L8 8.884l4.558 4.558.884-.884L8.884 8l4.558-4.558-.884-.884L8 7.116 3.442 2.558l-.884.884L7.116 8z"
                            />
                        </svg>
                    }
                    minW="54px"
                    h="18px"
                    px="6px"
                >
                    {t("common.delete")}
                </Button>
            </Tooltip>
        </Flex>
    );
}

/**
 * Memoized stash entry row with inline apply, pop, and delete actions.
 *
 * Action callbacks receive the stash index from host data so the stash tab can
 * send the matching command without deriving identity from the display label.
 */
export const StashRow = React.memo(StashRowInner);
