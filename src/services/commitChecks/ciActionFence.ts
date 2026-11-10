// Durable action fence. A re-run or cancel is recorded in workspaceState before its
// request is sent, so until a fetched result shows the action took effect no result for
// that commit is kept across restarts; otherwise the pre-action failure could be cached
// again and shown as final. A fence ends only by the provider's evidence rule (stored
// with the fence), a definite failure of the request, or the user's Refresh once the
// fence reads "not seen yet". Nothing deletes a fence by age.

import type {
    CiAction,
    CiActionEvidence,
    CiState,
    CommitCiDetail,
    CommitCiDetailData,
    ProviderId,
} from "../../types";
import type { CiTrace } from "./ciTrace";
import type { CommitChecksProvider } from "./types";

/**
 * Prefix of the per-fence Memento keys. Each fence is its own key, so a write from one
 * window (extension host) can neither drop nor bring back another window's fence:
 * workspaceState has no compare-and-swap, so a shared list would be last-writer-wins.
 */
export const ACTION_FENCE_KEY_PREFIX = "intelligit.ci.actionFence.v1:";

/** After this long without evidence, a fence reads "not seen yet — Refresh" (a design constant). */
export const ACTION_FENCE_NOT_SEEN_MS = 10 * 60 * 1000;

/** The target's state when the user clicked; the evidence rules compare against it. */
interface CiActionFenceBefore {
    readonly attempt?: number;
    readonly state: CiState;
    /** The retried job's id (GitLab job retry). */
    readonly jobId?: string;
    /** The highest job id in the pipeline (GitLab pipeline retry). */
    readonly maxJobId?: string;
    /** The retried job's logical id (GitLab job retry). */
    readonly logicalId?: string;
}

/** One stored fence. */
export interface CiActionFenceRecord {
    readonly repoKey: string;
    readonly hash: string;
    readonly provider: ProviderId;
    readonly action: CiAction;
    /** Run id for `rerunFailed` and `cancel`; job id for `rerunJob`. */
    readonly targetId: string;
    /** The target's run or pipeline id. */
    readonly runId: string;
    /** When the fence was written (epoch ms); the not-seen timer is armed from it. */
    readonly at: number;
    readonly before: CiActionFenceBefore;
    readonly evidence: CiActionEvidence;
}

/** What the caller supplies to start a fence; the store stamps `at`. */
export type CiActionFenceStart = Omit<CiActionFenceRecord, "at">;

/** The part of the fence store the persistent caches read inside their write queue. */
export interface CiActionFenceView {
    /** True while any fence exists for the commit, in any repository. */
    isFenced(hash: string): boolean;
}

/** Minimal workspaceState shape the store uses. */
export interface CiActionFenceState {
    get<T>(key: string): T | undefined;
    keys(): readonly string[];
    update(key: string, value: unknown): Thenable<void> | Promise<void> | void;
}

/** Store tuning. */
export interface CiActionFenceStoreOptions {
    /** Injectable clock for tests. */
    now?: () => number;
    /** Token-free diagnostic trace. */
    trace?: CiTrace;
}

/** Which commit a change event is about. */
export interface CiActionFenceChange {
    readonly repoKey: string;
    readonly hash: string;
}

/**
 * The evidence rule for an action: the provider's declared rule, `cancelled` for a
 * cancel when the provider declares none, else undefined (the re-run must not start).
 *
 * @param provider - The installed provider.
 * @param action - The action about to start.
 */
export function evidenceFor(
    provider: Pick<CommitChecksProvider, "actionEvidence">,
    action: CiAction,
): CiActionEvidence | undefined {
    return provider.actionEvidence?.(action) ?? (action === "cancel" ? "cancelled" : undefined);
}

/**
 * Whether a fetched detail shows the fenced action took effect for its target, by the
 * fence's stored evidence rule. Any other result leaves the fence in place.
 *
 * @param fence - The stored run id, click-time state and evidence rule.
 * @param detail - A freshly fetched detail for the fenced commit.
 */
