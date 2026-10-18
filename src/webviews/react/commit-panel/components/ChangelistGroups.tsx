import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Flex, Button } from "@chakra-ui/react";
import { VscChevronDown, VscChevronRight, VscEllipsis } from "react-icons/vsc";
import { FileTree } from "./FileTree";
import { VscCheckbox } from "../../shared/components/VscCheckbox";
import { ContextMenu } from "../../shared/components/ContextMenu";
import { getVsCodeApi } from "../../shared/vscodeApi";
import { JETBRAINS_UI, SHADOW } from "../../shared/tokens";
import { t } from "../../shared/i18n";
import { changelistFiles, type useChangelists } from "../hooks/useChangelists";
import type { WorkingFile } from "../../../../types";

type TreeProps = React.ComponentProps<typeof FileTree>;
interface Props {
    workflow: ReturnType<typeof useChangelists>;
    tree: TreeProps;
    files: WorkingFile[];
}

/** Uses scoped identities for split rows while All checkboxes still address deduplicated paths. */
export function ChangelistGroups({ workflow, tree, files }: Props): React.ReactElement {
    const state = workflow.metadata;
    const api = getVsCodeApi<unknown, Record<string, unknown>>();
    const [expanded, setExpanded] = useState<Record<string, boolean>>(() => {
        const saved = api.getState()?.changelistExpansion;
        return saved && typeof saved === "object" && !Array.isArray(saved)
            ? Object.fromEntries(
                  Object.entries(saved).filter(([, value]) => typeof value === "boolean"),
              )
            : {};
    });
    const expand = (key: string, open: boolean) => {
        const next = { ...expanded, [key]: open };
        setExpanded(next);
        api.setState({ ...api.getState(), changelistExpansion: next });
    };
    const expansionSignals = useRef([tree.expandAllSignal, tree.collapseAllSignal]);
    useEffect(() => {
        const previous = expansionSignals.current;
        expansionSignals.current = [tree.expandAllSignal, tree.collapseAllSignal];
        const expanding = tree.expandAllSignal !== previous[0];
        const collapsing = tree.collapseAllSignal !== previous[1];
        if (!state || (!expanding && !collapsing)) return;
        setExpanded((before) => {
            const next = { ...before };
            for (const list of state.lists)
                next[JSON.stringify([tree.repositoryRoot, list.id])] = expanding;
            api.setState({ ...api.getState(), changelistExpansion: next });
            return next;
        });
    }, [api, state, tree.repositoryRoot, tree.expandAllSignal, tree.collapseAllSignal]);
    const [menu, setMenu] = useState<{
        id: string;
        root?: string;
        revision: number;
        x: number;
        y: number;
    }>();
    // The control that opened the menu gets focus back when the menu closes.
    const menuOpener = useRef<HTMLElement | null>(null);
    const menuOpen = menu !== undefined;
    useEffect(() => {
        if (!menuOpen) return;
        document
            .querySelector<HTMLElement>('[role="menu"] [role="menuitem"][tabindex="0"]')
            ?.focus();
    }, [menuOpen]);
    const closeMenu = () => {
        setMenu(undefined);
        menuOpener.current?.focus();
    };
    const groups = useMemo(
        () =>
            state?.lists.map((list) => {
                const members = changelistFiles(files, state, list.id);
                return {
                    ...list,
                    files: members,
                    count: new Set(members.map((file) => file.path)).size,
                    partial: new Set(
                        members
                            .filter((file) => {
                                const ownership = state.changes[file.path];
                                return (
                                    ownership?.stale ||
                                    Object.keys(ownership?.lines ?? {}).length > 0 ||
                                    ownership?.selections?.[list.id] !== undefined
                                );
                            })
                            .map((file) => file.path),
                    ),
                };
            }) ?? [],
        [files, state],
    );
    if (!state) return <FileTree {...tree} />;
    return (
        <>
            <Button
                size="xs"
                variant="ghost"
                disabled={workflow.busy || workflow.checkedPaths.size === 0}
                onClick={() => workflow.saveShelf("files")}
            >
                {t("changes.saveSelectedWholeFiles")}
            </Button>
            <Button
                size="xs"
                variant="ghost"
                disabled={workflow.busy || workflow.checkedPaths.size === 0}
                onClick={() => workflow.saveShelf("files", undefined, "saveAndRemove")}
            >
                {t("changes.saveAndRemoveSelectedWholeFiles")}
            </Button>
            <Button
                size="xs"
                variant="ghost"
                disabled={workflow.busy || workflow.checkedPaths.size === 0}
                onClick={() => workflow.saveShelf("files", undefined, "rollback")}
            >
                {t("changes.rollBackSelectedWholeFiles")}
            </Button>
            {workflow.notice ? <Box role="status">{workflow.notice}</Box> : null}
            {groups.map((list) => {
                const key = JSON.stringify([tree.repositoryRoot, list.id]);
                const selected = workflow.filter === list.id;
                const canSelect = selected || workflow.filter === "all";
                const open = expanded[key] ?? (selected || list.id === state.activeId);
                const checked = canSelect ? workflow.checkedPaths : new Set<string>();
                const all =
                    list.files.length > 0 &&
                    list.files.every(
                        (file) =>
                            checked.has(file.path) &&
                            fullyIncluded(state, file.path, workflow.filter),
                    );
                const some = list.files.some((file) => checked.has(file.path));
                const review =
                    (state.targetOperationSummary?.phase === "reviewRequired" &&
                        state.targetOperationSummary.destinationId === list.id) ||
                    list.files.some((file) => {
                        const ownership = state.changes[file.path];
                        return (
                            ownership?.stale ||
                            ownership?.selections?.[workflow.filter]?.reviewRequired === true
                        );
                    });
                return (
                    <Box
                        key={key}
                        data-changelist-id={list.id}
                        data-repository-root={tree.repositoryRoot}
                    >
                        <Flex
                            onContextMenu={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                menuOpener.current =
                                    document.activeElement instanceof HTMLElement
                                        ? document.activeElement
                                        : null;
                                setMenu({
                                    id: list.id,
                                    root: tree.repositoryRoot,
                                    revision: state.revision,
                                    x: event.clientX,
                                    y: event.clientY,
                                });
                            }}
                            align="center"
                            gap="6px"
                            px="8px"
                            minH="28px"
                            bg={
                                selected
                                    ? JETBRAINS_UI.color.selected
                                    : JETBRAINS_UI.color.sectionHeader
                            }
                            color={
                                selected
                                    ? JETBRAINS_UI.color.selectedForeground
                                    : JETBRAINS_UI.color.foreground
                            }
                            boxShadow={selected ? SHADOW.selectedRing : undefined}
                        >
                            <Button
                                variant="ghost"
                                color="inherit"
                                _hover={{ bg: JETBRAINS_UI.color.hover }}
                                fontSize="12px"
                                size="xs"
                                minW="16px"
                                p={0}
                                aria-expanded={open}
                                aria-label={list.name}
                                onClick={() => expand(key, !open)}
                            >
                                {open ? <VscChevronDown /> : <VscChevronRight />}
                            </Button>
                            <VscCheckbox
                                isChecked={all}
                                isIndeterminate={some && !all}
                                disabled={!canSelect || workflow.busy || !list.files.length}
                                ariaLabel={t("changes.includeList", { name: list.name })}
                                onChange={() => workflow.toggleSection(list.files)}
                            />
                            <Button
                                variant="ghost"
                                color="inherit"
                                _hover={{ bg: JETBRAINS_UI.color.hover }}
                                fontSize="12px"
                                size="xs"
                                justifyContent="flex-start"
                                minW={0}
                                flex={1}
                                px={0}
                                fontWeight={list.id === state.activeId ? "bold" : "normal"}
                                title={list.description || list.name}
                                aria-pressed={selected}
                                onClick={() => workflow.choose(list.id)}
                            >
                                <Box
                                    as="span"
                                    overflow="hidden"
                                    textOverflow="ellipsis"
                                    whiteSpace="nowrap"
                                >
                                    {list.name}
                                </Box>
                            </Button>
                            {list.id === state.activeId ? (
                                <Box as="span" fontSize="11px">
                                    {t("changes.active")}
                                </Box>
                            ) : null}
                            {review ? (
                                <Box as="span" fontSize="11px">
                                    {t("changes.reviewRequired")}
                                </Box>
                            ) : some && !all ? (
                                <Box as="span" fontSize="11px">
                                    {t("changes.partialInclusion")}
                                </Box>
                            ) : null}
                            <Box
                                as="span"
                                fontSize="11px"
                                aria-label={t("changes.fileCount", { count: list.count })}
                            >
                                {list.count}
                            </Box>
                            <Button
                                variant="ghost"
                                color="inherit"
                                _hover={{ bg: JETBRAINS_UI.color.hover }}
                                fontSize="12px"
                                size="xs"
                                minW="18px"
                                p={0}
                                aria-label={t("changes.listActions", { name: list.name })}
                                onClick={(event) => {
                                    menuOpener.current = event.currentTarget;
                                    const rect = event.currentTarget.getBoundingClientRect();
                                    setMenu({
                                        id: list.id,
                                        root: tree.repositoryRoot,
                                        revision: state.revision,
                                        x: rect.left,
                                        y: rect.bottom,
                                    });
                                }}
                            >
                                <VscEllipsis />
                            </Button>
                        </Flex>
                        {open ? (
                            <Box role="group" aria-label={list.name}>
                                {list.files.length ? (
                                    <FileTree
                                        {...tree}
                                        files={list.files}
                                        // Collapsing the group unmounts this tree. Reopening must not
                                        // replay an older collapse alongside the latest expand signal.
                                        collapseAllSignal={0}
                                        checkedPaths={checked}
                                        partialPaths={list.partial}
                                        selectionDisabled={!canSelect || workflow.busy}
                                        onToggleFile={(path) => {
                                            if (canSelect) workflow.toggleFile(path);
                                        }}
                                        onToggleFolder={(items) => {
                                            if (canSelect) workflow.toggleFolder(items);
                                        }}
                                        onToggleSection={(items) => {
                                            if (canSelect) workflow.toggleSection(items);
                                        }}
                                        isAllChecked={(items) =>
                                            canSelect && workflow.allChecked(items)
                                        }
                                        isSomeChecked={(items) =>
                                            canSelect && workflow.someChecked(items)
                                        }
                                        onFileClick={(path) => workflow.openFile(path, list.id)}
                                        onShelfFileDragStart={undefined}
                                    />
                                ) : (
                                    <Box
                                        px="30px"
                                        py="4px"
                                        fontSize="12px"
                                        color="var(--vscode-descriptionForeground)"
                                    >
                                        {t("changes.emptyList")}
                                    </Box>
                                )}
                            </Box>
                        ) : null}
                    </Box>
                );
            })}
            {menu ? (
                <ContextMenu
                    x={menu.x}
                    y={menu.y}
                    items={[
                        ...(
                            [
                                ["save", t("changes.saveToShelf")],
                                ["saveAndRemove", t("changes.saveAndRemove")],
                                ["rollback", t("changes.rollback")],
                            ] as const
                        ).map(([action, label]) => ({
                            action,
                            label,
                            disabled:
                                workflow.busy ||
                                !groups.find((list) => list.id === menu.id)?.files.length,
                        })),
                        { action: "create", label: t("changes.newList") },
                        { action: "rename", label: t("changes.editList") },
                        {
                            action: "activate",
                            label: t("changes.makeActive"),
                            disabled: menu.id === state.activeId,
                        },
                        { action: "remove", label: t("changes.removeList") },
                    ]}
                    onClose={closeMenu}
                    onSelect={(action) => {
                        if (
                            (action === "save" ||
                                action === "saveAndRemove" ||
                                action === "rollback") &&
                            menu.root === tree.repositoryRoot &&
                            menu.revision === state.revision
                        )
                            workflow.saveShelf("list", menu.id, action);
                        if (
                            action === "create" ||
                            action === "rename" ||
                            action === "activate" ||
                            action === "remove"
                        )
                            workflow.command(action, menu.id);
                        closeMenu();
                    }}
                />
            ) : null}
        </>
    );
}

/** Explicit subsets and review-required selections keep their group checkbox mixed. */
function fullyIncluded(
    state: NonNullable<ReturnType<typeof useChangelists>["metadata"]>,
    path: string,
    scope: string,
): boolean {
    const ownership = state.changes[path];
    const selection = ownership?.selections?.[scope];
    if (!selection) return true;
    if (selection.reviewRequired || ownership.stale) return false;
    const owners = Object.values(ownership.lines);
    const total =
        scope === "all"
            ? selection.total
            : state.files[path] === scope
              ? selection.total - owners.filter((owner) => owner !== scope).length
              : owners.filter((owner) => owner === scope).length;
    return total > 0 && selection.lineIds.length === total;
}
