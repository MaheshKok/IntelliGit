// Tab switcher between Commit and Shelf tabs. Uses Chakra UI Tabs
// with custom styling to match the VS Code sidebar appearance.

import React from "react";
import { Tabs, TabList, Tab, TabPanels, TabPanel } from "@chakra-ui/react";

interface Props {
    stashCount: number;
    commitContent: React.ReactNode;
    shelfContent: React.ReactNode;
}

export function TabBar({ stashCount, commitContent, shelfContent }: Props): React.ReactElement {
    return (
        <Tabs variant="unstyled" display="flex" flexDirection="column" h="100%">
            <TabList borderBottom="1px solid var(--vscode-panel-border, #444)" flexShrink={0}>
                <Tab
                    px="14px"
                    py="6px"
                    minH="32px"
                    fontSize="12px"
                    fontWeight={600}
                    color="var(--vscode-foreground)"
                    opacity={0.75}
                    borderBottom="2px solid transparent"
                    _selected={{
                        opacity: 1,
                        borderBottomColor: "var(--vscode-focusBorder, #007acc)",
                    }}
                    _hover={{ opacity: 0.85 }}
                >
                    Commit
                </Tab>
                <Tab
                    px="14px"
                    py="6px"
                    minH="32px"
                    fontSize="12px"
                    fontWeight={600}
                    color="var(--vscode-foreground)"
                    opacity={0.75}
                    borderBottom="2px solid transparent"
                    _selected={{
                        opacity: 1,
                        borderBottomColor: "var(--vscode-focusBorder, #007acc)",
                    }}
                    _hover={{ opacity: 0.85 }}
                >
                    Shelf{stashCount > 0 ? ` (${stashCount})` : ""}
                </Tab>
            </TabList>
            <TabPanels flex={1} overflow="hidden" display="flex" flexDirection="column">
                <TabPanel p={0} flex={1} display="flex" flexDirection="column" overflow="hidden">
                    {commitContent}
                </TabPanel>
                <TabPanel p={0} flex={1} display="flex" flexDirection="column" overflow="hidden">
                    {shelfContent}
                </TabPanel>
            </TabPanels>
        </Tabs>
    );
}
