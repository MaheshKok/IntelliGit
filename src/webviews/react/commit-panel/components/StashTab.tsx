// Stash tab: one tree whose rows expand in place into their own files.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Flex } from "@chakra-ui/react";
import { SYSTEM_FONT_STACK } from "../../../../utils/constants";
import type { StashEntry, ThemeFolderIconMap, ThemeTreeIcon, WorkingFile } from "../../../../types";
import { StashFileTree, StashList } from "./StashList";
import { StashToolbar } from "./StashToolbar";
import { StashUnstashDialog } from "./StashUnstashDialog";
import { getVsCodeApi } from "../hooks/useVsCodeApi";
import { getSettings } from "../../shared/settings";
import { ContextMenu } from "../../shared/components/ContextMenu";
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
    isRefreshing?: boolean;
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

type StashFileContextAction = "openDiff" | "editSource" | "cherryPickSelectedChanges";

interface SelectionOverride {
    snapshot: StashEntry[];
    index: number;
}

interface FileSelection {
    stashHash: string | null;
    path: string | null;
}

interface StashRowContextMenuState {
    kind: "stash-row";
    x: number;
    y: number;
    index: number;
    returnFocusTarget: HTMLElement | null;
}

interface StashFileContextMenuState {
    kind: "stash-file";
    x: number;
    y: number;
    index: number;
    stashHash: string;
    path: string;
    returnFocusTarget: HTMLElement;
}

type StashContextMenuState = StashRowContextMenuState | StashFileContextMenuState;

interface UnstashDialogState {
    index: number;
    returnFocusTarget: HTMLElement | null;
}

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

/** Composite key so two expanded stashes cannot share one directory's collapse state. */
function directoryKey(stashHash: string, dirPath: string): string {
    return `${stashHash}\n${dirPath}`;
}

/** Returns a copy of the set with `key` added when absent and removed when present. */
function toggleMember(current: ReadonlySet<string>, key: string): Set<string> {
    const next = new Set(current);
    if (!next.delete(key)) next.add(key);
    return next;
}

/**
 * Renders the stash tree and its typed actions.
 *
 * The host remains authoritative for stash snapshots and mutation outcomes. A local mutation guard
 * clears only when the host acknowledges the matching request for this repository.
 */
