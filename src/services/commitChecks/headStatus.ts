// Watches the current HEAD's CI: a status bar item with live counts, and one notification
// per commit and machine when its CI finishes. Polling follows K26 (the pending ladder,
// then every 120 s while HEAD is incomplete or fenced); the notification follows K13 (an
// atomic directory claim before the toast, so only one window shows it).

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import type { ProviderCiCapabilities } from "../../shared/ci/capabilities";
import { isCompleteSnapshot, settlementOf, type CiSettlement } from "../../shared/ci/completion";
import { headMonitorDelayMs, HEAD_NONE_CHECK_RETRY_DELAYS_MS } from "../../shared/ci/pollSchedule";
import { ELAPSED_TICK_MS } from "../../shared/ci/timing";
import type {
    CiJob,
    CiRun,
    CommitCheckState,
    CommitChecksSnapshot,
    CommitCiDetail,
} from "../../types";
import type { CiGenerations, CiOperationContext } from "./ciGenerations";
import type { CiTrace } from "./ciTrace";

/** workspaceState key of the pending-observed set (K27). */
export const PENDING_OBSERVED_KEY = "intelligit.ci.pendingObserved.v1";
/** Entries older than this are dropped from the pending-observed set (K27). */
const PENDING_OBSERVED_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Folder under global storage that holds one claim directory per toasted commit (K13). */
export const TOAST_CLAIMS_FOLDER = "ci-toast-claims";
/** Opens the Checks tab for HEAD; the status bar item's command. */
export const SHOW_HEAD_CHECKS_COMMAND = "intelligit.ci.showHeadChecks";
/** Polls HEAD again; the paused status bar item's command. */
export const REFRESH_HEAD_CHECKS_COMMAND = "intelligit.ci.refreshHeadChecks";

const FAILED_STATES: ReadonlySet<CommitCheckState> = new Set([
    "failure",
    "timed_out",
    "action_required",
]);

/** The two settings this phase reads (K5, K6). */
export interface HeadStatusSettings {
    statusBar: boolean;
    notifyOnSettle: boolean;
}

/** The part of a configuration section the settings reader uses. */
export interface HeadStatusConfig {
    /** Reads one key, returning the default when it is unset. */
    get<T>(key: string, defaultValue: T): T;
}

/**
 * Reads K5 and K6. They are not contributed in `package.json` until Phase 18, so the
 * default comes from here, and a value that is not a boolean counts as the default.
 *
 * @param config - The `intelligit` configuration section.
 */
export function readHeadStatusSettings(config: HeadStatusConfig): HeadStatusSettings {
    const flag = (key: string): boolean => {
        const value: unknown = config.get(key, true);
        return typeof value === "boolean" ? value : true;
    };
    return {
        statusBar: flag("commitChecks.statusBar"),
        notifyOnSettle: flag("commitChecks.notifyOnSettle"),
    };
}

/** Job counts the status bar and the notification show. */
export interface HeadStatusCounts {
    failed: number;
    pending: number;
    passed: number;
}

/** The part of a VS Code status bar item this module sets. */
export interface HeadStatusBarItem {
    text: string;
    tooltip: vscode.StatusBarItem["tooltip"];
    command: vscode.StatusBarItem["command"];
    show(): void;
    hide(): void;
    dispose(): void;
}

