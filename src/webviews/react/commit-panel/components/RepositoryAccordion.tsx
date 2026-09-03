// Repository row shell for the docked multi-repository commit panel.

import React, { useCallback, useEffect, useRef, useState, type Dispatch } from "react";
import { Box, Flex } from "@chakra-ui/react";
import { VscRepo } from "react-icons/vsc";
import { TabBar } from "./TabBar";
import { CommitTab } from "./CommitTab";
import { StashTab } from "./StashTab";
import { ShelfTab } from "./ShelfTab";
import { isActiveShelf } from "./ShelfList";
import {
    COMMIT_PANEL_INDENT_GUIDE_COLOR,
    COMMIT_PANEL_SECTION_GUIDE_LEFT,
} from "../../shared/components/FileTreeRows";
import { useCheckedFiles } from "../hooks/useCheckedFiles";
import { useShelfDrag } from "../hooks/useShelfDrag";
import { getVsCodeApi } from "../hooks/useVsCodeApi";
import { canRunCommitAction } from "../commitEligibility";
import { ChevronIcon, WorktreeSmallIcon } from "../../shared/components/Icons";
import { t } from "../../shared/i18n";
import type { CommitPanelAction, RepositoryCommitPanelState } from "../types";
import { JETBRAINS_UI, MOTION, Z_INDEX } from "../../shared/tokens";

interface Props {
    repository: RepositoryCommitPanelState;
    isExpanded: boolean;
    isOnlyRepository: boolean;
    groupByDir: boolean;
    onToggleExpanded: (root: string) => void;
    onToggleGroupBy: () => void;
    dispatch: Dispatch<CommitPanelAction>;
}

type SavedWebviewState = Record<string, unknown> | undefined;
let commitMessageGenerationRequestSequence = 0;
const IDLE_GENERATION: RepositoryCommitPanelState["generation"] = { status: "idle" };

/**
 * Creates an opaque, client-local token that correlates one docked generation request with host events.
 *
 * The token deliberately contains no repository or draft data; callers generate it immediately before
 * dispatching so a synchronous host `start` event can only target the already-recorded request.
 */
function nextCommitMessageGenerationRequestId(): string {
    commitMessageGenerationRequestSequence += 1;
    return `commit-message-${Date.now()}-${commitMessageGenerationRequestSequence}`;
}

function savedBooleanByRepository(
    saved: SavedWebviewState,
    key: string,
    repositoryRoot: string,
): boolean | undefined {
    const byRepository = saved?.[key];
    if (!byRepository || typeof byRepository !== "object" || Array.isArray(byRepository)) {
        return undefined;
    }
    const value = (byRepository as Record<string, unknown>)[repositoryRoot];
    return typeof value === "boolean" ? value : undefined;
}

function savedShowIgnoredFiles(saved: SavedWebviewState, repositoryRoot: string): boolean {
    return (
        savedBooleanByRepository(saved, "showIgnoredFilesByRepository", repositoryRoot) ??
        saved?.showIgnoredFiles === true
    );
}

function savedObjectByRepository(saved: SavedWebviewState, key: string): Record<string, unknown> {
    const byRepository = saved?.[key];
    return byRepository && typeof byRepository === "object" && !Array.isArray(byRepository)
        ? { ...byRepository }
        : {};
}

function branchSummary(repository: RepositoryCommitPanelState): string | null {
    return repository.currentBranchName;
}

/** Uses the Worktrees section's short-name convention while retaining repository labels unchanged. */
function displayRepositoryLabel(repository: RepositoryCommitPanelState): string {
    if (repository.kind !== "worktree") return repository.label;
    return repository.label.split(/[\\/]/).filter(Boolean).pop() ?? repository.label;
}

function repositoryScope(root: string): { repositoryRoot?: string } {
    return root ? { repositoryRoot: root } : {};
}

/** Returns the idle lifecycle used by legacy repository snapshots that predate generation state. */
function generationOrIdle(
    generation: RepositoryCommitPanelState["generation"] | undefined,
): RepositoryCommitPanelState["generation"] {
    return generation ?? IDLE_GENERATION;
}

/**
 * Renders one repository accordion row and scopes every outbound row action by root.
 *
 * Commit, stash, refresh, draft, amend, and Git transport commands keep the
 * repository root in their payload so the host can route them to the matching runtime.
 */
