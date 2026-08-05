import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";

import { setGitSuccessListener } from "../git/executor";
import { logGitOpsWarning } from "../git/operationSupport";

/** Deep link to the VS Marketplace review form; `ssr=false` is required for the anchor to resolve. */
export const MARKETPLACE_REVIEW_URL =
    "https://marketplace.visualstudio.com/items?itemName=MaheshKok.intelligit&ssr=false#review-details";
/** Open VSX review tab, used for every editor that is not an official VS Code build. */
export const OPEN_VSX_REVIEW_URL = "https://open-vsx.org/extension/MaheshKok/intelligit/reviews";

/** Prompt body. Localized at display time; also the lookup key in the l10n bundle. */
export const PROMPT_MESSAGE = "Enjoying IntelliGit? A quick rating helps others find it.";
/** Accepting action: records the decision and opens the marketplace review form. */
export const RATE_ACTION = "Rate IntelliGit";
/** Deferring action: relies on the snooze already taken when the ask was reserved. */
export const LATER_ACTION = "Later";
/** Declining action: records a terminal decision, so the prompt never returns. */
export const NEVER_ACTION = "Don't ask again";

/** A decision the user cannot be asked about again. */
export type TerminalStatus = "rated" | "declined";

const KEYS = {
    status: "intelligit.reviewPrompt.status",
    askCount: "intelligit.reviewPrompt.askCount",
    snoozedUntil: "intelligit.reviewPrompt.snoozedUntil",
    lastAskAt: "intelligit.reviewPrompt.lastAskAt",
    successOps: "intelligit.reviewPrompt.successOps",
    activeDays: "intelligit.reviewPrompt.activeDays",
    lastActiveDay: "intelligit.reviewPrompt.lastActiveDay",
    installedAt: "intelligit.reviewPrompt.installedAt",
} as const;

/**
 * Only the decision keys travel with Settings Sync.
 *
 * Counters are deliberately machine-local: syncing them would let a heavily used
 * machine drag a fresh install straight past the thresholds.
 */
const SYNCED_KEYS: readonly string[] = [
    KEYS.status,
    KEYS.askCount,
    KEYS.snoozedUntil,
    KEYS.lastAskAt,
];

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_SUCCESS_OPS = 30;
const MIN_ACTIVE_DAYS = 5;
const MIN_INSTALL_AGE_MS = 14 * DAY_MS;
const MAX_ASKS = 3;
const SNOOZE_MS = 30 * DAY_MS;

const LATCH_DIRECTORY = "reviewPrompt";
const LATCH_FILE = "terminal.json";

/** Editors that serve the VS Marketplace; everything else resolves to Open VSX. */
const OFFICIAL_APP_NAMES: ReadonlySet<string> = new Set([
    "Visual Studio Code",
    "Visual Studio Code - Insiders",
]);

/** Push arguments that mean "this published nothing", so they must not earn credit. */
const NON_PUBLISHING_PUSH_ARGS: ReadonlySet<string> = new Set([
    "--delete",
    "-d",
    "--dry-run",
    "-n",
]);

/** Injection seam for the clock so gating windows are testable without waiting days. */
export interface ReviewPromptDeps {
    now: () => number;
}

/**
 * Reports whether a successful Git command should count towards the review prompt.
 *
 * Only work the user chose to publish counts. Deletions and dry runs succeed without
 * producing anything, and `-n` is a dry run for `push` but `--no-verify` for `commit`,
 * so the exclusions are classified per subcommand rather than globally.
 */
export function countsAsSuccess(subcommand: string, argv: readonly string[]): boolean {
    if (subcommand === "commit") return !argv.includes("--dry-run");
    if (subcommand !== "push") return false;
    return !argv.some(
        (arg) => NON_PUBLISHING_PUSH_ARGS.has(arg) || arg.startsWith(":"), // `:branch` deletes a remote ref
    );
}

/** Returns the review destination for the running editor. */
export function getReviewUrl(appName: string): string {
    return OFFICIAL_APP_NAMES.has(appName) ? MARKETPLACE_REVIEW_URL : OPEN_VSX_REVIEW_URL;
}

