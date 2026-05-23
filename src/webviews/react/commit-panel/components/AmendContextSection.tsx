// Shown when "Amend commit" is checked: recent branch commits plus a hint that
// Changes / Unversioned Files follow (JetBrains-style commit dialog context).

import React from "react";
import { Box, Flex } from "@chakra-ui/react";
import type { AmendBranchCommitSummary } from "../../../../types";
import { formatDateTime } from "../../shared/date";
import { SYSTEM_FONT_STACK } from "../../../../utils/constants";

interface Props {
    commits: AmendBranchCommitSummary[];
    historyLoaded: boolean;
}

export function AmendContextSection({ commits, historyLoaded }: Props): React.ReactElement {
    return (
        <Box
            flexShrink={0}
            borderBottom="1px solid"
            borderColor="var(--vscode-panel-border, rgba(128,128,128,0.35))"
            maxH="220px"
            display="flex"
            flexDirection="column"
            overflow="hidden"
            bg="var(--vscode-editorWidget-background, var(--vscode-panel-background, rgba(128, 128, 128, 0.12)))"
        >
            <Box px="8px" py="6px" flexShrink={0}>
                <Box
                    fontSize="11px"
                    fontWeight={600}
                    fontFamily={SYSTEM_FONT_STACK}
                    color="var(--vscode-foreground)"
                    letterSpacing="0.02em"
                >
                    Commits on this branch
                </Box>
                <Box
                    fontSize="10px"
                    fontFamily={SYSTEM_FONT_STACK}
                    color="var(--vscode-descriptionForeground)"
                    mt="3px"
                    lineHeight="1.35"
                >
                    Working tree{" "}
                    <Box as="span" fontWeight={600}>
                        Changes
                    </Box>{" "}
                    and{" "}
                    <Box as="span" fontWeight={600}>
                        Unversioned Files
                    </Box>{" "}
                    are listed below.
                </Box>
            </Box>
            <Box flex={1} overflowY="auto" px="4px" pb="6px" minH="48px" aria-busy={!historyLoaded}>
                {!historyLoaded ? (
                    <Box
                        px="6px"
                        py="4px"
                        fontSize="11px"
                        color="var(--vscode-descriptionForeground)"
                        fontFamily={SYSTEM_FONT_STACK}
                    >
                        Loading branch history...
                    </Box>
                ) : commits.length === 0 ? (
                    <Box
                        px="6px"
                        py="4px"
                        fontSize="11px"
                        color="var(--vscode-descriptionForeground)"
                        fontFamily={SYSTEM_FONT_STACK}
                    >
                        No commits to show.
                    </Box>
                ) : (
                    commits.map((c, index) => (
                        <Flex
                            key={`${c.shortHash}-${index}`}
                            align="flex-start"
                            gap="6px"
                            px="6px"
                            py="3px"
                            borderRadius="3px"
                            fontSize="11px"
                            fontFamily={SYSTEM_FONT_STACK}
                            lineHeight="1.35"
                            _hover={{ bg: "var(--vscode-list-hoverBackground)" }}
                        >
                            <Box
                                as="code"
                                flexShrink={0}
                                color="var(--vscode-textLink-foreground)"
                                fontSize="10px"
                            >
                                {c.shortHash}
                            </Box>
                            <Box flex={1} minW={0} color="var(--vscode-foreground)">
                                <Box as="span" wordBreak="break-word">
                                    {c.subject}
                                </Box>
                                {c.date ? (
                                    <Box
                                        fontSize="10px"
                                        color="var(--vscode-descriptionForeground)"
                                        mt="1px"
                                    >
                                        {formatDateTime(c.date)}
                                    </Box>
                                ) : null}
                            </Box>
                        </Flex>
                    ))
                )}
            </Box>
        </Box>
    );
}