/** The part of a VS Code Memento this module uses. */
export interface HeadStatusMemento {
    get<T>(key: string): T | undefined;
    update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

type MkdirFn = (target: string, options?: { recursive?: boolean }) => Promise<unknown>;

/** What the status bar shows. */
export type HeadStatusView =
    | { kind: "status"; counts: HeadStatusCounts; summary: string; startedAt?: number }
    | { kind: "paused"; message: string }
    | { kind: "unavailable"; message: string };

/**
 * Formats the status bar text.
 *
 * @param counts - Failed, pending and passed jobs.
 * @param elapsedMs - Time since the earliest incomplete run started; omitted when unknown.
 */
export function formatHeadStatusText(
    counts: HeadStatusCounts,
    elapsedMs: number | undefined,
): string {
    const text = `$(error) ${counts.failed} · $(sync~spin) ${counts.pending} · $(check) ${counts.passed}`;
    return elapsedMs === undefined ? text : `${text} · ${formatElapsed(elapsedMs)}`;
}

function formatElapsed(ms: number): string {
    const total = Math.max(0, Math.floor(ms / 1000));
    const seconds = String(total % 60).padStart(2, "0");
    const minutes = Math.floor(total / 60) % 60;
    const hours = Math.floor(total / 3600);
    return hours > 0
        ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
        : `${minutes}:${seconds}`;
}

function snapshotCounts(snapshot: CommitChecksSnapshot): HeadStatusCounts {
    return {
        failed: snapshot.items.filter((item) => FAILED_STATES.has(item.state)).length,
        pending: snapshot.items.filter((item) => item.state === "pending").length,
        passed: snapshot.items.filter((item) => item.state === "success").length,
    };
}

function detailJobs(detail: CommitCiDetail): { run: CiRun; job: CiJob }[] {
    return detail.runs.flatMap((run) => run.jobs.map((job) => ({ run, job })));
}

function detailCounts(detail: CommitCiDetail): HeadStatusCounts {
    const jobs = detailJobs(detail).map(({ job }) => job.state);
    return {
        failed: jobs.filter((state) => state === "failure").length,
        pending: jobs.filter((state) => state === "queued" || state === "running").length,
        passed: jobs.filter((state) => state === "success").length,
    };
}

/** Earliest start time of the detail's unfinished runs, in epoch ms. */
function earliestIncompleteStart(detail: CommitCiDetail | undefined): number | undefined {
    const starts = (detail?.runs ?? [])
        .filter((run) => run.state === "queued" || run.state === "running")
        .map((run) => (run.startedAt ? Date.parse(run.startedAt) : Number.NaN))
        .filter((value) => Number.isFinite(value));
    return starts.length > 0 ? Math.min(...starts) : undefined;
}

/** The status view of a snapshot's own counts, with the elapsed start time once known. */
function snapshotView(snapshot: CommitChecksSnapshot): (startedAt?: number) => HeadStatusView {
    return (startedAt) => ({
        kind: "status",
        counts: snapshotCounts(snapshot),
        summary: snapshot.summary,
        ...(startedAt !== undefined && { startedAt }),
    });
}

/** Status bar item dependencies. */
export interface HeadStatusBarDeps {
    switchOn(): boolean;
    settings(): HeadStatusSettings;
    createStatusBarItem(): HeadStatusBarItem;
    now?(): number;
}

/** The HEAD status bar item; created on first show, never while the Checks tab switch is off. */
export class HeadStatusBar {
    private item?: HeadStatusBarItem;
    private ticker?: ReturnType<typeof setInterval>;
    private view?: HeadStatusView;

    /**
     * Creates the bar; the item itself is created on first show.
     *
     * @param deps - The switch, the settings and the item factory.
     */
    constructor(private readonly deps: HeadStatusBarDeps) {}

    /** Shows a view, or hides the item when the setting or the switch is off. */
    render(view: HeadStatusView): void {
        // Ships hidden until Phase 18: no item while the Checks tab switch is off.
        if (!this.deps.switchOn()) return this.hide();
        if (!this.deps.settings().statusBar) return this.hide();
        this.view = view;
        this.item ??= this.deps.createStatusBarItem();
        this.paint();
        this.item.show();
        const ticking = view.kind === "status" && view.startedAt !== undefined;
        if (ticking && !this.ticker) {
            this.ticker = setInterval(() => this.paint(), ELAPSED_TICK_MS);
        } else if (!ticking) {
            this.stopTicker();
        }
    }

    /** Hides the item and stops the elapsed-time ticker. */
    hide(): void {
        this.view = undefined;
        this.stopTicker();
        this.item?.hide();
    }

    /** Disposes the item and stops the ticker. */
    dispose(): void {
        this.stopTicker();
        this.item?.dispose();
        this.item = undefined;
    }

