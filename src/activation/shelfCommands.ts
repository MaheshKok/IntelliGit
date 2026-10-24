import * as vscode from "vscode";
import type { ChangelistStore } from "../changes/changelistStore";
import { prepareShelfRestore } from "../commands/shelfRestoreTarget";
import { acquireWithBoundedWait } from "../git/boundedLockRetry";
import { REPOSITORY_GATE_ACQUIRE_TIMEOUT_MS } from "../git/repositoryMutationGate";
import {
    ShelfStaleShelfError,
    type ShelfMutationResult,
    type ShelfService,
    type ShelfSummary,
} from "../services/shelfService";
import { logShelfOperation, logShelfWarning } from "../services/shelfObservability";
import type { TargetShelfMutationResult } from "../services/shelfTargetRestore";
import type { DiscoveredRepository } from "../services/repositoryDiscovery";
import { getErrorMessage } from "../utils/errors";

/** Command IDs that must remain available in repository and no-repository activation modes. */
export const SHELF_COMMAND_IDS = [
    "intelligit.shelveChanges",
    "intelligit.shelveSilently",
    "intelligit.saveToShelf",
    "intelligit.unshelve",
    "intelligit.importPatch",
    "intelligit.applyPatchToChangelist",
    "intelligit.cleanUpShelf",
    "intelligit.purgeShelfRecovery",
] as const;