/**
 * Asks long-running, clearly-engaged users for a marketplace rating, at most three times
 * ever and never again after they answer.
 *
 * Durability has two independent layers. A write-once latch file records the terminal
 * decision for this machine: its *existence* is authoritative, its content only advisory,
 * and it is never rewritten or deleted, so no crash or concurrent window can reopen a
 * decision. A mirrored copy in `globalState` rides Settings Sync to other machines and
 * doubles as the fallback when the filesystem rejects the latch write. Counters live in
 * `globalState` alone, where a lost update costs at most one operation of credit.
 */
export class ReviewPromptService {
    private readonly now: () => number;
    /** Resolved during `init()`, so a context without usable storage cannot throw here. */
    private latchPath = "";

    /** Set once init completes; every entry point is inert until then. */
    private ready = false;
    /** True once a decision is known — from the latch, the mirror, or this session. */
    private decided = false;
    private askedThisSession = false;

    /** Serializes cycles so two commits cannot each consume the same remaining ask. */
    private queue: Promise<void> = Promise.resolve();
    /** Toasts are awaited off the queue so a modal answer never stalls later commits. */
    private prompts: Promise<void> = Promise.resolve();
    private scheduled = 0;

    /** Binds the service to an extension context; call `init()` before use. */
    constructor(
        private readonly context: vscode.ExtensionContext,
        deps: ReviewPromptDeps,
    ) {
        this.now = deps.now;
    }

    /**
     * Prepares storage and reconciles the latch with the synced mirror.
     *
     * Any failure leaves the service permanently inert rather than propagating: a rating
     * prompt must never be the reason activation fails.
     */
    async init(): Promise<void> {
        try {
            this.latchPath = path.join(
                this.context.globalStorageUri.fsPath,
                LATCH_DIRECTORY,
                LATCH_FILE,
            );
            this.context.globalState.setKeysForSync(SYNCED_KEYS);
            await mkdir(path.dirname(this.latchPath), { recursive: true });
            await this.reconcile();
            if (readNumber(this.context.globalState.get(KEYS.installedAt)) === undefined) {
                await this.context.globalState.update(KEYS.installedAt, this.now());
            }
            this.ready = true;
        } catch (error) {
            logGitOpsWarning("reviewPrompt.init", error);
        }
    }

    /**
     * Records a successful Git command. Fire-and-forget by contract — the Git boundary
     * must not wait on, or fail because of, the review prompt.
     */
    handleGitSuccess(subcommand: string, argv: readonly string[]): void {
        if (!this.ready || this.decided) return;
        if (!countsAsSuccess(subcommand, argv)) return;
        this.enqueue(() => this.runCycle());
    }

    /**
     * Writes the terminal decision, keeping whichever decision reached the latch first.
     *
     * Public because the toast handler is detached; tests drive it directly to pin the
     * first-writer-wins contract.
     */
    async recordDecision(status: TerminalStatus): Promise<void> {
        this.decided = true;
        const winner = await this.writeLatch(status);
        if (!winner) return;
        try {
            await this.mirror(winner);
        } catch (error) {
            // The mirror is the Settings Sync convenience copy; the latch already
            // carries the decision. Letting a Memento rejection escape would strand
            // the caller before `openExternal`, so a user who clicked Rate would be
            // silenced forever and never reach the review page — the one outcome
            // worse than not asking at all.
            logGitOpsWarning("reviewPrompt.mirror", error);
        }
    }

    /** Resolves once every queued cycle and pending toast has settled. */
    async whenIdle(): Promise<void> {
        for (let attempt = 0; attempt < 100; attempt += 1) {
            const seen = this.scheduled;
            await this.queue;
            await this.prompts;
            if (this.scheduled === seen) return;
        }
    }

    private enqueue(task: () => Promise<void>): void {
        this.scheduled += 1;
        this.queue = this.queue.then(() =>
            task().catch((error) => logGitOpsWarning("reviewPrompt.cycle", error)),
        );
    }

    private async runCycle(): Promise<void> {
        if (this.decided) return;
        await this.countOperation();
        if (!(await this.shouldAsk())) return;

        // Claimed before any await so a second cycle queued behind this one cannot
        // observe a stale "not yet asked" state.
        this.askedThisSession = true;
        await this.reserveAsk();

        // The reservation is several awaits long; another window may have landed a
        // decision inside that gap, and a spent ask is cheaper than an unwanted toast.
        if (await this.latchExists()) {
            this.decided = true;
            return;
        }
        this.showPrompt();
    }

