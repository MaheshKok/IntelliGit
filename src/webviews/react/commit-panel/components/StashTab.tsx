// Stash tab with flat stash selection, one lower selected-file pane, and typed actions.

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Box, Button, Flex } from "@chakra-ui/react";
import { SYSTEM_FONT_STACK } from "../../../../utils/constants";
import type { StashEntry, ThemeFolderIconMap, ThemeTreeIcon, WorkingFile } from "../../../../types";
import { StashFilePane, StashList } from "./StashList";
import { StashToolbar } from "./StashToolbar";
import { StashUnstashDialog } from "./StashUnstashDialog";
import { getVsCodeApi } from "../hooks/useVsCodeApi";
import { getSettings } from "../../shared/settings";
import { ContextMenu } from "../../shared/components/ContextMenu";
import { useFileTree, collectAllDirPaths } from "../hooks/useFileTree";
import type { TreeEntry } from "../types";
import { t } from "../../shared/i18n";

interface Props {
    repositoryRoot?: string;
    currentBranchName: string | null;
    stashes: StashEntry[];
    stashFiles: WorkingFile[];
    selectedIndex: number | null;
    folderIcon?: ThemeTreeIcon;
    folderExpandedIcon?: ThemeTreeIcon;
    folderIconsByName?: ThemeFolderIconMap;
    groupByDir: boolean;
    onToggleGroupBy: () => void;
}

type StashContextAction =
    | "apply"
    | "pop"
    | "unstash"
    | "drop"
    | "clear"
    | "showDiff"
    | "showDiffNewTab";

interface ExpandedDirsState {
    tree: TreeEntry[];
    dirs: Set<string>;
}

interface SelectionOverride {
    snapshot: StashEntry[];
    index: number;
}

interface FileSelection {
    stashIndex: number | null;
    path: string | null;
}

interface StashContextMenuState {
    x: number;
    y: number;
    index: number;
    returnFocusTarget: HTMLElement | null;
}

interface UnstashDialogState {
    index: number;
    returnFocusTarget: HTMLElement | null;
}

const MIN_STASH_LIST_HEIGHT = 100;
const STASH_LOWER_PANE_RESERVED_HEIGHT = 166;
const STASH_SPLITTER_KEYBOARD_STEP = 10;
let stashMutationRequestSequence = 0;

/** Returns a webview-local correlation ID for one stash mutation. */
function createStashMutationRequestId(): string {
    stashMutationRequestSequence += 1;
    return `stash-mutation-${stashMutationRequestSequence}`;
}

/** Throws for an action omitted from the exhaustive stash context switch. */
function rejectUnhandledStashAction(_action: never): never {
    throw new Error("Unhandled stash context action.");
}

/**
 * Renders flat stash rows and one selected-stash file pane.
 *
 * The host remains authoritative for stash snapshots and mutation outcomes. A local mutation guard
 * clears only when the host acknowledges the matching request for this repository.
 */
