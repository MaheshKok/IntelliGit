import { randomUUID } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { validateImportedPatch, validateShelfManifestPath } from "../shelf/importValidation";
import { classifyPatchHeader } from "../shelf/patchClassification";
import { indexPatchBlocks } from "../shelf/patchIO";
import type { ShelfStore } from "../shelf/store";
import { MAX_PARTIAL_TEXT_BYTES } from "../git/partialSnapshot";

/** These bytes originate only in a host-owned partial snapshot and Git-generated patch. */
export interface SelectedShelfInput {
    name: string;
    path: string;
    baseCommit: string;
    base: Buffer;
    patch: Buffer;
}

/** Captures one content-only selection with a real base for the existing three-way unshelve path. */
export async function captureSelectedShelf(
    store: ShelfStore,
    input: SelectedShelfInput,
    recordBase: boolean,
): Promise<{ shelfId: string; generation: number }> {
    const file = validateShelfManifestPath(input.path);
    if (
        !/^[a-f0-9]{40,64}$/.test(input.baseCommit) ||
        input.base.length > MAX_PARTIAL_TEXT_BYTES ||
        !isUtf8(input.base) ||
        input.base.includes(0) ||
        !input.patch.length ||
        input.patch.length > 8 * 1024 * 1024
    )
        throw new Error("Unsupported selected shelf content.");
    validateImportedPatch(input.patch);
    const blocks = indexPatchBlocks(input.patch);
    const classification = classifyPatchHeader(input.patch);
    if (
        blocks.length !== 1 ||
        blocks[0].path !== file ||
        classification.status !== "M" ||
        classification.binary ||
        classification.renamedFrom
    )
        throw new Error("Selected shelves require one ordinary tracked text modification.");
    const shelfId = randomUUID();
    const patch = await store.putObject(shelfId, input.patch);
    const base = recordBase ? await store.putObject(shelfId, input.base) : undefined;
    const manifest = await store.writeShelfGeneration(shelfId, {
        schemaVersion: 1,
        objectHashes: [patch.hash, ...(base ? [base.hash] : [])],
        metadata: {
            name: input.name,
            baseCommit: input.baseCommit,
            lifecycle: "shelved",
            createdAt: Date.now(),
        },
        files: [
            {
                changeId: "selected-text",
                worktreeBlock: {
                    path: file,
                    status: "M",
                    patchObjectHash: patch.hash,
                    ...(base ? { baseObjectHash: base.hash } : {}),
                },
                binary: false,
                untracked: false,
                baseAvailability: base ? "full" : "history",
                exactReconstruction: true,
                lifecycle: "shelved",
            },
        ],
    });
    return { shelfId, generation: manifest.generation };
}
