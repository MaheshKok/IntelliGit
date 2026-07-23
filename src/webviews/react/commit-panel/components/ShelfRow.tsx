import React from "react";
import { Box, Button, Flex } from "@chakra-ui/react";
import type { ShelfEntry } from "../../../protocol/commitPanelMessages";

/** Context-menu actions supported by an individual shelf row. */
export type ShelfContextAction =
    | "unshelve"
    | "unshelveSilently"
    | "rename"
    | "delete"
    | "showDiff"
    | "compareWithLocal"
    | "restore";

/** Presentation and interaction state for one shelf row. */
export interface ShelfRowProps {
    shelf: ShelfEntry;
    selected: boolean;
    isGhost: boolean;
    isRenaming: boolean;
    renameError?: string;
    onSelect: (shelfId: string) => void;
    onNavigate: (shelfId: string, key: string, target: HTMLElement) => void;
    onContextMenu: (shelf: ShelfEntry, x: number, y: number, target: HTMLElement) => void;
    onRenameSubmit: (shelf: ShelfEntry, name: string) => void;
    onRenameCancel: () => void;
    onRestore: (shelf: ShelfEntry) => void;
}

/** One selectable shelf row. Ghosts stay visually present but intentionally muted. */
export function ShelfRow({
    shelf,
    selected,
    isGhost,
    isRenaming,
    renameError,
    onSelect,
    onNavigate,
    onContextMenu,
    onRenameSubmit,
    onRenameCancel,
    onRestore,
}: ShelfRowProps): React.ReactElement {
    return (
        <Flex
            role="option"
            data-shelf-id={shelf.id}
            data-ghost={isGhost || undefined}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            align="center"
            w="calc(100% - 16px)"
            minH="30px"
            mx="8px"
            px="6px"
            gap="6px"
            borderRadius="3px"
            cursor="pointer"
            fontSize="13px"
            textAlign="left"
            opacity={isGhost ? 0.55 : 1}
            color={
                selected
                    ? "var(--intelligit-pycharm-selected-foreground)"
                    : "var(--intelligit-pycharm-foreground)"
            }
            bg={selected ? "var(--intelligit-pycharm-selected)" : "transparent"}
            _hover={{
                bg: selected
                    ? "var(--intelligit-pycharm-selected)"
                    : "var(--intelligit-pycharm-selected-hover)",
            }}
            onClick={() => onSelect(shelf.id)}
            onContextMenu={(event) => {
                event.preventDefault();
                onContextMenu(shelf, event.clientX, event.clientY, event.currentTarget);
            }}
            onKeyDown={(event) => {
                if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
                    event.preventDefault();
                    const rect = event.currentTarget.getBoundingClientRect();
                    onContextMenu(shelf, rect.left, rect.bottom, event.currentTarget);
                    return;
                }
                onNavigate(shelf.id, event.key, event.currentTarget);
            }}
            title={shelf.metadata.name}
        >
            {isRenaming ? (
                <Box flex={1} minW={0}>
                    <input
                        aria-label="Rename shelf"
                        autoFocus
                        defaultValue={shelf.metadata.name}
                        onClick={(event) => event.stopPropagation()}
                        onKeyDown={(event) => {
                            event.stopPropagation();
                            if (event.key === "Escape") onRenameCancel();
                            if (event.key === "Enter") onRenameSubmit(shelf, event.currentTarget.value);
                        }}
                        style={{
                            width: "100%",
                            minHeight: "24px",
                            padding: "2px 5px",
                            color: "var(--intelligit-pycharm-foreground)",
                            background: "var(--intelligit-pycharm-input)",
                            border: "1px solid var(--intelligit-pycharm-input-border)",
                            borderRadius: "3px",
                        }}
                    />
                    {renameError ? (
                        <Box role="alert" mt="2px" fontSize="12px" color="var(--vscode-errorForeground)">
                            {renameError}
                        </Box>
                    ) : null}
                </Box>
            ) : (
                <Box flex={1} minW={0} overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap">
                    {shelf.metadata.name}
                </Box>
            )}
            <Box flexShrink={0} fontSize="11px" color="var(--intelligit-pycharm-muted)">
                {shelf.metadata.lifecycle}
            </Box>
            {isGhost ? (
                <Button
                    aria-label="Restore"
                    variant="toolbarGhost"
                    size="xs"
                    onClick={(event) => {
                        event.stopPropagation();
                        onRestore(shelf);
                    }}
                >
                    Restore
                </Button>
            ) : null}
        </Flex>
    );
}