    private paint(): void {
        const { item, view } = this;
        if (!item || !view) return;
        if (view.kind === "paused") {
            item.text = `$(debug-pause) ${vscode.l10n.t("CI paused")}`;
            item.tooltip = view.message;
            item.command = REFRESH_HEAD_CHECKS_COMMAND;
            return;
        }
        if (view.kind === "unavailable") {
            item.text = `$(warning) ${vscode.l10n.t("CI unavailable")}`;
            item.tooltip = view.message;
            // No automatic retry: the user refreshes by hand.
            item.command = REFRESH_HEAD_CHECKS_COMMAND;
            return;
        }
        const now = this.deps.now?.() ?? Date.now();
        item.text = formatHeadStatusText(
            view.counts,
            view.startedAt === undefined ? undefined : now - view.startedAt,
        );
        item.tooltip = view.summary;
        item.command = SHOW_HEAD_CHECKS_COMMAND;
    }

    private stopTicker(): void {
        if (this.ticker) clearInterval(this.ticker);
        this.ticker = undefined;
    }
}

interface PendingObservedEntry {
    repoKey: string;
    hash: string;
    observedAt: number;
}

/** The pending-observed set (K27) with serialized writes. */
export class PendingObservedSet {
    private writes: Promise<void> = Promise.resolve();
    // Observed commits whose write has not been stored, with the time seen: a failed write
    // keeps the observation for this session (and its 7-day expiry), so the settle is still announced.
    private readonly unsaved = new Map<string, number>();

    /**
     * Creates the set over a memento.
     *
     * @param state - The workspace memento that holds the set.
     * @param now - The clock entries are dated and aged by.
     */
    constructor(
        private readonly state: HeadStatusMemento,
        private readonly now: () => number = Date.now,
    ) {}

    /** Whether the commit was seen incomplete in the last 7 days. */
    has(repoKey: string, hash: string): boolean {
        const key = `${repoKey}\0${hash}`;
        const observedAt = this.unsaved.get(key);
        if (observedAt !== undefined) {
            if (observedAt >= this.now() - PENDING_OBSERVED_MAX_AGE_MS) return true;
            this.unsaved.delete(key);
        }
        return this.read().some((entry) => entry.repoKey === repoKey && entry.hash === hash);
    }

    /** Adds the commit; resolves once the write is stored, rejects when it fails. */
    async add(repoKey: string, hash: string): Promise<void> {
        if (!this.unsaved.has(`${repoKey}\0${hash}`)) {
            this.unsaved.set(`${repoKey}\0${hash}`, this.now());
        }
        await this.write((entries) =>
            entries.some((entry) => entry.repoKey === repoKey && entry.hash === hash)
                ? entries
                : [...entries, { repoKey, hash, observedAt: this.now() }],
        );
        this.unsaved.delete(`${repoKey}\0${hash}`);
    }

    /** Removes the commit; resolves once the write is stored. */
    remove(repoKey: string, hash: string): Promise<void> {
        this.unsaved.delete(`${repoKey}\0${hash}`);
        return this.write((entries) =>
            entries.filter((entry) => entry.repoKey !== repoKey || entry.hash !== hash),
        );
    }

    private read(): PendingObservedEntry[] {
        const stored = this.state.get<unknown>(PENDING_OBSERVED_KEY);
        const cutoff = this.now() - PENDING_OBSERVED_MAX_AGE_MS;
        return (Array.isArray(stored) ? (stored as unknown[]) : []).filter(
            (entry): entry is PendingObservedEntry => {
                const candidate = entry as Partial<PendingObservedEntry> | null | undefined;
                return (
                    typeof candidate?.repoKey === "string" &&
                    typeof candidate.hash === "string" &&
                    typeof candidate.observedAt === "number" &&
                    candidate.observedAt >= cutoff
                );
            },
        );
    }

