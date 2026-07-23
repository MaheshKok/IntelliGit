import * as vscode from "vscode";
import type { ShelfService, ShelfSummary } from "../services/shelfService";
import type { DiscoveredRepository } from "../services/repositoryDiscovery";
import { getErrorMessage } from "../utils/errors";

/** Command IDs that must remain available in repository and no-repository activation modes. */
export const SHELF_COMMAND_IDS = [
    "intelligit.shelveChanges",
    "intelligit.shelveSilently",
    "intelligit.saveToShelf",
    "intelligit.unshelve",
    "intelligit.importPatch",
    "intelligit.cleanUpShelf",
    "intelligit.purgeShelfRecovery",
] as const;

/** Host callbacks and services used by command-palette shelf handlers. */
export interface ShelfCommandsDeps {
    readonly context: vscode.ExtensionContext;
    readonly getRepositories: () => readonly DiscoveredRepository[];
    readonly shelfServiceForRepository: (repositoryRoot: string) => ShelfService | undefined;
    /** Refreshes docked and undocked commit-panel state after a successful command mutation. */
    readonly refreshAfterMutation: () => Promise<void>;
}

type RepositoryPick = vscode.QuickPickItem & { readonly repository: DiscoveredRepository };
type ShelfPick = vscode.QuickPickItem & { readonly shelf: ShelfSummary };