function showsActionEffect(
    fence: Pick<CiActionFenceRecord, "runId" | "before" | "evidence">,
    detail: CommitCiDetailData,
): boolean {
    const run = detail.runs.find((candidate) => candidate.id === fence.runId);
    if (!run) return false;
    const { before } = fence;
    switch (fence.evidence) {
        case "runAttempt": {
            const attemptRose =
                run.attempt !== undefined &&
                before.attempt !== undefined &&
                run.attempt > before.attempt;
            const restarted =
                run.state !== before.state && (run.state === "queued" || run.state === "running");
            return attemptRose || restarted;
        }
        case "newerJobSameLogicalId":
            return run.jobs.some(
                (job) => job.logicalId === before.logicalId && isNewerId(job.id, before.jobId),
            );
        case "newerJobInPipeline":
            return run.jobs.some((job) => isNewerId(job.id, before.maxJobId));
        case "cancelled":
            return CANCEL_ENDED_STATES.has(run.state);
    }
}

// `cancelled` or complete; `queued`, `running` and `unknown` show neither.
const CANCEL_ENDED_STATES: ReadonlySet<CiState> = new Set<CiState>([
    "cancelled",
    "success",
    "failure",
    "skipped",
    "neutral",
]);

/** Fences for CI write actions, mirrored in memory and stored in workspaceState. */
export class CiActionFenceStore implements CiActionFenceView {
    private fences: readonly CiActionFenceRecord[];
    // Keyed by record, not target: an ended fence's late removal must not touch the timer
    // of a newer fence on the same target.
    private readonly timers = new Map<CiActionFenceRecord, ReturnType<typeof setTimeout>>();
    // Fences whose not-seen timer fired; read with the clock so either one switches the label.
    private readonly notSeenFired = new Set<CiActionFenceRecord>();
    private readonly listeners = new Set<(change: CiActionFenceChange) => void>();
    private readonly endListeners = new Set<(hash: string) => unknown>();
    // Fences whose begin write has not settled: their action is not sent yet, so no
    // fetched detail can show it.
    private readonly unsettled = new Set<CiActionFenceRecord>();
    // Ended fences kept in storage until every cache removed what it stored for the
    // commit, so after a restart they apply again instead of the old result being read.
    private readonly retained = new Set<CiActionFenceRecord>();
    // Fences `fail` is removing from storage; they stay in memory until that write succeeds.
    private readonly removing = new Set<CiActionFenceRecord>();
    private writes: Promise<void> = Promise.resolve();
    private readonly now: () => number;
    private readonly trace?: CiTrace;

    /**
     * Loads the stored fences, so they apply before the first fetch, and arms each
     * not-seen timer from its stored time.
     *
     * @param state - VS Code workspaceState-compatible storage.
     * @param options - Clock and trace overrides.
     */
    constructor(
        private readonly state: CiActionFenceState,
        options: CiActionFenceStoreOptions = {},
    ) {
        this.now = options.now ?? Date.now;
        this.trace = options.trace;
        // A malformed record, or one stored under another fence's key, is dropped; the
        // rest still apply.
        this.fences = state
            .keys()
            .filter((key) => key.startsWith(ACTION_FENCE_KEY_PREFIX))
            .map((key) => [key, state.get<unknown>(key)] as const)
            .filter(([key, value]) => isFenceRecord(value) && storageKey(value) === key)
            .map(([, value]) => value as CiActionFenceRecord);
        for (const fence of this.fences) this.arm(fence);
    }