// Selection, dialog, splitter, and mutation state have independent transitions; one reducer would couple them.
// react-doctor-disable-next-line react-doctor/no-giant-component
export function StashTab({
    repositoryRoot,
    currentBranchName,
    stashes,
    stashFiles,
    selectedIndex,
    folderIcon,
    folderExpandedIcon,
    folderIconsByName,
    groupByDir,
    onToggleGroupBy,
    // react-doctor-disable-next-line react-doctor/prefer-useReducer
}: Props): React.ReactElement {
    const vscode = getVsCodeApi();
    const { hoverDelay, tooltipsEnabled } = getSettings();
    const [selectionOverride, setSelectionOverride] = useState<SelectionOverride | null>(null);
    const displayedSelectedIndex =
        selectionOverride?.snapshot === stashes ? selectionOverride.index : selectedIndex;
    const displayedStashFiles = displayedSelectedIndex === selectedIndex ? stashFiles : [];
    const isStashFilesLoading =
        selectionOverride?.snapshot === stashes && selectionOverride.index !== selectedIndex;
    const tree = useFileTree(displayedStashFiles, groupByDir);
    const allDirPaths = useMemo(() => collectAllDirPaths(tree), [tree]);
    const [expandedDirsState, setExpandedDirsState] = useState<ExpandedDirsState>(() => ({
        tree,
        dirs: new Set(allDirPaths),
    }));
    const expandedDirs = useMemo(
        () => (expandedDirsState.tree === tree ? expandedDirsState.dirs : new Set(allDirPaths)),
        [allDirPaths, expandedDirsState, tree],
    );
    const [fileSelection, setFileSelection] = useState<FileSelection>({
        stashIndex: null,
        path: null,
    });
    const selectedFilePath =
        fileSelection.stashIndex === displayedSelectedIndex &&
        displayedStashFiles.some((file) => file.path === fileSelection.path)
            ? fileSelection.path
            : (displayedStashFiles[0]?.path ?? null);
    const [contextMenu, setContextMenu] = useState<StashContextMenuState | null>(null);
    const [unstashDialog, setUnstashDialog] = useState<UnstashDialogState | null>(null);
    const [stashListHeight, setStashListHeight] = useState(220);
    const [stashListMaxHeight, setStashListMaxHeight] = useState(220);
    const stashTabRef = useRef<HTMLDivElement>(null);
    const stashListHeightRef = useRef(stashListHeight);
    const stashListMaxHeightRef = useRef(stashListMaxHeight);
    const dragCleanupRef = useRef<(() => void) | null>(null);
    const pendingRequestIdRef = useRef<string | null>(null);
    const [pendingRequestId, setPendingRequestId] = useState<string | null>(null);
    const isMutationPending = pendingRequestId !== null;

    useEffect(() => {
        stashListHeightRef.current = stashListHeight;
    }, [stashListHeight]);

    useEffect(() => {
        const handleMessage = (event: MessageEvent<unknown>): void => {
            if (!event.data || typeof event.data !== "object") return;
            const message = event.data as {
                type?: unknown;
                requestId?: unknown;
                repositoryRoot?: unknown;
            };
            if (
                message.type !== "stashMutationCompleted" ||
                message.requestId !== pendingRequestIdRef.current ||
                message.repositoryRoot !== repositoryRoot
            ) {
                return;
            }
            pendingRequestIdRef.current = null;
            setPendingRequestId(null);
        };
        window.addEventListener("message", handleMessage);
        return () => window.removeEventListener("message", handleMessage);
    }, [repositoryRoot]);

    useEffect(
        () => () => {
            dragCleanupRef.current?.();
        },
        [],
    );

    const postRepositoryMessage = useCallback(
        <T extends object>(message: T): T & { repositoryRoot?: string } => ({
            ...message,
            ...(repositoryRoot ? { repositoryRoot } : {}),
        }),
        [repositoryRoot],
    );

    const selectStash = useCallback(
        (index: number) => {
            if (displayedSelectedIndex === index) return;
            setSelectionOverride({ snapshot: stashes, index });
            setFileSelection({ stashIndex: index, path: null });
            vscode.postMessage(postRepositoryMessage({ type: "stashSelect", index }));
        },
        [displayedSelectedIndex, postRepositoryMessage, stashes, vscode],
    );

    const beginMutation = useCallback(
        (createMessage: (requestId: string) => Parameters<typeof vscode.postMessage>[0]) => {
            if (pendingRequestIdRef.current !== null) return;
            const requestId = createStashMutationRequestId();
            pendingRequestIdRef.current = requestId;
            setPendingRequestId(requestId);
            vscode.postMessage(createMessage(requestId));
        },
        [vscode],
    );

    const restoreOnCurrentBranch = useCallback(
        (index: number, action: "apply" | "pop", reinstateIndex = false) => {
            beginMutation((requestId) =>
                postRepositoryMessage({
                    type: "stashUnstash",
                    index,
                    mode: "currentBranch",
                    action,
                    reinstateIndex,
                    requestId,
                }),
            );
        },
        [beginMutation, postRepositoryMessage],
    );

    const restoreOnNewBranch = useCallback(
        (index: number, branchName: string) => {
            beginMutation((requestId) =>
                postRepositoryMessage({
                    type: "stashUnstash",
                    index,
                    mode: "branch",
                    branchName,
                    requestId,
                }),
            );
        },
        [beginMutation, postRepositoryMessage],
    );

    const showStashDiff = useCallback(
        (index: number, preview: boolean, path?: string) => {
            vscode.postMessage(
                postRepositoryMessage({
                    type: "showStashDiff",
                    index,
                    ...(path ? { path } : {}),
                    ...(preview ? {} : { preview: false }),
                }),
            );
        },
        [postRepositoryMessage, vscode],
    );

    const handleContextAction = useCallback(
        (index: number, action: StashContextAction, returnFocusTarget: HTMLElement | null) => {
            switch (action) {
                case "pop":
                    restoreOnCurrentBranch(index, "pop");
                    return;
                case "apply":
                    restoreOnCurrentBranch(index, "apply");
                    return;
                case "unstash":
                    if (!isMutationPending) setUnstashDialog({ index, returnFocusTarget });
                    return;
                case "drop":
                    beginMutation((requestId) =>
                        postRepositoryMessage({ type: "stashDelete", index, requestId }),
                    );
                    return;
                case "clear":
                    beginMutation((requestId) =>
                        postRepositoryMessage({ type: "stashClear", requestId }),
                    );
                    return;
                case "showDiff":
                    showStashDiff(index, true);
                    return;
                case "showDiffNewTab":
                    showStashDiff(index, false);
                    return;
                default:
                    return rejectUnhandledStashAction(action);
            }
        },
        [
            beginMutation,
            isMutationPending,
            postRepositoryMessage,
            restoreOnCurrentBranch,
            showStashDiff,
        ],
    );

    const toggleDir = useCallback(
        (path: string) => {
            setExpandedDirsState((previous) => {
                const next = new Set(previous.tree === tree ? previous.dirs : allDirPaths);
                if (next.has(path)) next.delete(path);
                else next.add(path);
                return { tree, dirs: next };
            });
        },
        [allDirPaths, tree],
    );

    const expandAll = useCallback(() => {
        setExpandedDirsState({ tree, dirs: new Set(allDirPaths) });
    }, [allDirPaths, tree]);

    const collapseAll = useCallback(() => {
        setExpandedDirsState({ tree, dirs: new Set() });
    }, [tree]);

    const constrainStashListHeight = useCallback((requestedHeight: number) => {
        const containerHeight = stashTabRef.current?.clientHeight ?? 0;
        const maximumHeight =
            containerHeight > 0
                ? Math.max(
                      MIN_STASH_LIST_HEIGHT,
                      containerHeight - STASH_LOWER_PANE_RESERVED_HEIGHT,
                  )
                : stashListMaxHeightRef.current;
        const nextHeight = Math.max(
            MIN_STASH_LIST_HEIGHT,
            Math.min(requestedHeight, maximumHeight),
        );
        stashListHeightRef.current = nextHeight;
        stashListMaxHeightRef.current = maximumHeight;
        setStashListHeight(nextHeight);
        setStashListMaxHeight(maximumHeight);
    }, []);

    useLayoutEffect(() => {
        const stashTab = stashTabRef.current;
        if (!stashTab) return;
        const synchronizeBounds = (): void => {
            constrainStashListHeight(stashListHeightRef.current);
        };

        synchronizeBounds();
        window.addEventListener("resize", synchronizeBounds);
        let resizeObserver: ResizeObserver | undefined;
        if (typeof ResizeObserver !== "undefined") {
            resizeObserver = new ResizeObserver(synchronizeBounds);
            resizeObserver.observe(stashTab);
        }

        return () => {
            window.removeEventListener("resize", synchronizeBounds);
            resizeObserver?.disconnect();
        };
    }, [constrainStashListHeight]);

    const startSplitterDrag = useCallback(
        (event: React.MouseEvent) => {
            event.preventDefault();
            const startY = event.clientY;
            const startHeight = stashListHeightRef.current;
            const onMouseMove = (moveEvent: MouseEvent) => {
                constrainStashListHeight(startHeight + moveEvent.clientY - startY);
            };
            const cleanup = () => {
                document.removeEventListener("mousemove", onMouseMove);
                document.removeEventListener("mouseup", cleanup);
                document.body.style.cursor = "";
                document.body.style.userSelect = "";
                dragCleanupRef.current = null;
            };
            document.addEventListener("mousemove", onMouseMove);
            document.addEventListener("mouseup", cleanup);
            document.body.style.cursor = "row-resize";
            document.body.style.userSelect = "none";
            dragCleanupRef.current = cleanup;
        },
        [constrainStashListHeight],
    );

    const handleSplitterKeyDown = useCallback(
        (event: React.KeyboardEvent) => {
            if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
            event.preventDefault();
            constrainStashListHeight(
                stashListHeightRef.current +
                    (event.key === "ArrowDown"
                        ? STASH_SPLITTER_KEYBOARD_STEP
                        : -STASH_SPLITTER_KEYBOARD_STEP),
            );
        },
        [constrainStashListHeight],
    );

    return (
        <Flex
            ref={stashTabRef}
            data-testid="stash-tab"
            direction="column"
            flex={1}
            minH={0}
            overflow="hidden"
            bg="var(--intelligit-pycharm-panel)"
            color="var(--intelligit-pycharm-foreground)"
        >
            <StashList
                stashes={stashes}
                selectedIndex={displayedSelectedIndex}
                height={stashListHeight}
                maxHeight={`calc(100% - ${STASH_LOWER_PANE_RESERVED_HEIGHT}px)`}
                onStashClick={selectStash}
                onStashContextMenu={(index, x, y) => {
                    selectStash(index);
                    const returnFocusTarget = stashTabRef.current?.querySelector<HTMLElement>(
                        `[data-stash-index="${index}"]`,
                    );
                    setContextMenu({ index, x, y, returnFocusTarget: returnFocusTarget ?? null });
                }}
            />
            <Box
                data-testid="stash-splitter"
                role="separator"
                aria-label={t("a11y.resizeStashList")}
                aria-orientation="horizontal"
                aria-valuemin={MIN_STASH_LIST_HEIGHT}
                aria-valuemax={stashListMaxHeight}
                aria-valuenow={stashListHeight}
                tabIndex={0}
                h="4px"
                flexShrink={0}
                cursor="row-resize"
                bg="var(--intelligit-pycharm-border)"
                _hover={{ bg: "var(--intelligit-pycharm-blue)" }}
                onMouseDown={startSplitterDrag}
                onKeyDown={handleSplitterKeyDown}
            />
            <StashToolbar
                selectedIndex={displayedSelectedIndex}
                groupByDir={groupByDir}
                hasGroupedDirectories={allDirPaths.length > 0}
                hoverDelay={hoverDelay}
                tooltipsEnabled={tooltipsEnabled}
                onShowStashDiff={() => {
                    if (displayedSelectedIndex !== null)
                        showStashDiff(displayedSelectedIndex, true);
                }}
                onToggleGroupBy={onToggleGroupBy}
                onExpandAll={expandAll}
                onCollapseAll={collapseAll}
            />
            <StashFilePane
                stashFiles={displayedStashFiles}
                selectedIndex={displayedSelectedIndex}
                isLoading={isStashFilesLoading}
                groupByDir={groupByDir}
                selectedFilePath={selectedFilePath}
                tree={tree}
                expandedDirs={expandedDirs}
                folderIcon={folderIcon}
                folderExpandedIcon={folderExpandedIcon}
                folderIconsByName={folderIconsByName}
                onToggleDir={toggleDir}
                onFileSelect={(path) =>
                    setFileSelection({ stashIndex: displayedSelectedIndex, path })
                }
                onFileActivate={(path) => {
                    if (displayedSelectedIndex !== null)
                        showStashDiff(displayedSelectedIndex, true, path);
                }}
            />
            <Flex
                align="center"
                gap="10px"
                px="30px"
                py="12px"
                borderTop="1px solid var(--intelligit-pycharm-border)"
                bg="var(--intelligit-pycharm-panel)"
            >
                <Button
                    variant="primary"
                    size="sm"
                    onClick={() => {
                        if (displayedSelectedIndex !== null) {
                            restoreOnCurrentBranch(displayedSelectedIndex, "apply");
                        }
                    }}
                    isDisabled={displayedSelectedIndex === null || isMutationPending}
                    fontSize="12px"
                    fontFamily={SYSTEM_FONT_STACK}
                >
                    {t("common.apply")}
                </Button>
                <Button
                    variant="primary"
                    size="sm"
                    onClick={() => {
                        if (displayedSelectedIndex !== null) {
                            restoreOnCurrentBranch(displayedSelectedIndex, "pop");
                        }
                    }}
                    isDisabled={displayedSelectedIndex === null || isMutationPending}
                    fontSize="12px"
                    fontFamily={SYSTEM_FONT_STACK}
                >
                    {t("common.pop")}
                </Button>
            </Flex>
            {contextMenu ? (
                <ContextMenu
                    x={contextMenu.x}
                    y={contextMenu.y}
                    minWidth={300}
                    onClose={() => setContextMenu(null)}
                    onSelect={(action) =>
                        handleContextAction(
                            contextMenu.index,
                            action as StashContextAction,
                            contextMenu.returnFocusTarget,
                        )
                    }
                    items={[
                        { label: t("common.pop"), action: "pop", disabled: isMutationPending },
                        { label: t("common.apply"), action: "apply", disabled: isMutationPending },
                        {
                            label: t("stash.action.unstash"),
                            action: "unstash",
                            disabled: isMutationPending,
                        },
                        { label: t("common.drop"), action: "drop", disabled: isMutationPending },
                        { label: t("common.clear"), action: "clear", disabled: isMutationPending },
                        { label: "", action: "stash-divider", separator: true },
                        { label: t("common.showDiff"), action: "showDiff" },
                        { label: t("stash.action.showDiffNewTab"), action: "showDiffNewTab" },
                    ]}
                />
            ) : null}
            {unstashDialog ? (
                <StashUnstashDialog
                    currentBranchName={currentBranchName}
                    returnFocusTarget={unstashDialog.returnFocusTarget}
                    onClose={() => setUnstashDialog(null)}
                    onCurrentBranchSubmit={(action, reinstateIndex) => {
                        restoreOnCurrentBranch(unstashDialog.index, action, reinstateIndex);
                        setUnstashDialog(null);
                    }}
                    onBranchSubmit={(branchName) => {
                        restoreOnNewBranch(unstashDialog.index, branchName);
                        setUnstashDialog(null);
                    }}
                />
            ) : null}
        </Flex>
    );
}
