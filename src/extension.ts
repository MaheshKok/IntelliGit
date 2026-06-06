// Extension entry point. Registers coordinated IntelliGit webviews:
// commit graph (with integrated branch column/details) and commit panel.
// The extension host is the sole data coordinator -- views never talk directly.

import * as vscode from "vscode";
import { registerReadonlyDiffContentProvider } from "./services/diffService";
import { discoverGitRepositories } from "./services/repositoryDiscovery";
import { activateNoRepositoryMode } from "./activation/noRepositoryMode";
import { activateNoWorkspaceMode } from "./activation/onboarding";
import { activateRepositoryMode } from "./activation/repositoryMode";
import {
    HAS_MERGE_CONFLICTS_CONTEXT,
    registerStaleUndockedPanelSerializer,
    setViewContext,
    workspaceRoots,
} from "./activation/common";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    registerStaleUndockedPanelSerializer(context);
    registerReadonlyDiffContentProvider(context);
    void setViewContext(HAS_MERGE_CONFLICTS_CONTEXT, false);

    if (!vscode.workspace.workspaceFolders?.length) {
        activateNoWorkspaceMode(context);
        return;
    }

    const repositories = await discoverGitRepositories(workspaceRoots());
    if (repositories.length === 0) {
        activateNoRepositoryMode(context, {
            activateRepositoryMode: (discoveredRepositories, viewProviders) =>
                activateRepositoryMode(context, discoveredRepositories, viewProviders),
        });
        return;
    }

    await activateRepositoryMode(context, repositories);
}

export function deactivate(): void {}