    private write(
        change: (entries: PendingObservedEntry[]) => PendingObservedEntry[],
    ): Promise<void> {
        const next = this.writes.then(async () => {
            await this.state.update(PENDING_OBSERVED_KEY, change(this.read()));
        });
        this.writes = next.catch(() => undefined);
        return next;
    }
}

/** A settled HEAD the notification is offered for. */
export interface HeadSettledEvent {
    repoKey: string;
    hash: string;
    ctx: CiOperationContext;
    isCurrent(): boolean;
    capabilities: ProviderCiCapabilities;
    snapshot: CommitChecksSnapshot;
    /** The detail fetched after settlement, when the provider has runs. */
    detail?: CommitCiDetail;
}

/** Notification dependencies. */
export interface HeadSettleToastDeps {
    switchOn(): boolean;
    settings(): HeadStatusSettings;
    workspaceState: HeadStatusMemento;
    /** `<globalStorageUri>/ci-toast-claims`. */
    claimDir: string;
    mkdir?: MkdirFn;
    focused(): boolean;
    showInformationMessage(message: string, ...buttons: string[]): Thenable<string | undefined>;
    openChecks(hash: string): unknown;
    openLog(hash: string, run: CiRun, job: CiJob): unknown;
    rerunFailed(hash: string, runIds: string[], ctx: CiOperationContext): unknown;
    trace?: CiTrace;
    now?(): number;
}

/** The once-per-commit settle notification (K13). */
export class HeadSettleToast {
    readonly pendingObserved: PendingObservedSet;
    // Set before the first await, so one window never claims the same commit twice.
    private readonly running = new Set<string>();
    // Commits with a claim in flight, holding the newest event offered meanwhile.
    private readonly claims = new Map<string, HeadSettledEvent | undefined>();
    // Commits this window claimed but did not show, because the offering poll went stale.
    private readonly claimedUnshown = new Set<string>();

    /**
     * Creates the notification over its pending-observed set.
     *
     * @param deps - Storage, focus, the claim folder and the notification calls.
     */
    constructor(private readonly deps: HeadSettleToastDeps) {
        this.pendingObserved = new PendingObservedSet(
            deps.workspaceState,
            () => deps.now?.() ?? Date.now(),
        );
    }

    /**
     * Claims the commit and shows the notification. An unfocused window keeps the commit
     * in its pending-observed set and gets `"unfocused"`; the monitor calls this again on
     * the next focus. A claim that failed for a storage reason gets `"retry"`: the monitor
     * holds the event for the next focus the same way.
     */
    async settled(event: HeadSettledEvent): Promise<"unfocused" | "retry" | undefined> {
        // Ships hidden until Phase 18: no notification while the Checks tab switch is off.
        if (!this.deps.switchOn()) return undefined;
        const { repoKey, hash } = event;
        const key = `${repoKey}\0${hash}`;
        if (!this.deps.settings().notifyOnSettle) return undefined;
        // A newer poll confirmed the same settlement while the claim runs: the claimant shows it.
        if (this.claims.has(key)) {
            this.claims.set(key, event);
            return undefined;
        }
        if (this.running.has(key)) return undefined;
        if (!this.pendingObserved.has(repoKey, hash) || !event.isCurrent()) return undefined;
        if (!this.deps.focused()) return "unfocused";
        this.running.add(key);
        this.claims.set(key, undefined);
        try {
            if (!this.claimedUnshown.has(key)) {
                const failed = await this.claim(repoKey, hash, key);
                if (failed) return failed === "exists" ? undefined : "retry";
            }
            const owner = [event, this.claims.get(key)].find((candidate) => candidate?.isCurrent());
            if (!owner) {
                // This poll went stale and no newer one has confirmed yet: the claim is kept, and
                // the next poll that confirms the settlement shows the notification.
                this.claimedUnshown.add(key);
                this.running.delete(key);
                return undefined;
            }
            this.claimedUnshown.delete(key);
            this.show(owner);
            await this.pendingObserved.remove(repoKey, hash).catch(() => undefined);
            return undefined;
        } finally {
            this.claims.delete(key);
        }
    }

    /** Takes the claim directory; `"exists"` when another window holds it, `"failed"` on a storage error. */
    private async claim(
        repoKey: string,
        hash: string,
        key: string,
    ): Promise<"exists" | "failed" | undefined> {
        const mkdir = this.deps.mkdir ?? ((target, options) => fs.mkdir(target, options));
        const claim = path.join(this.deps.claimDir, createHash("sha256").update(key).digest("hex"));
        try {
            await mkdir(this.deps.claimDir, { recursive: true });
            await mkdir(claim);
            return undefined;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EEXIST") {
                this.deps.trace?.({ kind: "claim", outcome: "claim-exists", repoKey, hash });
                await this.pendingObserved.remove(repoKey, hash).catch(() => undefined);
                return "exists";
            }
            // The commit stays in the set and the next focus tries again.
            this.running.delete(key);
            this.deps.trace?.({
                kind: "claim",
                outcome: "failed",
                repoKey,
                hash,
                reason: "storage",
            });
            return "failed";
        }
    }

