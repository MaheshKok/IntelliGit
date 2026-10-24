import { isSafeShelfRelativePath } from "./pathValidation";

/** Git change kinds representable by one shelf layer. */
export type ShelfChangeStatus = "M" | "A" | "D" | "R" | "T";

/** One staged or working-tree side of a logical shelf change. */
export interface ShelfLayerBlock {
    path: string;
    renamedFrom?: string;
    status: ShelfChangeStatus;
    modeBefore?: string;
    modeAfter?: string;
    beforeContentHash?: string;
    afterContentHash?: string;
    /** Immutable patch object for this specific index or worktree layer. */
    patchObjectHash?: string;
    /** Immutable base blob when this entry retains a full base revision. */
    baseObjectHash?: string;
    /** Raw materialized and working-tree bytes retained when filters diverge. */
    rawBeforeObjectHash?: string;
    rawAfterObjectHash?: string;
}

/** Whether the captured base can be read later for conflict handling. */
type ShelfBaseAvailability = "full" | "history" | "none";

/** Lifecycle retained for an individual shelf change. */
type ShelfFileLifecycle = "shelved" | "applied" | "retained";

/** Captured source text is descriptive provenance, never destination authority. */
interface ShelfSourceList {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly draft: string;
}

/** Exact source owners and immutable anchor evidence retained across shelf generations. */
export interface ShelfSelectionProvenance {
    readonly version: 1;
    readonly scope: "list" | "files" | "selection";
    readonly sourceLists: readonly ShelfSourceList[];
    readonly scopeDraft?: string;
    readonly entries: readonly {
        readonly changeId: string;
        readonly sourceListIds: readonly string[];
        readonly ownershipObjectHash?: string;
    }[];
}

/** Immutable proof that one target operation published its frozen successful entry set. */
export interface ShelfTargetOperationReceipt {
    readonly targetOperationId: string;
    readonly sourceGeneration: number;
    readonly sourceChecksum: string;
    readonly appliedChangeIds: readonly string[];
}

/** Shelf-wide metadata retained with every immutable generation. */
export interface ShelfMetadata {
    readonly name: string;
    readonly baseCommit?: string;
    readonly lifecycle: ShelfFileLifecycle;
    /** Epoch milliseconds when this shelf was first created. */
    readonly createdAt?: number;
    /** Epoch milliseconds when a fully removed shelf became an already-unshelved ghost. */
    readonly appliedAt?: number;
    readonly selection?: ShelfSelectionProvenance;
    readonly targetOperationReceipt?: ShelfTargetOperationReceipt;
}

/** Explicit persisted payload used by host services instead of untyped manifest files. */
export interface ShelfPersistenceContract {
    readonly metadata: ShelfMetadata;
    readonly files: readonly ShelfFileEntry[];
}

/** Raised when a persisted contract is malformed or contains unsafe references. */
export class ShelfPersistenceContractError extends Error {
    /** Creates a stable storage-boundary validation error. */
    constructor() {
        super("Invalid persisted shelf contract.");
        this.name = "ShelfPersistenceContractError";
    }
}

/**
 * One logical change, deliberately retaining independent index and worktree
 * blocks so staged rename chains cannot be collapsed into one path pair.
 */
export interface ShelfFileEntry {
    changeId: string;
    indexBlock?: ShelfLayerBlock;
    worktreeBlock?: ShelfLayerBlock;
    binary: boolean;
    untracked: boolean;
    baseAvailability: ShelfBaseAvailability;
    exactReconstruction: boolean;
    lifecycle: ShelfFileLifecycle;
}

/** Capture states that Phase 1 intentionally refuses instead of approximating. */
export type ShelfUnsupportedState =
    | "symlink"
    | "submodule"
    | "type-swap"
    | "unmerged-stage"
    | "intent-to-add"
    | "skip-worktree"
    | "assume-unchanged";

/** Typed per-file error for capture states without a lossless representation. */
export class ShelfUnsupportedStateError extends Error {
    /** Creates a stable error for a rejected change. */
    constructor(
        readonly changeId: string,
        readonly state: ShelfUnsupportedState,
    ) {
        super(`Cannot shelve ${changeId}: ${state} is unsupported.`);
        this.name = "ShelfUnsupportedStateError";
    }
}

/** Throws the explicit capture error for an unsupported Git state. */
export function assertShelfStateSupported(changeId: string, state: ShelfUnsupportedState): never {
    throw new ShelfUnsupportedStateError(changeId, state);
}

/**
 * Selection is by logical change ID only: callers receive complete entries,
 * including both sides of a rename or staged/worktree rename chain.
 */
export function selectWholeShelfEntries(
    entries: readonly ShelfFileEntry[],
    changeIds: ReadonlySet<string> | readonly string[],
): ShelfFileEntry[] {
    const selected = changeIds instanceof Set ? changeIds : new Set(changeIds);
    return entries.filter((entry) => selected.has(entry.changeId));
}

