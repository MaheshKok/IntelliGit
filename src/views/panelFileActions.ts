import * as vscode from "vscode";
import type { GitOps } from "../git/operations";
import type {
    StashEntry,
    ThemeFolderIconMap,
    ThemeIconFont,
    ThemeTreeIcon,
    WorkingFile,
} from "../types";
import { assertRepoRelativePath, deleteFileWithFallback } from "../utils/fileOps";
import { assertNumber, assertRepoPathArray, assertString } from "./messageValidation";
import type { IconThemeService } from "./shared";

interface PanelFileActionDeps {
    gitOps: GitOps;
    getWorkspaceRoot: () => vscode.Uri;
    refreshData: (silent?: boolean) => Promise<void>;
    fireWorkingTreeChanged: () => void;
}

interface ShelfSelectionDeps extends PanelFileActionDeps {
    iconTheme: IconThemeService;
    getFiles: () => WorkingFile[];
    getStashes: () => StashEntry[];
    currentBranchHasUpstream: () => Promise<boolean>;
    setShelfState: (state: {
        selectedShelfIndex: number;
        shelfFiles: WorkingFile[];
        folderIconsByName: ThemeFolderIconMap;
    }) => void;
    postUpdate: (message: {
        type: "update";
        files: WorkingFile[];
        stashes: StashEntry[];
        shelfFiles: WorkingFile[];
        selectedShelfIndex: number;
        folderIcon?: ThemeTreeIcon;
        folderExpandedIcon?: ThemeTreeIcon;
        folderIconsByName: ThemeFolderIconMap;
        iconFonts: ThemeIconFont[];
        currentBranchHasUpstream: boolean;
    }) => void;
}

/**
 * Stages repository-relative paths requested by a commit-panel webview.
 *
 * Path validation happens inside this boundary before Git sees the list; a successful stage refreshes
 * panel state and notifies listeners that the working tree changed.
 */
export async function stageFilesFromPanel(
    deps: PanelFileActionDeps,
    pathsValue: unknown,
): Promise<void> {
    await deps.gitOps.stageFiles(assertRepoPathArray(pathsValue, "paths"));
    await deps.refreshData();
    deps.fireWorkingTreeChanged();
}

/**
 * Unstages repository-relative paths requested by a commit-panel webview.
 *
 * The same validation path as staging is used so untrusted webview arrays cannot address paths
 * outside the active repository before Git index state is refreshed.
 */
export async function unstageFilesFromPanel(
    deps: PanelFileActionDeps,
    pathsValue: unknown,
): Promise<void> {
    await deps.gitOps.unstageFiles(assertRepoPathArray(pathsValue, "paths"));
    await deps.refreshData();
    deps.fireWorkingTreeChanged();
}

/**
 * Delegates branch publishing to the extension command and refreshes panel state afterward.
 *
 * Remote selection, credential prompts, and upstream naming remain owned by the publish command;
 * this helper only bridges panel UI state back to the active repository view.
 */
/**
 * Marks currently unversioned files as intent-to-add from a webview drop action.
 *
 * The current Git status is re-read after the drag payload arrives so stale webview state cannot
 * move a file that has already become tracked, staged, deleted, or otherwise non-unversioned. The
 * refresh is silent because the row transition is a direct result of the user's drop gesture and
 * should not flash the global commit-panel refresh indicator.
 */
export async function trackUnversionedFilesFromPanel(
    deps: PanelFileActionDeps,
    pathsValue: unknown,
): Promise<void> {
    const paths = assertRepoPathArray(pathsValue, "paths");
    if (paths.length === 0) return;

    const currentFiles = await deps.gitOps.getStatus();
    const currentByPath = new Map(currentFiles.map((file) => [file.path, file]));
    const stalePaths = paths.filter((path) => {
        const status = currentByPath.get(path)?.status;
        return status !== "?" && status !== "A";
    });
    if (stalePaths.length > 0) {
        throw new Error(
            `Only unversioned files can be moved into Changes: ${stalePaths.join(", ")}`,
        );
    }

    await deps.gitOps.intentToAddFiles(paths);
    await deps.refreshData(true);
    deps.fireWorkingTreeChanged();
}

/**
 * Publishes the current branch from the commit panel and refreshes local working-tree state.
 *
 * The helper delegates the publish flow to the extension command so credential prompts and remote
 * validation stay centralized, then performs a visible refresh because the branch/upstream state may
 * have changed and notifies listeners that working-tree metadata should be re-read.
 */
export async function publishBranchFromPanel(deps: PanelFileActionDeps): Promise<void> {
    await vscode.commands.executeCommand("intelligit.publishBranch");
    await deps.refreshData();
    deps.fireWorkingTreeChanged();
}

/**
 * Opens VS Code's Git change view for a validated repository-relative file path.
 *
 * The active repository root is supplied by the owning provider; path validation prevents a webview
 * payload from constructing editor URIs outside that root.
 */