    private show(event: HeadSettledEvent): void {
        const { capabilities, detail, hash, snapshot } = event;
        const counts = detail ? detailCounts(detail) : snapshotCounts(snapshot);
        const failedJobs = detail
            ? detailJobs(detail).filter(({ job }) => job.state === "failure")
            : [];
        const failedRunIds = [...new Set(failedJobs.map(({ run }) => run.id))];
        const openChecks = vscode.l10n.t("Open Checks");
        const openLog = vscode.l10n.t("Open log");
        const rerun = vscode.l10n.t("Re-run failed");
        const buttons = [
            openChecks,
            ...(capabilities.logs && failedJobs.length > 0 ? [openLog] : []),
            ...(capabilities.rerunFailed && failedRunIds.length > 0 ? [rerun] : []),
        ];
        const message = vscode.l10n.t(
            "CI finished for {0}: {1} failed, {2} passed.",
            hash.slice(0, 7),
            counts.failed,
            counts.passed,
        );
        // Not awaited: the promise settles only when the user dismisses the notification.
        // Each button's handler reports its own errors.
        void Promise.resolve(this.deps.showInformationMessage(message, ...buttons))
            .then((choice) => {
                if (choice === openChecks) return this.deps.openChecks(hash);
                if (choice === openLog && failedJobs[0]) {
                    return this.deps.openLog(hash, failedJobs[0].run, failedJobs[0].job);
                }
                if (choice === rerun) return this.deps.rerunFailed(hash, failedRunIds, event.ctx);
                return undefined;
            })
            .catch(() => undefined);
    }
}

/** Snapshot and detail fetch options; `force` skips the caches. */
export interface HeadFetchOptions {
    force?: boolean;
}

/** What one poll carries to the handler of its snapshot. */
interface PollContext {
    run: number;
    hash: string;
    repoKey: string;
    options: HeadFetchOptions;
    ctx: CiOperationContext;
    current: () => boolean;
    capabilities: ProviderCiCapabilities;
}

/** HEAD monitor dependencies. */
export interface HeadCiStatusDeps extends HeadSettleToastDeps, HeadStatusBarDeps {
    /** `intelligit.commitChecks.enabled`. */
    enabled(): boolean;
    repoKey(): string | undefined;
    headHash(): Promise<string | undefined>;
    isUnpushed(hash: string): Promise<boolean>;
    /** The matched provider's capabilities; undefined when no provider matches. */
    capabilities(hash: string): Promise<ProviderCiCapabilities | undefined>;
    snapshot(hash: string, options: HeadFetchOptions): Promise<CommitChecksSnapshot>;
    detail(
        hash: string,
        options: HeadFetchOptions,
        ctx: CiOperationContext,
    ): Promise<CommitCiDetail | undefined>;
    /** Drops the cached and in-flight detail of the commit, never its snapshot. */
    invalidateDetail(hash: string): Promise<void>;
    /** End of the request cooldown of the provider serving `hash`, in epoch ms; 0 or past when none. */
    cooldownUntil(hash: string): number | Promise<number>;
    isFenced(hash: string): boolean;
    generations: CiGenerations;
}

/** The HEAD monitor (§10): one per active repository. */
export class HeadCiStatus {
    private readonly bar: HeadStatusBar;
    private readonly toast: HeadSettleToast;
    private head?: string;
    private headRepoKey?: string;
    private attempt = 0;
    private noneAttempt = 0;
    private timer?: ReturnType<typeof setTimeout>;
    // Bumped on every HEAD change, restart and dispose; a poll from an older run is dropped.
    private run = 0;
    // Bumped on every HEAD lookup; a lookup that a newer one overtook is dropped.
    private lookup = 0;
    // Bumped on every poll; only the newest poll may write or schedule.
    private pollSequence = 0;
    private detailSequence = 0;
    // A settlement detail came back `unknown`: every later complete poll fetches it again.
    private lastUnknown = false;
    private awaitingFocus?: HeadSettledEvent;
    private latestOffer?: HeadSettledEvent;
    private disposed = false;

