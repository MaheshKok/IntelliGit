import * as vscode from "vscode";
import type { ShelfMutationResult, ShelfService, ShelfSummary } from "../services/shelfService";
import { logShelfOperation, logShelfWarning } from "../services/shelfObservability";
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

function localize(message: string, values?: Record<string, string | number | boolean>): string {
    if ("l10n" in vscode) return values ? vscode.l10n.t(message, values) : vscode.l10n.t(message);
    return message.replace(/\{(\w+)\}/g, (_placeholder, name: string) =>
        String(values?.[name] ?? `{${name}}`),
    );
}

/** Registers host-owned command-palette shelf actions for the active repository set. */
export function registerShelfCommands(deps: ShelfCommandsDeps): void {
    const selectService = async (): Promise<ShelfService | undefined> => {
        const repositories = deps.getRepositories();
        if (repositories.length === 0) {
            vscode.window.showInformationMessage(
                localize("No Git repositories found in this workspace."),
            );
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
                { placeHolder: localize("Select a repository for shelf changes") },
            );
            if (!picked) return undefined;
            repository = picked.repository;
        }
        const service = deps.shelfServiceForRepository(repository.root);
        if (!service)
            vscode.window.showErrorMessage(
                localize("Shelf service is unavailable for this repository."),
            );
        return service;
    };

    const runMutation = async (
        service: ShelfService,
        operation: string,
        action: () => Promise<ShelfMutationResult | void>,
        success: string,
        failure: string,
    ): Promise<void> => {
        try {
            const result = await action();
            logShelfOperation(
                { operation, repositoryRoot: service.repositoryRoot },
                result ?? { status: "ok" },
            );
            vscode.window.showInformationMessage(success);
            await deps.refreshAfterMutation();
        } catch (error) {
            logShelfWarning(`${operation} failed`, error);
            vscode.window.showErrorMessage(`${failure}: ${getErrorMessage(error)}`);
        }
    };

    const defaultName = (): string =>
        localize("Uncommitted changes [{date}]", { date: new Date().toLocaleString() });
    const shelve = async (silent: boolean, keepLocal: boolean, prompt: boolean): Promise<void> => {
        const service = await selectService();
        if (!service) return;
        const suggestedName = defaultName();
        const name = prompt
            ? await vscode.window.showInputBox({
                  prompt: localize("Shelf name"),
                  value: suggestedName,
              })
            : suggestedName;
        if (!name) return;
        await runMutation(
            service,
            "shelveSave",
            () => service.shelve({ name, paths: [], silent, keepLocal }),
            keepLocal ? localize("Changes saved to shelf.") : localize("Changes shelved."),
            keepLocal ? localize("Save to shelf failed") : localize("Shelve changes failed"),
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
                vscode.window.showInformationMessage(
                    localize("No shelves are available to unshelve."),
                );
                return;
            }
            const picked = await vscode.window.showQuickPick<ShelfPick>(
                shelves.map((shelf) => ({
                    label: shelf.metadata.name,
                    description: shelf.id,
                    shelf,
                })),
                { placeHolder: localize("Select a shelf to unshelve") },
            );
            if (!picked) return;
            await runMutation(
                service,
                "unshelve",
                () =>
                    service.unshelve({
                        id: picked.shelf.id,
                        expectedShelfGeneration: picked.shelf.generation,
                        removeFromShelf:
                            vscode.workspace
                                .getConfiguration("intelligit")
                                .get<boolean>("shelf.removeOnUnshelve", true) !== false,
                        mode: "flattened",
                    }),
                localize("Shelf unshelved."),
                localize("Unshelve failed"),
            );
        } catch (error) {
            vscode.window.showErrorMessage(
                `${localize("Unshelve failed")}: ${getErrorMessage(error)}`,
            );
        }
    };

    const importPatch = async (): Promise<void> => {
        const service = await selectService();
        if (!service) return;
        const sources = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: true,
            filters: { [localize("Patch files")]: ["patch", "diff"] },
        });
        if (!sources) return;
        await runMutation(
            service,
            "shelfImportPatch",
            () => service.importPatch({ fileUris: sources.map((uri) => uri.fsPath) }),
            localize("Patch imported to shelf."),
            localize("Import patch failed"),
        );
    };

    const cleanUp = async (): Promise<void> => {
        const service = await selectService();
        if (!service) return;
        try {
            const listed = await service.listShelves();
            const ghosts = listed.shelves.filter((shelf) => shelf.metadata.lifecycle === "applied");
            if (ghosts.length === 0) {
                vscode.window.showInformationMessage(
                    localize("No already unshelved shelves to clean up."),
                );
                return;
            }
            const action = localize("Clean Up Shelf");
            const confirmed = await vscode.window.showWarningMessage(
                localize("Permanently delete all already unshelved shelves?"),
                { modal: true },
                action,
            );
            if (confirmed !== action) return;
            await runMutation(
                service,
                "shelfCleanUp",
                () =>
                    service.cleanUp({
                        shelfIds: ghosts.map((shelf) => shelf.id),
                        expectedCatalogGeneration: listed.catalogGeneration,
                    }),
                localize("Already unshelved shelves cleaned up."),
                localize("Clean up shelf failed"),
            );
        } catch (error) {
            vscode.window.showErrorMessage(
                `${localize("Clean up shelf failed")}: ${getErrorMessage(error)}`,
            );
        }
    };

    const purgeRecovery = async (): Promise<void> => {
        const service = await selectService();
        if (!service) return;
        const action = localize("Purge Shelf Recovery");
        const confirmed = await vscode.window.showWarningMessage(
            localize("Permanently delete shelf recovery snapshots?"),
            { modal: true },
            action,
        );
        if (confirmed !== action) return;
        await runMutation(
            service,
            "shelfPurgeRecovery",
            async () => {
                await service.purgeRecovery();
            },
            localize("Shelf recovery snapshots purged."),
            localize("Purge shelf recovery failed"),
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