    /**
     * Writes a fence and waits for the write. It applies in memory at once, so results
     * already in flight are not persisted. A failed write removes it again, also from
     * storage (a write may store and still reject), and rejects: the action must not be
     * sent. A target that already has a fence in the repository rejects at once and keeps
     * that fence: the earlier action must end first, since the evidence of one could end
     * the other's fence. A fence the user's Refresh ended, or `fail` started removing,
     * before its write finished also rejects. None of these rejections needs `fail`.
     *
     * @param start - The target, its click-time state and the provider's evidence rule.
     */
    async begin(start: CiActionFenceStart): Promise<void> {
        const record: CiActionFenceRecord = { ...start, at: this.now() };
        const id = fenceId(record);
        if (this.fences.some((fence) => fenceId(fence) === id)) {
            throw new Error("An earlier action on this target is still waiting.");
        }
        this.fences = [...this.fences, record];
        this.unsettled.add(record);
        this.arm(record);
        try {
            await this.persist(record);
        } catch (error) {
            if (this.fences.includes(record)) {
                this.disarm(record);
                this.fences = this.fences.filter((fence) => fence !== record);
                try {
                    await this.persist(record);
                } catch {
                    // Stored anyway, it reads "not seen yet" after 10 min and Refresh ends it.
                    this.traceFence("failed", record);
                }
            }
            throw error;
        } finally {
            this.unsettled.delete(record);
        }
        // Refresh may end the fence while its write is still pending (it reads "not seen
        // yet" after 10 min), and `fail` may be removing it; with no fence stored, the
        // action must not be sent.
        if (!this.fences.includes(record) || this.removing.has(record)) {
            throw new Error("The action's fence was ended before it was sent.");
        }
        this.traceFence("fenced", record);
    }

    /**
     * Ends a fence after a definite failure of its request (forbidden, another HTTP
     * error, or not sent). The fence stays in memory until its removal is stored, so this
     * window matches what a restart would load; a failed removal write rejects, and a
     * later call retries it.
     *
     * @param repoKey - Repository the action ran in.
     * @param hash - Fenced commit.
     * @param targetId - The action's target id.
     */
    async fail(repoKey: string, hash: string, targetId: string): Promise<void> {
        const id = fenceId({ repoKey, hash, targetId });
        const failed = this.fences.filter((fence) => fenceId(fence) === id);
        if (failed.length === 0) return;
        // The action never ran, so nothing fetched meanwhile predates it: no end event.
        for (const fence of failed) this.removing.add(fence);
        try {
            await Promise.all(failed.map((fence) => this.persist(fence)));
        } catch (error) {
            for (const fence of failed) this.traceFence("failed", fence);
            throw error;
        } finally {
            for (const fence of failed) this.removing.delete(fence);
        }
        for (const fence of failed) this.disarm(fence);
        this.fences = this.fences.filter((fence) => !failed.includes(fence));
    }

    /**
     * Ends every fence of the commit in that repository that the fetched detail shows took
     * effect; another repository's fence for the same commit stays. The fences leave memory
     * before this returns its promise, so a write queued right after sees them gone.
     *
     * @param repoKey - Repository the detail was fetched for.
     * @param hash - The detail's commit.
     * @param detail - A freshly fetched detail.
     * @returns True when at least one fence ended.
     */
    async resolve(repoKey: string, hash: string, detail: CommitCiDetailData): Promise<boolean> {
        const ended = this.fences.filter(
            (fence) =>
                fence.repoKey === repoKey &&
                fence.hash === hash &&
                fence.provider === detail.provider &&
                !this.unsettled.has(fence) &&
                showsActionEffect(fence, detail),
        );
        await this.end(ended);
        return ended.length > 0;
    }

    /**
     * The user's Refresh on a target: ends its fence only once it reads "not seen yet";
     * while it still reads "Waiting…" the fence stays.
     *
     * @param repoKey - Repository the action ran in.
     * @param hash - Fenced commit.
     * @param targetId - The action's target id.
     * @returns True when the fence ended.
     */
    async endByUserRefresh(repoKey: string, hash: string, targetId: string): Promise<boolean> {
        const id = fenceId({ repoKey, hash, targetId });
        const ended = this.fences.filter((fence) => fenceId(fence) === id && this.notSeen(fence));
        await this.end(ended);
        return ended.length > 0;
    }

    /**
     * True while any fence exists for the commit. Repository-blind on purpose: the same
     * SHA in another repository only loses cross-restart caching, never correctness.
     *
     * @param hash - Commit hash.
     */
    isFenced(hash: string): boolean {
        return this.fences.some((fence) => fence.hash === hash);
    }