// This row keeps root-scoped actions next to their matching tab content to avoid indirect routing.
// react-doctor-disable-next-line react-doctor/no-giant-component
export function RepositoryAccordion({
    repository,
    isExpanded,
    isOnlyRepository,
    groupByDir,
    onToggleExpanded,
    onToggleGroupBy,
    dispatch,
}: Props): React.ReactElement {
    const vscode = getVsCodeApi();
    const [showIgnoredFiles, setShowIgnoredFiles] = useState<boolean>(() => {
        const saved = vscode.getState?.();
        return savedShowIgnoredFiles(saved, repository.root);
    });
    const showIgnoredFilesPostedRef = useRef(false);
    const { checkedPaths, toggleFile, toggleFolder, toggleSection, isAllChecked, isSomeChecked } =
        useCheckedFiles(repository.files, repository.root, repository.filesHydrated);
    const shelfDrag = useShelfDrag({
        repositoryRoot: repository.root || undefined,
        catalogGeneration: repository.catalogGeneration,
        removeOnUnshelve: repository.shelfRemoveOnUnshelve,
        onMessage: (message) => vscode.postMessage(message),
    });
    const summary = branchSummary(repository);
    const displayLabel = displayRepositoryLabel(repository);
    const generation = generationOrIdle(repository.generation);
    const generationStatus = generation.status;
    const generationRequestId = generation.requestId;
    const isGenerationActive = generationStatus !== "idle";
    const canCommit = canRunCommitAction(
        repository.isAmend,
        checkedPaths.size,
        repository.commitMessage,
    );
    const shouldPublishBranch = !repository.currentBranchHasUpstream;
    const canPush = shouldPublishBranch
        ? repository.currentBranchName !== null
        : repository.currentBranchAhead > 0;
    const pushLabel = shouldPublishBranch ? "commit.action.publishAndPush" : "common.push";

    useEffect(() => {
        const prev = vscode.getState?.() ?? {};
        vscode.setState({
            ...prev,
            showIgnoredFilesByRepository: {
                ...savedObjectByRepository(prev, "showIgnoredFilesByRepository"),
                [repository.root]: showIgnoredFiles,
            },
        });
    }, [repository.root, showIgnoredFiles, vscode]);

    useEffect(() => {
        const shouldPost = showIgnoredFilesPostedRef.current || showIgnoredFiles;
        showIgnoredFilesPostedRef.current = true;
        if (!shouldPost) return;
        vscode.postMessage({
            type: "setShowIgnoredFiles",
            ...repositoryScope(repository.root),
            showIgnoredFiles,
        });
    }, [repository.root, showIgnoredFiles, vscode]);

    useEffect(() => {
        if (!isExpanded) return;
        if (!repository.isAmend) return;
        if (repository.isRefreshing) return;
        vscode.postMessage({
            type: "getAmendBranchCommits",
            ...repositoryScope(repository.root),
        });
    }, [isExpanded, repository.isAmend, repository.isRefreshing, repository.root, vscode]);

    const postRepositoryCommand = useCallback(
        (type: "sync" | "fetch" | "pull" | "push" | "publishBranch" | "openRepository") => {
            vscode.postMessage({ type, ...repositoryScope(repository.root) });
        },
        [repository.root, vscode],
    );

    const handleMessageChange = useCallback(
        (message: string) => {
            if (isGenerationActive) return;
            dispatch({ type: "SET_COMMIT_MESSAGE", repositoryRoot: repository.root, message });
            vscode.postMessage({
                type: "saveCommitDraft",
                ...repositoryScope(repository.root),
                message,
            });
        },
        [dispatch, isGenerationActive, repository.root, vscode],
    );

    const handleAmendChange = useCallback(
        (isAmend: boolean) => {
            if (isGenerationActive || !repository.hasCommits) return;
            dispatch({ type: "SET_AMEND", repositoryRoot: repository.root, isAmend });
            if (isAmend) {
                vscode.postMessage({
                    type: "getLastCommitMessage",
                    ...repositoryScope(repository.root),
                });
            }
        },
        [dispatch, isGenerationActive, repository.hasCommits, repository.root, vscode],
    );

    const handleCommit = useCallback(() => {
        if (isGenerationActive || (repository.isAmend && !repository.hasCommits)) return;
        vscode.postMessage({
            type: "commitSelected",
            ...repositoryScope(repository.root),
            message: repository.commitMessage.trim(),
            amend: repository.isAmend,
            push: false,
            paths: Array.from(checkedPaths),
        });
    }, [
        checkedPaths,
        isGenerationActive,
        repository.commitMessage,
        repository.hasCommits,
        repository.isAmend,
        repository.root,
        vscode,
    ]);

    const handleGenerateMessage = useCallback(() => {
        const hasGenerationInput = repository.isAmend
            ? repository.hasCommits
            : checkedPaths.size > 0;
        if (
            !repository.root ||
            isGenerationActive ||
            repository.wholeIndexOperationInProgress ||
            !hasGenerationInput
        ) {
            return;
        }
        const requestId = nextCommitMessageGenerationRequestId();
        dispatch({
            type: "REQUEST_COMMIT_MESSAGE_GENERATION",
            repositoryRoot: repository.root,
            requestId,
            snapshot: repository.commitMessage,
        });
        vscode.postMessage({
            type: "generateCommitMessage",
            repositoryRoot: repository.root,
            requestId,
            paths: Array.from(checkedPaths),
            amend: repository.isAmend,
        });
    }, [
        checkedPaths,
        dispatch,
        isGenerationActive,
        repository.commitMessage,
        repository.hasCommits,
        repository.isAmend,
        repository.root,
        repository.wholeIndexOperationInProgress,
        vscode,
    ]);

    const handleCancelGeneration = useCallback(() => {
        if (
            (generationStatus !== "requested" && generationStatus !== "running") ||
            !generationRequestId
        ) {
            return;
        }
        vscode.postMessage({
            type: "cancelCommitMessageGeneration",
            repositoryRoot: repository.root,
            requestId: generationRequestId,
        });
    }, [generationRequestId, generationStatus, repository.root, vscode]);

    const handlePush = useCallback(() => {
        postRepositoryCommand(shouldPublishBranch ? "publishBranch" : "push");
    }, [postRepositoryCommand, shouldPublishBranch]);

    const handleToggleShowIgnoredFiles = useCallback(() => {
        setShowIgnoredFiles((value) => !value);
    }, []);

    const commitContent = (
        <CommitTab
            repositoryRoot={repository.root || undefined}
            files={repository.files}
            commitMessage={repository.commitMessage}
            isAmend={repository.isAmend}
            amendBranchCommits={repository.amendBranchCommits}
            amendBranchHistoryLoaded={repository.amendBranchHistoryLoaded}
            isRefreshing={repository.isRefreshing}
            checkedPaths={checkedPaths}
            onToggleFile={toggleFile}
            onToggleFolder={toggleFolder}
            onToggleSection={toggleSection}
            isAllChecked={isAllChecked}
            isSomeChecked={isSomeChecked}
            onMessageChange={handleMessageChange}
            onAmendChange={handleAmendChange}
            onCommit={handleCommit}
            canCommit={canCommit}
            onPush={handlePush}
            canPush={canPush}
            pushLabel={pushLabel}
            currentBranchAhead={repository.currentBranchAhead}
            currentBranchName={repository.currentBranchName}
            currentBranchUpstream={repository.currentBranchUpstream}
            generationStatus={generationStatus}
            onGenerateMessage={handleGenerateMessage}
            onCancelGeneration={handleCancelGeneration}
            hasCommits={repository.hasCommits}
            wholeIndexOperationInProgress={repository.wholeIndexOperationInProgress}
            activeOperation={repository.activeOperation ?? "none"}
            rebaseControl={repository.rebaseControl}
            folderIcon={repository.folderIcon}
            folderExpandedIcon={repository.folderExpandedIcon}
            folderIconsByName={repository.folderIconsByName}
            groupByDir={groupByDir}
            showIgnoredFiles={showIgnoredFiles}
            onToggleGroupBy={onToggleGroupBy}
            onToggleShowIgnoredFiles={handleToggleShowIgnoredFiles}
            catalogGeneration={repository.catalogGeneration}
            onShelfFileDragStart={shelfDrag.onCommitFileDragStart}
        />
    );
    const stashContent = (
        <StashTab
            repositoryRoot={repository.root || undefined}
            currentBranchName={repository.currentBranchName}
            stashes={repository.stashes}
            stashFiles={repository.stashFiles}
            selectedIndex={repository.selectedStashIndex}
            folderIcon={repository.folderIcon}
            folderExpandedIcon={repository.folderExpandedIcon}
            folderIconsByName={repository.folderIconsByName}
            groupByDir={groupByDir}
            isRefreshing={repository.isRefreshing}
            onToggleGroupBy={onToggleGroupBy}
        />
    );
    const shelfContent = (
        <ShelfTab
            repositoryRoot={repository.root || undefined}
            shelves={repository.shelves}
            selectedShelfId={repository.selectedShelfId}
            catalogGeneration={repository.catalogGeneration}
            shelfRemoveOnUnshelve={repository.shelfRemoveOnUnshelve ?? true}
            shelfHealth={repository.shelfHealth ?? []}
            groupByDir={groupByDir}
            folderIcon={repository.folderIcon}
            folderExpandedIcon={repository.folderExpandedIcon}
            folderIconsByName={repository.folderIconsByName}
            isRefreshing={repository.isRefreshing}
            outcome={repository.shelfMutationOutcome ?? undefined}
            onRefresh={() =>
                vscode.postMessage({ type: "refresh", ...repositoryScope(repository.root) })
            }
            onSelect={(message) =>
                vscode.postMessage({ ...message, ...repositoryScope(repository.root) })
            }
            onUnshelve={(message) =>
                vscode.postMessage({ ...message, ...repositoryScope(repository.root) })
            }
            onUnshelveSilently={(message) =>
                vscode.postMessage({ ...message, ...repositoryScope(repository.root) })
            }
            onRename={(message) =>
                vscode.postMessage({ ...message, ...repositoryScope(repository.root) })
            }
            onDelete={(message) =>
                vscode.postMessage({ ...message, ...repositoryScope(repository.root) })
            }
            onShowDiff={(message) =>
                vscode.postMessage({ ...message, ...repositoryScope(repository.root) })
            }
            onCompareWithLocal={(message) =>
                vscode.postMessage({ ...message, ...repositoryScope(repository.root) })
            }
            onRestoreGhost={(message) =>
                vscode.postMessage({ ...message, ...repositoryScope(repository.root) })
            }
            onImportPatch={(message) =>
                vscode.postMessage({ ...message, ...repositoryScope(repository.root) })
            }
            onExportPatch={(message) =>
                vscode.postMessage({ ...message, ...repositoryScope(repository.root) })
            }
            onCopyPatch={(message) =>
                vscode.postMessage({ ...message, ...repositoryScope(repository.root) })
            }
            onCleanUp={(message) =>
                vscode.postMessage({ ...message, ...repositoryScope(repository.root) })
            }
            onToggleGroupBy={onToggleGroupBy}
            onOpenConflictEditor={(message) =>
                vscode.postMessage({ ...message, ...repositoryScope(repository.root) })
            }
            onResolveStructural={(message) =>
                vscode.postMessage({ ...message, ...repositoryScope(repository.root) })
            }
            onDragOver={shelfDrag.onShelfDragOver}
            onDrop={shelfDrag.onShelfDrop}
            onShelfEntryDragStart={shelfDrag.onShelfEntryDragStart}
        />
    );

    if (isOnlyRepository) {
        return (
            <Flex direction="column" flex={1} minH={0} overflow="hidden">
                <TabBar
                    stashCount={repository.stashes.length}
                    shelfCount={(repository.shelves ?? []).filter(isActiveShelf).length}
                    shelfWarningCount={(repository.shelfHealth ?? []).length}
                    onSync={() => postRepositoryCommand("sync")}
                    onFetch={() => postRepositoryCommand("fetch")}
                    onPull={() => postRepositoryCommand("pull")}
                    onPush={handlePush}
                    onOpenRepository={() => postRepositoryCommand("openRepository")}
                    currentBranchBehind={repository.currentBranchBehind}
                    commitContent={commitContent}
                    stashContent={stashContent}
                    shelfContent={shelfContent}
                    onCommitDragOver={shelfDrag.onCommitDragOver}
                    onCommitDrop={shelfDrag.onCommitDrop}
                    onShelfDragOver={shelfDrag.onShelfDragOver}
                    onShelfDrop={shelfDrag.onShelfDrop}
                />
            </Flex>
        );
    }

    return (
        <Flex
            data-testid="repository-accordion"
            data-repository-root={repository.root}
            direction="column"
            flex="0 0 auto"
            borderBottom="1px solid var(--intelligit-pycharm-border)"
        >
            <Flex
                as="button"
                type="button"
                data-testid="repository-accordion-header"
                align="center"
                gap="6px"
                w="100%"
                minH="32px"
                px="8px"
                py="4px"
                bg="var(--intelligit-pycharm-panel)"
                color="var(--intelligit-pycharm-foreground)"
                textAlign="left"
                transition={`background-color ${MOTION.state}`}
                _hover={{ bg: "var(--intelligit-pycharm-selected-hover)" }}
                onClick={() => onToggleExpanded(repository.root)}
                aria-expanded={isExpanded}
            >
                <Box
                    as="span"
                    display="inline-flex"
                    w="16px"
                    flexShrink={0}
                    color="var(--vscode-descriptionForeground)"
                >
                    <ChevronIcon expanded={isExpanded} />
                </Box>
                <Box
                    as="span"
                    data-testid="repository-kind-icon"
                    data-repository-kind={repository.kind}
                    display="inline-flex"
                    alignItems="center"
                    w="16px"
                    flexShrink={0}
                    color="var(--vscode-descriptionForeground)"
                >
                    {repository.kind === "worktree" ? (
                        <WorktreeSmallIcon color="var(--vscode-descriptionForeground)" />
                    ) : (
                        <VscRepo
                            size={16}
                            aria-hidden
                            focusable="false"
                            style={{ color: "var(--vscode-descriptionForeground)" }}
                        />
                    )}
                </Box>
                <Box as="span" flexShrink={0} fontSize="13px" fontWeight={600}>
                    {displayLabel}
                </Box>
                {summary ? (
                    <Flex
                        as="span"
                        align="center"
                        gap="6px"
                        flex={1}
                        minW={0}
                        overflow="hidden"
                        fontSize="11px"
                        color="var(--vscode-descriptionForeground)"
                    >
                        <Box
                            as="span"
                            minW={0}
                            overflow="hidden"
                            textOverflow="ellipsis"
                            whiteSpace="nowrap"
                        >
                            {summary}
                        </Box>
                    </Flex>
                ) : (
                    <Box as="span" flex={1} />
                )}
                {repository.isRefreshing ? (
                    <Box as="span" color="var(--vscode-descriptionForeground)" fontSize="11px">
                        {t("common.refreshing")}
                    </Box>
                ) : null}
                {repository.error ? (
                    <Box
                        as="span"
                        color="var(--vscode-errorForeground)"
                        fontSize="12px"
                        title={repository.error}
                    >
                        !
                    </Box>
                ) : null}
                <Box
                    as="span"
                    minW="18px"
                    h="16px"
                    lineHeight="16px"
                    px="6px"
                    flexShrink={0}
                    textAlign="center"
                    fontSize="11px"
                    bg="var(--vscode-badge-background, rgba(255, 255, 255, 0.12))"
                    color="var(--vscode-badge-foreground, #d6dbe5)"
                    borderRadius={`${JETBRAINS_UI.size.pillRadius}px`}
                >
                    {repository.changedFileCount}
                </Box>
            </Flex>
            {isExpanded ? (
                <Flex
                    direction="column"
                    h={isOnlyRepository ? "100%" : "520px"}
                    minH={isOnlyRepository ? 0 : "360px"}
                    overflow="hidden"
                    position="relative"
                >
                    <Box
                        aria-hidden
                        data-testid="repository-accordion-guide"
                        position="absolute"
                        top={0}
                        bottom={0}
                        left={`${COMMIT_PANEL_SECTION_GUIDE_LEFT}px`}
                        w="1px"
                        bg={COMMIT_PANEL_INDENT_GUIDE_COLOR}
                        pointerEvents="none"
                        zIndex={Z_INDEX.raised}
                    />
                    <Box
                        data-testid="repository-accordion-content"
                        data-repository-root={repository.root}
                        flex={1}
                        minW={0}
                        minH={0}
                        overflow="hidden"
                        pl="19px"
                    >
                        <TabBar
                            stashCount={repository.stashes.length}
                            shelfCount={(repository.shelves ?? []).filter(isActiveShelf).length}
                            shelfWarningCount={(repository.shelfHealth ?? []).length}
                            onSync={() => postRepositoryCommand("sync")}
                            onFetch={() => postRepositoryCommand("fetch")}
                            onPull={() => postRepositoryCommand("pull")}
                            onPush={handlePush}
                            onOpenRepository={() => postRepositoryCommand("openRepository")}
                            currentBranchBehind={repository.currentBranchBehind}
                            commitContent={commitContent}
                            stashContent={stashContent}
                            shelfContent={shelfContent}
                            onCommitDragOver={shelfDrag.onCommitDragOver}
                            onCommitDrop={shelfDrag.onCommitDrop}
                            onShelfDragOver={shelfDrag.onShelfDragOver}
                            onShelfDrop={shelfDrag.onShelfDrop}
                        />
                    </Box>
                </Flex>
            ) : null}
        </Flex>
    );
}