// Selection, dialog, expansion, and mutation state have independent transitions; one reducer would couple them.
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
    isRefreshing = false,
    onToggleGroupBy,
    // react-doctor-disable-next-line react-doctor/prefer-useReducer
}: Props): React.ReactElement {
    const vscode = getVsCodeApi();
    const { hoverDelay, tooltipsEnabled } = getSettings();
    const [selectionOverride, setSelectionOverride] = useState<SelectionOverride | null>(null);
    const displayedSelectedIndex =
        selectionOverride?.snapshot === stashes ? selectionOverride.index : selectedIndex;
    const [filesByHash, setFilesByHash] = useState<Readonly<Record<string, WorkingFile[]>>>({});
    const [expandedHashes, setExpandedHashes] = useState<ReadonlySet<string>>(
        () => new Set<string>(),
    );
    const [collapsedDirectories, setCollapsedDirectories] = useState<ReadonlySet<string>>(
        () => new Set<string>(),
    );
    const [fileSelection, setFileSelection] = useState<FileSelection>({
        stashHash: null,
        path: null,
    });
    // A file selection lapses when its stash collapses, handing the tree's single
    // selection back to the stash row rather than leaving nothing highlighted.
    const hasSelectedFile =
        fileSelection.stashHash !== null &&
        fileSelection.path !== null &&
        expandedHashes.has(fileSelection.stashHash);
    const [contextMenu, setContextMenu] = useState<StashContextMenuState | null>(null);
    const [unstashDialog, setUnstashDialog] = useState<UnstashDialogState | null>(null);
    const stashTabRef = useRef<HTMLDivElement>(null);
    const pendingRequestIdRef = useRef<string | null>(null);
    const [pendingRequestId, setPendingRequestId] = useState<string | null>(null);
    const isMutationPending = pendingRequestId !== null;

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

    // The host only ever ships files for the stash it considers selected, so pairing
    // this snapshot's files with this snapshot's selection is what makes the cache safe.
    useEffect(() => {
        if (selectedIndex === null) return;
        const hash = stashes.find((stash) => stash.index === selectedIndex)?.hash;
        if (hash === undefined) return;
        setFilesByHash((current) =>
            current[hash] === stashFiles ? current : { ...current, [hash]: stashFiles },
        );
    }, [selectedIndex, stashFiles, stashes]);

    const postRepositoryMessage = useCallback(
        <T extends object>(message: T): T & { repositoryRoot?: string } => ({
            ...message,
            ...(repositoryRoot ? { repositoryRoot } : {}),
        }),
        [repositoryRoot],
    );

    const selectStash = useCallback(
        (index: number) => {
            // Selecting a row takes the tree's single selection back from any file row.
            setFileSelection({ stashHash: null, path: null });
            if (displayedSelectedIndex === index) return;
            setSelectionOverride({ snapshot: stashes, index });
            vscode.postMessage(postRepositoryMessage({ type: "stashSelect", index }));
        },
        [displayedSelectedIndex, postRepositoryMessage, stashes, vscode],
    );

    // Expanding a row implies selecting it, and selecting is what loads its files.
    // One request at a time: the next uncached row is asked for after this one lands.
    useEffect(() => {
        const pending = stashes.find(
            (stash) => expandedHashes.has(stash.hash) && filesByHash[stash.hash] === undefined,
        );
        if (pending) selectStash(pending.index);
    }, [expandedHashes, filesByHash, selectStash, stashes]);

    const toggleStashExpansion = useCallback((stash: StashEntry): void => {
        setExpandedHashes((current) => toggleMember(current, stash.hash));
    }, []);

    const toggleDirectory = useCallback((stashHash: string, dirPath: string): void => {
        setCollapsedDirectories((current) =>
            toggleMember(current, directoryKey(stashHash, dirPath)),
        );
    }, []);

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

    const handleFileContextAction = useCallback(
        (menu: StashFileContextMenuState, action: StashFileContextAction) => {
            switch (action) {
                case "openDiff":
                    showStashDiff(menu.index, true, menu.path);
                    return;
                case "editSource":
                    vscode.postMessage(
                        postRepositoryMessage({ type: "openFile", path: menu.path }),
                    );
                    return;
                case "cherryPickSelectedChanges":
                    beginMutation((requestId) =>
                        postRepositoryMessage({
                            type: "cherryPickStashFile",
                            index: menu.index,
                            stashHash: menu.stashHash,
                            path: menu.path,
                            requestId,
                        }),
                    );
                    return;
                default:
                    return rejectUnhandledStashAction(action);
            }
        },
        [beginMutation, postRepositoryMessage, showStashDiff, vscode],
    );

    const closeContextMenu = useCallback(() => {
        const returnFocusTarget = contextMenu?.returnFocusTarget ?? null;
        setContextMenu(null);
        returnFocusTarget?.focus();
    }, [contextMenu]);

    const expandAll = useCallback(() => {
        setExpandedHashes(new Set(stashes.map((stash) => stash.hash)));
        setCollapsedDirectories(new Set<string>());
    }, [stashes]);

    const collapseAll = useCallback(() => {
        setExpandedHashes(new Set<string>());
        setCollapsedDirectories(new Set<string>());
    }, []);

    const renderSubtree = useCallback(
        (stash: StashEntry, files: WorkingFile[]): React.ReactNode => (
            <StashFileTree
                files={files}
                groupByDir={groupByDir}
                depth={0}
                selectedFilePath={
                    fileSelection.stashHash === stash.hash ? fileSelection.path : null
                }
                isDirectoryCollapsed={(path) =>
                    collapsedDirectories.has(directoryKey(stash.hash, path))
                }
                folderIcon={folderIcon}
                folderExpandedIcon={folderExpandedIcon}
                folderIconsByName={folderIconsByName}
                onToggleDirectory={(path) => toggleDirectory(stash.hash, path)}
                onFileSelect={(path) => setFileSelection({ stashHash: stash.hash, path })}
                onFileActivate={(path) => showStashDiff(stash.index, true, path)}
                onFileContextMenu={(path, x, y, returnFocusTarget) => {
                    setFileSelection({ stashHash: stash.hash, path });
                    setContextMenu({
                        kind: "stash-file",
                        index: stash.index,
                        stashHash: stash.hash,
                        path,
                        x,
                        y,
                        returnFocusTarget,
                    });
                }}
            />
        ),
        [
            collapsedDirectories,
            fileSelection,
            folderExpandedIcon,
            folderIcon,
            folderIconsByName,
            groupByDir,
            showStashDiff,
            toggleDirectory,
        ],
    );

    const rowContextMenuItems = useMemo(
        () => [
            { label: t("common.pop"), action: "pop", disabled: isMutationPending },
            { label: t("common.apply"), action: "apply", disabled: isMutationPending },
            { label: t("stash.action.unstash"), action: "unstash", disabled: isMutationPending },
            { label: t("common.drop"), action: "drop", disabled: isMutationPending },
            { label: t("common.clear"), action: "clear", disabled: isMutationPending },
            { label: "", action: "stash-divider", separator: true },
            { label: t("common.showDiff"), action: "showDiff" },
            { label: t("stash.action.showDiffNewTab"), action: "showDiffNewTab" },
        ],
        [isMutationPending],
    );

    const fileContextMenuItems = useMemo(
        () => [
            { label: t("stash.fileAction.openDiff"), action: "openDiff" },
            { label: t("stash.fileAction.editSource"), action: "editSource" },
            {
                label: t("stash.fileAction.cherryPickSelectedChanges"),
                action: "cherryPickSelectedChanges",
                disabled: isMutationPending,
            },
        ],
        [isMutationPending],
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
            <StashToolbar
                selectedIndex={displayedSelectedIndex}
                groupByDir={groupByDir}
                canExpandOrCollapse={stashes.length > 0}
                hoverDelay={hoverDelay}
                tooltipsEnabled={tooltipsEnabled}
                isRefreshing={isRefreshing}
                onRefresh={() =>
                    vscode.postMessage({
                        type: "refresh",
                        ...(repositoryRoot ? { repositoryRoot } : {}),
                    })
                }
                onShowStashDiff={() => {
                    if (displayedSelectedIndex !== null)
                        showStashDiff(displayedSelectedIndex, true);
                }}
                onToggleGroupBy={onToggleGroupBy}
                onExpandAll={expandAll}
                onCollapseAll={collapseAll}
            />
            <StashList
                stashes={stashes}
                selectedIndex={displayedSelectedIndex}
                hasSelectedFile={hasSelectedFile}
                expandedHashes={expandedHashes}
                filesByHash={filesByHash}
                onStashClick={selectStash}
                onToggleExpand={toggleStashExpansion}
                onStashContextMenu={(index, x, y) => {
                    selectStash(index);
                    const returnFocusTarget = stashTabRef.current?.querySelector<HTMLElement>(
                        `[data-stash-index="${index}"]`,
                    );
                    setContextMenu({
                        kind: "stash-row",
                        index,
                        x,
                        y,
                        returnFocusTarget: returnFocusTarget ?? null,
                    });
                }}
                renderSubtree={renderSubtree}
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
                    onClose={closeContextMenu}
                    onSelect={(action) => {
                        if (contextMenu.kind === "stash-row") {
                            handleContextAction(
                                contextMenu.index,
                                action as StashContextAction,
                                contextMenu.returnFocusTarget,
                            );
                            return;
                        }
                        handleFileContextAction(contextMenu, action as StashFileContextAction);
                    }}
                    items={
                        contextMenu.kind === "stash-row"
                            ? rowContextMenuItems
                            : fileContextMenuItems
                    }
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
