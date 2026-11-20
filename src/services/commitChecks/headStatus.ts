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
    | { kind: "paused"; message: string };

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
        return this.read().some((entry) => entry.repoKey === repoKey && entry.hash === hash);
    }

    /** Adds the commit; resolves once the write is stored. */
    add(repoKey: string, hash: string): Promise<void> {
        return this.write((entries) =>
            entries.some((entry) => entry.repoKey === repoKey && entry.hash === hash)
                ? entries
                : [...entries, { repoKey, hash, observedAt: this.now() }],
        );
    }

    /** Removes the commit; resolves once the write is stored. */
    remove(repoKey: string, hash: string): Promise<void> {
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
     * the next focus.
     */
    async settled(event: HeadSettledEvent): Promise<"unfocused" | undefined> {
        // Ships hidden until Phase 18: no notification while the Checks tab switch is off.
        if (!this.deps.switchOn()) return undefined;
        const { repoKey, hash } = event;
        const key = `${repoKey}\0${hash}`;
        if (this.running.has(key) || !this.deps.settings().notifyOnSettle) return undefined;
        if (!this.pendingObserved.has(repoKey, hash) || !event.isCurrent()) return undefined;
        if (!this.deps.focused()) return "unfocused";
        this.running.add(key);
        const mkdir = this.deps.mkdir ?? ((target, options) => fs.mkdir(target, options));
        const claim = path.join(this.deps.claimDir, createHash("sha256").update(key).digest("hex"));
        try {
            await mkdir(this.deps.claimDir, { recursive: true });
            await mkdir(claim);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EEXIST") {
                this.deps.trace?.({ kind: "claim", outcome: "claim-exists", repoKey, hash });
                await this.pendingObserved.remove(repoKey, hash).catch(() => undefined);
                return undefined;
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
            return undefined;
        }
        await this.pendingObserved.remove(repoKey, hash).catch(() => undefined);
        // At most once: a HEAD that moved during the claim loses its notification.
        if (event.isCurrent()) this.show(event);
        return undefined;
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
    /** End of the provider's request cooldown in epoch ms; 0 or past when none. */
    cooldownUntil(): number;
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
    private detailSequence = 0;
    // A settlement detail came back `unknown`: every later complete poll fetches it again.
    private lastUnknown = false;
    private awaitingFocus?: HeadSettledEvent;
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
        const head = await this.deps.headHash();
        // Worktrees of one repository can share a HEAD commit, so the repository counts too.
        if (head !== undefined && head === this.head && this.deps.repoKey() === this.headRepoKey) {
            return;
        }
        await this.start(head);
    }

    /** Settings, sign-in or provider changes: starts over on the current HEAD. */
    async restart(): Promise<void> {
        if (!this.deps.switchOn() || this.disposed) return;
        await this.start(await this.deps.headHash());
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
        if (!this.deps.switchOn() || this.disposed || !this.head) return;
        if (this.deps.cooldownUntil() > this.now()) return;
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
        if (!this.active()) return this.bar.hide();
        const cooldownEnd = this.deps.cooldownUntil();
        if (cooldownEnd > this.now()) {
            this.deps.trace?.({ kind: "monitor", outcome: "paused", repoKey, hash });
            this.bar.render({
                kind: "paused",
                message: vscode.l10n.t(
                    "Commit-check requests are temporarily paused due to rate limiting.",
                ),
            });
            // The attempt number is kept: the ladder resumes where the cooldown stopped it.
            return this.schedule(run, cooldownEnd - this.now());
        }
        const ctx = this.deps.generations.capture(repoKey);
        const current = () =>
            run === this.run &&
            this.head === hash &&
            this.deps.repoKey() === repoKey &&
            this.deps.generations.isCurrent(ctx, repoKey);
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
        if (snapshot.state === "none") return this.onNone(run, hash, snapshot);
        if (snapshot.state === "unavailable") {
            this.bar.hide();
            return;
        }
        const view = (startedAt?: number): HeadStatusView => ({
            kind: "status",
            counts: snapshotCounts(snapshot),
            summary: snapshot.summary,
            ...(startedAt !== undefined && { startedAt }),
        });
        if (!isCompleteSnapshot(snapshot)) {
            this.bar.render(view());
            await this.toast.pendingObserved.add(repoKey, hash);
            if (!current()) return;
            if (capabilities.runs) this.trackElapsed(hash, options, ctx, current, view);
            return this.schedule(run, headMonitorDelayMs(this.attempt++));
        }
        this.bar.render(view());
        const settlement = await this.settlementDetail(hash, repoKey, capabilities, snapshot, ctx);
        if (!current()) return;
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
            return this.schedule(run, headMonitorDelayMs(this.attempt++));
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
    ): Promise<{ state: CiSettlement; detail?: CommitCiDetail }> {
        if (!capabilities.runs) return { state: "settled" };
        const transition = this.lastUnknown || this.toast.pendingObserved.has(repoKey, hash);
        if (!transition && snapshot.state !== "failure") return { state: "settled" };
        this.detailSequence += 1;
        let detail: CommitCiDetail | undefined;
        try {
            if (transition) await this.deps.invalidateDetail(hash);
            detail = await this.deps.detail(hash, transition ? { force: true } : {}, ctx);
        } catch {
            detail = undefined;
        }
        const state: CiSettlement =
            detail && detail.outcome !== "unavailable" ? settlementOf(detail) : "unknown";
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

    private async onNone(run: number, hash: string, snapshot: CommitChecksSnapshot): Promise<void> {
        if (await this.deps.isUnpushed(hash)) {
            if (run === this.run) this.bar.hide();
            return;
        }
        if (run !== this.run) return;
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
        if ((await this.toast.settled(event)) === "unfocused") this.awaitingFocus = event;
    }
}
