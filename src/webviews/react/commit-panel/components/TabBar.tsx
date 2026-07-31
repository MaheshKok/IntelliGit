// Tab switcher between Commit and Stash tabs. Uses Chakra UI Tabs
// with custom styling to match the VS Code sidebar appearance.

import React from "react";
import {
    Flex,
    IconButton,
    Tab,
    TabList,
    TabPanel,
    TabPanels,
    Tabs,
    Tooltip,
} from "@chakra-ui/react";
import { getSettings } from "../../shared/settings";
import { DISABLED_GLYPH_COLOR } from "../../shared/components/ToolbarIconButton";
import { t } from "../../shared/i18n";

interface Props {
    stashCount: number;
    shelfCount?: number;
    shelfWarningCount?: number;
    onSync?: () => void;
    onFetch?: () => void;
    onPull?: () => void;
    onPush?: () => void;
    /** Optional undocked-only action that returns IntelliGit to the docked views. */
    onDock?: () => void;
    commitContent: React.ReactNode;
    stashContent: React.ReactNode;
    shelfContent?: React.ReactNode;
    onCommitDragOver?: (event: React.DragEvent<HTMLElement>) => void;
    onCommitDrop?: (event: React.DragEvent<HTMLElement>) => void;
    onShelfDragOver?: (event: React.DragEvent<HTMLElement>) => void;
    onShelfDrop?: (event: React.DragEvent<HTMLElement>) => void;
}

const sharedTabStyles = {
    px: "14px",
    py: "6px",
    minH: "32px",
    fontSize: "12px",
    fontWeight: 600,
    color: "var(--intelligit-pycharm-foreground)",
    opacity: 0.75,
    borderBottom: "2px solid transparent",
    borderRadius: 0,
    _selected: {
        opacity: 1,
        borderBottomColor: "var(--intelligit-pycharm-blue)",
    },
    _hover: { opacity: 0.9, bg: "rgba(255,255,255,0.02)" },
} as const;

/**
 * Hosts the Commit and Stash tab panels with VS Code sidebar styling.
 *
 * Callers provide already-wired panel content, allowing the tab shell to stay
 * presentation-only while reflecting the current stash count in the stash label.
 */
