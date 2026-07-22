import {
    ShelfPersistenceContractError,
    type ShelfPersistenceContract,
} from "./model";

/** Ensures every persisted per-layer artifact can be located in this shelf generation. */
export function assertPersistedObjectReferences(
    persistence: ShelfPersistenceContract,
    objectHashes: readonly string[],
): void {
    if (!objectHashes.every(isShelfObjectHash)) throw new ShelfPersistenceContractError();
    const available = new Set(objectHashes);
    for (const entry of persistence.files) {
        for (const block of [entry.indexBlock, entry.worktreeBlock]) {
            if (!block) continue;
            for (const hash of [
                block.patchObjectHash,
                block.baseObjectHash,
                block.rawBeforeObjectHash,
                block.rawAfterObjectHash,
            ]) {
                if (hash && !available.has(hash)) throw new ShelfPersistenceContractError();
            }
        }
    }
}

/** Recognizes the SHA-256 object addresses permitted in persisted shelf artifacts. */
export function isShelfObjectHash(value: unknown): value is string {
    return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