/** Registers host-owned command-palette shelf actions for the active repository set. */
export function registerShelfCommands(deps: ShelfCommandsDeps): void {
    const selectService = async (): Promise<ShelfService | undefined> => {
        const repositories = deps.getRepositories();
        if (repositories.length === 0) {
            vscode.window.showInformationMessage("No Git repositories found in this workspace.");
            return undefined;
        }
        let repository = repositories[0];
        if (repositories.length > 1) {
            const picked = await vscode.window.showQuickPick<RepositoryPick>(
                repositories.map((candidate) => ({
                    label: candidate.label,
                    description: candidate.root,
                    repository: candidate,
                })),
                { placeHolder: "Select a repository for shelf changes" },
            );
            if (!picked) return undefined;
            repository = picked.repository;
        }
        const service = deps.shelfServiceForRepository(repository.root);
        if (!service)
            vscode.window.showErrorMessage("Shelf service is unavailable for this repository.");
        return service;
    };

    const runMutation = async (
        action: () => Promise<void>,
        success: string,
        failure: string,
    ): Promise<void> => {
        try {
            await action();
            vscode.window.showInformationMessage(success);
            await deps.refreshAfterMutation();
        } catch (error) {
            vscode.window.showErrorMessage(`${failure}: ${getErrorMessage(error)}`);
        }
    };

    const defaultName = (): string => `Uncommitted changes [${new Date().toLocaleString()}]`;
    const shelve = async (silent: boolean, keepLocal: boolean, prompt: boolean): Promise<void> => {
        const service = await selectService();
        if (!service) return;
        const suggestedName = defaultName();
        const name = prompt
            ? await vscode.window.showInputBox({
                  prompt: "Shelf name",
                  value: suggestedName,
              })
            : suggestedName;
        if (!name) return;
        await runMutation(
            async () => {
                await service.shelve({ name, paths: [], silent, keepLocal });
            },
            keepLocal ? "Changes saved to shelf." : "Changes shelved.",
            keepLocal ? "Save to shelf failed" : "Shelve changes failed",
        );
    };

    const unshelve = async (): Promise<void> => {
        const service = await selectService();
        if (!service) return;
        try {
            const shelves = (await service.listShelves()).shelves
                .filter((shelf) => shelf.metadata.lifecycle !== "applied")
                .sort((left, right) => {
                    const leftCreatedAt = left.metadata.createdAt;
                    const rightCreatedAt = right.metadata.createdAt;
                    if (leftCreatedAt === undefined || rightCreatedAt === undefined) {
                        if (leftCreatedAt !== rightCreatedAt)
                            return leftCreatedAt === undefined ? 1 : -1;
                    } else if (leftCreatedAt !== rightCreatedAt) {
                        return rightCreatedAt - leftCreatedAt;
                    }
                    return (
                        left.metadata.name.localeCompare(right.metadata.name) ||
                        left.id.localeCompare(right.id)
                    );
                });
            if (shelves.length === 0) {
                vscode.window.showInformationMessage("No shelves are available to unshelve.");
                return;
            }
            const picked = await vscode.window.showQuickPick<ShelfPick>(
                shelves.map((shelf) => ({
                    label: shelf.metadata.name,
                    description: shelf.id,
                    shelf,
                })),
                { placeHolder: "Select a shelf to unshelve" },
            );
            if (!picked) return;
            await runMutation(
                async () => {
                    await service.unshelve({
                        id: picked.shelf.id,
                        expectedShelfGeneration: picked.shelf.generation,
                        removeFromShelf: true,
                        mode: "flattened",
                    });
                },
                "Shelf unshelved.",
                "Unshelve failed",
            );
        } catch (error) {
            vscode.window.showErrorMessage(`Unshelve failed: ${getErrorMessage(error)}`);
        }
    };

    const importPatch = async (): Promise<void> => {
        const service = await selectService();
        if (!service) return;
        const sources = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: true,
            filters: { "Patch files": ["patch", "diff"] },
        });
        if (!sources) return;
        await runMutation(
            async () => {
                await service.importPatch({ fileUris: sources.map((uri) => uri.fsPath) });
            },
            "Patch imported to shelf.",
            "Import patch failed",
        );
    };

    const cleanUp = async (): Promise<void> => {
        const service = await selectService();
        if (!service) return;
        try {
            const listed = await service.listShelves();
            const ghosts = listed.shelves.filter((shelf) => shelf.metadata.lifecycle === "applied");
            if (ghosts.length === 0) {
                vscode.window.showInformationMessage("No already unshelved shelves to clean up.");
                return;
            }
            const action = "Clean Up Shelf";
            const confirmed = await vscode.window.showWarningMessage(
                "Permanently delete all already unshelved shelves?",
                { modal: true },
                action,
            );
            if (confirmed !== action) return;
            await runMutation(
                async () => {
                    await service.cleanUp({
                        shelfIds: ghosts.map((shelf) => shelf.id),
                        expectedCatalogGeneration: listed.catalogGeneration,
                    });
                },
                "Already unshelved shelves cleaned up.",
                "Clean up shelf failed",
            );
        } catch (error) {
            vscode.window.showErrorMessage(`Clean up shelf failed: ${getErrorMessage(error)}`);
        }
    };

    const purgeRecovery = async (): Promise<void> => {
        const service = await selectService();
        if (!service) return;
        const action = "Purge Shelf Recovery";
        const confirmed = await vscode.window.showWarningMessage(
            "Permanently delete shelf recovery snapshots?",
            { modal: true },
            action,
        );
        if (confirmed !== action) return;
        await runMutation(
            async () => {
                await service.purgeRecovery();
            },
            "Shelf recovery snapshots purged.",
            "Purge shelf recovery failed",
        );
    };

    deps.context.subscriptions.push(
        vscode.commands.registerCommand("intelligit.shelveChanges", () =>
            shelve(false, false, true),
        ),
        vscode.commands.registerCommand("intelligit.shelveSilently", () =>
            shelve(true, false, false),
        ),
        vscode.commands.registerCommand("intelligit.saveToShelf", () => shelve(true, true, false)),
        vscode.commands.registerCommand("intelligit.unshelve", unshelve),
        vscode.commands.registerCommand("intelligit.importPatch", importPatch),
        vscode.commands.registerCommand("intelligit.cleanUpShelf", cleanUp),
        vscode.commands.registerCommand("intelligit.purgeShelfRecovery", purgeRecovery),
    );
}