    /**
     * Creates the monitor; nothing is fetched until the first repository-change signal.
     *
     * @param deps - Everything the monitor reads, fetches and shows.
     */
    constructor(private readonly deps: HeadCiStatusDeps) {
        this.bar = new HeadStatusBar(deps);
        this.toast = new HeadSettleToast(deps);
    }

    /** The repository-change signal: restarts the schedule when HEAD moved. */
    async onRepositoryChanged(): Promise<void> {
        // Ships hidden until Phase 18: no timer and no request while the switch is off.
        if (!this.deps.switchOn() || this.disposed) return;
        const lookup = ++this.lookup;
        const head = await this.deps.headHash();
        // A newer lookup or a dispose during the wait owns the schedule now.
        if (lookup !== this.lookup || this.disposed) return;
        // Worktrees of one repository can share a HEAD commit, so the repository counts too.
        if (head !== undefined && head === this.head && this.deps.repoKey() === this.headRepoKey) {
            return;
        }
        await this.start(head);
    }

    /** Settings, sign-in or provider changes: starts over on the current HEAD. */
    async restart(): Promise<void> {
        if (!this.deps.switchOn() || this.disposed) return;
        const lookup = ++this.lookup;
        const head = await this.deps.headHash();
        if (lookup !== this.lookup || this.disposed) return;
        await this.start(head);
    }

    /** `onDidChangeWindowState` with `focused: true`: offers a held notification again. */
    async onWindowFocused(): Promise<void> {
        if (!this.deps.switchOn() || this.disposed) return;
        const event = this.awaitingFocus;
        if (!event || !event.isCurrent()) return;
        this.awaitingFocus = undefined;
        await this.offerToast(event);
    }

    /** `intelligit.ci.showHeadChecks`: opens the Checks tab for HEAD. */
    async showHeadChecks(): Promise<void> {
        if (!this.deps.switchOn()) return;
        const head = await this.deps.headHash();
        if (head) await this.deps.openChecks(head);
    }

    /** `intelligit.ci.refreshHeadChecks`: polls now unless the cooldown still runs. */
    async refresh(): Promise<void> {
        const hash = this.head;
        if (!this.deps.switchOn() || this.disposed || !hash) return;
        const until = await this.cooldownEnd(hash);
        if (until > this.now() || this.disposed || hash !== this.head) return;
        this.clearTimer();
        await this.poll(this.run, { force: true });
    }

    /** True while a poll is scheduled. */
    isPolling(): boolean {
        return this.timer !== undefined;
    }

    /** Stops polling, drops any late result and disposes the status bar item. */
    dispose(): void {
        this.disposed = true;
        this.run += 1;
        this.clearTimer();
        this.bar.dispose();
    }

    private now(): number {
        return this.deps.now?.() ?? Date.now();
    }

    /** The cooldown end for `hash`'s provider; an unreadable remote counts as none, the fetch reports it. */
    private async cooldownEnd(hash: string): Promise<number> {
        try {
            return await this.deps.cooldownUntil(hash);
        } catch {
            return 0;
        }
    }

    private active(): boolean {
        const settings = this.deps.settings();
        return this.deps.enabled() && (settings.statusBar || settings.notifyOnSettle);
    }

    private async start(head: string | undefined): Promise<void> {
        this.run += 1;
        this.clearTimer();
        this.head = head;
        this.headRepoKey = this.deps.repoKey();
        this.attempt = 0;
        this.noneAttempt = 0;
        this.lastUnknown = false;
        this.awaitingFocus = undefined;
        if (!head || !this.active()) return this.bar.hide();
        await this.poll(this.run, {});
    }

    private schedule(run: number, delayMs: number): void {
        this.clearTimer();
        this.timer = setTimeout(() => {
            this.timer = undefined;
            void this.poll(run, { force: true });
        }, delayMs);
    }

