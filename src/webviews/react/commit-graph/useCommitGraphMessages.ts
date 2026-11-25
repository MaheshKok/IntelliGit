// Owns the CommitGraphPanel window-message bridge for extension-host events.
// The hook stays separate from render logic so the root component remains small.
// It preserves the existing VS Code webview message contract without changing dispatch behavior.

import { useEffect, useLayoutEffect, useRef } from "react";
import type React from "react";
import type { CommitGraphInbound } from "../../protocol/commitGraphTypes";
import { retireCiBisect } from "../commit-info/checks/ciBisect";
import { openChecksTab } from "../commit-info/checks/checksTabState";
import type { CommitGraphPanelAction } from "./types";
import type { VsCodeApi } from "../shared/vscodeApi";

/**
 * Subscribes to extension-host commit graph messages and dispatches panel state updates.
 *
 * `loadingMore` remains caller-owned because the root component also controls pagination requests.
 */
export function useCommitGraphMessages(params: {
    vscode: VsCodeApi;
    dispatch: React.Dispatch<CommitGraphPanelAction>;
    sendReady: boolean;
    loadingMore: React.MutableRefObject<boolean>;
    selectedHash: string | null;
    /** Repository the Checks tab shows; an `openChecksTab` message for another one is dropped. */
    ciRepoKey?: string;
    setViewVisible: (visible: boolean) => void;
    onShowRebaseDialog: (dialog: Extract<CommitGraphInbound, { type: "showRebaseDialog" }>) => void;
    onShowReviewPrompt: (requestId: string) => void;
}): void {
    const {
        vscode,
        dispatch,
        sendReady,
        loadingMore,
        selectedHash,
        ciRepoKey,
        setViewVisible,
        onShowRebaseDialog,
        onShowReviewPrompt,
    } = params;
    const selectedHashRef = useRef<string | null>(selectedHash);
    const ciRepoKeyRef = useRef(ciRepoKey);
    // An Open Checks request received before any detail waits for the next detail, whose
    // repository decides whether it applies (as in CommitInfoApp).
    const heldChecksRef = useRef<{ repoKey: string; hash: string } | undefined>(undefined);
    const selectFirstOnNextLoadRef = useRef(false);
    useLayoutEffect(() => {
        selectedHashRef.current = selectedHash;
        ciRepoKeyRef.current = ciRepoKey;
    }, [selectedHash, ciRepoKey]);
    // Held in a ref for the same reason as `selectedHashRef`: this effect owns the single
    // `ready` post and the window subscription, so its dependency list must stay fixed. Naming
    // the callback as a dependency would re-post `ready` and re-subscribe whenever a host
    // re-created it.
    const onShowRebaseDialogRef = useRef(onShowRebaseDialog);
    const onShowReviewPromptRef = useRef(onShowReviewPrompt);
    useLayoutEffect(() => {
        onShowRebaseDialogRef.current = onShowRebaseDialog;
        onShowReviewPromptRef.current = onShowReviewPrompt;
    }, [onShowRebaseDialog, onShowReviewPrompt]);

    useEffect(() => {
        if (sendReady) {
            vscode.postMessage({ type: "ready" });
        }

        const handler = (event: MessageEvent<CommitGraphInbound>) => {
            const data = event.data;
            if (
                !data ||
                typeof data !== "object" ||
                typeof (data as { type?: unknown }).type !== "string"
            ) {
                return;
            }
            const showChecks = (hash: string): void => {
                if (hash !== selectedHashRef.current) {
                    selectedHashRef.current = hash;
                    dispatch({ type: "selectCommit", hash });
                    vscode.postMessage({ type: "selectCommit", hash });
                }
                openChecksTab();
            };
            switch (data.type) {
                case "loadCommits": {
                    loadingMore.current = false;
                    const forceFirstCommit = !data.append && selectFirstOnNextLoadRef.current;
                    const previousSelectedHash = selectedHashRef.current;
                    const firstCommitHash = data.commits[0]?.hash ?? null;
                    // Only a branch change may move the selection on its own: a refresh keeps the
                    // hash already selected, even when this page no longer lists it (#246).
                    const nextSelectedHash = forceFirstCommit
                        ? firstCommitHash
                        : (previousSelectedHash ??
                          (!data.append ? firstCommitHash : previousSelectedHash));
                    if (!data.append) {
                        selectFirstOnNextLoadRef.current = false;
                    }
                    selectedHashRef.current = nextSelectedHash;
                    dispatch({
                        type: "loadCommits",
                        commits: data.commits,
                        append: Boolean(data.append),
                        hasMore: data.hasMore,
                        selectedHash: nextSelectedHash,
                        unpushedHashes: data.unpushedHashes,
                    });
                    if (
                        !data.append &&
                        nextSelectedHash !== null &&
                        (forceFirstCommit || nextSelectedHash !== previousSelectedHash)
                    ) {
                        vscode.postMessage({
                            type: "selectCommit",
                            hash: nextSelectedHash,
                        });
                    }
                    break;
                }
                case "setBranches":
                    dispatch({
                        type: "setBranches",
                        branches: data.branches,
                        worktrees: data.worktrees,
                        folderIcon: data.folderIcon,
                        folderExpandedIcon: data.folderExpandedIcon,
                        folderIconsByName: data.folderIconsByName,
                        iconFonts: data.iconFonts,
                        commitChecksEnabled: data.commitChecksEnabled,
                        showCiColumn: data.showCiColumn,
                    });
                    break;
                case "setSelectedBranch":
                    selectFirstOnNextLoadRef.current = true;
                    dispatch({ type: "setSelectedBranch", branch: data.branch ?? null });
                    break;
                case "setFilterText":
                    dispatch({ type: "setFilterText", text: data.text });
                    break;
                case "setCommitDetail":
                    // Every commit list receives the detail another list selected; ring that row.
                    selectedHashRef.current = data.detail.hash;
                    dispatch({ type: "selectCommit", hash: data.detail.hash });
                    dispatch({
                        type: "setCommitDetail",
                        detail: data.detail,
                        folderIcon: data.folderIcon,
                        folderExpandedIcon: data.folderExpandedIcon,
                        folderIconsByName: data.folderIconsByName,
                        iconFonts: data.iconFonts,
                        ciRepoKey: data.ciRepoKey,
                    });
                    ciRepoKeyRef.current = data.ciRepoKey;
                    {
                        const held = heldChecksRef.current;
                        heldChecksRef.current = undefined;
                        if (held && held.repoKey === data.ciRepoKey) showChecks(held.hash);
                    }
                    break;
                case "clearCommitDetail":
                    // The host ended the run of the repository it left; a Checks tab that is not
                    // mounted cannot retire it, and coming back would show it again.
                    if (data.ciRepoKey !== undefined) retireCiBisect(data.ciRepoKey);
                    dispatch({ type: "clearCommitDetail", loading: data.loading ?? false });
                    break;
                case "setCommitChecks":
                    dispatch({ type: "setCommitChecks", snapshot: data.snapshot });
                    break;
                case "setViewVisibility":
                    setViewVisible(data.visible);
                    break;
                case "showRebaseDialog":
                    onShowRebaseDialogRef.current(data);
                    break;
                case "showReviewPrompt":
                    onShowReviewPromptRef.current(data.requestId);
                    break;
                case "openChecksTab":
                    if (ciRepoKeyRef.current === undefined) {
                        heldChecksRef.current = { repoKey: data.repoKey, hash: data.hash };
                        break;
                    }
                    if (data.repoKey === ciRepoKeyRef.current) showChecks(data.hash);
                    break;
                case "loadError":
                    selectFirstOnNextLoadRef.current = false;
                    dispatch({ type: "loadError", clearCommits: !loadingMore.current });
                    loadingMore.current = false;
                    console.error("[IntelliGit] Load error:", data.message);
                    break;
                case "error":
                    console.error("[IntelliGit] Extension error:", data);
                    break;
            }
        };

        window.addEventListener("message", handler);
        return () => window.removeEventListener("message", handler);
        // Keep the original root effect subscription lifetime; dispatch and loadingMore are stable.
        // react-doctor-disable-next-line react-doctor/exhaustive-deps
    }, [sendReady, vscode]); // eslint-disable-line react-hooks/exhaustive-deps
}
