// Repository row shell for the docked multi-repository commit panel.

import React, { useCallback, useEffect, useRef, useState, type Dispatch } from "react";
import { Box, Flex, IconButton, Tooltip } from "@chakra-ui/react";
import { TabBar } from "./TabBar";
import { CommitTab } from "./CommitTab";
import { StashTab } from "./StashTab";
import { useCheckedFiles } from "../hooks/useCheckedFiles";
import { getVsCodeApi } from "../hooks/useVsCodeApi";
import { canRunCommitAction } from "../commitEligibility";
import { getSettings } from "../../shared/settings";
import { t } from "../../shared/i18n";
import type { CommitPanelAction, RepositoryCommitPanelState } from "../types";

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

function branchSummary(repository: RepositoryCommitPanelState): string {
    const parts: string[] = [];
    if (repository.currentBranchName) {
        parts.push(
            repository.currentBranchUpstream
                ? `${repository.currentBranchName} -> ${repository.currentBranchUpstream}`
                : repository.currentBranchName,
        );
    }
    const divergence: string[] = [];
    if (repository.currentBranchAhead > 0) divergence.push(`+${repository.currentBranchAhead}`);
    if (repository.currentBranchBehind > 0) divergence.push(`-${repository.currentBranchBehind}`);
    if (divergence.length > 0) parts.push(divergence.join(" "));
    return parts.join(" | ");
}