    private clearTimer(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = undefined;
    }

    private async poll(run: number, options: HeadFetchOptions): Promise<void> {
        const hash = this.head;
        const repoKey = this.deps.repoKey();
        if (run !== this.run || !hash || !repoKey) return;
        // A poll scheduled before the switch went off sends nothing and re-arms nothing.
        if (!this.deps.switchOn() || !this.active()) return this.bar.hide();
        const sequence = ++this.pollSequence;
        const ctx = this.deps.generations.capture(repoKey);
        const current = () =>
            sequence === this.pollSequence &&
            this.deps.switchOn() &&
            run === this.run &&
            this.head === hash &&
            this.deps.repoKey() === repoKey &&
            this.deps.generations.isCurrent(ctx, repoKey);
        const cooldownEnd = await this.cooldownEnd(hash);
        if (!current()) return;
        if (cooldownEnd > this.now()) return this.pause(run, repoKey, hash, cooldownEnd);
        // Unreadable remotes count as no provider until the next HEAD change or restart.
        const capabilities = await this.deps.capabilities(hash).catch(() => undefined);
        if (!current()) return;
        if (!capabilities) return this.bar.hide();
        let snapshot: CommitChecksSnapshot;
        try {
            snapshot = await this.deps.snapshot(hash, options);
        } catch {
            if (current()) this.bar.hide();
            return;
        }
        if (!current()) {
            this.deps.trace?.({ kind: "monitor", outcome: "discarded-generation", repoKey, hash });
            return;
        }
        if (snapshot.state === "none") return this.onNone(run, hash, snapshot, current);
        const poll: PollContext = { run, hash, repoKey, options, ctx, current, capabilities };
        if (snapshot.state === "unavailable") {
            return this.onUnavailable(poll, snapshot.error ?? snapshot.summary);
        }
        if (!isCompleteSnapshot(snapshot)) return this.onIncomplete(poll, snapshot);
        await this.onComplete(poll, snapshot);
    }

    private async onUnavailable(
        { run, hash, repoKey, current }: PollContext,
        message: string,
    ): Promise<void> {
        // The fetch itself may have found the cooldown: read the gate again.
        const until = await this.cooldownEnd(hash);
        if (!current()) return;
        if (until > this.now()) return this.pause(run, repoKey, hash, until);
        this.bar.render({ kind: "unavailable", message });
    }

    private async onIncomplete(
        { run, hash, repoKey, options, ctx, current, capabilities }: PollContext,
        snapshot: CommitChecksSnapshot,
    ): Promise<void> {
        const view = snapshotView(snapshot);
        this.bar.render(view());
        try {
            await this.toast.pendingObserved.add(repoKey, hash);
        } catch {
            // The set keeps the observation in memory, so the settle is still announced.
            this.deps.trace?.({
                kind: "monitor",
                outcome: "failed",
                repoKey,
                hash,
                reason: "storage",
            });
        }
        if (!current()) return;
        if (capabilities.runs) this.trackElapsed(hash, options, ctx, current, view);
        this.schedule(run, headMonitorDelayMs(this.attempt++));
    }

    private async onComplete(poll: PollContext, snapshot: CommitChecksSnapshot): Promise<void> {
        const { run, hash, repoKey, ctx, current, capabilities } = poll;
        this.bar.render(snapshotView(snapshot)());
        const settlement = await this.settlementDetail(
            hash,
            repoKey,
            capabilities,
            snapshot,
            ctx,
            current,
        );
        if (!current()) return;
        // A provider failure is not unknown coverage: show it and wait for the user's refresh.
        if (settlement.state === "unavailable") {
            return this.onUnavailable(poll, settlement.detail?.error ?? snapshot.summary);
        }
        // The detail counts jobs; the snapshot only aggregates them.
        if (settlement.state === "settled" && settlement.detail) {
            this.bar.render({
                kind: "status",
                counts: detailCounts(settlement.detail),
                summary: snapshot.summary,
            });
        }
        if (settlement.state === "settled" && this.toast.pendingObserved.has(repoKey, hash)) {
            await this.offerToast({
                repoKey,
                hash,
                ctx,
                isCurrent: current,
                capabilities,
                snapshot,
                ...(settlement.detail && { detail: settlement.detail }),
            });
        }
        if (!current()) return;
        if (settlement.state !== "settled" || this.deps.isFenced(hash)) {
            this.schedule(run, headMonitorDelayMs(this.attempt++));
        }
    }

