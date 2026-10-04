import { realpath } from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";
import type { PullUpdateStrategy } from "../git/updateWithLocalChanges";

/** Tests containment using a relative path, including directory names that merely begin with two dots. */
function isContained(relative: string): boolean {
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Preserves opened folder URIs for repositories above or below them, including symlink paths. */
async function configurationResources(repositoryRoot: string): Promise<vscode.Uri[]> {
    const folders = await Promise.all(
        (vscode.workspace.workspaceFolders ?? [])
            .filter((folder) => folder.uri.scheme === "file")
            .map(async (folder) => {
                try {
                    return { folder, canonicalRoot: await realpath(folder.uri.fsPath) };
                } catch (error) {
                    const code = (error as NodeJS.ErrnoException).code;
                    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
                    throw error;
                }
            }),
    );
    const existingFolders = folders.filter((folder) => folder !== undefined);
    const matches = existingFolders
        .map(({ folder, canonicalRoot }) => ({
            folder,
            canonicalRoot,
            relative: path.relative(canonicalRoot, repositoryRoot),
        }))
        .filter(({ relative }) => isContained(relative))
        .sort((a, b) => b.canonicalRoot.length - a.canonicalRoot.length);
    const match = matches[0];
    if (match) return [vscode.Uri.file(path.join(match.folder.uri.fsPath, match.relative))];
    const children = existingFolders
        .filter(({ canonicalRoot }) => isContained(path.relative(repositoryRoot, canonicalRoot)))
        .map(({ folder }) => folder.uri);
    return children.length ? children : [vscode.Uri.file(repositoryRoot)];
}

/** Defaults an unset strategy to Rebase; invalid values, conflicting folders or unresolved scope stop the update. */
export async function readPullUpdateStrategy(repositoryRoot: string): Promise<PullUpdateStrategy> {
    const resources = await configurationResources(repositoryRoot);
    const strategies = resources.map((resource) => {
        const configuredStrategy = vscode.workspace
            .getConfiguration("intelligit", resource)
            .get<unknown>("updateStrategy");
        const strategy = configuredStrategy === undefined ? "rebase" : configuredStrategy;
        if (strategy !== "rebase" && strategy !== "merge") {
            throw new Error(
                vscode.l10n.t(
                    'Set intelligit.updateStrategy to "rebase" or "merge" before pulling.',
                ),
            );
        }
        return strategy;
    });
    if (new Set(strategies).size !== 1) {
        throw new Error(
            vscode.l10n.t(
                "Workspace folders for this repository have different intelligit.updateStrategy values. Choose the same value in each folder before pulling.",
            ),
        );
    }
    return strategies[0];
}
