import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { changeFingerprint } from "./parseDiff";
import { assertRepoRelativePath } from "../utils/repoRelativePath";
import type {
    ChangelistState,
    ChangeOwnership,
    RangeSnapshot,
    RangeSnapshotReference,
} from "../webviews/protocol/changeSelection";
import { ChangelistPersistence, ChangelistEvidenceError } from "./changelistPersistence";
import {
    reconcileRanges,
    type HydratedChangeOwnership,
    type HydratedChangelistState,
} from "./rangeMapping";
import { validRangeMetadata, validSnapshot, snapshotReference } from "./rangeMetadata";

interface MetadataStorage {
    get<T>(key: string): T | undefined;
    update(key: string, value: unknown): PromiseLike<void>;
}

interface CommitInclusion {
    path: string;
    contentId: string;
    lineIds: readonly string[];
    total: number;
}

// Keep the original key: schema 2 is also a downgrade sentinel that v1 clients refuse.
const STORAGE_KEY = "intelligit.changelists.v1";
const BACKUP_KEY = "intelligit.changelists.v1.backup";
const MAX_DRAFT = 100_000;
const MAX_DESCRIPTION = 4_000;
/** A stable fallback independent of locale or a user-created list name. */
const DEFAULT_CHANGELIST_ID = "default";
const instances = new WeakMap<MetadataStorage, ChangelistStore>();
const MAX_LISTS = 100;
const MAX_FILES = 20_000;

/** A concurrent writer won the revision; callers must refresh rather than overwrite its decision. */
export class ChangelistRevisionError extends Error {
    /** Preserve the established user-visible conflict message across storage backends. */
    constructor() {
        super("Changelists changed. Refresh before retrying.");
    }
}

/** Creates a fresh worktree with one active list and independent empty list and All drafts. */
function emptyState(): ChangelistState {
    return {
        revision: 0,
        activeId: DEFAULT_CHANGELIST_ID,
        lists: [{ id: DEFAULT_CHANGELIST_ID, name: "Changes", description: "", draft: "" }],
        allDraft: "",
        files: Object.create(null) as Record<string, string>,
        changes: Object.create(null) as Record<string, ChangeOwnership>,
    };
}

/** Normalizes list names before comparison and rejects empty, oversized, or control-bearing text. */
function nameFor(value: string): string {
    const name = value.normalize("NFC").trim();
    if (!name || name.length > 80 || /[\u0000-\u001f]/.test(name)) {
        throw new Error("A changelist name must contain 1 to 80 printable characters.");
    }
    return name;
}

/** A stable validator identity permits reuse of already-validated authoritative schema-4 state. */
function parseDurableState(value: unknown): ChangelistState | undefined {
    return parseState(value, 2, false);
}

/** Legacy validation is isolated from compact schema-4 parsing. */
function parseLegacyState(value: unknown): HydratedChangelistState | undefined {
    return parseState(value, 2, true);
}

/** Serialized, revisioned worktree metadata shared by docked and undocked providers. */
export class ChangelistStore {
    private readonly roots = new Map<string, ChangelistState>();
    private writes = Promise.resolve();
    private readonly listeners = new Set<(root: string, state: ChangelistState) => void>();
    private loadError?: string;
    private migrationSource?: unknown;
    private readonly commitLeases = new Map<string, string>();
    private readonly mirrorScopes = new Map<string, string>();
    private readonly durable = new Map<string, ChangelistPersistence>();
    private requiresConnection = false;
    private readonly seeds = new Map<string, HydratedChangelistState>();
    private readonly hydratedReferences = new WeakMap<RangeSnapshot, RangeSnapshotReference>();
    private readonly evidence = new Map<string, Map<string, RangeSnapshot>>();

    /** Reuses the workspace store so independent panels cannot overwrite each other's lists. */
    static forStorage(storage?: MetadataStorage): ChangelistStore {
        if (!storage) return new ChangelistStore();
        const previous = instances.get(storage);
        if (previous) return previous;
        const store = new ChangelistStore(storage);
        instances.set(storage, store);
        return store;
    }

    /** Loads only bounded, well-formed metadata; corrupt records never redirect Git. */
    constructor(private readonly storage?: MetadataStorage) {
        const saved = storage?.get<unknown>(STORAGE_KEY);
        if (saved === undefined) return;
        if (
            !saved ||
            typeof saved !== "object" ||
            !("entries" in saved) ||
            !("schemaVersion" in saved) ||
            ![1, 2, 3, 4].includes(saved.schemaVersion as number)
        ) {
            this.loadError = "Changelist metadata is invalid and will not be overwritten.";
            return;
        }
        const entries = (saved as { entries?: unknown }).entries;
        this.requiresConnection = saved.schemaVersion === 3 || saved.schemaVersion === 4;
        if (!Array.isArray(entries) || entries.length > 128) {
            this.loadError = "Changelist metadata is invalid and will not be overwritten.";
            return;
        }
        for (const value of entries as unknown[]) {
            const entry = metadataRecord(value);
            if (
                !entry ||
                typeof entry.root !== "string" ||
                !entry.state ||
                this.roots.has(entry.root)
            ) {
                this.loadError = "Changelist metadata is invalid and will not be overwritten.";
                return;
            }
            const state = parseState(entry.state, saved.schemaVersion === 1 ? 1 : 2, true);
            if (!state) {
                this.loadError = "Changelist metadata is invalid and will not be overwritten.";
                return;
            }
            if (saved.schemaVersion === 1) {
                const legacyDraft = storage?.get<unknown>(`commitDraft:${entry.root}`);
                if (
                    legacyDraft !== undefined &&
                    (typeof legacyDraft !== "string" || legacyDraft.length > MAX_DRAFT)
                ) {
                    this.loadError = "Changelist draft is invalid and will not be overwritten.";
                    return;
                }
                state.allDraft = typeof legacyDraft === "string" ? legacyDraft : "";
            }
            this.seeds.set(entry.root, state);
            this.roots.set(entry.root, this.compactMemoryState(entry.root, state));
        }
        if (saved.schemaVersion === 1) this.migrationSource = structuredClone(saved);
    }