export async function showDiffFromPanel(
    deps: PanelFileActionDeps,
    pathValue: unknown,
): Promise<void> {
    const filePath = assertRepoRelativePath(assertString(pathValue, "path"));
    const uri = vscode.Uri.joinPath(deps.getWorkspaceRoot(), filePath);
    await vscode.commands.executeCommand("git.openChange", uri);
}

/**
 * Opens an untitled diff document for one file inside a shelved change.
 *
 * The shelf index must be finite and the path repository-relative. Empty patch content is converted
 * into a visible fallback message so the panel action always produces understandable editor output.
 */
export async function showShelfDiffFromPanel(
    deps: Pick<PanelFileActionDeps, "gitOps">,
    indexValue: unknown,
    pathValue: unknown,
): Promise<void> {
    const index = assertNumber(indexValue, "index");
    const filePath = assertRepoRelativePath(assertString(pathValue, "path"));
    const patch = await deps.gitOps.getShelvedFilePatch(index, filePath);
    const doc = await vscode.workspace.openTextDocument({
        content: patch || `No shelved diff found for ${filePath}.`,
        language: "diff",
    });
    await vscode.window.showTextDocument(doc, { preview: true });
}

/**
 * Opens a validated repository file in the editor without mutating Git state.
 *
 * The workspace root comes from the active provider, making this action safe for both docked and
 * undocked panels as long as their repository root assumptions stay in sync.
 */
export async function openFileFromPanel(
    deps: PanelFileActionDeps,
    pathValue: unknown,
): Promise<void> {
    const filePath = assertRepoRelativePath(assertString(pathValue, "path"));
    const uri = vscode.Uri.joinPath(deps.getWorkspaceRoot(), filePath);
    await vscode.window.showTextDocument(uri);
}

/**
 * Confirms and deletes a repository-relative file selected from the commit panel.
 *
 * Deletion uses the shared Git/filesystem fallback helper, then refreshes and emits change events
 * only when a file was actually removed.
 */
export async function deleteFileFromPanel(
    deps: PanelFileActionDeps,
    pathValue: unknown,
): Promise<void> {
    const filePath = assertRepoRelativePath(assertString(pathValue, "path"));
    const deleteAction = vscode.l10n.t("Delete");
    const confirm = await vscode.window.showWarningMessage(
        vscode.l10n.t("Delete {path}?", { path: filePath }),
        { modal: true },
        deleteAction,
    );
    if (confirm !== deleteAction) return;
    const deleted = await deleteFileWithFallback(deps.gitOps, deps.getWorkspaceRoot(), filePath);
    if (!deleted) return;
    vscode.window.showInformationMessage(vscode.l10n.t("Deleted {path}", { path: filePath }));
    await deps.refreshData();
    deps.fireWorkingTreeChanged();
}

/**
 * Opens a read-only history document for a validated repository-relative file path.
 *
 * History content comes from Git and is shown as a preview editor; an empty Git result becomes a
 * stable fallback message instead of an empty buffer.
 */
export async function showHistoryFromPanel(
    deps: PanelFileActionDeps,
    pathValue: unknown,
): Promise<void> {
    const filePath = assertRepoRelativePath(assertString(pathValue, "path"));
    const history = await deps.gitOps.getFileHistory(filePath);
    const doc = await vscode.workspace.openTextDocument({
        content: history || "No history found.",
        language: "git-commit",
    });
    await vscode.window.showTextDocument(doc, { preview: true });
}

/**
 * Loads a shelf selection, decorates its files, and posts a full panel update.
 *
 * Selecting a shelf does not mutate the repository. It refreshes provider-held shelf state and
 * includes current branch upstream status so push-related UI stays consistent with working files.
 */
export async function selectShelfFromPanel(
    deps: ShelfSelectionDeps,
    indexValue: unknown,
): Promise<void> {
    const selectedShelfIndex = assertNumber(indexValue, "index");
    const files = deps.getFiles();
    const shelfFiles = await deps.iconTheme.decorateWorkingFiles(
        await deps.gitOps.getShelvedFiles(selectedShelfIndex),
    );
    const folderIconsByName = await deps.iconTheme.getFolderIconsByWorkingFiles([
        ...files,
        ...shelfFiles,
    ]);
    deps.setShelfState({ selectedShelfIndex, shelfFiles, folderIconsByName });
    const { folderIcons, iconFonts } = deps.iconTheme.getThemeData();
    deps.postUpdate({
        type: "update",
        files,
        stashes: deps.getStashes(),
        shelfFiles,
        selectedShelfIndex,
        folderIcon: folderIcons.folderIcon,
        folderExpandedIcon: folderIcons.folderExpandedIcon,
        folderIconsByName,
        iconFonts,
        currentBranchHasUpstream: await deps.currentBranchHasUpstream(),
    });
}