    /**
     * The newest fence of the commit in the repository, as the served detail carries it.
     *
     * @param repoKey - Repository the detail is served for.
     * @param hash - Commit hash.
     */
    fenceFor(repoKey: string, hash: string): CommitCiDetail["actionFence"] {
        const newest = this.fences
            .filter((fence) => fence.repoKey === repoKey && fence.hash === hash)
            .reduce<CiActionFenceRecord | undefined>(
                (latest, fence) => (latest && latest.at > fence.at ? latest : fence),
                undefined,
            );
        if (!newest) return undefined;
        return { targetId: newest.targetId, action: newest.action, notSeen: this.notSeen(newest) };
    }

    /**
     * Listens for a fence switching to "not seen yet"; the host re-posts the detail with
     * no fetch.
     *
     * @param listener - Called with the fenced commit.
     * @returns A disposable that removes the listener.
     */
    onDidChange(listener: (change: CiActionFenceChange) => void): { dispose(): void } {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
    }

    /**
     * Listens for a commit's fence ending by evidence or the user's Refresh (not by a
     * definite failure). Called synchronously, before the end is stored, so the caches
     * drop what they hold for the commit before any later write. The end is stored only
     * once every promise the listeners return resolves; a rejection keeps the fence
     * stored, so it applies again after a restart.
     *
     * @param listener - Called with the commit whose fence ended; may return the removal
     *   of what a cache stored for it.
     * @returns A disposable that removes the listener.
     */
    onDidEnd(listener: (hash: string) => unknown): { dispose(): void } {
        this.endListeners.add(listener);
        return { dispose: () => this.endListeners.delete(listener) };
    }

    /** Clears every timer and listener; the stored fences stay. */
    dispose(): void {
        for (const timer of this.timers.values()) clearTimeout(timer);
        this.timers.clear();
        this.listeners.clear();
        this.endListeners.clear();
    }

    private notSeen(fence: CiActionFenceRecord): boolean {
        return this.notSeenFired.has(fence) || this.now() - fence.at >= ACTION_FENCE_NOT_SEEN_MS;
    }

    private async end(ended: readonly CiActionFenceRecord[]): Promise<void> {
        if (ended.length === 0) return;
        for (const fence of ended) this.disarm(fence);
        this.fences = this.fences.filter((fence) => !ended.includes(fence));
        for (const fence of ended) this.retained.add(fence);
        const removals = [...new Set(ended.map((fence) => fence.hash))].map(async (hash) => {
            if (!(await this.emitEnd(hash))) return;
            for (const fence of ended) if (fence.hash === hash) this.retained.delete(fence);
        });
        await Promise.all(removals);
        for (const fence of ended) if (this.retained.has(fence)) this.traceFence("failed", fence);
        try {
            await Promise.all(ended.map((fence) => this.persist(fence)));
        } catch {
            // The fence is gone for this window; after a restart it applies again until a
            // fetch shows the action or the user refreshes, which costs caching only.
            for (const fence of ended) this.traceFence("failed", fence);
        }
    }

    // Writes only the key of the fence's target, with this window's value for it when the
    // write runs (writes run in order): the live fence unless it is being removed, else an
    // ended fence still retained, else nothing (the key is removed).
    private persist(target: CiActionFenceRecord): Promise<void> {
        const id = fenceId(target);
        const write = this.writes.then(() => {
            const value =
                this.fences.find((fence) => fenceId(fence) === id && !this.removing.has(fence)) ??
                [...this.retained].find((fence) => fenceId(fence) === id);
            return this.state.update(storageKey(target), value);
        });
        this.writes = write.then(
            () => undefined,
            () => undefined,
        );
        return write;
    }

    private arm(fence: CiActionFenceRecord): void {
        const delay = Math.max(0, fence.at + ACTION_FENCE_NOT_SEEN_MS - this.now());
        const timer = setTimeout(() => {
            this.timers.delete(fence);
            this.notSeenFired.add(fence);
            this.emit(this.listeners, { repoKey: fence.repoKey, hash: fence.hash });
        }, delay);
        this.timers.set(fence, timer);
    }