/** Validates and copies persisted metadata and per-layer object references. */
export function parseShelfPersistenceContract(value: unknown): ShelfPersistenceContract {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw contractError();
    const candidate = value as { readonly metadata?: unknown; readonly files?: unknown };
    if (!Array.isArray(candidate.files)) throw contractError();
    const metadata = parseMetadata(candidate.metadata);
    const files = candidate.files.map(parseFileEntry);
    if (new Set(files.map((file) => file.changeId)).size !== files.length) throw contractError();
    if (metadata.selection) {
        const changes = new Set(files.map((file) => file.changeId));
        if (metadata.selection.entries.some((entry) => !changes.has(entry.changeId))) {
            throw contractError();
        }
    }
    if (metadata.targetOperationReceipt) {
        const applied = new Set(
            files.filter((file) => file.lifecycle === "applied").map((file) => file.changeId),
        );
        if (metadata.targetOperationReceipt.appliedChangeIds.some((id) => !applied.has(id)))
            throw contractError();
    }
    return { metadata, files };
}

function parseMetadata(value: unknown): ShelfMetadata {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw contractError();
    const metadata = value as Partial<ShelfMetadata>;
    if (
        typeof metadata.name !== "string" ||
        metadata.name.trim().length === 0 ||
        metadata.name.length > 255 ||
        metadata.name.includes("\0") ||
        !isLifecycle(metadata.lifecycle) ||
        (metadata.baseCommit !== undefined && !isGitObjectId(metadata.baseCommit)) ||
        (metadata.appliedAt !== undefined &&
            (!Number.isSafeInteger(metadata.appliedAt) || metadata.appliedAt < 0)) ||
        (metadata.createdAt !== undefined &&
            (!Number.isSafeInteger(metadata.createdAt) || metadata.createdAt < 0))
    ) {
        throw contractError();
    }
    return {
        name: metadata.name,
        baseCommit: metadata.baseCommit,
        lifecycle: metadata.lifecycle,
        createdAt: metadata.createdAt,
        appliedAt: metadata.appliedAt,
        selection:
            metadata.selection === undefined ? undefined : parseSelection(metadata.selection),
        targetOperationReceipt:
            metadata.targetOperationReceipt === undefined
                ? undefined
                : parseShelfTargetOperationReceipt(metadata.targetOperationReceipt),
    };
}

/** Validates a nonempty, canonical receipt without inferring success from caller flags. */
export function parseShelfTargetOperationReceipt(value: unknown): ShelfTargetOperationReceipt {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw contractError();
    const receipt = value as Partial<ShelfTargetOperationReceipt>;
    if (
        !isChangeId(receipt.targetOperationId) ||
        !Number.isSafeInteger(receipt.sourceGeneration) ||
        receipt.sourceGeneration! < 1 ||
        !isOptionalHash(receipt.sourceChecksum) ||
        receipt.sourceChecksum === undefined ||
        !Array.isArray(receipt.appliedChangeIds) ||
        receipt.appliedChangeIds.length === 0 ||
        receipt.appliedChangeIds.length > 20_000 ||
        !receipt.appliedChangeIds.every(isChangeId) ||
        receipt.appliedChangeIds.some((id, index, ids) => index > 0 && ids[index - 1] >= id)
    )
        throw contractError();
    return {
        targetOperationId: receipt.targetOperationId,
        sourceGeneration: receipt.sourceGeneration!,
        sourceChecksum: receipt.sourceChecksum,
        appliedChangeIds: [...receipt.appliedChangeIds],
    };
}

/** Rejects malformed references and applies the established changelist text bounds without rewriting text. */
function parseSelection(value: unknown): ShelfSelectionProvenance {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw contractError();
    const selection = value as Partial<ShelfSelectionProvenance>;
    if (
        selection.version !== 1 ||
        !["list", "files", "selection"].includes(selection.scope ?? "") ||
        !Array.isArray(selection.sourceLists) ||
        selection.sourceLists.length === 0 ||
        selection.sourceLists.length > 100 ||
        !Array.isArray(selection.entries) ||
        selection.entries.length === 0 ||
        selection.entries.length > 20_000 ||
        (selection.scopeDraft !== undefined &&
            (typeof selection.scopeDraft !== "string" || selection.scopeDraft.length > 100_000))
    ) {
        throw contractError();
    }
    const sourceLists = selection.sourceLists.map(parseSourceList);
    const owners = new Set(sourceLists.map((list) => list.id));
    if (owners.size !== sourceLists.length) throw contractError();
    const changes = new Set<string>();
    const entries = selection.entries.map((entry: ShelfSelectionProvenance["entries"][number]) => {
        if (
            !entry ||
            typeof entry !== "object" ||
            Array.isArray(entry) ||
            !isChangeId(entry.changeId) ||
            changes.has(entry.changeId) ||
            !Array.isArray(entry.sourceListIds) ||
            entry.sourceListIds.length === 0 ||
            new Set(entry.sourceListIds).size !== entry.sourceListIds.length ||
            entry.sourceListIds.some((id: unknown) => typeof id !== "string" || !owners.has(id)) ||
            !isOptionalHash(entry.ownershipObjectHash)
        ) {
            throw contractError();
        }
        changes.add(entry.changeId);
        return {
            changeId: entry.changeId,
            sourceListIds: [...(entry.sourceListIds as readonly string[])],
            ownershipObjectHash: entry.ownershipObjectHash,
        };
    });
    return {
        version: 1,
        scope: selection.scope as ShelfSelectionProvenance["scope"],
        sourceLists,
        scopeDraft: selection.scopeDraft,
        entries,
    };
}