/** Host callbacks and services used by command-palette shelf handlers. */
export interface ShelfCommandsDeps {
    readonly context: vscode.ExtensionContext;
    readonly getRepositories: () => readonly DiscoveredRepository[];
    readonly shelfServiceForRepository: (repositoryRoot: string) => ShelfService | undefined;
    /** Shared metadata store already connected for every shelf repository at activation. */
    readonly changelists: ChangelistStore;
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
        } catch (error) {
            logShelfWarning(`${operation} failed`, error);
            vscode.window.showErrorMessage(`${failure}: ${getErrorMessage(error)}`);
            return;
        }
        await refreshAfter(operation);
    };

    /** A refresh failure is logged separately and never relabels a completed mutation. */
    const refreshAfter = async (operation: string): Promise<void> => {
        try {
            await deps.refreshAfterMutation();
        } catch (error) {
            logShelfWarning(`refresh after ${operation} failed`, error);
        }
    };

    const staleRestoreMessage = (): string =>
        localize("The shelf or changelists changed. Nothing was unshelved; try again.");

    /** Every targeted outcome has its own text; only a fully applied restore reports success. */
    const reportTargetedRestore = (result: TargetShelfMutationResult): void => {
        if (result.status === "applied") {
            vscode.window.showInformationMessage(localize("Shelf unshelved."));
            return;
        }
        vscode.window.showWarningMessage(
            {
                notApplied: localize("No shelf changes were applied."),
                conflicted: localize(
                    "Unshelve stopped with conflicts. Resolve them from the Shelf tab.",
                ),
                stale: staleRestoreMessage(),
                busy: localize(
                    "Another repository operation is running or awaiting review. Nothing was unshelved.",
                ),
                appliedNeedsReview: localize(
                    "Unshelve changed files but needs review before it can finish.",
                ),
            }[result.status],
        );
    };

    const defaultName = (): string => localize("Uncommitted changes");
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
            // A user-asked restore waits as long as the repository gate; the store's own 1 s wait suits panel refreshes.
            const listed = await acquireWithBoundedWait(() => service.listShelves(), {
                timeoutMs: REPOSITORY_GATE_ACQUIRE_TIMEOUT_MS,
                retryDelayMs: 150,
            });
            const shelves = listed.shelves
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
            // The repository, service and settings are captured here; the destination prompt
            // below can outlive an active-repository switch without redirecting the restore.
            const result = await prepareShelfRestore(
                service,
                deps.changelists,
                {
                    shelfId: picked.shelf.id,
                    expectedShelfGeneration: picked.shelf.generation,
                    removeFromShelf:
                        vscode.workspace
                            .getConfiguration("intelligit")
                            .get<boolean>("shelf.removeOnUnshelve", true) !== false,
                    mode: "flattened",
                },
                (input) => service.unshelve(input),
            );
            if (!result) return;
            logShelfOperation(
                { operation: "unshelve", repositoryRoot: service.repositoryRoot },
                result,
            );
            reportTargetedRestore(result);
            if (result.status !== "stale" && result.status !== "busy")
                await refreshAfter("unshelve");
        } catch (error) {
            if (error instanceof ShelfStaleShelfError) {
                vscode.window.showWarningMessage(staleRestoreMessage());
                return;
            }
            logShelfWarning("unshelve failed", error);
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

    /**
     * Imports first: the durable shelf freezes and validates the exact patch bytes, and its
     * checksum fences the later apply. Every cancel after that point reports the import.
     */
    const applyPatchToChangelist = async (): Promise<void> => {
        const service = await selectService();
        if (!service) return;
        const sources = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: true,
            filters: { [localize("Patch files")]: ["patch", "diff"] },
        });
        if (!sources) return;
        let imported: ShelfMutationResult;
        try {
            imported = await service.importPatch({ fileUris: sources.map((uri) => uri.fsPath) });
            logShelfOperation(
                { operation: "shelfImportPatch", repositoryRoot: service.repositoryRoot },
                imported,
            );
        } catch (error) {
            logShelfWarning("shelfImportPatch failed", error);
            vscode.window.showErrorMessage(
                `${localize("Import patch failed")}: ${getErrorMessage(error)}`,
            );
            return;
        }
        const shelfId = imported.shelfId;
        const generation = imported.newGeneration;
        if (shelfId === undefined || generation === undefined)
            throw new Error("Patch import did not report the new shelf.");
        const importedOnly = async (): Promise<void> => {
            vscode.window.showInformationMessage(
                localize("Patch imported to shelf. Nothing was applied."),
            );
            await refreshAfter("shelfImportPatch");
        };
        try {
            const manifest = await service.getShelfManifest(shelfId);
            const result = await prepareShelfRestore(
                service,
                deps.changelists,
                {
                    shelfId,
                    expectedShelfGeneration: generation,
                    removeFromShelf:
                        vscode.workspace
                            .getConfiguration("intelligit")
                            .get<boolean>("shelf.removeOnUnshelve", true) !== false,
                    mode: "flattened",
                },
                async (input) => {
                    const target = input.targetOperation.target;
                    const listName =
                        target.kind === "new"
                            ? target.name
                            : (deps.changelists
                                  .get(service.repositoryRoot)
                                  .lists.find((list) => list.id === target.id)?.name ?? target.id);
                    const applyLabel = localize("Apply Patch");
                    const confirmed = await vscode.window.showInformationMessage(
                        localize("Apply the imported patch to changelist {list}?", {
                            list: listName,
                        }),
                        {
                            modal: true,
                            detail: manifest.files
                                .map(
                                    (entry) =>
                                        (entry.worktreeBlock ?? entry.indexBlock)?.path ??
                                        entry.changeId,
                                )
                                .join("\n"),
                        },
                        applyLabel,
                    );
                    return confirmed === applyLabel ? service.unshelve(input) : undefined;
                },
            );
            if (!result) return await importedOnly();
            logShelfOperation(
                { operation: "unshelve", repositoryRoot: service.repositoryRoot },
                result,
            );
            reportTargetedRestore(result);
            await refreshAfter("unshelve");
        } catch (error) {
            logShelfWarning("apply patch to changelist failed", error);
            vscode.window.showErrorMessage(
                `${localize("Patch imported to shelf, but applying it failed")}: ${getErrorMessage(error)}`,
            );
            await refreshAfter("shelfImportPatch");
        }
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
        vscode.commands.registerCommand(
            "intelligit.applyPatchToChangelist",
            applyPatchToChangelist,
        ),
        vscode.commands.registerCommand("intelligit.cleanUpShelf", cleanUp),
        vscode.commands.registerCommand("intelligit.purgeShelfRecovery", purgeRecovery),
    );
}
