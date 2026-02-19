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
    const tabs: Array<{ key: string; label: string; content: React.ReactNode }> = [
        { key: "commit", label: "Commit", content: commitContent },
        {
            key: "shelf",
            label: `Shelf${stashCount > 0 ? ` (${stashCount})` : ""}`,
            content: shelfContent,
        },
    ];

    const sharedTabStyles = {
        px: "14px",
        py: "6px",
        minH: "32px",
        fontSize: "12px",
        fontWeight: 600,
        color: "var(--vscode-foreground)",
        opacity: 0.75,
        borderBottom: "2px solid transparent",
        _selected: {
            opacity: 1,
            borderBottomColor: "var(--vscode-focusBorder, #007acc)",
        },
        _hover: { opacity: 0.85 },
    } as const;

    return (
        <Tabs variant="unstyled" display="flex" flexDirection="column" h="100%">
            <TabList borderBottom="1px solid var(--vscode-panel-border, #444)" flexShrink={0}>
                {tabs.map((tab) => (
                    <Tab key={tab.key} {...sharedTabStyles}>
                        {tab.label}
                    </Tab>
                ))}
            </TabList>
            <TabPanels flex={1} overflow="hidden" display="flex" flexDirection="column">
                {tabs.map((tab) => (
                    <TabPanel
                        key={tab.key}
                        p={0}
                        flex={1}
                        display="flex"
                        flexDirection="column"
                        overflow="hidden"
                    >
                        {tab.content}
                    </TabPanel>
                ))}
            </TabPanels>
        </Tabs>
    );
}
