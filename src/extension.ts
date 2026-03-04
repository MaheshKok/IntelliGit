// Extension entry point. Registers coordinated IntelliGit webviews:
// commit graph (with integrated branch column/details) and commit panel.
// The extension host is the sole data coordinator -- views never talk directly.

import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { GitExecutor } from "./git/executor";
import { GitOps, UpstreamPushDeclinedError } from "./git/operations";
import { CommitGraphViewProvider } from "./views/CommitGraphViewProvider";
import { CommitInfoViewProvider } from "./views/CommitInfoViewProvider";
import { CommitPanelViewProvider } from "./views/CommitPanelViewProvider";
import { MergeConflictSessionPanel } from "./views/MergeConflictSessionPanel";
import { MergeConflictsTreeProvider } from "./views/MergeConflictsTreeProvider";
import type { Branch } from "./types";
import type { CommitAction } from "./webviews/react/commitGraphTypes";
import { getErrorMessage, isBranchNotFullyMergedError } from "./utils/errors";
import { deleteFileWithFallback } from "./utils/fileOps";
import { EMPTY_TREE_HASH } from "./utils/constants";
import {
    containsConflictMarkers,
    detectInstalledJetBrainsMergeToolCandidates,
    detectInstalledJetBrainsMergeToolPath,
    launchJetBrainsMergeTool,
    resolveJetBrainsMergeBinaryPath,
} from "./utils/jetbrainsMergeTool";
import { runWithNotificationProgress } from "./utils/notifications";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) return;

    const repoRoot = workspaceFolder.uri.fsPath;
    const executor = new GitExecutor(repoRoot);
    const gitOps = new GitOps(executor);

    try {
        const isRepo = await gitOps.isRepository();
        if (!isRepo) return;
    } catch {
        return;
    }

    // Cached branch list for webview context menu lookups
    let currentBranches: Branch[] = [];
    let commitDetailRequestSeq = 0;

    // --- Providers ---

    const commitGraph = new CommitGraphViewProvider(context.extensionUri, gitOps);
    const commitInfo = new CommitInfoViewProvider(context.extensionUri);
    const commitPanel = new CommitPanelViewProvider(context.extensionUri, gitOps);
    const mergeConflicts = new MergeConflictsTreeProvider(gitOps, workspaceFolder.uri);

    // --- Register views ---

    const emptyTreeProvider: vscode.TreeDataProvider<never> = {
        getTreeItem: () => {
            throw new Error("unreachable");
        },
        getChildren: () => [],
    };
    const badgeView = vscode.window.createTreeView("intelligit.fileCountBadge", {
        treeDataProvider: emptyTreeProvider,
    });
    const mergeConflictsView = vscode.window.createTreeView("intelligit.mergeConflicts", {
        treeDataProvider: mergeConflicts,
    });

    const updateBadge = (count: number) => {
        badgeView.badge =
            count > 0
                ? { tooltip: `${count} changed file${count !== 1 ? "s" : ""}`, value: count }
                : undefined;
    };
    const updateConflictCount = (count: number) => {
        mergeConflictsView.description = count > 0 ? `${count}` : "";
        vscode.commands.executeCommand("setContext", "intelligit.hasMergeConflicts", count > 0);
    };
    const refreshMergeConflicts = async () => {
        updateConflictCount(await mergeConflicts.refresh());
    };
    const refreshConflictUi = async () => {
        await commitPanel.refresh();
        await refreshMergeConflicts();
    };

    const getIntelliGitConfig = (): vscode.WorkspaceConfiguration | null => {
        const getConfiguration = vscode.workspace.getConfiguration;
        if (typeof getConfiguration !== "function") return null;
        return getConfiguration.call(vscode.workspace, "intelligit");
    };

    const getJetBrainsMergeToolPath = (): string => {
        return getIntelliGitConfig()?.get<string>("jetbrainsMergeTool.path", "").trim() ?? "";
    };

    const getDefaultJetBrainsMergeToolPath = (): string => {
        switch (process.platform) {
            case "darwin":
                return "/Applications/PyCharm.app";
            case "win32":
                return "C:\\Program Files\\JetBrains\\PyCharm\\bin\\pycharm64.exe";
            default:
                return "pycharm";
        }
    };

    const saveJetBrainsMergeToolPath = async (rawPath: string): Promise<string | null> => {
        const trimmed = rawPath.trim();
        if (!trimmed) return null;

        if (path.isAbsolute(trimmed) && !fs.existsSync(trimmed)) {
            vscode.window.showErrorMessage(`JetBrains path not found: ${trimmed}`);
            return null;
        }

        let resolvedBinaryPath: string;
        try {
            resolvedBinaryPath = await resolveJetBrainsMergeBinaryPath(trimmed);
        } catch (err) {
            const msg = getErrorMessage(err);
            vscode.window.showErrorMessage(`Invalid JetBrains merge tool path: ${msg}`);
            return null;
        }

        const config = getIntelliGitConfig();
        if (config && typeof config.update === "function") {
            await config.update(
                "jetbrainsMergeTool.path",
                trimmed,
                vscode.ConfigurationTarget.Global,
            );
        }

        const resolutionText =
            resolvedBinaryPath === trimmed
                ? `Executable: ${resolvedBinaryPath}`
                : `Resolved executable: ${resolvedBinaryPath}`;
        vscode.window.showInformationMessage(`Saved JetBrains merge tool path. ${resolutionText}`);
        return trimmed;
    };

    const promptForJetBrainsMergeToolPath = async (): Promise<string | null> => {
        const existing = getJetBrainsMergeToolPath();
        const detected = existing ? null : await detectInstalledJetBrainsMergeToolPath();
        const suggested = existing || detected || getDefaultJetBrainsMergeToolPath();
        const input = await vscode.window.showInputBox({
            title: "JetBrains Merge Tool Path",
            prompt: "Enter a JetBrains IDE binary path/command (pycharm, idea, webstorm) or a macOS .app bundle path.",
            placeHolder: suggested,
            value: suggested,
            ignoreFocusOut: true,
        });
        if (!input) return null;

        return saveJetBrainsMergeToolPath(input);
    };

    const detectAndPickJetBrainsMergeToolPath = async (): Promise<string | null> => {
        const candidates = await detectInstalledJetBrainsMergeToolCandidates();
        if (candidates.length === 0) {
            vscode.window.showWarningMessage(
                "No JetBrains IDE installations were auto-detected. Enter the path manually instead.",
            );
            return promptForJetBrainsMergeToolPath();
        }

        const quickPickItems = await Promise.all(
            candidates.slice(0, 50).map(async (candidatePath) => {
                let detail: string | undefined;
                try {
                    const resolved = await resolveJetBrainsMergeBinaryPath(candidatePath);
                    detail = resolved === candidatePath ? undefined : `Resolved: ${resolved}`;
                } catch {
                    detail = undefined;
                }
                return {
                    label: path.basename(candidatePath),
                    description: candidatePath,
                    detail,
                    candidatePath,
                };
            }),
        );

        quickPickItems.push({
            label: "$(edit) Enter path manually",
            description: "Open the path prompt",
            detail: undefined,
            candidatePath: "__manual__",
        });

        const picked = await vscode.window.showQuickPick(quickPickItems, {
            title: "Detect JetBrains Merge Tool",
            placeHolder: "Select a detected JetBrains IDE to use as the merge tool",
            ignoreFocusOut: true,
            matchOnDescription: true,
            matchOnDetail: true,
        });
        if (!picked) return null;
        if (picked.candidatePath === "__manual__") {
            return promptForJetBrainsMergeToolPath();
        }
        return saveJetBrainsMergeToolPath(picked.candidatePath);
    };

    const openBuiltInMergeEditorForFile = async (filePath: string): Promise<void> => {
        const fileUri = vscode.Uri.file(path.join(repoRoot, filePath));
        try {
            await vscode.commands.executeCommand("git.openMergeEditor", fileUri);
        } catch (error) {
            const message = getErrorMessage(error);
            vscode.window.showWarningMessage(
                `VS Code merge editor command failed (${message}). Opening the file instead.`,
            );
            await vscode.commands.executeCommand("vscode.open", fileUri);
        }
    };

    const sleep = (ms: number): Promise<void> =>
        new Promise((resolve) => {
            setTimeout(resolve, ms);
        });

    const readMergedFileWithRetry = async (
        outputFileFsPath: string,
        beforeMergeText: string | null,
    ): Promise<string> => {
        let lastReadError: unknown;
        const delaysMs = [0, 80, 160, 320, 500];

        for (let attempt = 0; attempt < delaysMs.length; attempt++) {
            if (delaysMs[attempt] > 0) {
                await sleep(delaysMs[attempt]);
            }

            try {
                const text = await fs.promises.readFile(outputFileFsPath, "utf8");
                const unchanged = beforeMergeText !== null && text === beforeMergeText;
                const hasConflictBlock = containsConflictMarkers(text);
                if ((unchanged || hasConflictBlock) && attempt < delaysMs.length - 1) {
                    continue;
                }
                return text;
            } catch (readErr) {
                lastReadError = readErr;
                if (attempt === delaysMs.length - 1) throw readErr;
            }
        }

        throw lastReadError instanceof Error
            ? lastReadError
            : new Error("Failed to read merged file after external merge tool closed.");
    };

    const openJetBrainsMergeToolForFile = async (filePath: string): Promise<boolean> => {
        let jetBrainsPath = getJetBrainsMergeToolPath();
        if (!jetBrainsPath) {
            const action = await vscode.window.showInformationMessage(
                "JetBrains merge tool path is not configured.",
                "Configure",
                "Open VS Code Merge Editor",
            );
            if (action === "Open VS Code Merge Editor") {
                await openBuiltInMergeEditorForFile(filePath);
                return true;
            }
            if (action !== "Configure") return false;
            const configured = await promptForJetBrainsMergeToolPath();
            if (!configured) return false;
            jetBrainsPath = configured;
        }

        try {
            const versions = await gitOps.getConflictFileVersions(filePath);
            const outputFileFsPath = path.join(repoRoot, filePath);
            const beforeMergeText = await fs.promises
                .readFile(outputFileFsPath, "utf8")
                .catch(() => null);

            await runWithNotificationProgress(
                `Opening JetBrains merge tool for ${filePath}...`,
                async () => {
                    await launchJetBrainsMergeTool({
                        binaryPath: jetBrainsPath,
                        repoRootFsPath: repoRoot,
                        relativeFilePath: filePath,
                        outputFileFsPath,
                        baseContent: versions.base,
                        oursContent: versions.ours,
                        theirsContent: versions.theirs,
                    });
                },
            );

            try {
                const mergedText = await readMergedFileWithRetry(outputFileFsPath, beforeMergeText);
                if (!containsConflictMarkers(mergedText)) {
                    await gitOps.stageFile(filePath);
                    vscode.window.showInformationMessage(`Merged and staged: ${filePath}`);
                } else {
                    vscode.window.showInformationMessage(
                        `Merge tool closed, but conflict markers remain in ${filePath}`,
                    );
                }
            } catch (readErr) {
                const msg = getErrorMessage(readErr);
                vscode.window.showWarningMessage(
                    `Could not inspect merged file '${filePath}' after JetBrains merge: ${msg}`,
                );
            }

            await refreshConflictUi();
            return true;
        } catch (error) {
            const message = getErrorMessage(error);
            vscode.window.showErrorMessage(`JetBrains merge tool failed: ${message}`);
            return false;
        }
    };

    const openMergeConflictForFile = async (filePath: string): Promise<void> => {
        const preferExternal =
            getIntelliGitConfig()?.get<boolean>("jetbrainsMergeTool.preferExternal", true) ?? true;

        if (preferExternal && getJetBrainsMergeToolPath()) {
            const opened = await openJetBrainsMergeToolForFile(filePath);
            if (opened) return;
        }
        await openBuiltInMergeEditorForFile(filePath);
    };

    const openConflictSession = async (labels?: {
        sourceBranch?: string;
        targetBranch?: string;
    }): Promise<void> => {
        await MergeConflictSessionPanel.open(context.extensionUri, gitOps, labels ?? {}, {
            onOpenMergeConflict: async (filePath) => {
                await openMergeConflictForFile(filePath);
            },
            onConflictStateChanged: async () => {
                await refreshConflictUi();
            },
        });
    };

    const normalizeGitPath = (fsPathValue: string): string => fsPathValue.split(path.sep).join("/");

    const getRepoRelativeFilePathFromUri = (uri: vscode.Uri): string | null => {
        if (uri.scheme !== "file") return null;
        const relative = path.relative(repoRoot, uri.fsPath);
        if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
        return normalizeGitPath(relative);
    };

    const getEditorContextFileUri = (ctx?: unknown): vscode.Uri | null => {
        if (ctx instanceof vscode.Uri) return ctx;
        const activeUri = vscode.window.activeTextEditor?.document.uri;
        return activeUri?.scheme === "file" ? activeUri : null;
    };

    type CommitInfoFileContext = {
        filePath: string;
        commitHash: string;
        commitShortHash?: string;
    };

    const getCommitInfoFileContext = (value: unknown): CommitInfoFileContext | null => {
        if (!value || typeof value !== "object") return null;
        const maybe = value as {
            filePath?: unknown;
            commitHash?: unknown;
            commitShortHash?: unknown;
        };
        if (typeof maybe.filePath !== "string" || typeof maybe.commitHash !== "string") return null;
        const filePath = maybe.filePath.trim();
        const commitHash = maybe.commitHash.trim();
        const commitShortHash =
            typeof maybe.commitShortHash === "string" ? maybe.commitShortHash.trim() : undefined;
        if (!filePath || !commitHash) return null;
        return { filePath, commitHash, commitShortHash };
    };

    const closeTemporaryDiffSourceTab = async (uri: vscode.Uri): Promise<void> => {
        const matchingTab = vscode.window.tabGroups.all
            .flatMap((group) => group.tabs)
            .find((tab) => {
                const input = tab.input;
                return (
                    input instanceof vscode.TabInputText && input.uri.toString() === uri.toString()
                );
            });
        if (!matchingTab) return;
        try {
            await vscode.window.tabGroups.close(matchingTab, true);
        } catch {
            // Best-effort cleanup only; diff view is already open.
        }
    };

    const openDiffAgainstGitRef = async (
        fileUri: vscode.Uri,
        repoRelativeFilePath: string,
        ref: string,
        sourceLabel: "revision" | "branch",
    ): Promise<void> => {
        const trimmedRef = ref.trim();
        if (!trimmedRef) return;

        const currentDoc = await vscode.workspace.openTextDocument(fileUri);
        const refContent = await gitOps.getFileContentAtRef(repoRelativeFilePath, trimmedRef);
        const leftDoc = await vscode.workspace.openTextDocument({
            content: refContent,
            language: currentDoc.languageId,
        });
        const title = `${repoRelativeFilePath} (${sourceLabel}: ${trimmedRef}) <-> Working Tree`;
        await vscode.commands.executeCommand("vscode.diff", leftDoc.uri, fileUri, title);
        await closeTemporaryDiffSourceTab(leftDoc.uri);
    };

    const compareEditorFileWithBranch = async (ctx?: unknown): Promise<void> => {
        const fileUri = getEditorContextFileUri(ctx);
        if (!fileUri) {
            vscode.window.showErrorMessage(
                "Compare with Branch is only available for local files.",
            );
            return;
        }

        const repoRelativeFilePath = getRepoRelativeFilePathFromUri(fileUri);
        if (!repoRelativeFilePath) {
            vscode.window.showErrorMessage(
                "Selected file is outside the current IntelliGit repository workspace.",
            );
            return;
        }

        try {
            const branches = await gitOps.getBranches();
            const picks = branches
                .slice()
                .sort((a, b) => {
                    if (a.isRemote !== b.isRemote) return a.isRemote ? 1 : -1;
                    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
                    return a.name.localeCompare(b.name);
                })
                .map((branch) => ({
                    label: branch.isCurrent ? `${branch.name} (current)` : branch.name,
                    description: branch.isRemote ? "remote branch" : "local branch",
                    detail: branch.hash,
                    refName: branch.name,
                }));

            const picked = await vscode.window.showQuickPick(picks, {
                title: "Compare with Branch",
                placeHolder: `Select a branch for ${repoRelativeFilePath}`,
                ignoreFocusOut: true,
                matchOnDescription: true,
                matchOnDetail: true,
            });
            if (!picked) return;

            await openDiffAgainstGitRef(fileUri, repoRelativeFilePath, picked.refName, "branch");
        } catch (error) {
            const message = getErrorMessage(error);
            vscode.window.showErrorMessage(`Compare with branch failed: ${message}`);
        }
    };

    const compareEditorFileWithRevision = async (ctx?: unknown): Promise<void> => {
        const fileUri = getEditorContextFileUri(ctx);
        if (!fileUri) {
            vscode.window.showErrorMessage(
                "Compare with Revision is only available for local files.",
            );
            return;
        }

        const repoRelativeFilePath = getRepoRelativeFilePathFromUri(fileUri);
        if (!repoRelativeFilePath) {
            vscode.window.showErrorMessage(
                "Selected file is outside the current IntelliGit repository workspace.",
            );
            return;
        }

        try {
            const historyEntries = await gitOps.getFileHistoryEntries(repoRelativeFilePath, 20);
            const historyPicks = historyEntries.map((entry) => ({
                label: `${entry.shortHash}  ${entry.subject || "(no subject)"}`,
                description: entry.author,
                detail: entry.date,
                refName: entry.hash,
            }));
            const manualSentinel = "__manual__";
            const picks = [
                ...historyPicks,
                {
                    label: "$(edit) Enter revision manually",
                    description: "Commit hash, tag, or ref name",
                    detail: undefined,
                    refName: manualSentinel,
                },
            ];

            const picked = await vscode.window.showQuickPick(picks, {
                title: "Compare with Revision",
                placeHolder:
                    historyPicks.length > 0
                        ? `Select a recent revision for ${repoRelativeFilePath}`
                        : `No recent file history found. Enter a revision for ${repoRelativeFilePath}`,
                ignoreFocusOut: true,
                matchOnDescription: true,
                matchOnDetail: true,
            });
            if (!picked) return;

            let refName = picked.refName;
            if (refName === manualSentinel) {
                const input = await vscode.window.showInputBox({
                    title: "Compare with Revision",
                    prompt: `Enter a commit hash, tag, or ref for ${repoRelativeFilePath}`,
                    placeHolder: "HEAD~1",
                    ignoreFocusOut: true,
                });
                if (!input?.trim()) return;
                refName = input.trim();
            }

            await openDiffAgainstGitRef(fileUri, repoRelativeFilePath, refName, "revision");
        } catch (error) {
            const message = getErrorMessage(error);
            vscode.window.showErrorMessage(`Compare with revision failed: ${message}`);
        }
    };

    context.subscriptions.push(
        badgeView,
        mergeConflictsView,
        commitPanel.onDidChangeFileCount(updateBadge),
        vscode.window.registerWebviewViewProvider(CommitGraphViewProvider.viewType, commitGraph),
        vscode.window.registerWebviewViewProvider(CommitInfoViewProvider.viewType, commitInfo),
        vscode.window.registerWebviewViewProvider(CommitPanelViewProvider.viewType, commitPanel),
    );

    // --- Wire data flow ---

    context.subscriptions.push(
        commitGraph.onCommitSelected(async (hash) => {
            const requestId = ++commitDetailRequestSeq;
            try {
                const detail = await gitOps.getCommitDetail(hash);
                if (requestId !== commitDetailRequestSeq) return;
                (
                    commitGraph as {
                        setCommitDetail?: (commitDetail: import("./types").CommitDetail) => void;
                    }
                ).setCommitDetail?.(detail);
                commitInfo.setCommitDetail(detail);
            } catch (err) {
                const msg = getErrorMessage(err);
                vscode.window.showErrorMessage(`Failed to load commit: ${msg}`);
            }
        }),
    );

    context.subscriptions.push(
        commitGraph.onBranchFilterChanged(() => {
            (commitGraph as { clearCommitDetail?: () => void }).clearCommitDetail?.();
            commitInfo.clear();
        }),
    );

    // Forward branch actions from webview context menu to VS Code commands
    context.subscriptions.push(
        commitGraph.onBranchAction(({ action, branchName }) => {
            const branch = currentBranches.find((b) => b.name === branchName);
            if (!branch) return;
            const item: { branch: Branch } = { branch };
            vscode.commands.executeCommand(`intelligit.${action}`, item);
        }),
    );

    context.subscriptions.push(
        commitGraph.onCommitAction(async ({ action, hash }) => {
            try {
                await handleCommitContextAction({ action, hash });
            } catch (error) {
                const message = getErrorMessage(error);
                console.error(`Commit action '${action}' failed:`, error);
                vscode.window.showErrorMessage(`Commit action failed: ${message}`);
            }
        }),
    );

    context.subscriptions.push(
        commitGraph.onOpenCommitFileDiff(async ({ commitHash, filePath }) => {
            try {
                await openCommitFileDiff(commitHash, filePath);
            } catch (error) {
                const message = getErrorMessage(error);
                vscode.window.showErrorMessage(`Failed to open commit diff: ${message}`);
            }
        }),
        commitInfo.onOpenCommitFileDiff(async ({ commitHash, filePath }) => {
            try {
                await openCommitFileDiff(commitHash, filePath);
            } catch (error) {
                const message = getErrorMessage(error);
                vscode.window.showErrorMessage(`Failed to open commit diff: ${message}`);
            }
        }),
    );

    // --- Helper ---

    const clearSelection = () => {
        (commitGraph as { clearCommitDetail?: () => void }).clearCommitDetail?.();
        commitInfo.clear();
    };

    const getCheckedOutBranchName = async (): Promise<string | null> => {
        try {
            const head = (await executor.run(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
            if (head && head !== "HEAD") return head;
        } catch {
            // Fall back to cached branch metadata.
        }
        return getCurrentBranchName() ?? null;
    };

    const getLocalBranchMergeStatusForDelete = async (
        branchName: string,
        currentBranchName: string | null,
    ): Promise<{ merged: boolean; target: string }> => {
        const target = currentBranchName?.trim() || "HEAD";
        try {
            await executor.run(["merge-base", "--is-ancestor", branchName, target]);
            return { merged: true, target };
        } catch {
            return { merged: false, target };
        }
    };

    const getCurrentBranchName = () => currentBranches.find((b) => b.isCurrent)?.name;

    const getLocalNameFromRemote = (remoteBranchName: string) =>
        remoteBranchName.split("/").slice(1).join("/");

    const checkoutBranch = async (branch: Branch): Promise<string> => {
        if (!branch.isRemote) {
            await executor.run(["checkout", branch.name]);
            return branch.name;
        }

        const localName = getLocalNameFromRemote(branch.name);
        const existingLocal = currentBranches.find((b) => !b.isRemote && b.name === localName);
        if (existingLocal) {
            await executor.run(["checkout", existingLocal.name]);
            return existingLocal.name;
        }

        await executor.run(["checkout", "--track", branch.name]);
        return localName;
    };

    const resolveRemoteName = async (branch: Branch): Promise<string | null> => {
        if (branch.remote) return branch.remote;
        try {
            const raw = await executor.run(["remote"]);
            const remotes = raw
                .split("\n")
                .map((r) => r.trim())
                .filter(Boolean);
            return remotes[0] ?? null;
        } catch {
            return null;
        }
    };

    const resolveTrackedRemoteBranch = (
        branch: Branch,
    ): { remote: string; remoteBranch: string } | null => {
        if (branch.upstream && branch.upstream.includes("/")) {
            const [remote, ...rest] = branch.upstream.split("/");
            const remoteBranch = rest.join("/");
            if (remote && remoteBranch) {
                return { remote, remoteBranch };
            }
        }

        if (branch.remote) {
            const expected = `${branch.remote}/${branch.name}`;
            if (currentBranches.some((b) => b.isRemote && b.name === expected)) {
                return { remote: branch.remote, remoteBranch: branch.name };
            }
        }

        // Fallback: match remote branches whose name ends with the local branch name.
        // Only used when there is exactly one match to avoid ambiguity (e.g. both
        // "origin/feat" and "upstream/feat" would produce two matches and be skipped).
        const suffixMatches = currentBranches.filter(
            (b) => b.isRemote && b.name.endsWith(`/${branch.name}`),
        );
        if (suffixMatches.length === 1) {
            const [remote, ...rest] = suffixMatches[0].name.split("/");
            const remoteBranch = rest.join("/");
            if (remote && remoteBranch) {
                return { remote, remoteBranch };
            }
        }

        return null;
    };

    const resolveRemoteDeleteTarget = (
        branch: Branch,
    ): { remote: string; remoteBranch: string } | null => {
        if (!branch.isRemote) return null;
        const parts = branch.name.split("/");
        if (parts.length < 2) return null;

        const remote = branch.remote ?? parts[0];
        const remoteBranch = parts.slice(1).join("/");
        if (!remote || !remoteBranch) return null;

        return { remote, remoteBranch };
    };

    const showDeletedBranchActions = async (branch: Branch): Promise<void> => {
        const restoreLabel = "Restore";
        const deleteTrackedLabel = "Delete Tracked Branch";
        const tracked = resolveTrackedRemoteBranch(branch);
        const buttons = tracked ? [restoreLabel, deleteTrackedLabel] : [restoreLabel];
        const action = await vscode.window.showInformationMessage(
            `Deleted: ${branch.name}`,
            ...buttons,
        );

        if (action === restoreLabel) {
            if (!isValidGitHash(branch.hash)) {
                vscode.window.showErrorMessage(
                    `Cannot restore '${branch.name}': missing or invalid commit hash.`,
                );
                return;
            }
            try {
                await executor.run(["branch", branch.name, branch.hash]);
                vscode.window.showInformationMessage(`Restored ${branch.name}`);
                await vscode.commands.executeCommand("intelligit.refresh");
            } catch (error) {
                const msg = getErrorMessage(error);
                vscode.window.showErrorMessage(`Restore failed: ${msg}`);
            }
            return;
        }

        if (action === deleteTrackedLabel && tracked) {
            const confirm = await vscode.window.showWarningMessage(
                `Delete tracked branch '${tracked.remote}/${tracked.remoteBranch}'?`,
                { modal: true },
                deleteTrackedLabel,
            );
            if (confirm !== deleteTrackedLabel) return;

            try {
                await runWithNotificationProgress(
                    `Deleting tracked branch ${tracked.remote}/${tracked.remoteBranch}...`,
                    async () => {
                        await executor.run([
                            "push",
                            tracked.remote,
                            "--delete",
                            tracked.remoteBranch,
                        ]);
                    },
                );
                vscode.window.showInformationMessage(
                    `Deleted tracked branch ${tracked.remote}/${tracked.remoteBranch}`,
                );
                await vscode.commands.executeCommand("intelligit.refresh");
            } catch (error) {
                const msg = getErrorMessage(error);
                vscode.window.showErrorMessage(`Delete tracked branch failed: ${msg}`);
            }
        }
    };

    const isHashMatch = (a: string, b: string): boolean => a.startsWith(b) || b.startsWith(a);
    const isValidGitHash = (value: string): boolean => /^[0-9a-fA-F]{7,40}$/.test(value);
    const isValidBranchName = (value: string): boolean =>
        value.length > 0 && !value.startsWith("-") && /^[A-Za-z0-9._/-]+$/.test(value);
    const assertNever = (value: never): never => {
        throw new Error(`Unhandled commit action: ${String(value)}`);
    };

    const isCommitUnpushed = async (hash: string): Promise<boolean> => {
        const unpushed = await gitOps.getUnpushedCommitHashes();
        return unpushed.some((h) => isHashMatch(h, hash));
    };

    const getCommitParentHashes = async (hash: string): Promise<string[]> => {
        const raw = (await executor.run(["rev-list", "--parents", "-n", "1", hash])).trim();
        const parts = raw.split(/\s+/).filter(Boolean);
        return parts.slice(1);
    };

    const isMergeCommitHash = async (hash: string): Promise<boolean> =>
        (await getCommitParentHashes(hash)).length > 1;

    type MainlineParentPickResult =
        | { kind: "notMerge" }
        | { kind: "cancelled" }
        | { kind: "selected"; parentNumber: number };

    const pickMainlineParent = async (
        hash: string,
        actionLabel: string,
        knownParents?: string[],
    ): Promise<MainlineParentPickResult> => {
        const parents = knownParents ?? (await getCommitParentHashes(hash));
        if (parents.length <= 1) return { kind: "notMerge" };

        const pick = await vscode.window.showQuickPick(
            parents.map((parent, idx) => ({
                label: `Parent ${idx + 1} (${parent.slice(0, 8)})`,
                detail:
                    idx === 0
                        ? "Usually the target branch side of the merge."
                        : "Alternate merge parent.",
                parentNumber: idx + 1,
            })),
            {
                title: `${actionLabel}: select mainline parent`,
                placeHolder: "Pick the parent number to use with -m",
            },
        );

        if (!pick) return { kind: "cancelled" };
        return { kind: "selected", parentNumber: pick.parentNumber };
    };

    const getUndoCommitCount = async (hash: string): Promise<number> => {
        const raw = (await executor.run(["rev-list", "--count", `${hash}^..HEAD`])).trim();
        const parsed = Number(raw);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
    };

    const refreshAll = async (): Promise<void> => {
        await vscode.commands.executeCommand("intelligit.refresh");
    };

    const buildCommitFilePatch = async (
        commitHash: string,
        filePath: string,
        actionLabel: string,
    ): Promise<string | null> => {
        const parents = await getCommitParentHashes(commitHash);

        let baseRef: string;
        if (parents.length > 1) {
            const result = await pickMainlineParent(commitHash, actionLabel, parents);
            if (result.kind === "cancelled") return null;
            if (result.kind === "notMerge") return null;
            baseRef = `${commitHash}^${result.parentNumber}`;
        } else {
            baseRef = parents.length === 0 ? EMPTY_TREE_HASH : parents[0];
        }

        return executor.run([
            "diff",
            "--binary",
            "--full-index",
            "--no-color",
            baseRef,
            commitHash,
            "--",
            filePath,
        ]);
    };

    const openCommitFileDiff = async (commitHash: string, filePath: string): Promise<void> => {
        const parents = await getCommitParentHashes(commitHash);

        let parentRef: string;
        let parentDisplayHash: string;
        if (parents.length > 1) {
            const result = await pickMainlineParent(commitHash, "Open Commit File Diff", parents);
            if (result.kind === "cancelled") return;
            if (result.kind === "notMerge") return;
            parentRef = `${commitHash}^${result.parentNumber}`;
            parentDisplayHash = parents[result.parentNumber - 1] ?? parentRef;
        } else {
            parentRef = parents.length === 0 ? EMPTY_TREE_HASH : parents[0];
            parentDisplayHash = parentRef;
        }

        let leftContent: string;
        try {
            leftContent = await gitOps.getFileContentAtRef(filePath, parentRef);
        } catch {
            leftContent = "";
        }

        let rightContent: string;
        try {
            rightContent = await gitOps.getFileContentAtRef(filePath, commitHash);
        } catch {
            rightContent = "";
        }

        // Detect language from the working tree file if it exists on disk.
        let language: string | undefined;
        const diskPath = path.join(repoRoot, filePath);
        try {
            const diskDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(diskPath));
            language = diskDoc.languageId;
        } catch {
            // File may not exist on disk (deleted or only in history).
        }

        const leftDoc = await vscode.workspace.openTextDocument({ content: leftContent, language });
        const rightDoc = await vscode.workspace.openTextDocument({
            content: rightContent,
            language,
        });
        const shortParent = parentDisplayHash.slice(0, 8);
        const shortCommit = commitHash.slice(0, 8);
        const title = `${filePath} (${shortParent} ↔ ${shortCommit})`;
        await vscode.commands.executeCommand("vscode.diff", leftDoc.uri, rightDoc.uri, title);
        await closeTemporaryDiffSourceTab(leftDoc.uri);
    };

    const applyPatchTextToRepo = async (patchText: string, reverse: boolean): Promise<void> => {
        const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "intelligit-filepatch-"));
        const patchFilePath = path.join(tempDir, "selected-change.patch");
        try {
            await fs.promises.writeFile(patchFilePath, patchText, "utf8");
            const args = [
                "apply",
                "--index",
                "--3way",
                "--whitespace=nowarn",
                ...(reverse ? ["-R"] : []),
                patchFilePath,
            ];
            await executor.run(args);
        } finally {
            await fs.promises.rm(tempDir, { recursive: true, force: true }).catch((err) => {
                console.warn(`[intelligit] Failed to clean up temp patch dir ${tempDir}:`, err);
            });
        }
    };

    const compareCommitInfoFileWithLocal = async (ctx: unknown): Promise<void> => {
        const fileCtx = getCommitInfoFileContext(ctx);
        if (!fileCtx) return;
        try {
            const fileUri = vscode.Uri.file(path.join(repoRoot, fileCtx.filePath));
            await openDiffAgainstGitRef(fileUri, fileCtx.filePath, fileCtx.commitHash, "revision");
        } catch (error) {
            const message = getErrorMessage(error);
            vscode.window.showErrorMessage(`Compare with local failed: ${message}`);
        }
    };

    const commitFileChangeModeLabels = {
        "cherry-pick": {
            actionTitle: "Cherry-pick Selected Change",
            confirmLabel: "Apply Change",
            confirmPrompt: (short: string, filePath: string) =>
                `Apply the change from ${short} for ${filePath} to your working tree and stage it?`,
            progressVerb: "Applying",
            successVerb: "Applied",
            errorLabel: "Cherry-pick selected change",
        },
        revert: {
            actionTitle: "Revert Selected Change",
            confirmLabel: "Revert Change",
            confirmPrompt: (short: string, filePath: string) =>
                `Apply the inverse of the change from ${short} for ${filePath} to your working tree and stage it?`,
            progressVerb: "Reverting",
            successVerb: "Reverted",
            errorLabel: "Revert selected change",
        },
    } as const;

    const applySelectedCommitFileChange = async (
        ctx: unknown,
        mode: "cherry-pick" | "revert",
    ): Promise<void> => {
        const fileCtx = getCommitInfoFileContext(ctx);
        if (!fileCtx) return;

        const short = fileCtx.commitShortHash || fileCtx.commitHash.slice(0, 8);
        const labels = commitFileChangeModeLabels[mode];

        const confirmed = await vscode.window.showWarningMessage(
            labels.confirmPrompt(short, fileCtx.filePath),
            { modal: true },
            labels.confirmLabel,
        );
        if (confirmed !== labels.confirmLabel) return;

        try {
            const patchText = await buildCommitFilePatch(
                fileCtx.commitHash,
                fileCtx.filePath,
                labels.actionTitle,
            );
            if (patchText === null) return; // merge parent selection cancelled
            if (!patchText.trim()) {
                vscode.window.showInformationMessage(
                    `No file-level patch found for ${fileCtx.filePath} in ${short}.`,
                );
                return;
            }

            await runWithNotificationProgress(
                `${labels.progressVerb} selected change for ${fileCtx.filePath}...`,
                async () => {
                    await applyPatchTextToRepo(patchText, mode === "revert");
                },
            );

            vscode.window.showInformationMessage(
                `${labels.successVerb} selected change from ${short} for ${fileCtx.filePath}.`,
            );
        } catch (error) {
            const message = getErrorMessage(error);
            vscode.window.showErrorMessage(`${labels.errorLabel} failed: ${message}`);
        } finally {
            await refreshConflictUi().catch(() => {});
        }
    };

    const handleCommitContextAction = async (params: {
        action: CommitAction;
        hash: string;
    }): Promise<void> => {
        const { action, hash } = params;
        const validatedHash = hash.trim();
        if (!isValidGitHash(validatedHash)) {
            console.error("Blocked commit action due to invalid hash:", { action, hash });
            vscode.window.showErrorMessage("Invalid commit hash received for commit action.");
            return;
        }
        const short = validatedHash.slice(0, 8);

        switch (action) {
            case "copyRevision": {
                await vscode.env.clipboard.writeText(validatedHash);
                vscode.window.showInformationMessage(`Copied revision ${short}.`);
                return;
            }
            case "createPatch": {
                const defaultUri = vscode.Uri.file(path.join(repoRoot, `${short}.patch`));
                const targetUri = await vscode.window.showSaveDialog({
                    defaultUri,
                    filters: { Patch: ["patch", "diff"] },
                });
                if (!targetUri) return;
                const patchText = await executor.run([
                    "format-patch",
                    "-1",
                    "--stdout",
                    validatedHash,
                ]);
                await vscode.workspace.fs.writeFile(targetUri, Buffer.from(patchText, "utf8"));
                vscode.window.showInformationMessage(
                    `Patch created: ${path.basename(targetUri.fsPath)}`,
                );
                return;
            }
            case "cherryPick": {
                const confirm = await vscode.window.showWarningMessage(
                    `Cherry-pick commit ${short}?`,
                    { modal: true },
                    "Cherry-pick",
                );
                if (confirm !== "Cherry-pick") return;

                const mainlineParent = await pickMainlineParent(validatedHash, "Cherry-pick");
                if (mainlineParent.kind === "cancelled") return;
                const args =
                    mainlineParent.kind === "notMerge"
                        ? ["cherry-pick", validatedHash]
                        : ["cherry-pick", "-m", String(mainlineParent.parentNumber), validatedHash];
                await executor.run(args);
                vscode.window.showInformationMessage(`Cherry-picked ${short}.`);
                await refreshAll();
                return;
            }
            case "checkoutRevision": {
                const confirm = await vscode.window.showWarningMessage(
                    `Checkout commit ${short}? This creates a detached HEAD state.`,
                    { modal: true },
                    "Checkout",
                );
                if (confirm !== "Checkout") return;
                await executor.run(["checkout", validatedHash]);
                vscode.window.showInformationMessage(`Checked out revision ${short}.`);
                await refreshAll();
                return;
            }
            case "resetCurrentToHere": {
                const confirm = await vscode.window.showWarningMessage(
                    `Hard reset current branch to ${short}? This will reset the index and working tree and permanently discard any uncommitted changes.`,
                    { modal: true },
                    "Reset",
                );
                if (confirm !== "Reset") return;
                await executor.run(["reset", "--hard", validatedHash]);
                vscode.window.showInformationMessage(`Reset current branch to ${short}.`);
                await refreshAll();
                return;
            }
            case "revertCommit": {
                const confirm = await vscode.window.showWarningMessage(
                    `Revert commit ${short}?`,
                    { modal: true },
                    "Revert",
                );
                if (confirm !== "Revert") return;
                const mainlineParent = await pickMainlineParent(validatedHash, "Revert");
                if (mainlineParent.kind === "cancelled") return;
                const args =
                    mainlineParent.kind === "notMerge"
                        ? ["revert", "--no-edit", validatedHash]
                        : [
                              "revert",
                              "-m",
                              String(mainlineParent.parentNumber),
                              "--no-edit",
                              validatedHash,
                          ];
                await executor.run(args);
                vscode.window.showInformationMessage(`Reverted ${short}.`);
                await refreshAll();
                return;
            }
            case "newBranch": {
                const branchName = await vscode.window.showInputBox({
                    prompt: `New branch from ${short}`,
                    placeHolder: "branch-name",
                });
                if (!branchName) return;
                if (!isValidBranchName(branchName)) {
                    vscode.window.showErrorMessage(
                        `Invalid branch name '${branchName}'. Names must contain only alphanumeric characters, dots, dashes, underscores, or slashes, and must not start with a dash.`,
                    );
                    return;
                }
                await executor.run(["branch", branchName, validatedHash]);
                vscode.window.showInformationMessage(`Created branch ${branchName} at ${short}.`);
                await refreshAll();
                return;
            }
            case "newTag": {
                const tagName = await vscode.window.showInputBox({
                    prompt: `New tag at ${short}`,
                    placeHolder: "v1.0.0",
                });
                if (!tagName) return;
                if (!isValidBranchName(tagName)) {
                    vscode.window.showErrorMessage(
                        `Invalid tag name '${tagName}'. Names must contain only alphanumeric characters, dots, dashes, underscores, or slashes, and must not start with a dash.`,
                    );
                    return;
                }
                await executor.run(["tag", tagName, validatedHash]);
                vscode.window.showInformationMessage(`Created tag ${tagName}.`);
                await refreshAll();
                return;
            }
            case "undoCommit": {
                if (!(await isCommitUnpushed(validatedHash))) {
                    vscode.window.showErrorMessage(
                        "Undo Commit is available only for unpushed commits.",
                    );
                    return;
                }
                if (await isMergeCommitHash(validatedHash)) {
                    vscode.window.showErrorMessage(
                        "Undo Commit is not available for merge commits.",
                    );
                    return;
                }
                const undoCount = await getUndoCommitCount(validatedHash);
                const confirm = await vscode.window.showWarningMessage(
                    `Undo ${undoCount} commit(s) up to ${short} (soft reset)?`,
                    { modal: true },
                    "Undo",
                );
                if (confirm !== "Undo") return;
                await executor.run(["reset", "--soft", `${validatedHash}^`]);
                vscode.window.showInformationMessage(
                    `Undid ${undoCount} commit(s) up to ${short}.`,
                );
                await refreshAll();
                return;
            }
            case "editCommitMessage": {
                if (!(await isCommitUnpushed(validatedHash))) {
                    vscode.window.showErrorMessage(
                        "Edit Commit Message is available only for unpushed commits.",
                    );
                    return;
                }
                if (await isMergeCommitHash(validatedHash)) {
                    vscode.window.showErrorMessage(
                        "Edit Commit Message is not available for merge commits.",
                    );
                    return;
                }

                const headHash = (await executor.run(["rev-parse", "HEAD"])).trim();
                if (isHashMatch(validatedHash, headHash)) {
                    const currentMessage = (
                        await executor.run(["log", "-1", "--format=%B"])
                    ).trim();
                    const nextMessage = await vscode.window.showInputBox({
                        prompt: "Edit commit message",
                        value: currentMessage,
                    });
                    if (!nextMessage) return;
                    await executor.run(["commit", "--amend", "-m", nextMessage]);
                    vscode.window.showInformationMessage("Commit message updated.");
                    await refreshAll();
                    return;
                }

                const terminal = vscode.window.createTerminal({
                    name: "IntelliGit Reword Commit",
                    cwd: repoRoot,
                });
                terminal.show();
                terminal.sendText(`git rebase -i ${validatedHash}^`);
                vscode.window.showInformationMessage(
                    "Interactive rebase opened. Mark the commit as 'reword' in the todo list.",
                );
                return;
            }
            case "dropCommit": {
                if (!(await isCommitUnpushed(validatedHash))) {
                    vscode.window.showErrorMessage(
                        "Drop Commit is available only for unpushed commits.",
                    );
                    return;
                }
                if (await isMergeCommitHash(validatedHash)) {
                    vscode.window.showErrorMessage(
                        "Drop Commit is not available for merge commits.",
                    );
                    return;
                }
                const confirm = await vscode.window.showWarningMessage(
                    `Drop commit ${short} from current branch history?`,
                    { modal: true },
                    "Drop",
                );
                if (confirm !== "Drop") return;
                await executor.run([
                    "rebase",
                    "--onto",
                    `${validatedHash}^`,
                    validatedHash,
                    "HEAD",
                ]);
                vscode.window.showInformationMessage(`Dropped ${short} from history.`);
                await refreshAll();
                return;
            }
            case "interactiveRebaseFromHere": {
                if (!(await isCommitUnpushed(validatedHash))) {
                    vscode.window.showErrorMessage(
                        "Interactive Rebase from Here is available only for unpushed commits.",
                    );
                    return;
                }
                if (await isMergeCommitHash(validatedHash)) {
                    vscode.window.showErrorMessage(
                        "Interactive Rebase from Here is not available for merge commits.",
                    );
                    return;
                }
                const terminal = vscode.window.createTerminal({
                    name: "IntelliGit Interactive Rebase",
                    cwd: repoRoot,
                });
                terminal.show();
                terminal.sendText(`git rebase -i ${validatedHash}^`);
                vscode.window.showInformationMessage(`Opened interactive rebase from ${short}.`);
                return;
            }
            default:
                return assertNever(action);
        }
    };

    // --- Commands ---

    context.subscriptions.push(
        vscode.commands.registerCommand("intelligit.refresh", async () => {
            currentBranches = await gitOps.getBranches();
            commitGraph.setBranches(currentBranches);
            await commitGraph.refresh();
            await commitPanel.refresh();
            await refreshMergeConflicts();
            await clearSelection();
        }),

        vscode.commands.registerCommand(
            "intelligit.filterByBranch",
            async (branchName?: string) => {
                await commitGraph.filterByBranch(branchName ?? null);
                await clearSelection();
            },
        ),

        vscode.commands.registerCommand("intelligit.showGitLog", async () => {
            await vscode.commands.executeCommand("intelligit.commitGraph.focus");
        }),

        vscode.commands.registerCommand("intelligit.mergeConflictsRefresh", async () => {
            await refreshMergeConflicts();
        }),
    );

    const isFilePathContext = (value: unknown): value is { filePath: string } => {
        return (
            !!value &&
            typeof value === "object" &&
            "filePath" in value &&
            typeof value.filePath === "string"
        );
    };

    const resolveConflictPath = (ctx: unknown): string | null =>
        isFilePathContext(ctx) ? ctx.filePath : null;

    context.subscriptions.push(
        vscode.commands.registerCommand("intelligit.openMergeConflict", async (ctx: unknown) => {
            const filePath = resolveConflictPath(ctx);
            if (!filePath) return;
            await openMergeConflictForFile(filePath);
        }),
        vscode.commands.registerCommand("intelligit.compareWithRevision", async (ctx?: unknown) => {
            await compareEditorFileWithRevision(ctx);
        }),
        vscode.commands.registerCommand("intelligit.compareWithBranch", async (ctx?: unknown) => {
            await compareEditorFileWithBranch(ctx);
        }),
        vscode.commands.registerCommand("intelligit.openConflictSession", async () => {
            const conflicts = await gitOps.getConflictFilesDetailed();
            if (conflicts.length === 0) {
                vscode.window.showInformationMessage("No unresolved merge conflicts found.");
                return;
            }
            await openConflictSession();
        }),
        vscode.commands.registerCommand("intelligit.detectJetBrainsMergeTool", async () => {
            await detectAndPickJetBrainsMergeToolPath();
        }),
        vscode.commands.registerCommand(
            "intelligit.openMergeConflictInJetBrains",
            async (ctx: unknown) => {
                const filePath = resolveConflictPath(ctx);
                if (!filePath) return;
                await openJetBrainsMergeToolForFile(filePath);
            },
        ),
        vscode.commands.registerCommand("intelligit.conflictAcceptYours", async (ctx: unknown) => {
            const filePath = resolveConflictPath(ctx);
            if (!filePath) return;
            try {
                await runWithNotificationProgress(
                    `Accepting yours for ${filePath}...`,
                    async () => {
                        await gitOps.acceptConflictSide(filePath, "ours");
                    },
                );
                vscode.window.showInformationMessage(`Accepted yours for ${filePath}`);
                await refreshConflictUi();
            } catch (error) {
                const message = getErrorMessage(error);
                vscode.window.showErrorMessage(`Accept yours failed: ${message}`);
            }
        }),
        vscode.commands.registerCommand("intelligit.conflictAcceptTheirs", async (ctx: unknown) => {
            const filePath = resolveConflictPath(ctx);
            if (!filePath) return;
            try {
                await runWithNotificationProgress(
                    `Accepting theirs for ${filePath}...`,
                    async () => {
                        await gitOps.acceptConflictSide(filePath, "theirs");
                    },
                );
                vscode.window.showInformationMessage(`Accepted theirs for ${filePath}`);
                await refreshConflictUi();
            } catch (error) {
                const message = getErrorMessage(error);
                vscode.window.showErrorMessage(`Accept theirs failed: ${message}`);
            }
        }),
    );

    // --- Branch action commands ---

    const branchActionCommands: Array<{
        id: string;
        handler: (item: { branch?: Branch }) => Promise<void>;
    }> = [
        {
            id: "intelligit.checkout",
            handler: async (item) => {
                const branch = item.branch;
                if (!branch) return;
                try {
                    const checkedOut = await checkoutBranch(branch);
                    vscode.window.showInformationMessage(`Checked out ${checkedOut}`);
                    await vscode.commands.executeCommand("intelligit.refresh");
                } catch (err) {
                    const msg = getErrorMessage(err);
                    vscode.window.showErrorMessage(`Checkout failed: ${msg}`);
                }
            },
        },
        {
            id: "intelligit.newBranchFrom",
            handler: async (item) => {
                const base = item.branch?.name;
                if (!base) return;
                const newName = await vscode.window.showInputBox({
                    prompt: `New branch from ${base}`,
                    placeHolder: "branch-name",
                });
                if (!newName) return;
                try {
                    await executor.run(["checkout", "-b", newName, base]);
                    vscode.window.showInformationMessage(`Created and checked out ${newName}`);
                    await vscode.commands.executeCommand("intelligit.refresh");
                } catch (err) {
                    const msg = getErrorMessage(err);
                    vscode.window.showErrorMessage(`Failed to create branch: ${msg}`);
                }
            },
        },
        {
            id: "intelligit.checkoutAndRebase",
            handler: async (item) => {
                const branch = item.branch;
                if (!branch) return;
                const onto = getCurrentBranchName();
                if (!onto) {
                    vscode.window.showErrorMessage("No current branch found.");
                    return;
                }
                try {
                    const checkedOut = await checkoutBranch(branch);
                    if (checkedOut === onto) {
                        vscode.window.showInformationMessage(
                            `${checkedOut} is already the current branch.`,
                        );
                        return;
                    }
                    await executor.run(["rebase", onto]);
                    vscode.window.showInformationMessage(
                        `Checked out ${checkedOut} and rebased onto ${onto}`,
                    );
                    await vscode.commands.executeCommand("intelligit.refresh");
                } catch (err) {
                    const msg = getErrorMessage(err);
                    vscode.window.showErrorMessage(`Checkout and rebase failed: ${msg}`);
                }
            },
        },
        {
            id: "intelligit.rebaseCurrentOnto",
            handler: async (item) => {
                const name = item.branch?.name;
                if (!name) return;
                const confirm = await vscode.window.showWarningMessage(
                    `Rebase current branch onto ${name}?`,
                    { modal: true },
                    "Rebase",
                );
                if (confirm !== "Rebase") return;
                try {
                    await executor.run(["rebase", name]);
                    vscode.window.showInformationMessage(`Rebased onto ${name}`);
                    await vscode.commands.executeCommand("intelligit.refresh");
                } catch (err) {
                    const msg = getErrorMessage(err);
                    vscode.window.showErrorMessage(`Rebase failed: ${msg}`);
                }
            },
        },
        {
            id: "intelligit.mergeIntoCurrent",
            handler: async (item) => {
                const name = item.branch?.name;
                if (!name) return;
                const confirm = await vscode.window.showWarningMessage(
                    `Merge ${name} into current branch?`,
                    { modal: true },
                    "Merge",
                );
                if (confirm !== "Merge") return;
                try {
                    await executor.run(["merge", name]);
                    vscode.window.showInformationMessage(`Merged ${name}`);
                    await vscode.commands.executeCommand("intelligit.refresh");
                } catch (err) {
                    try {
                        const conflicts = await gitOps.getConflictFilesDetailed();
                        if (conflicts.length > 0) {
                            await openConflictSession({
                                sourceBranch: name,
                                targetBranch: getCurrentBranchName() || undefined,
                            });
                            await refreshConflictUi();
                            vscode.window.showWarningMessage(
                                `Merge produced ${conflicts.length} unresolved conflict file${conflicts.length === 1 ? "" : "s"}. Opened Conflicts session.`,
                            );
                            return;
                        }
                    } catch {
                        // Fall back to merge error if conflict inspection/session launch fails.
                    }
                    const msg = getErrorMessage(err);
                    vscode.window.showErrorMessage(`Merge failed: ${msg}`);
                }
            },
        },
        {
            id: "intelligit.updateBranch",
            handler: async (item) => {
                const branch = item.branch;
                const name = branch?.name;
                if (!name || branch?.isRemote) return;
                try {
                    await runWithNotificationProgress(`Updating ${name}...`, async () => {
                        const remote = await resolveRemoteName(branch);
                        if (branch.isCurrent) {
                            if (remote) {
                                await executor.run(["pull", "--ff-only", remote, name]);
                            } else {
                                await executor.run(["pull", "--ff-only"]);
                            }
                            return;
                        }

                        if (!remote) {
                            throw new Error(`No remote configured for branch ${name}.`);
                        }

                        await executor.run([
                            "fetch",
                            remote,
                            `${name}:${name}`,
                            "--recurse-submodules=no",
                            "--progress",
                            "--prune",
                        ]);
                    });
                    vscode.window.showInformationMessage(`Updated ${name}`);
                    await vscode.commands.executeCommand("intelligit.refresh");
                } catch (err) {
                    const msg = getErrorMessage(err);
                    vscode.window.showErrorMessage(`Update failed: ${msg}`);
                }
            },
        },
        {
            id: "intelligit.pushBranch",
            handler: async (item) => {
                const branch = item.branch;
                if (!branch || branch.isRemote) return;
                try {
                    await runWithNotificationProgress(`Pushing ${branch.name}...`, async () => {
                        const remote = await resolveRemoteName(branch);
                        if (branch.isCurrent) {
                            if (branch.remote) {
                                await executor.run(["push", branch.remote, branch.name]);
                            } else {
                                await gitOps.push();
                            }
                        } else {
                            if (!remote) {
                                throw new Error(`No remote configured for branch ${branch.name}.`);
                            }
                            await executor.run(["push", "-u", remote, branch.name]);
                        }
                    });
                    vscode.window.showInformationMessage(`Pushed ${branch.name}`);
                    await vscode.commands.executeCommand("intelligit.refresh");
                } catch (err) {
                    if (err instanceof UpstreamPushDeclinedError) return;
                    const msg = getErrorMessage(err);
                    vscode.window.showErrorMessage(`Push failed: ${msg}`);
                }
            },
        },
        {
            id: "intelligit.renameBranch",
            handler: async (item) => {
                const name = item.branch?.name;
                if (!name) return;
                const newName = await vscode.window.showInputBox({
                    prompt: `Rename ${name} to`,
                    value: name,
                });
                if (!newName || newName === name) return;
                try {
                    await executor.run(["branch", "-m", name, newName]);
                    vscode.window.showInformationMessage(`Renamed ${name} to ${newName}`);
                    await vscode.commands.executeCommand("intelligit.refresh");
                } catch (err) {
                    const msg = getErrorMessage(err);
                    vscode.window.showErrorMessage(`Rename failed: ${msg}`);
                }
            },
        },
        {
            id: "intelligit.deleteBranch",
            handler: async (item) => {
                const branch = item.branch;
                if (!branch) return;
                const name = branch.name;
                if (!name) return;
                const isRemote = !!branch.isRemote;
                const checkedOutBranch = isRemote ? null : await getCheckedOutBranchName();

                if (!isRemote && checkedOutBranch && checkedOutBranch === name) {
                    await vscode.window.showWarningMessage(
                        `Cannot delete '${name}' because it is currently checked out. Switch to another branch and try again.`,
                        { modal: true },
                        "OK",
                    );
                    return;
                }

                let confirmLabel = "Delete";
                let confirmMessage = `Delete branch ${name}?`;
                if (!isRemote) {
                    const mergeStatus = await getLocalBranchMergeStatusForDelete(
                        name,
                        checkedOutBranch,
                    );
                    if (!mergeStatus.merged) {
                        const targetLabel =
                            mergeStatus.target === "HEAD"
                                ? "the current branch"
                                : `'${mergeStatus.target}'`;
                        confirmLabel = "Delete Anyway";
                        confirmMessage =
                            `Branch ${name} has unmerged commits relative to ${targetLabel}. Delete anyway?\n` +
                            `This may permanently lose commits not reachable from ${targetLabel}.`;
                    }
                }

                const confirm = await vscode.window.showWarningMessage(
                    confirmMessage,
                    { modal: true },
                    confirmLabel,
                );
                if (confirm !== confirmLabel) return;
                try {
                    if (isRemote) {
                        const target = resolveRemoteDeleteTarget(branch);
                        if (!target) {
                            vscode.window.showErrorMessage(
                                `Delete failed: unable to determine remote target for '${name}'.`,
                            );
                            return;
                        }
                        await runWithNotificationProgress(
                            `Deleting remote branch ${target.remote}/${target.remoteBranch}...`,
                            async () => {
                                await executor.run([
                                    "push",
                                    target.remote,
                                    "--delete",
                                    target.remoteBranch,
                                ]);
                            },
                        );
                        vscode.window.showInformationMessage(
                            `Deleted ${target.remote}/${target.remoteBranch}`,
                        );
                        await vscode.commands.executeCommand("intelligit.refresh");
                    } else {
                        const forceDelete = confirmLabel === "Delete Anyway";
                        await executor.run(["branch", forceDelete ? "-D" : "-d", name]);
                        await vscode.commands.executeCommand("intelligit.refresh");
                        await showDeletedBranchActions(branch);
                    }
                } catch (err) {
                    if (!isRemote && isBranchNotFullyMergedError(err)) {
                        const forceConfirm = await vscode.window.showWarningMessage(
                            `Branch '${name}' has unmerged commits. Do you still want to delete it?\nThis may permanently lose commits not reachable from the current branch.`,
                            { modal: true },
                            "Delete Anyway",
                        );
                        if (forceConfirm !== "Delete Anyway") return;
                        try {
                            await executor.run(["branch", "-D", name]);
                            await vscode.commands.executeCommand("intelligit.refresh");
                            await showDeletedBranchActions(branch);
                        } catch (forceErr) {
                            const msg = getErrorMessage(forceErr);
                            vscode.window.showErrorMessage(`Delete failed: ${msg}`);
                        }
                        return;
                    }
                    const msg = getErrorMessage(err);
                    vscode.window.showErrorMessage(`Delete failed: ${msg}`);
                }
            },
        },
    ];

    for (const cmd of branchActionCommands) {
        context.subscriptions.push(
            vscode.commands.registerCommand(cmd.id, (item: unknown) => {
                const validated =
                    item && typeof item === "object" && "branch" in item
                        ? (item as { branch?: Branch })
                        : { branch: undefined };
                return cmd.handler(validated);
            }),
        );
    }

    // --- Commit panel file context menu commands ---

    context.subscriptions.push(
        vscode.commands.registerCommand(
            "intelligit.commitFileCompareWithLocal",
            async (ctx: unknown) => {
                await compareCommitInfoFileWithLocal(ctx);
            },
        ),
        vscode.commands.registerCommand(
            "intelligit.commitFileCherryPickChange",
            async (ctx: unknown) => {
                await applySelectedCommitFileChange(ctx, "cherry-pick");
            },
        ),
        vscode.commands.registerCommand(
            "intelligit.commitFileRevertChange",
            async (ctx: unknown) => {
                await applySelectedCommitFileChange(ctx, "revert");
            },
        ),
        vscode.commands.registerCommand(
            "intelligit.fileRollback",
            async (ctx: { filePath?: string }) => {
                if (!ctx?.filePath) return;
                const confirm = await vscode.window.showWarningMessage(
                    `Rollback ${ctx.filePath}?`,
                    { modal: true },
                    "Rollback",
                );
                if (confirm !== "Rollback") return;
                try {
                    await gitOps.rollbackFiles([ctx.filePath]);
                    vscode.window.showInformationMessage("Changes rolled back.");
                } catch (error) {
                    const message = getErrorMessage(error);
                    console.error("Failed to rollback file:", error);
                    vscode.window.showErrorMessage(`Rollback failed: ${message}`);
                } finally {
                    await commitPanel.refresh();
                }
            },
        ),
        vscode.commands.registerCommand(
            "intelligit.fileJumpToSource",
            async (ctx: { filePath?: string }) => {
                if (!ctx?.filePath) return;
                const uri = vscode.Uri.joinPath(workspaceFolder.uri, ctx.filePath);
                await vscode.window.showTextDocument(uri);
            },
        ),
        vscode.commands.registerCommand(
            "intelligit.fileDelete",
            async (ctx: { filePath?: string }) => {
                if (!ctx?.filePath) return;
                const confirm = await vscode.window.showWarningMessage(
                    `Delete ${ctx.filePath}?`,
                    { modal: true },
                    "Delete",
                );
                if (confirm !== "Delete") return;

                const deleted = await deleteFileWithFallback(
                    gitOps,
                    workspaceFolder.uri,
                    ctx.filePath,
                );
                if (!deleted) return;

                vscode.window.showInformationMessage(`Deleted ${ctx.filePath}`);
                await commitPanel.refresh();
            },
        ),
        vscode.commands.registerCommand(
            "intelligit.fileShelve",
            async (ctx: { filePath?: string }) => {
                if (!ctx?.filePath) return;
                try {
                    await gitOps.shelveSave([ctx.filePath]);
                    vscode.window.showInformationMessage(`Shelved ${ctx.filePath}.`);
                } catch (error) {
                    const message = getErrorMessage(error);
                    console.error("Failed to shelve file:", error);
                    vscode.window.showErrorMessage(`Shelve failed: ${message}`);
                } finally {
                    await commitPanel.refresh();
                }
            },
        ),
        vscode.commands.registerCommand(
            "intelligit.fileShowHistory",
            async (ctx: { filePath?: string }) => {
                if (!ctx?.filePath) return;
                try {
                    const history = await gitOps.getFileHistory(ctx.filePath);
                    const doc = await vscode.workspace.openTextDocument({
                        content: history || "No history found.",
                        language: "git-commit",
                    });
                    await vscode.window.showTextDocument(doc, { preview: true });
                } catch (error) {
                    const message = getErrorMessage(error);
                    console.error("Failed to load file history:", error);
                    vscode.window.showErrorMessage(`Show history failed: ${message}`);
                }
            },
        ),
        vscode.commands.registerCommand("intelligit.fileRefresh", async () => {
            await commitPanel.refresh();
        }),
        vscode.commands.registerCommand("intelligit.fileRefreshing", () => {
            // No-op: visual-only command shown while refreshing (disabled via enablement).
        }),
    );

    // --- Initial load ---

    currentBranches = await gitOps.getBranches();
    commitGraph.setBranches(currentBranches);

    // Eagerly fetch file count so the activity bar badge shows immediately.
    // commitPanel.refresh() runs getStatus() and fires onDidChangeFileCount,
    // which updateBadge() picks up to set the tree view badge.
    commitPanel.refresh().catch((err) => {
        console.error("Initial commit panel refresh failed:", err);
    });
    refreshMergeConflicts().catch((err) => {
        console.error("Initial merge conflicts refresh failed:", err);
    });

    // --- Auto-refresh on file changes ---

    // Light refresh: working tree changes -> commit panel only
    let lightTimer: ReturnType<typeof setTimeout> | undefined;
    const debouncedLightRefresh = () => {
        if (lightTimer) clearTimeout(lightTimer);
        lightTimer = setTimeout(async () => {
            await commitPanel.refresh();
        }, 300);
    };

    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(debouncedLightRefresh),
        vscode.workspace.onDidSaveTextDocument(debouncedLightRefresh),
        vscode.workspace.onDidCreateFiles(debouncedLightRefresh),
        vscode.workspace.onDidDeleteFiles(debouncedLightRefresh),
        vscode.workspace.onDidRenameFiles(debouncedLightRefresh),
    );

    // Full refresh: git state changes -> branches + commit graph + commit panel
    let fullTimer: ReturnType<typeof setTimeout> | undefined;
    const debouncedFullRefresh = () => {
        if (fullTimer) clearTimeout(fullTimer);
        fullTimer = setTimeout(async () => {
            currentBranches = await gitOps.getBranches();
            commitGraph.setBranches(currentBranches);
            await commitGraph.refresh();
            await commitPanel.refresh();
            await refreshMergeConflicts();
        }, 500);
    };

    // VS Code's file watcher excludes .git/ by default, so use Node's fs.watch
    // to detect git state changes (new commits, branch changes, fetches)
    const gitDir = path.join(repoRoot, ".git");
    const gitStateFiles = new Set([
        "HEAD",
        "FETCH_HEAD",
        "packed-refs",
        "MERGE_HEAD",
        "REBASE_HEAD",
    ]);
    const fsWatchers: fs.FSWatcher[] = [];

    try {
        const dirWatcher = fs.watch(gitDir, (_event, filename) => {
            if (filename && gitStateFiles.has(filename)) {
                debouncedFullRefresh();
            }
        });
        fsWatchers.push(dirWatcher);
    } catch {
        /* .git dir may not be watchable */
    }

    try {
        const refsWatcher = fs.watch(path.join(gitDir, "refs"), { recursive: true }, () =>
            debouncedFullRefresh(),
        );
        fsWatchers.push(refsWatcher);
    } catch {
        /* refs dir may not exist yet */
    }

    context.subscriptions.push(new vscode.Disposable(() => fsWatchers.forEach((w) => w.close())));

    // --- Disposables ---

    context.subscriptions.push(commitGraph, commitInfo, commitPanel, mergeConflicts);
}

export function deactivate(): void {}