    private async countOperation(): Promise<void> {
        const state = this.context.globalState;
        await state.update(KEYS.successOps, readCounter(state.get(KEYS.successOps), 0) + 1);

        const today = dayKey(this.now());
        if (state.get<string>(KEYS.lastActiveDay) !== today) {
            await state.update(KEYS.lastActiveDay, today);
            await state.update(KEYS.activeDays, readCounter(state.get(KEYS.activeDays), 0) + 1);
        }
    }

    private async shouldAsk(): Promise<boolean> {
        if (this.askedThisSession) return false;
        if (!isEnabled()) return false;

        const state = this.context.globalState;
        if (readStatus(state.get(KEYS.status))) return false;
        if (readCounter(state.get(KEYS.askCount), 0) >= MAX_ASKS) return false;
        if (this.now() < readCounter(state.get(KEYS.snoozedUntil), 0)) return false;
        if (readCounter(state.get(KEYS.successOps), 0) < MIN_SUCCESS_OPS) return false;
        if (readCounter(state.get(KEYS.activeDays), 0) < MIN_ACTIVE_DAYS) return false;

        const installedAt = readCounter(state.get(KEYS.installedAt), this.now());
        if (this.now() - installedAt < MIN_INSTALL_AGE_MS) return false;

        if (await this.latchExists()) {
            this.decided = true;
            return false;
        }
        return true;
    }

    /**
     * Spends the ask before the toast is shown.
     *
     * A crash between reserving and showing costs the user one ask; the reverse order
     * would let a crash loop re-ask forever, which is the failure that actually annoys.
     */
    private async reserveAsk(): Promise<void> {
        const state = this.context.globalState;
        await state.update(KEYS.askCount, readCounter(state.get(KEYS.askCount), 0) + 1);
        await state.update(KEYS.lastAskAt, this.now());
        await state.update(KEYS.snoozedUntil, this.now() + SNOOZE_MS);
    }

    private showPrompt(): void {
        this.scheduled += 1;
        this.prompts = this.prompts.then(() =>
            this.ask().catch((error) => logGitOpsWarning("reviewPrompt.ask", error)),
        );
    }

    private async ask(): Promise<void> {
        // Compared by value below, so the localized labels must be the same instances
        // that were offered — the user's choice comes back translated.
        const rate = vscode.l10n.t(RATE_ACTION);
        const later = vscode.l10n.t(LATER_ACTION);
        const never = vscode.l10n.t(NEVER_ACTION);

        const choice = await vscode.window.showInformationMessage(
            vscode.l10n.t(PROMPT_MESSAGE),
            rate,
            later,
            never,
        );

        if (choice === rate) {
            await this.recordDecision("rated");
            await vscode.env.openExternal(vscode.Uri.parse(getReviewUrl(vscode.env.appName)));
            return;
        }
        if (choice === never) {
            await this.recordDecision("declined");
        }
        // `Later` and dismissal are already covered by the snooze taken at reservation.
    }

    /**
     * Brings the latch and the synced mirror into agreement at startup.
     *
     * The latch wins locally when both exist; a mirror-only decision — the shape Settings
     * Sync delivers on a second machine — seeds the latch so this machine is silenced
     * even if the mirror is later cleared.
     */
    private async reconcile(): Promise<void> {
        const latched = await this.readLatch();
        if (latched.exists) {
            this.decided = true;
            if (latched.status) await this.mirror(latched.status);
            return;
        }

        const mirrored = readStatus(this.context.globalState.get(KEYS.status));
        if (!mirrored) return;
        this.decided = true;
        await this.writeLatch(mirrored);
    }

    /**
     * Creates the latch exclusively, and returns the decision that actually holds.
     *
     * `wx` publishes existence atomically but not content, so a reader can legitimately
     * find the file empty. Existence alone is therefore the terminal signal, and an
     * unreadable winner returns `undefined` rather than letting this caller's status
     * masquerade as the one on record.
     */
    private async writeLatch(status: TerminalStatus): Promise<TerminalStatus | undefined> {
        const payload = JSON.stringify({ status, decidedAt: this.now() });
        try {
            await writeFile(this.latchPath, payload, { encoding: "utf8", flag: "wx" });
            return status;
        } catch (error) {
            if (isFileExistsError(error)) {
                const existing = await this.readLatch();
                return existing.status;
            }
            // The mirror is the only durable copy left; keep it truthful and carry on.
            logGitOpsWarning("reviewPrompt.writeLatch", error);
            return status;
        }
    }

