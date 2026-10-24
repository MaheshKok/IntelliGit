import { randomUUID } from "node:crypto";
import type { ChangelistStore } from "../changes/changelistStore";
import { ShelfStaleShelfError, type ShelfService } from "../services/shelfService";
import type { ShelfRestoreTarget, UnshelveInput } from "../services/shelfTargetRestore";
import { pickChangelistTarget } from "./changelistTarget";

/** Restore intent validated by the caller before the destination prompt. */
export interface ShelfRestoreRequest {
    readonly shelfId: string;
    readonly expectedShelfGeneration: number;
    readonly changeIds?: readonly string[];
    readonly removeFromShelf: boolean;
    readonly mode: UnshelveInput["mode"];
}

/** Fully captured input; executing it never re-reads an active repository or list state. */
export type TargetedUnshelveInput = UnshelveInput & {
    readonly targetOperation: ShelfRestoreTarget;
    readonly expectedShelfGeneration: number;
};

/**
 * Reads the source shelf and destination lists from the already-captured repository, prompts for a
 * destination, then runs `apply` with a host-issued operation. Cancellation returns undefined
 * before any metadata or Git write; a source that changed before the prompt is rejected as stale.
 * Observer writes are held from before the prompt stamps its revision until `apply` ends.
 */
export async function prepareShelfRestore<T>(
    service: ShelfService,
    changelists: ChangelistStore,
    request: ShelfRestoreRequest,
    apply: (input: TargetedUnshelveInput) => Promise<T>,
): Promise<T | undefined> {
    const root = service.repositoryRoot;
    const manifest = await service.getShelfManifest(request.shelfId);
    if (manifest.generation !== request.expectedShelfGeneration)
        throw new ShelfStaleShelfError(request.expectedShelfGeneration, manifest.generation);
    const known = new Set(manifest.files.map((entry) => entry.changeId));
    if (request.changeIds?.some((id) => !known.has(id)))
        throw new Error("Shelf change ID does not exist.");
    const selected = new Set(request.changeIds ?? known);
    const selection = manifest.metadata.selection;
    const owners = new Set(
        selection?.entries
            .filter((entry) => selected.has(entry.changeId))
            .flatMap((entry) => entry.sourceListIds),
    );
    const release = await changelists.holdObservers(root);
    try {
        await changelists.settled(root);
        const picked = await pickChangelistTarget({
            state: changelists.get(root),
            suggestedName: manifest.metadata.name,
            sourceLists: selection?.sourceLists.filter((list) => owners.has(list.id)) ?? [],
        });
        if (!picked) return undefined;
        return await apply({
            id: request.shelfId,
            ...(request.changeIds ? { changeIds: request.changeIds } : {}),
            removeFromShelf: request.removeFromShelf,
            mode: request.mode,
            expectedShelfGeneration: manifest.generation,
            targetOperation: {
                id: randomUUID(),
                root,
                target: picked.target,
                sourceChecksum: manifest.checksum,
                ...(picked.draftChoice ? { draftChoice: picked.draftChoice } : {}),
            },
        });
    } finally {
        release();
    }
}