function repositoryScope(root: string): { repositoryRoot?: string } {
    return root ? { repositoryRoot: root } : {};
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
        useCheckedFiles(repository.files, repository.root || undefined);
    const summary = branchSummary(repository);
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
        (type: "sync" | "fetch" | "pull" | "push" | "publishBranch") => {
            vscode.postMessage({ type, ...repositoryScope(repository.root) });
        },
        [repository.root, vscode],
    );

    const handleMessageChange = useCallback(
        (message: string) => {
            dispatch({ type: "SET_COMMIT_MESSAGE", repositoryRoot: repository.root, message });
            vscode.postMessage({
                type: "saveCommitDraft",
                ...repositoryScope(repository.root),
                message,
            });
        },
        [dispatch, repository.root, vscode],
    );

    const handleAmendChange = useCallback(
        (isAmend: boolean) => {
            dispatch({ type: "SET_AMEND", repositoryRoot: repository.root, isAmend });
            if (isAmend) {
                vscode.postMessage({
                    type: "getLastCommitMessage",
                    ...repositoryScope(repository.root),
                });
            }
        },
        [dispatch, repository.root, vscode],
    );

    const handleCommit = useCallback(() => {
        vscode.postMessage({
            type: "commitSelected",
            ...repositoryScope(repository.root),
            message: repository.commitMessage.trim(),
            amend: repository.isAmend,
            push: false,
            paths: Array.from(checkedPaths),
        });
    }, [checkedPaths, repository.commitMessage, repository.isAmend, repository.root, vscode]);

    const handlePush = useCallback(() => {
        postRepositoryCommand(shouldPublishBranch ? "publishBranch" : "push");
    }, [postRepositoryCommand, shouldPublishBranch]);

    const handleToggleShowIgnoredFiles = useCallback(() => {
        setShowIgnoredFiles((value) => !value);
    }, []);

    return (
        <Flex
            data-testid="repository-accordion"
            data-repository-root={repository.root}
            direction="column"
            flex={isOnlyRepository && isExpanded ? 1 : "0 0 auto"}
            minH={isOnlyRepository ? 0 : undefined}
            borderBottom="1px solid var(--intelligit-pycharm-border)"
        >
            <Flex
                as="button"
                type="button"
                data-testid="repository-accordion-header"
                align="center"
                gap="8px"
                w="100%"
                minH="34px"
                px="8px"
                py="4px"
                bg="var(--intelligit-pycharm-header)"
                color="var(--intelligit-pycharm-foreground)"
                textAlign="left"
                onClick={() => onToggleExpanded(repository.root)}
                aria-expanded={isExpanded}
            >
                <Box as="span" w="12px" flexShrink={0} fontSize="12px">
                    {isExpanded ? "v" : ">"}
                </Box>
                <Box as="span" flexShrink={0} fontSize="12px" fontWeight={700}>
                    {repository.label}
                </Box>
                {summary ? (
                    <Box
                        as="span"
                        flex={1}
                        minW={0}
                        overflow="hidden"
                        textOverflow="ellipsis"
                        whiteSpace="nowrap"
                        color="var(--vscode-descriptionForeground)"
                        fontSize="11px"
                    >
                        {summary}
                    </Box>
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
                    minW="22px"
                    px="5px"
                    textAlign="center"
                    fontSize="11px"
                    color="var(--vscode-descriptionForeground)"
                    border="1px solid var(--intelligit-pycharm-border)"
                    borderRadius="999px"
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
                >
                    <Flex
                        data-testid="repository-action-toolbar"
                        align="center"
                        justify="flex-end"
                        minH="28px"
                        px="6px"
                        bg="var(--intelligit-pycharm-header)"
                        borderBottom="1px solid var(--intelligit-pycharm-border)"
                    >
                        <RepositoryActionButton
                            label={t("common.sync")}
                            onClick={() => postRepositoryCommand("sync")}
                            color="#c8a2ff"
                        >
                            <path
                                fill="currentColor"
                                d="M13 2v4H9l1.55-1.55A4.4 4.4 0 0 0 3.9 6.2l-.94-.34A5.4 5.4 0 0 1 11.25 3.75L13 2zM3 14v-4h4l-1.55 1.55A4.4 4.4 0 0 0 12.1 9.8l.94.34a5.4 5.4 0 0 1-8.29 2.11L3 14z"
                            />
                        </RepositoryActionButton>
                        <RepositoryActionButton
                            label={t("common.fetch")}
                            onClick={() => postRepositoryCommand("fetch")}
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
                        </RepositoryActionButton>
                        <RepositoryActionButton
                            label={t("common.pull")}
                            onClick={() => postRepositoryCommand("pull")}
                            color="#8fd5ff"
                        >
                            <path
                                fill="currentColor"
                                d="M7.5 1h1v8.1l2.15-2.15.7.7L8 11 4.65 7.65l.7-.7L7.5 9.1V1z"
                            />
                            <path fill="currentColor" d="M3 13h10v1H3v-1z" />
                        </RepositoryActionButton>
                        <RepositoryActionButton
                            label={t("common.push")}
                            onClick={handlePush}
                            color="#a6e3a1"
                        >
                            <path
                                fill="currentColor"
                                d="M8 1l3.35 3.35-.7.7L8.5 2.9V11h-1V2.9L5.35 5.05l-.7-.7L8 1z"
                            />
                            <path fill="currentColor" d="M3 13h10v1H3v-1z" />
                        </RepositoryActionButton>
                    </Flex>
                    <Box flex={1} minH={0} overflow="hidden">
                        <TabBar
                            stashCount={repository.stashes.length}
                            commitContent={
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
                                    currentBranchName={repository.currentBranchName}
                                    currentBranchUpstream={repository.currentBranchUpstream}
                                    folderIcon={repository.folderIcon}
                                    folderExpandedIcon={repository.folderExpandedIcon}
                                    folderIconsByName={repository.folderIconsByName}
                                    groupByDir={groupByDir}
                                    showIgnoredFiles={showIgnoredFiles}
                                    onToggleGroupBy={onToggleGroupBy}
                                    onToggleShowIgnoredFiles={handleToggleShowIgnoredFiles}
                                />
                            }
                            stashContent={
                                <StashTab
                                    repositoryRoot={repository.root || undefined}
                                    stashes={repository.stashes}
                                    stashFiles={repository.stashFiles}
                                    selectedIndex={repository.selectedStashIndex}
                                    folderIcon={repository.folderIcon}
                                    folderExpandedIcon={repository.folderExpandedIcon}
                                    folderIconsByName={repository.folderIconsByName}
                                    groupByDir={groupByDir}
                                    onToggleGroupBy={onToggleGroupBy}
                                />
                            }
                        />
                    </Box>
                </Flex>
            ) : null}
        </Flex>
    );
}

function RepositoryActionButton({
    label,
    onClick,
    color,
    disabled = false,
    children,
}: {
    label: string;
    onClick: () => void;
    color: string;
    disabled?: boolean;
    children: React.ReactNode;
}): React.ReactElement {
    const { hoverDelay, tooltipsEnabled, iconStyle } = getSettings();
    const resolvedColor = disabled
        ? "var(--vscode-disabledForeground)"
        : iconStyle === "standard"
          ? "var(--vscode-icon-foreground)"
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
                aria-disabled={disabled || undefined}
                isDisabled={disabled}
                variant="toolbarGhost"
                size="sm"
                alignSelf="center"
                mx="4px"
                opacity={disabled ? 0.55 : undefined}
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