    /** Native inputs must wait for authoritative hydration after a schema-3 workspace reload. */
    needsConnection(root: string): boolean {
        return this.requiresConnection && !this.durable.has(root);
    }

    /** Returns an independent snapshot without exposing mutable host-owned maps. */
    get(root: string): ChangelistState {
        return structuredClone(this.authoritative(root));
    }

    /** Revision polling validates authoritative metadata without cloning any ownership or evidence. */
    revision(root: string): number {
        return this.authoritative(root).revision;
    }

    /** Borrowed compact state remains private; callers receive independent snapshots through get. */
    private authoritative(root: string): ChangelistState {
        if (this.loadError) throw new Error(this.loadError);
        const persistence = this.durable.get(root);
        if (persistence) {
            const saved = persistence.read(parseDurableState);
            if (!saved) throw new Error("Changelist metadata disappeared and requires review.");
            this.roots.set(root, saved);
        }
        const existing = this.roots.get(root);
        if (existing) return existing;
        const state = emptyState();
        const legacy = this.storage?.get<unknown>(`commitDraft:${root}`);
        if (legacy !== undefined && (typeof legacy !== "string" || legacy.length > MAX_DRAFT))
            throw new Error("Changelist draft is invalid and will not be overwritten.");
        state.allDraft = typeof legacy === "string" ? legacy : "";
        return state;
    }

    /**
     * Migrate under the worktree's metadata lock, retaining the original complete workspace
     * record and a downgrade sentinel. Every later writer reloads the authoritative file.
     */
    async connect(root: string, gitDir: string): Promise<void> {
        const operation = this.writes.then(async () => {
            if (this.durable.has(root)) return;
            const seed = this.seeds.get(root) ?? (await this.hydrateState(root, this.get(root)));
            const persistence = await ChangelistPersistence.open(root, gitDir);
            const release = await persistence.acquire();
            try {
                const legacy = await persistence.readLegacy(parseLegacyState);
                const existing = legacy ? undefined : persistence.read(parseDurableState);
                const existingMatches =
                    !this.roots.has(root) ||
                    persistence.migratedFrom(root, seed) ||
                    (legacy
                        ? isDeepStrictEqual(legacy.state, seed)
                        : existing
                          ? await this.matchesSeed(root, existing, seed, persistence)
                          : true);
                if (!existingMatches) {
                    await persistence.preserveConflict({
                        legacy: this.storage?.get(STORAGE_KEY),
                        root,
                        state: seed,
                    });
                    throw new Error("Conflicting changelist migration metadata requires review.");
                }
                if (!existing && !legacy)
                    await persistence.backup({
                        legacy: this.storage?.get(STORAGE_KEY),
                        root,
                        state: seed,
                    });
                if (legacy) await persistence.backupLegacy(legacy.bytes);
                const state =
                    existing ?? (await this.compactState(root, legacy?.state ?? seed, persistence));
                await persistence.validateEvidence(state);
                if (this.migrationSource !== undefined) await this.backupMigration();
                const hasSeed = this.roots.has(root) || (!existing && !legacy);
                await this.publishConnectionSentinel(root, seed, hasSeed);
                this.requiresConnection = true;
                if (!existing) await persistence.write(state);
                await persistence.collect(undefined, state);
                if (hasSeed) this.seeds.set(root, seed);
                this.durable.set(root, persistence);
                this.roots.set(root, state);
                this.evidence.delete(root);
                this.migrationSource = undefined;
            } finally {
                await release();
            }
        });
        this.writes = operation.then(
            () => undefined,
            () => undefined,
        );
        return operation;
    }

    /** Preserves real workspace seeds, omits invented adoption intent, and avoids unchanged sentinel writes. */
    private async publishConnectionSentinel(
        root: string,
        seed: HydratedChangelistState,
        hasSeed: boolean,
    ): Promise<void> {
        const seeds = new Map(this.seeds);
        if (hasSeed && !seeds.has(root)) seeds.set(root, seed);
        // Detached references never enter workspace storage; old clients refuse the new sentinel.
        const sentinel = {
            schemaVersion: 4,
            entries: [...seeds].map(([key, value]) => ({ root: key, state: value })),
        };
        if (JSON.stringify(this.storage?.get(STORAGE_KEY)) !== JSON.stringify(sentinel))
            await this.storage?.update(STORAGE_KEY, sentinel);
    }

    /** Browser snapshots omit potentially large host-only range evidence and undo history. */
    view(root: string): ChangelistState {
        const state = this.get(root);
        for (const ownership of Object.values(state.changes)) {
            delete ownership.tracking;
            delete ownership.history;
        }
        return state;
    }

    /** Reconciles one host-captured snapshot atomically with the current active list and revision. */
    track(
        root: string,
        file: string,
        snapshot: RangeSnapshot,
        revision?: number,
    ): Promise<ChangelistState> {
        const safe = assertRepoRelativePath(file);
        return this.write(root, revision, async (state) => {
            const fallback = state.files[safe] ?? state.activeId;
            state.files[safe] = fallback;
            const previous = await this.hydrate(root, safe, state.changes[safe]);
            state.changes[safe] = await this.compact(
                root,
                safe,
                reconcileRanges(previous, snapshot, fallback, state.activeId),
            );
        });
    }

    /** Failed lifecycle reads retain evidence and prevent implicit whole-file commits. */
    requireReview(root: string, file: string, unknown = false): Promise<ChangelistState> {
        const safe = assertRepoRelativePath(file);
        return this.write(root, undefined, (state) => {
            const previous = state.changes[safe];
            if (previous || unknown)
                state.changes[safe] = {
                    ...(previous ?? { contentId: "", lines: {} }),
                    stale: true,
                };
        });
    }