    /**
     * Reads the latch, failing closed.
     *
     * Only `ENOENT` proves no decision was ever recorded. `EACCES`, `EIO` and the
     * rest mean the latch is *unreadable*, which is not the same as absent — a
     * locked-down globalStorage would otherwise re-prompt a user who already
     * declined, the exact failure the latch exists to prevent. An unreadable latch
     * reports the same shape as a half-written one: present, status unknown.
     */
    private async readLatch(): Promise<{ exists: boolean; status?: TerminalStatus }> {
        try {
            const raw = await readFile(this.latchPath, "utf8");
            return { exists: true, status: parseLatch(raw) };
        } catch (error) {
            if (isMissingFileError(error)) return { exists: false };
            logGitOpsWarning("reviewPrompt.readLatch", error);
            return { exists: true };
        }
    }

    /** Probes the latch, failing closed on anything but a confirmed absence. */
    private async latchExists(): Promise<boolean> {
        try {
            await access(this.latchPath);
            return true;
        } catch (error) {
            if (isMissingFileError(error)) return false;
            logGitOpsWarning("reviewPrompt.latchExists", error);
            return true;
        }
    }

    /** Mirrors a decision for Settings Sync; the first decision on record always wins. */
    private async mirror(status: TerminalStatus): Promise<void> {
        if (readStatus(this.context.globalState.get(KEYS.status))) return;
        await this.context.globalState.update(KEYS.status, status);
    }
}

/**
 * Starts the review prompt and connects it to the Git success hook.
 *
 * The listener is installed only once storage has been prepared, and removed on
 * disposal — including when the extension shuts down while startup is still in flight.
 * Callers fire this without awaiting it, so it absorbs its own failures rather than
 * surfacing an unhandled rejection during activation.
 */
export async function registerReviewPrompt(context: vscode.ExtensionContext): Promise<void> {
    try {
        const service = new ReviewPromptService(context, { now: () => Date.now() });
        let active = true;

        context.subscriptions.push({
            dispose: () => {
                active = false;
                setGitSuccessListener(undefined);
            },
        });

        await service.init();
        if (!active) return;
        setGitSuccessListener((subcommand, argv) => service.handleGitSuccess(subcommand, argv));
    } catch (error) {
        logGitOpsWarning("reviewPrompt.register", error);
    }
}

function isEnabled(): boolean {
    return vscode.workspace
        .getConfiguration("intelligit")
        .get<boolean>("reviewPrompt.enabled", true);
}

/** Local calendar day, so "active days" matches the days the user actually worked. */
function dayKey(timestamp: number): string {
    const date = new Date(timestamp);
    const month = `${date.getMonth() + 1}`.padStart(2, "0");
    const day = `${date.getDate()}`.padStart(2, "0");
    return `${date.getFullYear()}-${month}-${day}`;
}

/** Reads a persisted number, discarding anything a corrupted profile may have left. */
function readNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readCounter(value: unknown, fallback: number): number {
    return readNumber(value) ?? fallback;
}

function readStatus(value: unknown): TerminalStatus | undefined {
    return value === "rated" || value === "declined" ? value : undefined;
}

function parseLatch(raw: string): TerminalStatus | undefined {
    try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== "object" || parsed === null) return undefined;
        return readStatus((parsed as { status?: unknown }).status);
    } catch {
        return undefined;
    }
}

function isFileExistsError(error: unknown): boolean {
    return errorCode(error) === "EEXIST";
}

/**
 * Whether an error proves the latch does not exist.
 *
 * `ENOENT` and `ENOTDIR` are the two codes that settle the question: a missing
 * path component and a non-directory path component both mean the file cannot be
 * there. Everything else — `EACCES`, `EIO`, `EPERM` — means the answer is unknown,
 * and callers fail closed rather than reading "unknown" as "never decided".
 */
function isMissingFileError(error: unknown): boolean {
    const code = errorCode(error);
    return code === "ENOENT" || code === "ENOTDIR";
}

function errorCode(error: unknown): string | undefined {
    if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
}