    /**
     * Fetches the detail a complete snapshot needs. After a pending HEAD settles (seen in
     * this window or recorded in the pending-observed set), or after an `unknown` result,
     * the cached and in-flight detail is dropped first so the fetch starts after
     * settlement (Codex R3 #3). A complete failing HEAD seen for the first time reads the
     * caches first (R2 #15).
     */
    private async settlementDetail(
        hash: string,
        repoKey: string,
        capabilities: ProviderCiCapabilities,
        snapshot: CommitChecksSnapshot,
        ctx: CiOperationContext,
        current: () => boolean,
    ): Promise<{ state: CiSettlement | "unavailable"; detail?: CommitCiDetail }> {
        if (!capabilities.runs) return { state: "settled" };
        const transition = this.lastUnknown || this.toast.pendingObserved.has(repoKey, hash);
        if (!transition && snapshot.state !== "failure") return { state: "settled" };
        this.detailSequence += 1;
        let detail: CommitCiDetail | undefined;
        try {
            if (transition) {
                await this.deps.invalidateDetail(hash);
                // The switch, HEAD or a dispose may have changed during the invalidation: no request.
                if (!current()) return { state: "unknown" };
            }
            detail = await this.deps.detail(hash, transition ? { force: true } : {}, ctx);
        } catch {
            detail = undefined;
        }
        const state: CiSettlement | "unavailable" =
            detail?.outcome === "unavailable"
                ? "unavailable"
                : detail
                  ? settlementOf(detail)
                  : "unknown";
        // `unavailable` keeps the flag too, so the user's refresh fetches the detail afresh.
        this.lastUnknown = state !== "settled";
        return { state, ...(detail && { detail }) };
    }

    /** Fetches the detail of an incomplete HEAD for the elapsed time; not awaited. */
    private trackElapsed(
        hash: string,
        options: HeadFetchOptions,
        ctx: CiOperationContext,
        current: () => boolean,
        view: (startedAt?: number) => HeadStatusView,
    ): void {
        const sequence = ++this.detailSequence;
        void this.deps
            .detail(hash, options, ctx)
            .then((detail) => {
                if (sequence !== this.detailSequence || !current()) return;
                const startedAt = earliestIncompleteStart(detail);
                if (startedAt !== undefined) this.bar.render(view(startedAt));
            })
            .catch(() => undefined);
    }

    private pause(run: number, repoKey: string, hash: string, until: number): void {
        this.deps.trace?.({ kind: "monitor", outcome: "paused", repoKey, hash });
        this.bar.render({
            kind: "paused",
            message: vscode.l10n.t(
                "Commit-check requests are temporarily paused due to rate limiting.",
            ),
        });
        // The attempt number is kept: the ladder resumes where the cooldown stopped it.
        this.schedule(run, until - this.now());
    }

    private async onNone(
        run: number,
        hash: string,
        snapshot: CommitChecksSnapshot,
        current: () => boolean,
    ): Promise<void> {
        const unpushed = await this.deps.isUnpushed(hash);
        // Sign-out, a HEAD move or a newer poll during the lookup drops this answer.
        if (!current()) return;
        if (unpushed) return this.bar.hide();
        this.bar.render({
            kind: "status",
            counts: snapshotCounts(snapshot),
            summary: snapshot.summary,
        });
        // A pushed HEAD whose checks are not registered yet: the short ladder, then stop.
        const delay = HEAD_NONE_CHECK_RETRY_DELAYS_MS[this.noneAttempt++];
        if (delay !== undefined) this.schedule(run, delay);
    }

    private async offerToast(event: HeadSettledEvent): Promise<void> {
        this.latestOffer = event;
        const outcome = await this.toast.settled(event);
        // A newer poll's event may have been queued behind this claim: hold that one.
        if (outcome === "unfocused" || outcome === "retry") this.awaitingFocus = this.latestOffer;
    }
}
