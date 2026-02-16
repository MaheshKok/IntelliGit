// Toolbar with 7 icon buttons: Refresh, Rollback, Group by Directory,
// Shelve Changes, Show Diff, Expand All, Collapse All.

import React from "react";
import { Flex, Box, IconButton, Tooltip } from "@chakra-ui/react";

interface Props {
    onRefresh: () => void;
    onRollback: () => void;
    onToggleGroupBy: () => void;
    onShelve: () => void;
    onShowDiff: () => void;
    onExpandAll: () => void;
    onCollapseAll: () => void;
}

export function Toolbar({
    onRefresh,
    onRollback,
    onToggleGroupBy,
    onShelve,
    onShowDiff,
    onExpandAll,
    onCollapseAll,
}: Props): React.ReactElement {
    return (
        <Flex
            align="center"
            gap="2px"
            px="8px"
            py="4px"
            borderBottom="1px solid var(--vscode-panel-border, #444)"
            flexShrink={0}
        >
            <ToolbarButton label="Refresh" onClick={onRefresh}>
                <path
                    fill="currentColor"
                    d="M13.451 5.609l-.579-.939-1.068.812-.076.094c.335.57.528 1.236.528 1.949a4.093 4.093 0 0 1-4.09 4.09 4.093 4.093 0 0 1-4.09-4.09 4.088 4.088 0 0 1 3.354-4.027v1.938l4.308-2.906L7.43.002v1.906a5.593 5.593 0 0 0-4.856 5.617A5.594 5.594 0 0 0 8.166 13.1a5.594 5.594 0 0 0 5.592-5.575c0-1.755-.461-2.381-1.307-3.416l1-.5z"
                />
            </ToolbarButton>
            <ToolbarButton label="Rollback" onClick={onRollback}>
                <path
                    fill="currentColor"
                    d="M2.5 2l3.068 3.069L4.856 5.78l.707-.707L3.594 3.1H7A4.505 4.505 0 0 1 11.5 7.609 4.505 4.505 0 0 1 7 12.109H3.5v1H7a5.506 5.506 0 0 0 5.5-5.5A5.506 5.506 0 0 0 7 2.109H3.594l1.97-1.97-.708-.707L1.788 2.5z"
                />
            </ToolbarButton>
            <ToolbarButton label="Group by Directory" onClick={onToggleGroupBy}>
                <path
                    fill="currentColor"
                    d="M14.5 3H7.71l-.85-.85A.5.5 0 0 0 6.5 2H1.5A1.5 1.5 0 0 0 0 3.5v9A1.5 1.5 0 0 0 1.5 14h13a1.5 1.5 0 0 0 1.5-1.5v-7A1.5 1.5 0 0 0 14.5 4V3zM1.5 3h4.79l.85.85a.5.5 0 0 0 .36.15h7a.5.5 0 0 1 .5.5v.5H1V3.5a.5.5 0 0 1 .5-.5zM1 12.5V6h14v6.5a.5.5 0 0 1-.5.5h-13a.5.5 0 0 1-.5-.5z"
                />
            </ToolbarButton>
            <ToolbarButton label="Shelve Changes" onClick={onShelve}>
                <path
                    fill="currentColor"
                    d="M14.5 1h-13A1.5 1.5 0 0 0 0 2.5v2A1.5 1.5 0 0 0 1 5.95V13.5A1.5 1.5 0 0 0 2.5 15h11a1.5 1.5 0 0 0 1.5-1.5V5.95A1.5 1.5 0 0 0 16 4.5v-2A1.5 1.5 0 0 0 14.5 1zM14 13.5a.5.5 0 0 1-.5.5h-11a.5.5 0 0 1-.5-.5V6h12v7.5zm1-9a.5.5 0 0 1-.5.5h-13a.5.5 0 0 1-.5-.5v-2a.5.5 0 0 1 .5-.5h13a.5.5 0 0 1 .5.5v2zM6 9h4v1H6V9z"
                />
            </ToolbarButton>
            <ToolbarButton label="Show Diff Preview" onClick={onShowDiff}>
                <path
                    fill="currentColor"
                    d="M2 3.5A1.5 1.5 0 0 1 3.5 2h5.586a1.5 1.5 0 0 1 1.06.44l2.415 2.414A1.5 1.5 0 0 1 13 5.914V12.5a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 2 12.5v-9zm1.5-.5a.5.5 0 0 0-.5.5v9a.5.5 0 0 0 .5.5h8a.5.5 0 0 0 .5-.5V5.914L9.086 2.5H3.5zM7 7V5h1v2h2v1H8v2H7V8H5V7h2z"
                />
            </ToolbarButton>
            <Box flex={1} />
            <ToolbarButton label="Expand All" onClick={onExpandAll}>
                <path
                    fill="currentColor"
                    fillRule="evenodd"
                    d="M5.828 10.172a.5.5 0 0 0-.707 0l-4.096 4.096V11.5a.5.5 0 0 0-1 0v3.975a.5.5 0 0 0 .5.5H4.5a.5.5 0 0 0 0-1H1.732l4.096-4.096a.5.5 0 0 0 0-.707m4.344-4.344a.5.5 0 0 0 .707 0l4.096-4.096V4.5a.5.5 0 1 0 1 0V.525a.5.5 0 0 0-.5-.5H11.5a.5.5 0 0 0 0 1h2.768l-4.096 4.096a.5.5 0 0 0 0 .707"
                />
            </ToolbarButton>
            <ToolbarButton label="Collapse All" onClick={onCollapseAll}>
                <path
                    fill="currentColor"
                    fillRule="evenodd"
                    d="M.172 15.828a.5.5 0 0 0 .707 0l4.096-4.096V14.5a.5.5 0 1 0 1 0v-3.975a.5.5 0 0 0-.5-.5H1.5a.5.5 0 0 0 0 1h2.768L.172 15.121a.5.5 0 0 0 0 .707M15.828.172a.5.5 0 0 0-.707 0l-4.096 4.096V1.5a.5.5 0 1 0-1 0v3.975a.5.5 0 0 0 .5.5H14.5a.5.5 0 0 0 0-1h-2.768L15.828.879a.5.5 0 0 0 0-.707"
                />
            </ToolbarButton>
        </Flex>
    );
}

function ToolbarButton({
    label,
    onClick,
    children,
}: {
    label: string;
    onClick: () => void;
    children: React.ReactNode;
}): React.ReactElement {
    return (
        <Tooltip label={label} fontSize="11px" placement="bottom" openDelay={300}>
            <IconButton
                aria-label={label}
                variant="toolbarGhost"
                size="sm"
                onClick={onClick}
                icon={
                    <svg width="18" height="18" viewBox="0 0 16 16">
                        {children}
                    </svg>
                }
            />
        </Tooltip>
    );
}