    private disarm(fence: CiActionFenceRecord): void {
        const timer = this.timers.get(fence);
        if (timer !== undefined) clearTimeout(timer);
        this.timers.delete(fence);
        this.notSeenFired.delete(fence);
    }

    private emit<T>(listeners: ReadonlySet<(value: T) => void>, value: T): void {
        for (const listener of listeners) {
            try {
                listener(value);
            } catch {
                // One listener's failure must not stop the others.
            }
        }
    }

    // Calls every end listener synchronously; true once every removal they return succeeded.
    private async emitEnd(hash: string): Promise<boolean> {
        let threw = false;
        const removals: unknown[] = [];
        for (const listener of this.endListeners) {
            try {
                removals.push(listener(hash));
            } catch {
                threw = true;
            }
        }
        const settled = await Promise.allSettled(removals);
        return !threw && settled.every((result) => result.status === "fulfilled");
    }

    private traceFence(outcome: "fenced" | "failed", fence: CiActionFenceRecord): void {
        this.trace?.({
            kind: "fence",
            outcome,
            repoKey: fence.repoKey,
            provider: fence.provider,
            hash: fence.hash,
            ...(outcome === "failed" && { reason: "storage" as const }),
        });
    }
}

function fenceId(fence: Pick<CiActionFenceRecord, "repoKey" | "hash" | "targetId">): string {
    return `${fence.repoKey}\0${fence.hash}\0${fence.targetId}`;
}

// The fence's own Memento key; one target in one repository has at most one fence.
function storageKey(fence: Pick<CiActionFenceRecord, "repoKey" | "hash" | "targetId">): string {
    return `${ACTION_FENCE_KEY_PREFIX}${encodeURIComponent(fence.repoKey)}/${fence.hash}/${encodeURIComponent(fence.targetId)}`;
}

// Provider job ids are decimal integers; anything else cannot be ordered, so it never
// counts as newer.
function isNewerId(id: string, than: string | undefined): boolean {
    if (than === undefined || !/^\d+$/.test(id) || !/^\d+$/.test(than)) return false;
    return BigInt(id) > BigInt(than);
}

const PROVIDERS: ReadonlySet<string> = new Set<ProviderId>([
    "github",
    "gitlab",
    "bitbucket-cloud",
    "bitbucket-server",
]);
const ACTIONS: ReadonlySet<string> = new Set<CiAction>(["rerunFailed", "rerunJob", "cancel"]);
const EVIDENCE: ReadonlySet<string> = new Set<CiActionEvidence>([
    "runAttempt",
    "newerJobSameLogicalId",
    "newerJobInPipeline",
    "cancelled",
]);
const STATES: ReadonlySet<string> = new Set<CiState>([
    "queued",
    "running",
    "success",
    "failure",
    "cancelled",
    "skipped",
    "neutral",
    "unknown",
]);

function isOptional(value: unknown, type: "string" | "number"): boolean {
    return value === undefined || typeof value === type;
}

function isFenceRecord(value: unknown): value is CiActionFenceRecord {
    if (!value || typeof value !== "object") return false;
    const fence = value as Partial<Record<keyof CiActionFenceRecord, unknown>>;
    const before = fence.before as Partial<Record<keyof CiActionFenceBefore, unknown>> | null;
    return (
        typeof fence.repoKey === "string" &&
        typeof fence.hash === "string" &&
        typeof fence.provider === "string" &&
        PROVIDERS.has(fence.provider) &&
        typeof fence.action === "string" &&
        ACTIONS.has(fence.action) &&
        typeof fence.targetId === "string" &&
        typeof fence.runId === "string" &&
        typeof fence.at === "number" &&
        Number.isFinite(fence.at) &&
        typeof fence.evidence === "string" &&
        EVIDENCE.has(fence.evidence) &&
        !!before &&
        typeof before === "object" &&
        typeof before.state === "string" &&
        STATES.has(before.state) &&
        isOptional(before.attempt, "number") &&
        isOptional(before.jobId, "string") &&
        isOptional(before.maxJobId, "string") &&
        isOptional(before.logicalId, "string")
    );
}