    /** Subscriptions report metadata changes only, never Git or filesystem mutations. */
    subscribe(listener: (root: string, state: ChangelistState) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /** Reserves metadata after pending writes, preventing membership changes during a commit. */
    async beginCommit(root: string): Promise<() => Promise<void>> {
        const operation = this.writes.then(async () => {
            if (this.commitLeases.has(root))
                throw new Error("A selected commit is already in progress.");
            const release = await this.durable.get(root)?.acquire();
            let state: ChangelistState;
            try {
                state = this.get(root);
            } catch (error) {
                await release?.();
                throw error;
            }
            const token = randomUUID();
            this.commitLeases.set(root, token);
            this.notify(root, state);
            return async () => {
                if (this.commitLeases.get(root) !== token) return;
                this.commitLeases.delete(root);
                await release?.();
                this.notify(root, this.get(root));
            };
        });
        this.writes = operation.then(
            () => undefined,
            () => undefined,
        );
        return operation;
    }

    /** Shared providers expose the same root's semantic commit fence. */
    isCommitting(root: string): boolean {
        return this.commitLeases.has(root);
    }

    /** Assigns new files and prunes consumed records, retaining clean history for stash/undo restoration. */
    async reconcileFiles(root: string, paths: readonly string[]): Promise<ChangelistState> {
        if (paths.length > MAX_FILES) throw new Error("Too many changelist files.");
        const safe = [...new Set(paths.map(assertRepoRelativePath))];
        if (safe.length > MAX_FILES) throw new Error("Too many changelist files.");
        return this.write(
            root,
            undefined,
            (state) => {
                const current = new Set(safe);
                for (const file of Object.keys(state.files)) {
                    const change = state.changes[file];
                    const consumed =
                        change &&
                        !change.stale &&
                        change.totalChanges === 0 &&
                        Object.keys(change.lines).length === 0 &&
                        Object.keys(change.selections ?? {}).length === 0 &&
                        !change.history?.some(
                            ({ snapshot }) =>
                                snapshot.baseHash === change.tracking?.baseHash &&
                                snapshot.anchorCount > 0,
                        );
                    if (!current.has(file) && (!change || consumed)) {
                        delete state.files[file];
                        delete state.changes[file];
                    }
                }
                for (const file of safe) {
                    if (!Object.hasOwn(state.files, file)) state.files[file] = state.activeId;
                }
            },
            false,
        );
    }

    /** Creates a named list under revision compare-and-swap. */
    create(
        root: string,
        revision: number,
        name: string,
        description = "",
        makeActive = false,
        movePaths: readonly string[] = [],
    ): Promise<ChangelistState> {
        return this.write(root, revision, (state) => {
            if (state.lists.length >= MAX_LISTS) throw new Error("Too many changelists.");
            const accepted = nameFor(name);
            if (
                state.lists.some(
                    (list) => list.name.normalize("NFC").toLowerCase() === accepted.toLowerCase(),
                )
            ) {
                throw new Error("A changelist with this name already exists.");
            }
            const id = randomUUID();
            state.lists.push({
                id,
                name: accepted,
                description: descriptionFor(description),
                draft: "",
            });
            moveWholeFiles(state, id, movePaths);
            if (makeActive) state.activeId = id;
        });
    }

    /** Renames any list without changing its stable identity or saved intent. */
    rename(root: string, revision: number, id: string, name: string): Promise<ChangelistState> {
        return this.write(root, revision, (state) => {
            const list = requireList(state, id);
            const accepted = nameFor(name);
            if (
                state.lists.some(
                    (item) =>
                        item.id !== id &&
                        item.name.normalize("NFC").toLowerCase() === accepted.toLowerCase(),
                )
            ) {
                throw new Error("A changelist with this name already exists.");
            }
            list.name = accepted;
        });
    }

    /** Changes where subsequently discovered files are assigned, not Git's index. */
    activate(root: string, revision: number, id: string): Promise<ChangelistState> {
        return this.write(root, revision, (state) => {
            requireList(state, id);
            state.activeId = id;
        });
    }

    /** Moves only whole files atomically, preserving every saved inclusion and partial owner. */
    moveFiles(
        root: string,
        revision: number,
        id: string,
        paths: readonly string[],
    ): Promise<ChangelistState> {
        return this.write(root, revision, (state) => {
            requireList(state, id);
            moveWholeFiles(state, id, paths);
        });
    }

    /** Edits description and name atomically; cancellation belongs to the host before this call. */
    edit(
        root: string,
        revision: number,
        id: string,
        name: string,
        description: string,
    ): Promise<ChangelistState> {
        return this.write(root, revision, (state) => {
            const list = requireList(state, id);
            const accepted = nameFor(name);
            if (
                state.lists.some(
                    (item) =>
                        item.id !== id &&
                        item.name.normalize("NFC").toLowerCase() === accepted.toLowerCase(),
                )
            )
                throw new Error("A changelist with this name already exists.");
            list.name = accepted;
            list.description = descriptionFor(description);
        });
    }

    /** Reads one exact scope; a removed ID never falls back to All or the active list. */
    draft(root: string, scope: string): string {
        const state = this.get(root);
        return scope === "all" ? (state.allDraft ?? "") : (requireList(state, scope).draft ?? "");
    }

    /** The last focused composer owns the native SCM mirror; selection never activates a list. */
    selectDraft(root: string, scope: string): void {
        this.draft(root, scope);
        this.mirrorScopes.set(root, scope);
    }

    /** Removed mirror scopes follow their destination; delayed writes still carry the original ID. */
    mirrorScope(root: string): string {
        const scope = this.mirrorScopes.get(root) ?? "all";
        return scope === "all" || this.get(root).lists.some((list) => list.id === scope)
            ? scope
            : (this.get(root).removedScopes?.[scope] ?? "all");
    }

    /** Clears only the exact successfully committed draft while the host owns the commit lease. */
    clearCommittedDraft(root: string, scope: string, expected: string): Promise<ChangelistState> {
        return this.write(
            root,
            undefined,
            (state) => {
                const list = scope === "all" ? undefined : requireList(state, scope);
                if (list) {
                    if ((list.draft ?? "").trim() === expected.trim()) list.draft = "";
                } else if ((state.allDraft ?? "").trim() === expected.trim()) state.allDraft = "";
            },
            false,
        );
    }

    /** Compare-and-swap prevents a delayed pane, native edit or AI result overwriting newer text. */
    saveDraft(
        root: string,
        scope: string,
        expected: string | undefined,
        text: string,
    ): Promise<ChangelistState> {
        if (text.length > MAX_DRAFT)
            return Promise.reject(new Error("The commit draft is too long."));
        return this.write(root, undefined, (state) => {
            const list = scope === "all" ? undefined : requireList(state, scope);
            const previous = list ? (list.draft ?? "") : (state.allDraft ?? "");
            if (expected !== undefined && previous !== expected)
                throw new Error(
                    "The commit draft changed. Review the latest text before retrying.",
                );
            if (list) list.draft = text;
            else state.allDraft = text;
        });
    }

    /** Removes metadata only, remapping every owner and fencing ambiguous inclusion atomically. */
    remove(
        root: string,
        revision: number,
        id: string,
        targetId?: string,
        draftChoice?: "source" | "target" | "append",
    ): Promise<ChangelistState> {
        return this.write(root, revision, (state) => {
            const source = requireList(state, id);
            const survivors = state.lists.filter((list) => list.id !== id);
            if (targetId === id) throw new Error("Choose a surviving destination changelist.");
            let target = targetId
                ? survivors.find((list) => list.id === targetId)
                : (survivors.find((list) => list.id === state.activeId) ?? survivors[0]);
            if (targetId && !target)
                throw new Error("The destination changelist no longer exists.");
            if (!target) {
                // Never reuse the removed ID: stale panes must fail, including after deleting the last list.
                target = { id: randomUUID(), name: "Changes", description: "", draft: "" };
                survivors.push(target);
            }
            const incoming = source.draft ?? "";
            const existing = target.draft ?? "";
            if (incoming && existing && !draftChoice)
                throw new Error(
                    "Choose which commit draft to keep or append before removing the list.",
                );
            if (!existing || draftChoice === "source") target.draft = incoming;
            else if (draftChoice === "append" && incoming)
                target.draft = `${existing}\n\n${incoming}`;
            if ((target.draft?.length ?? 0) > MAX_DRAFT)
                throw new Error("The combined commit draft is too long.");
            for (const [file, ownership] of Object.entries(state.changes)) {
                mergeScopeSelection(ownership, state.files[file], id, target.id);
                remapOwners(ownership, id, target.id);
            }
            for (const file of Object.keys(state.files)) {
                if (state.files[file] === id) state.files[file] = target.id;
            }
            redirectRemovedScope(state, id, target.id);
            state.lists = survivors;
            if (state.activeId === id) state.activeId = target.id;
        });
    }

    /** Pins line ownership to a content identity and marks changed assignments for review. */
    registerChanges(
        root: string,
        file: string,
        contentId: string,
        totalChanges?: number,
    ): Promise<ChangelistState> {
        const safe = assertRepoRelativePath(file);
        return this.write(
            root,
            undefined,
            (state) => {
                if (!Object.hasOwn(state.files, safe)) state.files[safe] = state.activeId;
                const previous = state.changes[safe];
                if (!previous) state.changes[safe] = { contentId, lines: {}, totalChanges };
                else if (previous.contentId !== contentId) {
                    state.changes[safe] = {
                        ...previous,
                        contentId,
                        stale: Object.keys(previous.lines).length > 0,
                        totalChanges,
                    };
                }
            },
            false,
        );
    }

    /** Explicitly reviewed line assignments replace the current snapshot's metadata only. */
    assignChanges(
        root: string,
        revision: number,
        file: string,
        contentId: string,
        id: string,
        fingerprints: readonly string[],
        validFingerprints: ReadonlySet<string>,
    ): Promise<ChangelistState> {
        const safe = assertRepoRelativePath(file);
        return this.write(root, revision, (state) => {
            requireList(state, id);
            const ownership = state.changes[safe];
            if (!ownership || ownership.contentId !== contentId)
                throw new Error("The change snapshot is stale.");
            if (ownership.stale && new Set(fingerprints).size !== validFingerprints.size) {
                throw new Error(
                    "Review all current changes before replacing outdated assignments.",
                );
            }
            const lines = ownership.stale ? {} : { ...ownership.lines };
            for (const fingerprint of fingerprints) {
                if (!validFingerprints.has(fingerprint))
                    throw new Error("Unknown change assignment.");
                lines[fingerprint] = id;
            }
            state.changes[safe] = { ...ownership, contentId, lines, stale: false };
        });
    }

    /** Records explicit commit inclusion separately from list membership or the Git index. */
    recordSelection(
        root: string,
        file: string,
        contentId: string,
        scope: string,
        lineIds: readonly string[],
        total: number,
    ): Promise<ChangelistState> {
        return this.writeSelection(root, file, contentId, scope, lineIds, total);
    }

    /** Persists staging inclusion under the same root lease used by explicit commits. */
    prepareStageInclusion(
        root: string,
        revision: number,
        scope: string,
        file: CommitInclusion,
    ): Promise<ChangelistState> {
        return this.writeSelection(
            root,
            file.path,
            file.contentId,
            scope,
            file.lineIds,
            file.total,
            revision,
        );
    }

    private writeSelection(
        root: string,
        file: string,
        contentId: string,
        scope: string,
        lineIds: readonly string[],
        total: number,
        leaseRevision?: number,
    ): Promise<ChangelistState> {
        const safe = assertRepoRelativePath(file);
        if (lineIds.length > 100_000 || !Number.isSafeInteger(total) || total < lineIds.length) {
            throw new Error("Invalid partial commit selection.");
        }
        return this.write(
            root,
            leaseRevision,
            (state) => {
                if (leaseRevision !== undefined && !this.commitLeases.has(root))
                    throw new Error("A selected commit lease is required.");
                if (scope !== "all") requireList(state, scope);
                const previous = state.changes[safe] ?? { contentId, lines: {} };
                state.changes[safe] = {
                    ...previous,
                    selections: {
                        ...previous.selections,
                        [scope]: { contentId, lineIds: [...lineIds], total },
                    },
                };
            },
            leaseRevision === undefined,
        );
    }

    /** The explicit whole-file action removes only the current view's partial inclusion. */
    resetSelection(
        root: string,
        revision: number,
        scope: string,
        paths: readonly string[],
    ): Promise<ChangelistState> {
        if (paths.length > MAX_FILES) throw new Error("Too many changelist files.");
        return this.write(root, revision, (state) => {
            if (scope !== "all") requireList(state, scope);
            for (const file of paths.map(assertRepoRelativePath)) {
                const selections = state.changes[file]?.selections;
                if (selections) delete selections[scope];
            }
        });
    }

    /** Persists exclusion fences before Git can publish, including the whole-file All view. */
    prepareCommitInclusion(
        root: string,
        revision: number,
        scope: string,
        files: readonly CommitInclusion[],
    ): Promise<ChangelistState> {
        if (!files.length || files.length > 64) throw new Error("Invalid selected commit files.");
        return this.write(
            root,
            revision,
            (state) => {
                if (!this.commitLeases.has(root))
                    throw new Error("A selected commit lease is required.");
                if (scope !== "all") requireList(state, scope);
                for (const file of files) {
                    const safe = assertRepoRelativePath(file.path);
                    if (
                        !Number.isSafeInteger(file.total) ||
                        file.total > 100_000 ||
                        file.lineIds.length === 0 ||
                        file.lineIds.length > file.total ||
                        new Set(file.lineIds).size !== file.lineIds.length
                    ) {
                        throw new Error("Invalid selected commit inclusion.");
                    }
                    const previous = state.changes[safe] ?? {
                        contentId: file.contentId,
                        lines: {},
                    };
                    const inclusion = {
                        contentId: file.contentId,
                        lineIds: [...file.lineIds],
                        total: file.total,
                    };
                    state.changes[safe] = {
                        ...previous,
                        selections: { ...previous.selections, all: inclusion, [scope]: inclusion },
                    };
                }
            },
            false,
        );
    }

    /** Rolls back only this attempt's scope fields, retaining unrelated observations and choices. */
    restoreCommitInclusion(
        root: string,
        previous: ChangelistState,
        attempted: ChangelistState,
        scope: string,
        paths: readonly string[],
    ): Promise<ChangelistState> {
        return this.write(
            root,
            undefined,
            (state) => {
                if (!this.commitLeases.has(root))
                    throw new Error("A selected commit lease is required.");
                for (const file of paths.map(assertRepoRelativePath)) {
                    const current = state.changes[file];
                    if (!current?.selections) continue;
                    for (const key of new Set(["all", scope])) {
                        if (
                            JSON.stringify(current.selections[key]) !==
                            JSON.stringify(attempted.changes[file]?.selections?.[key])
                        )
                            continue;
                        const before = previous.changes[file]?.selections?.[key];
                        if (before === undefined) delete current.selections[key];
                        else current.selections[key] = structuredClone(before);
                    }
                    if (Object.keys(current.selections).length === 0) delete current.selections;
                    if (
                        !previous.changes[file] &&
                        !current.selections &&
                        current.contentId === attempted.changes[file]?.contentId &&
                        Object.keys(current.lines).length === 0 &&
                        current.totalChanges === undefined &&
                        current.stale === undefined
                    )
                        delete state.changes[file];
                }
            },
            false,
        );
    }

    /** Serializes host-local mutations, checks revisions and commit leases, and publishes only after durable storage and migration backup succeed. */
    private async write(
        root: string,
        revision: number | undefined,
        mutate: (state: ChangelistState) => void | Promise<void>,
        userMutation = true,
    ): Promise<ChangelistState> {
        const operation = this.writes
            .catch(() => undefined)
            .then(async () => {
                if (userMutation && this.commitLeases.has(root)) {
                    throw new Error("Changelists cannot change during a selected commit.");
                }
                const persistence = this.durable.get(root);
                if (this.requiresConnection && !persistence)
                    throw new Error(
                        "Changelist metadata requires a connected worktree before writing.",
                    );
                const release = this.commitLeases.has(root)
                    ? undefined
                    : await persistence?.acquire();
                try {
                    const before = this.get(root);
                    if (revision !== undefined && revision !== before.revision) {
                        throw new ChangelistRevisionError();
                    }
                    const next = structuredClone(before);
                    next.files = Object.assign(Object.create(null), next.files) as Record<
                        string,
                        string
                    >;
                    next.changes = Object.assign(Object.create(null), next.changes) as Record<
                        string,
                        ChangeOwnership
                    >;
                    await mutate(next);
                    if (
                        JSON.stringify(before) === JSON.stringify(next) &&
                        this.migrationSource === undefined &&
                        this.roots.has(root)
                    )
                        return before;
                    next.revision++;
                    if (persistence) {
                        await persistence.write(next);
                        await persistence.collect(before, next);
                        this.roots.set(root, next);
                        this.notify(root, next);
                        return structuredClone(next);
                    }
                    if (this.storage) {
                        const entries = [];
                        for (const [key, value] of this.roots) {
                            if (key !== root)
                                entries.push({
                                    root: key,
                                    state: await this.hydrateState(key, value),
                                });
                        }
                        const seed = await this.hydrateState(root, next);
                        entries.push({ root, state: seed });
                        if (entries.length > 128)
                            throw new Error("Too many changelist repositories.");
                        if (Buffer.byteLength(JSON.stringify(entries)) > 4 * 1024 * 1024)
                            throw new Error("Changelist metadata exceeds its storage budget.");
                        if (this.migrationSource !== undefined) await this.backupMigration();
                        await this.storage.update(STORAGE_KEY, { schemaVersion: 2, entries });
                        this.seeds.set(root, seed);
                    }
                    this.migrationSource = undefined;
                    this.roots.set(root, next);
                    const live = new Set(
                        Object.values(next.changes).flatMap((ownership) => [
                            ...(ownership.tracking ? [ownership.tracking.blob] : []),
                            ...(ownership.history ?? []).map((entry) => entry.snapshot.blob),
                        ]),
                    );
                    for (const blob of this.evidence.get(root)?.keys() ?? [])
                        if (!live.has(blob)) this.evidence.get(root)!.delete(blob);
                    this.notify(root, next);
                    return structuredClone(next);
                } finally {
                    await release?.();
                }
            });
        this.writes = operation.then(
            () => undefined,
            () => undefined,
        );
        return operation;
    }

    /** A pre-existing backup must describe this migration; never replace unrelated recovery evidence. */
    private async backupMigration(): Promise<void> {
        const backup = this.storage?.get(BACKUP_KEY);
        if (backup !== undefined && JSON.stringify(backup) !== JSON.stringify(this.migrationSource))
            throw new Error("A different changelist migration backup requires review.");
        if (backup === undefined) await this.storage?.update(BACKUP_KEY, this.migrationSource);
    }

    /** Only known committed identities are consumed; unmatched remaining groups require review. */
    consumeCommitted(
        root: string,
        file: string,
        contentId: string,
        scope: string,
        committed: ReadonlySet<string>,
        available: ReadonlySet<string>,
        total: number,
        snapshot?: RangeSnapshot,
    ): Promise<ChangelistState> {
        const safe = assertRepoRelativePath(file);
        return this.write(
            root,
            undefined,
            async (state) => {
                const previous = snapshot
                    ? await this.compact(
                          root,
                          safe,
                          reconcileRanges(
                              await this.hydrate(root, safe, state.changes[safe]),
                              snapshot,
                              state.files[safe] ?? state.activeId,
                              state.activeId,
                          ),
                      )
                    : (state.changes[safe] ?? { contentId, lines: {} });
                const lines = Object.fromEntries(
                    Object.entries(previous.lines).filter(([id]) => snapshot || !committed.has(id)),
                );
                state.changes[safe] = {
                    ...previous,
                    contentId,
                    lines,
                    stale:
                        (snapshot && previous.stale) ||
                        Object.keys(lines).some((id) => !available.has(id)),
                    totalChanges: total,
                    selections: {
                        ...previous.selections,
                        all: { contentId, lineIds: [], total },
                        [scope]: { contentId, lineIds: [], total },
                    },
                };
            },
            false,
        );
    }

    /** Keeps detached evidence private and independently owned until a canonical worktree is connected. */
    private remember(root: string, file: string, snapshot: RangeSnapshot): RangeSnapshotReference {
        if (!validSnapshot(snapshot)) throw new ChangelistEvidenceError();
        const blob = changeFingerprint(JSON.stringify([root, file, snapshot]));
        let snapshots = this.evidence.get(root);
        if (!snapshots) this.evidence.set(root, (snapshots = new Map<string, RangeSnapshot>()));
        if (!snapshots.has(blob)) snapshots.set(blob, structuredClone(snapshot));
        return snapshotReference(snapshot, blob);
    }

    /** Constructor conversion is synchronous; only validated legacy snapshots reach this path. */
    private compactMemoryState(root: string, state: HydratedChangelistState): ChangelistState {
        return {
            ...state,
            changes: Object.fromEntries(
                Object.entries(state.changes).map(([file, ownership]) => {
                    const { tracking, history, ...metadata } = ownership;
                    return [
                        file,
                        {
                            ...metadata,
                            ...(tracking ? { tracking: this.remember(root, file, tracking) } : {}),
                            ...(history
                                ? {
                                      history: history.map((entry) => ({
                                          snapshot: this.remember(root, file, entry.snapshot),
                                          lines: entry.lines,
                                      })),
                                  }
                                : {}),
                        },
                    ];
                }),
            ),
        };
    }

    /** Hydrates just one file and each distinct snapshot once while the caller holds its metadata lease. */
    private async hydrate(
        root: string,
        file: string,
        ownership: ChangeOwnership | undefined,
        persistence = this.durable.get(root),
    ): Promise<HydratedChangeOwnership | undefined> {
        if (!ownership) return undefined;
        const cache = new Map<string, Promise<RangeSnapshot>>();
        const load = async (reference: RangeSnapshotReference): Promise<RangeSnapshot> => {
            let pending = cache.get(reference.blob);
            if (!pending) {
                pending = (async () => {
                    const snapshot = persistence
                        ? await persistence.loadSnapshot(file, reference)
                        : this.evidence.get(root)?.get(reference.blob);
                    if (!snapshot) throw new ChangelistEvidenceError();
                    const value = persistence ? snapshot : structuredClone(snapshot);
                    if (persistence) this.hydratedReferences.set(value, reference);
                    return value;
                })();
                cache.set(reference.blob, pending);
            }
            const value = await pending;
            const expected = snapshotReference(value, reference.blob);
            if (
                Object.keys(expected).some(
                    (key) =>
                        expected[key as keyof RangeSnapshotReference] !==
                        reference[key as keyof RangeSnapshotReference],
                )
            )
                throw new ChangelistEvidenceError();
            return value;
        };
        const { tracking, history, ...metadata } = ownership;
        return {
            ...metadata,
            ...(tracking ? { tracking: await load(tracking) } : {}),
            ...(history
                ? {
                      history: await Promise.all(
                          history.map(async (entry) => ({
                              snapshot: await load(entry.snapshot),
                              lines: entry.lines,
                          })),
                      ),
                  }
                : {}),
        };
    }

    /** Replaces complete immutable snapshots with descriptors before any global clone or publication. */
    private async compact(
        root: string,
        file: string,
        ownership: HydratedChangeOwnership,
        persistence = this.durable.get(root),
    ): Promise<ChangeOwnership> {
        const { tracking, history, ...metadata } = ownership;
        const save = (snapshot: RangeSnapshot) => {
            const known = this.hydratedReferences.get(snapshot);
            return (
                known ??
                (persistence
                    ? persistence.storeSnapshot(file, snapshot)
                    : this.remember(root, file, snapshot))
            );
        };
        return {
            ...metadata,
            ...(tracking ? { tracking: await save(tracking) } : {}),
            ...(history
                ? {
                      history: await Promise.all(
                          history.map(async (entry) => ({
                              snapshot: await save(entry.snapshot),
                              lines: entry.lines,
                          })),
                      ),
                  }
                : {}),
        };
    }

    /** Compares an unproved migration seed one file at a time without retaining all durable payloads. */
    private async matchesSeed(
        root: string,
        state: ChangelistState,
        seed: HydratedChangelistState,
        persistence: ChangelistPersistence,
    ): Promise<boolean> {
        const { changes, ...metadata } = state;
        const { changes: original, ...legacy } = seed;
        if (
            !isDeepStrictEqual(
                { ...metadata, files: { ...metadata.files } },
                { ...legacy, files: { ...legacy.files } },
            ) ||
            Object.keys(changes).length !== Object.keys(original).length
        )
            return false;
        for (const [file, ownership] of Object.entries(changes)) {
            if (
                !Object.hasOwn(original, file) ||
                !isDeepStrictEqual(
                    await this.hydrate(root, file, ownership, persistence),
                    original[file],
                )
            )
                return false;
        }
        return true;
    }

    /** Whole-state hydration is restricted to connection and legacy workspace serialization. */
    private async hydrateState(
        root: string,
        state: ChangelistState,
        persistence = this.durable.get(root),
    ): Promise<HydratedChangelistState> {
        const changes = Object.create(null) as Record<string, HydratedChangeOwnership>;
        for (const [file, ownership] of Object.entries(state.changes))
            changes[file] = (await this.hydrate(root, file, ownership, persistence))!;
        return { ...state, changes };
    }

    /** Migration converts each file once without changing logical revisions, history order or owners. */
    private async compactState(
        root: string,
        state: HydratedChangelistState,
        persistence: ChangelistPersistence,
    ): Promise<ChangelistState> {
        const changes = Object.create(null) as Record<string, ChangeOwnership>;
        for (const [file, ownership] of Object.entries(state.changes))
            changes[file] = await this.compact(root, file, ownership, persistence);
        return { ...state, changes };
    }

    private notify(root: string, state: ChangelistState): void {
        for (const listener of this.listeners) {
            try {
                listener(root, structuredClone(state));
            } catch (error) {
                console.error("[IntelliGit] Changelist delivery failed:", error);
            }
        }
    }
}

function requireList(state: ChangelistState, id: string) {
    const list = state.lists.find((entry) => entry.id === id);
    if (!list) throw new Error("The changelist no longer exists.");
    return list;
}

/** Removed IDs cannot survive in current ownership or bounded undo/redo evidence. */
function remapOwners(ownership: ChangeOwnership, from: string, to: string): void {
    for (const lines of [
        ownership.lines,
        ...(ownership.history ?? []).map((entry) => entry.lines),
    ]) {
        for (const fingerprint of Object.keys(lines)) {
            if (lines[fingerprint] === from) lines[fingerprint] = to;
        }
    }
}

/** Validates persisted ownership and scope identities before cloning them; v1 gains empty draft fields without changing inclusion or IDs. */
function parseState(
    value: unknown,
    version: 1 | 2,
    inline: true,
): HydratedChangelistState | undefined;
function parseState(value: unknown, version: 1 | 2, inline: false): ChangelistState | undefined;
function parseState(
    value: unknown,
    version: 1 | 2,
    inline: boolean,
): ChangelistState | HydratedChangelistState | undefined {
    if (!metadataRecord(value)) return undefined;
    const state = value as ChangelistState | HydratedChangelistState;
    if (!validStateHeader(state)) return undefined;
    try {
        const ids = new Set<string>();
        for (const list of state.lists) {
            if (
                typeof list.id !== "string" ||
                typeof list.name !== "string" ||
                (list.id !== DEFAULT_CHANGELIST_ID && !/^[a-f0-9-]{36}$/.test(list.id))
            )
                return undefined;
            nameFor(list.name);
            if (!validListText(list.description, list.draft, version)) return undefined;
            if (ids.has(list.id)) return undefined;
            ids.add(list.id);
        }
        if (!ids.has(state.activeId)) return undefined;
        if (version === 1 && !ids.has(DEFAULT_CHANGELIST_ID)) return undefined;
        if (
            version === 2 &&
            (typeof state.allDraft !== "string" || state.allDraft.length > MAX_DRAFT)
        )
            return undefined;
        if (!validRedirects(state.removedScopes, ids)) return undefined;
        if (Object.keys(state.files).length > MAX_FILES) return undefined;
        for (const [file, id] of Object.entries(state.files)) {
            assertRepoRelativePath(file);
            if (!ids.has(id)) return undefined;
        }
        const changes: Record<string, ChangeOwnership | HydratedChangeOwnership> = state.changes;
        for (const [file, ownership] of Object.entries(changes)) {
            assertRepoRelativePath(file);
            if (!validOwnership(ownership, ids, inline)) return undefined;
        }
        const parsed = structuredClone(state);
        if (version === 1) {
            parsed.lists = parsed.lists.map((list) => ({ ...list, description: "", draft: "" }));
            parsed.allDraft = "";
        }
        return parsed;
    } catch {
        return undefined;
    }
}

function metadataRecord(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

/** Rejects unbounded lists, invalid revisions, and non-record ownership maps before reading nested persisted values. */
function validStateHeader(state: ChangelistState | HydratedChangelistState): boolean {
    return (
        Number.isSafeInteger(state.revision) &&
        state.revision >= 0 &&
        Array.isArray(state.lists) &&
        state.lists.length > 0 &&
        state.lists.length <= MAX_LISTS &&
        metadataRecord(state.files) !== undefined &&
        metadataRecord(state.changes) !== undefined
    );
}

/** Rejects malformed persisted ownership, unknown list references, and invalid inclusion or range metadata. */
function validOwnership(
    ownership: ChangeOwnership | HydratedChangeOwnership,
    ids: ReadonlySet<string>,
    inline: boolean,
): boolean {
    if (
        !metadataRecord(ownership) ||
        typeof ownership.contentId !== "string" ||
        !metadataRecord(ownership.lines) ||
        (ownership.stale !== undefined && typeof ownership.stale !== "boolean")
    )
        return false;
    if (
        ownership.totalChanges !== undefined &&
        (!Number.isSafeInteger(ownership.totalChanges) ||
            ownership.totalChanges < 0 ||
            ownership.totalChanges > 100_000)
    )
        return false;
    for (const [fingerprint, id] of Object.entries(ownership.lines)) {
        if (!/^[a-f0-9]{64}$/.test(fingerprint) || !ids.has(id)) return false;
    }
    return validCommitSelections(ownership, ids) && validRangeMetadata(ownership, ids, inline);
}

/** Accepts bounded, exact-scope inclusion records, including explicit empty selections and stale-review fences. */
function validCommitSelections(
    ownership: ChangeOwnership | HydratedChangeOwnership,
    ids: ReadonlySet<string>,
): boolean {
    if (ownership.selections === undefined) return true;
    if (!metadataRecord(ownership.selections)) return false;
    for (const [scope, selection] of Object.entries(ownership.selections)) {
        if (scope !== "all" && !ids.has(scope)) return false;
        if (
            !metadataRecord(selection) ||
            typeof selection.contentId !== "string" ||
            (selection.reviewRequired !== undefined &&
                typeof selection.reviewRequired !== "boolean") ||
            !Array.isArray(selection.lineIds) ||
            selection.lineIds.length > 100_000 ||
            selection.lineIds.some(
                (id) => typeof id !== "string" || !/^\d{1,5}:\d{1,6}$/.test(id),
            ) ||
            !Number.isSafeInteger(selection.total) ||
            selection.total < selection.lineIds.length ||
            selection.total > 100_000
        )
            return false;
    }
    return true;
}

/** Descriptions are bounded plain text and may contain line breaks. */
function descriptionFor(value: string): string {
    if (value.length > MAX_DESCRIPTION || value.includes("\0"))
        throw new Error("A changelist description must contain at most 4000 characters.");
    return value;
}

/** Preserve exact explicit unions; unknown implicit ranges keep their fence and require review. */
function mergeScopeSelection(
    ownership: ChangeOwnership,
    fallback: string | undefined,
    source: string,
    target: string,
): void {
    const selections = ownership.selections;
    if (!selections) return;
    const incoming = selections[source];
    const existing = selections[target];
    const sourceOwns = fallback === source || Object.values(ownership.lines).includes(source);
    const targetOwns = fallback === target || Object.values(ownership.lines).includes(target);
    if (
        incoming &&
        existing &&
        incoming.contentId === existing.contentId &&
        incoming.total === existing.total &&
        !incoming.reviewRequired &&
        !existing.reviewRequired &&
        incoming.lineIds.length === existing.lineIds.length &&
        incoming.lineIds.every((line) => existing.lineIds.includes(line))
    ) {
        selections[target] = {
            ...existing,
            lineIds: [...new Set([...existing.lineIds, ...incoming.lineIds])],
        };
    } else if (incoming || (sourceOwns && existing)) {
        const preserved = existing ?? incoming;
        selections[target] = {
            ...preserved,
            lineIds: [...preserved.lineIds],
            ...(incoming && !targetOwns && !existing ? {} : { reviewRequired: true }),
        };
    }
    delete selections[source];
}

/** Validate new text fields without inventing content for a corrupt version-2 record. */
function validListText(description: unknown, draft: unknown, version: 1 | 2): boolean {
    if (version === 1) return true;
    if (typeof description !== "string" || typeof draft !== "string" || draft.length > MAX_DRAFT)
        return false;
    descriptionFor(description);
    return true;
}

/** Redirects can only name removed IDs and currently surviving destinations. */
function validRedirects(value: unknown, ids: ReadonlySet<string>): boolean {
    if (value === undefined) return true;
    const entries = metadataRecord(value);
    return (
        !!entries &&
        Object.keys(entries).length <= 100 &&
        Object.entries(entries).every(
            ([from, to]) =>
                (from === DEFAULT_CHANGELIST_ID || /^[a-f0-9-]{36}$/.test(from)) &&
                !ids.has(from) &&
                typeof to === "string" &&
                ids.has(to),
        )
    );
}

/** Creation-with-move and existing-list moves share the same atomic safety checks. */
function moveWholeFiles(state: ChangelistState, id: string, paths: readonly string[]): void {
    if (paths.length > MAX_FILES) throw new Error("Too many changelist files.");
    for (const value of paths) {
        const file = assertRepoRelativePath(value);
        if (!Object.hasOwn(state.files, file)) throw new Error("The file list changed.");
        const ownership = state.changes[file];
        if (
            ownership &&
            (Object.keys(ownership.lines).length || Object.keys(ownership.selections ?? {}).length)
        )
            throw new Error("Move partial selections through their partial editor.");
        state.files[file] = id;
    }
}

/** Keep recent deleted view scopes pointed at surviving lists, including chained deletions. */
function redirectRemovedScope(state: ChangelistState, removed: string, target: string): void {
    const redirects = Object.fromEntries(
        Object.entries(state.removedScopes ?? {})
            .slice(-99)
            .map(([from, to]) => [from, to === removed ? target : to]),
    );
    redirects[removed] = target;
    state.removedScopes = redirects;
}