export function TabBar({
    stashCount,
    shelfCount = 0,
    shelfWarningCount = 0,
    onSync,
    onFetch,
    onPull,
    onPush,
    onDock,
    commitContent,
    stashContent,
    shelfContent,
    onCommitDragOver,
    onCommitDrop,
    onShelfDragOver,
    onShelfDrop,
}: Props): React.ReactElement {
    const tabs: Array<{ key: string; label: string; content: React.ReactNode }> = [
        { key: "commit", label: t("commit.tab.commit"), content: commitContent },
        {
            key: "stash",
            label:
                stashCount > 0
                    ? t("commit.tab.stashWithCount", { count: stashCount })
                    : t("commit.tab.stash"),
            content: stashContent,
        },
        {
            key: "shelf",
            label:
                shelfCount > 0
                    ? t("commit.tab.shelfWithCount", { count: shelfCount })
                    : t("commit.tab.shelf"),
            content: shelfContent,
        },
    ];
    const gitActions =
        onSync && onFetch && onPull && onPush ? { onSync, onFetch, onPull, onPush } : null;

    return (
        <Tabs
            variant="unstyled"
            display="flex"
            flexDirection="column"
            h="100%"
            bg="var(--intelligit-pycharm-panel)"
        >
            <Flex
                data-testid="commit-panel-tab-row"
                bg="var(--intelligit-pycharm-panel)"
                borderBottom="1px solid var(--intelligit-pycharm-border)"
                flexShrink={0}
                align="stretch"
            >
                <TabList>
                    {tabs.map((tab) => (
                        <Tab
                            key={tab.key}
                            {...sharedTabStyles}
                            onDragOver={
                                tab.key === "commit"
                                    ? onCommitDragOver
                                    : tab.key === "shelf"
                                      ? onShelfDragOver
                                      : undefined
                            }
                            onDrop={
                                tab.key === "commit"
                                    ? onCommitDrop
                                    : tab.key === "shelf"
                                      ? onShelfDrop
                                      : undefined
                            }
                        >
                            {tab.label}
                            {tab.key === "shelf" && shelfWarningCount > 0 ? (
                                <span
                                    aria-label={t("a11y.shelfWarning", {
                                        count: shelfWarningCount,
                                    })}
                                    style={{
                                        marginLeft: 4,
                                        borderRadius: 999,
                                        padding: "0 5px",
                                        background:
                                            "var(--vscode-inputValidation-warningBackground)",
                                        color: "var(--vscode-inputValidation-warningForeground)",
                                    }}
                                >
                                    {shelfWarningCount}
                                </span>
                            ) : null}
                        </Tab>
                    ))}
                </TabList>
                {gitActions ? (
                    <Flex align="center" ml="auto" gap="2px" pr="6px">
                        <GitActionButton
                            label={t("common.sync")}
                            onClick={gitActions.onSync}
                            color="#c8a2ff"
                        >
                            <path
                                fill="currentColor"
                                d="M13 2v4H9l1.55-1.55A4.4 4.4 0 0 0 3.9 6.2l-.94-.34A5.4 5.4 0 0 1 11.25 3.75L13 2zM3 14v-4h4l-1.55 1.55A4.4 4.4 0 0 0 12.1 9.8l.94.34a5.4 5.4 0 0 1-8.29 2.11L3 14z"
                            />
                        </GitActionButton>
                        <GitActionButton
                            label={t("common.fetch")}
                            onClick={gitActions.onFetch}
                            color="#8fd5ff"
                        >
                            <path
                                fill="none"
                                stroke="currentColor"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth="1.3"
                                d="M5 12.5h-.5a2.8 2.8 0 0 1-.35-5.58A4.1 4.1 0 0 1 12 5.8a2.9 2.9 0 0 1 .5 5.7H11"
                            />
                            <path
                                fill="none"
                                stroke="currentColor"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth="1.3"
                                d="M8 6.7v5.6m-2.1-2L8 12.4l2.1-2.1"
                            />
                        </GitActionButton>
                        <GitActionButton
                            label={t("common.pull")}
                            onClick={gitActions.onPull}
                            color="#8fd5ff"
                        >
                            <path
                                fill="currentColor"
                                d="M7.5 1h1v8.1l2.15-2.15.7.7L8 11 4.65 7.65l.7-.7L7.5 9.1V1z"
                            />
                            <path fill="currentColor" d="M3 13h10v1H3v-1z" />
                        </GitActionButton>
                        <GitActionButton
                            label={t("common.push")}
                            onClick={gitActions.onPush}
                            color="#a6e3a1"
                        >
                            <path
                                fill="currentColor"
                                d="M8 1l3.35 3.35-.7.7L8.5 2.9V11h-1V2.9L5.35 5.05l-.7-.7L8 1z"
                            />
                            <path fill="currentColor" d="M3 13h10v1H3v-1z" />
                        </GitActionButton>
                    </Flex>
                ) : null}
                {onDock ? (
                    <Flex align="center" ml={gitActions ? 0 : "auto"} pr="6px">
                        <GitActionButton
                            label={t("common.dockIntelliGit")}
                            title={t("common.dockIntelliGit")}
                            onClick={onDock}
                            color="#8fd5ff"
                            standardColor="var(--vscode-button-foreground)"
                        >
                            <path
                                fill="currentColor"
                                d="M2 3h12v10H2V3zm1 1v8h10V4H3zm1 1h3v6H4V5zm4 0h4v2H8V5z"
                            />
                        </GitActionButton>
                    </Flex>
                ) : null}
            </Flex>
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

function GitActionButton({
    label,
    title,
    onClick,
    color,
    standardColor = "var(--vscode-icon-foreground)",
    disabled = false,
    children,
}: {
    label: string;
    title?: string;
    onClick: () => void;
    color: string;
    standardColor?: string;
    disabled?: boolean;
    children: React.ReactNode;
}): React.ReactElement {
    const { hoverDelay, tooltipsEnabled, iconStyle } = getSettings();
    const resolvedColor = disabled
        ? DISABLED_GLYPH_COLOR
        : iconStyle === "standard"
          ? standardColor
          : color;
    return (
        <Tooltip
            label={label}
            fontSize="11px"
            placement="bottom"
            openDelay={hoverDelay}
            isDisabled={!tooltipsEnabled}
        >
            <IconButton
                aria-label={label}
                title={tooltipsEnabled ? undefined : title}
                aria-disabled={disabled || undefined}
                isDisabled={disabled}
                variant="toolbarGhost"
                size="sm"
                alignSelf="center"
                _disabled={{ opacity: 1, cursor: "default" }}
                cursor={disabled ? "default" : undefined}
                onClick={disabled ? undefined : onClick}
                icon={
                    <svg
                        width="16"
                        height="16"
                        viewBox="0 0 16 16"
                        style={{ color: resolvedColor }}
                    >
                        {children}
                    </svg>
                }
            />
        </Tooltip>
    );
}
