import * as vscode from "vscode";
import { GitExecutor } from "../git/executor";
import { GitOps } from "../git/operations";
import type { DiscoveredRepository } from "../services/repositoryDiscovery";
import type { StashEntry, ThemeFolderIconMap, WorkingFile } from "../types";

/**
 * Holds mutable commit-panel state for one discovered repository.
 *
 * The provider still owns behavior in this phase; this object only keeps the state and Git facade
 * that must not bleed between repositories while the webview UI is still single-repository.
 */
export class CommitPanelRepositoryRuntime {
    repository: DiscoveredRepository;
    readonly repoRootUri: vscode.Uri;
    readonly gitOps: GitOps;
    files: WorkingFile[] = [];
    stashes: StashEntry[] = [];
    selectedStashIndex: number | null = null;
    stashFiles: WorkingFile[] = [];
    folderIconsByName: ThemeFolderIconMap = {};
    showIgnoredFiles = false;
    currentBranch: string | null = null;
    currentBranchHasUpstreamCache = false;
    hasRemotesCache = false;
    currentBranchAheadCache = 0;
    currentBranchBehindCache = 0;
    currentBranchNameCache: string | null = null;
    currentBranchUpstreamCache: string | null = null;
    filterText = "";
    offset = 0;
    loadingMore = false;
    requestSeq = 0;
    dataRefreshSeq = 0;
    countRefreshSeq = 0;
    hasScannedFileCount = false;

    /**
     * Creates a runtime for one repository root.
     *
     * `gitOps` is injectable only so the existing single-repository activation path can keep using
     * its already-constructed facade; newly discovered roots get an executor bound to their root.
     */
    constructor(repository: DiscoveredRepository, gitOps?: GitOps) {
        this.repository = repository;
        this.repoRootUri = vscode.Uri.file(repository.root);
        this.gitOps = gitOps ?? new GitOps(new GitExecutor(repository.root));
    }
}