/** Keeps source names and drafts byte-for-byte while enforcing the same text contract as changelists. */
function parseSourceList(value: unknown): ShelfSourceList {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw contractError();
    const list = value as Partial<ShelfSourceList>;
    if (
        typeof list.id !== "string" ||
        (list.id !== "default" && !/^[a-f0-9-]{36}$/.test(list.id)) ||
        typeof list.name !== "string" ||
        !list.name.normalize("NFC").trim() ||
        list.name.normalize("NFC").trim().length > 80 ||
        /[\u0000-\u001f]/.test(list.name.normalize("NFC").trim()) ||
        typeof list.description !== "string" ||
        list.description.length > 4_000 ||
        list.description.includes("\0") ||
        typeof list.draft !== "string" ||
        list.draft.length > 100_000
    ) {
        throw contractError();
    }
    return { id: list.id, name: list.name, description: list.description, draft: list.draft };
}

function parseFileEntry(value: unknown): ShelfFileEntry {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw contractError();
    const entry = value as Partial<ShelfFileEntry>;
    if (
        !isChangeId(entry.changeId) ||
        !isOptionalLayer(entry.indexBlock) ||
        !isOptionalLayer(entry.worktreeBlock) ||
        (!entry.indexBlock && !entry.worktreeBlock) ||
        typeof entry.binary !== "boolean" ||
        typeof entry.untracked !== "boolean" ||
        !isBaseAvailability(entry.baseAvailability) ||
        typeof entry.exactReconstruction !== "boolean" ||
        !isLifecycle(entry.lifecycle)
    ) {
        throw contractError();
    }
    const indexBlock = entry.indexBlock ? parseLayerBlock(entry.indexBlock) : undefined;
    const worktreeBlock = entry.worktreeBlock ? parseLayerBlock(entry.worktreeBlock) : undefined;
    const blocks = [indexBlock, worktreeBlock].filter(
        (block): block is ShelfLayerBlock => block !== undefined,
    );
    if (blocks.some((block) => !block.patchObjectHash)) throw contractError();
    if (entry.baseAvailability === "full" && blocks.some((block) => !block.baseObjectHash)) {
        throw contractError();
    }
    if (
        !entry.exactReconstruction &&
        (!worktreeBlock?.rawBeforeObjectHash || !worktreeBlock.rawAfterObjectHash)
    ) {
        throw contractError();
    }
    return {
        changeId: entry.changeId,
        indexBlock,
        worktreeBlock,
        binary: entry.binary,
        untracked: entry.untracked,
        baseAvailability: entry.baseAvailability,
        exactReconstruction: entry.exactReconstruction,
        lifecycle: entry.lifecycle,
    };
}

function isOptionalLayer(value: unknown): value is ShelfLayerBlock | undefined {
    return value === undefined || (!!value && typeof value === "object" && !Array.isArray(value));
}

function parseLayerBlock(value: ShelfLayerBlock): ShelfLayerBlock {
    if (
        !isSafeShelfRelativePath(value.path) ||
        (value.renamedFrom !== undefined && !isSafeShelfRelativePath(value.renamedFrom)) ||
        !isChangeStatus(value.status) ||
        !isOptionalMode(value.modeBefore) ||
        !isOptionalMode(value.modeAfter) ||
        !isOptionalHash(value.beforeContentHash) ||
        !isOptionalHash(value.afterContentHash) ||
        !isOptionalHash(value.patchObjectHash) ||
        !isOptionalHash(value.baseObjectHash) ||
        !isOptionalHash(value.rawBeforeObjectHash) ||
        !isOptionalHash(value.rawAfterObjectHash)
    ) {
        throw contractError();
    }
    return { ...value };
}

function isChangeId(value: unknown): value is string {
    return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function isChangeStatus(value: unknown): value is ShelfChangeStatus {
    return value === "M" || value === "A" || value === "D" || value === "R" || value === "T";
}

function isBaseAvailability(value: unknown): value is ShelfBaseAvailability {
    return value === "full" || value === "history" || value === "none";
}

function isLifecycle(value: unknown): value is ShelfFileLifecycle {
    return value === "shelved" || value === "applied" || value === "retained";
}

function isOptionalMode(value: unknown): boolean {
    return value === undefined || (typeof value === "string" && /^[0-7]{6}$/.test(value));
}

function isOptionalHash(value: unknown): boolean {
    return value === undefined || (typeof value === "string" && /^[a-f0-9]{64}$/.test(value));
}

function isGitObjectId(value: unknown): value is string {
    return typeof value === "string" && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value);
}

function contractError(): ShelfPersistenceContractError {
    return new ShelfPersistenceContractError();
}
