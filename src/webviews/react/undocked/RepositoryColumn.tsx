// Far-left repository selector for the undocked multi-repository view.

import React from "react";
import { Box } from "@chakra-ui/react";
import type { RepositoryViewIdentity } from "../../protocol/undockedMessages";

interface RepositoryColumnProps {
    width: number;
    repositories: RepositoryViewIdentity[];
    selectedRepositoryRoot: string | null;
    onSelectRepository: (root: string) => void;
}

/**
 * Renders known repositories as a resizable selector column.
 *
 * The column never moves with the commit-panel side setting; it only emits roots
 * that came from host repository hydration.
 */
export function RepositoryColumn({
    width,
    repositories,
    selectedRepositoryRoot,
    onSelectRepository,
}: RepositoryColumnProps): React.ReactElement {
    return (
        <Box
            data-testid="undocked-repository-section"
            style={{ width: `${width}px` }}
            flexShrink={0}
            overflowY="auto"
            overflowX="hidden"
            bg="var(--vscode-sideBar-background)"
        >
            {repositories.map((repository) => {
                const isSelected = repository.root === selectedRepositoryRoot;
                // A lone repository has nothing to be chosen against; the fill would only shout.
                const paintSelected = isSelected && repositories.length > 1;
                return (
                    <Box
                        as="button"
                        type="button"
                        key={repository.root}
                        data-testid="undocked-repository-row"
                        data-repository-root={repository.root}
                        aria-current={isSelected ? "true" : undefined}
                        title={repository.root}
                        width="100%"
                        minH="32px"
                        px="8px"
                        py="5px"
                        border={0}
                        borderBottom="1px solid var(--vscode-panel-border)"
                        bg={
                            paintSelected
                                ? "var(--vscode-list-activeSelectionBackground)"
                                : "transparent"
                        }
                        color={
                            paintSelected
                                ? "var(--vscode-list-activeSelectionForeground)"
                                : "var(--vscode-sideBar-foreground)"
                        }
                        textAlign="left"
                        cursor="pointer"
                        onClick={() => onSelectRepository(repository.root)}
                        _hover={{
                            bg: paintSelected
                                ? "var(--vscode-list-activeSelectionBackground)"
                                : "var(--vscode-list-hoverBackground)",
                        }}
                    >
                        <Box
                            as="span"
                            display="block"
                            overflow="hidden"
                            textOverflow="ellipsis"
                            whiteSpace="nowrap"
                            fontSize="12px"
                            fontWeight={isSelected ? 700 : 500}
                        >
                            {repository.label}
                        </Box>
                    </Box>
                );
            })}
        </Box>
    );
}
