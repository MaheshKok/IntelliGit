import React, { useCallback } from "react";
import { Box, Button, Flex } from "@chakra-ui/react";
import type { ShelfEntry } from "../../../protocol/commitPanelMessages";
import { ChevronIcon } from "../../shared/components/Icons";
import { formatDateTime } from "../../shared/date";
import { t } from "../../shared/i18n";

/** Context-menu actions supported by an individual shelf row. */
export type ShelfContextAction =
    | "unshelve"
    | "unshelveSilently"
    | "rename"
    | "delete"
    | "showDiff"
    | "showDiffNewTab"
    | "compareWithLocal"
    | "restore"
    | "createPatch"
    | "copyPatchToClipboard"
    | "importPatches";

/** Presentation and interaction state for one shelf row. */
export interface ShelfRowProps {
    shelf: ShelfEntry;
    state: {
        selected: boolean;
        /** Owns the list's roving tabindex, which stays on a shelf row even when a file is selected. */
        isFocusTarget: boolean;
        isGhost: boolean;
        isExpanded: boolean;
        isRenaming: boolean;
        renameError?: string;
    };
    onSelect: (shelfId: string) => void;
    onToggleExpand: (shelfId: string) => void;
    onNavigate: (shelfId: string, key: string, target: HTMLElement) => void;
    onContextMenu: (shelf: ShelfEntry, x: number, y: number, target: HTMLElement) => void;
    onRenameSubmit: (shelf: ShelfEntry, name: string) => void;
    onRenameCancel: () => void;
    onRestore: (shelf: ShelfEntry) => void;
    onDragStart?: (event: React.DragEvent<HTMLElement>, shelf: ShelfEntry) => void;
}

/**
 * PyCharm's shelf meta line: `2 files, 2/22/26, 8:55 AM`. Older shelves predate
 * `createdAt`, so the count stands alone when there is no timestamp to show.
 */
function shelfMetaText(shelf: ShelfEntry): string {
    const files = t("common.fileCount", { count: shelf.files.length });
    const createdAt = shelf.metadata.createdAt;
    if (createdAt === undefined) return files;
    return t("common.filesAndDate", {
        files,
        date: formatDateTime(new Date(createdAt).toISOString()),
    });
}

/** One selectable shelf row. Ghosts stay visually present but intentionally muted. */
export function ShelfRow({
    shelf,
    state,
    onSelect,
    onToggleExpand,
    onNavigate,
    onContextMenu,
    onRenameSubmit,
    onRenameCancel,
    onRestore,
    onDragStart,
}: ShelfRowProps): React.ReactElement {
    const focusRenameInput = useCallback((input: HTMLInputElement | null): void => {
        input?.focus();
    }, []);

    return (
        <Flex
            role="treeitem"
            data-shelf-id={shelf.id}
            data-ghost={state.isGhost || undefined}
            aria-selected={state.selected}
            aria-expanded={state.isExpanded}
            aria-level={1}
            tabIndex={state.isFocusTarget ? 0 : -1}
            align="center"
            w="calc(100% - 8px)"
            minH="24px"
            mx="4px"
            px="6px"
            gap="6px"
            borderRadius="5px"
            transition="background-color 120ms ease-out"
            cursor="pointer"
            fontSize="13px"
            textAlign="left"
            opacity={state.isGhost ? 0.55 : 1}
            color={
                state.selected
                    ? "var(--intelligit-pycharm-selected-foreground)"
                    : "var(--intelligit-pycharm-foreground)"
            }
            bg={state.selected ? "var(--intelligit-pycharm-selected)" : "transparent"}
            _hover={{
                bg: state.selected
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
            draggable={!state.isGhost && Boolean(onDragStart)}
            onDragStart={(event) => onDragStart?.(event, shelf)}
        >
            <Box
                as="span"
                display="inline-flex"
                alignItems="center"
                flexShrink={0}
                aria-hidden
                onClick={() => onToggleExpand(shelf.id)}
            >
                <ChevronIcon expanded={state.isExpanded} />
            </Box>
            {state.isRenaming ? (
                <Box flex={1} minW={0}>
                    <input
                        aria-label={t("shelf.rename.label")}
                        ref={focusRenameInput}
                        defaultValue={shelf.metadata.name}
                        onClick={(event) => event.stopPropagation()}
                        onKeyDown={(event) => {
                            event.stopPropagation();
                            if (event.key === "Escape") onRenameCancel();
                            if (event.key === "Enter")
                                onRenameSubmit(shelf, event.currentTarget.value);
                        }}
                        style={{
                            width: "100%",
                            minHeight: "24px",
                            padding: "2px 5px",
                            color: "var(--intelligit-pycharm-foreground)",
                            background: "var(--intelligit-pycharm-input)",
                            border: "1px solid var(--intelligit-pycharm-input-border)",
                            borderRadius: "4px",
                        }}
                    />
                    {state.renameError ? (
                        <Box
                            role="alert"
                            mt="2px"
                            fontSize="12px"
                            color="var(--vscode-errorForeground)"
                        >
                            {state.renameError}
                        </Box>
                    ) : null}
                </Box>
            ) : (
                <Box
                    as="span"
                    minW={0}
                    overflow="hidden"
                    textOverflow="ellipsis"
                    whiteSpace="nowrap"
                >
                    {shelf.metadata.name}
                </Box>
            )}
            <Box
                data-shelf-meta
                flexShrink={0}
                fontSize="11px"
                color={
                    state.selected
                        ? "var(--intelligit-pycharm-selected-foreground)"
                        : "var(--intelligit-pycharm-muted)"
                }
                opacity={state.selected ? 0.8 : 1}
            >
                {shelfMetaText(shelf)}
            </Box>
            <Box flex={1} minW={0} />
            {state.isGhost ? (
                <Button
                    aria-label={t("shelf.action.restore")}
                    variant="toolbarGhost"
                    size="xs"
                    onClick={(event) => {
                        event.stopPropagation();
                        onRestore(shelf);
                    }}
                >
                    {t("shelf.action.restore")}
                </Button>
            ) : null}
        </Flex>
    );
}
