import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";

import { setGitSuccessListener } from "../git/executor";
import { logGitOpsWarning } from "../git/operationSupport";
import { findVisibleReviewPromptHost, type ReviewPromptResult } from "./reviewPromptHost";

/** Deep link to the VS Marketplace review form; `ssr=false` is required for the anchor to resolve. */
export const MARKETPLACE_REVIEW_URL =
    "https://marketplace.visualstudio.com/items?itemName=MaheshKok.intelligit&ssr=false#review-details";
/** Open VSX review tab, used for every editor that is not an official VS Code build. */
export const OPEN_VSX_REVIEW_URL = "https://open-vsx.org/extension/MaheshKok/intelligit/reviews";
/**
 * Where a low rating is offered a hearing.
 *
 * The card offers this *alongside* the review link rather than instead of it — routing an
 * unhappy user to a fixable issue is fair; hiding the public review form from them is not.
 */
export const FEEDBACK_URL =
    "https://github.com/MaheshKok/IntelliGit/issues/new?labels=feedback&title=Feedback%20on%20IntelliGit";

/** Prompt body. Localized at display time; also the lookup key in the l10n bundle. */
export const PROMPT_MESSAGE = "Enjoying IntelliGit? A quick rating helps others find it.";
/** Accepting action: records the decision and opens the marketplace review form. */
export const RATE_ACTION = "Rate IntelliGit";
/** Deferring action: relies on the snooze already taken when the ask was reserved. */
export const LATER_ACTION = "Later";
/** Declining action: records a terminal decision, so the prompt never returns. */
export const NEVER_ACTION = "Don't ask again";
/** Explicit command for previewing the same notification without waiting for usage gates. */
export const SHOW_REVIEW_PROMPT_COMMAND = "intelligit.showReviewPrompt";
/** Explicit command for clearing this machine's rating record so the prompt can be tested again. */
export const RESET_REVIEW_PROMPT_COMMAND = "intelligit.resetReviewPrompt";
/** Explicit command for rendering the card itself, bypassing the surface choice. */
export const SHOW_REVIEW_PROMPT_CARD_COMMAND = "intelligit.showReviewPromptCard";

/** Shown when the card is requested with no graph view able to host it. */
export const CARD_UNAVAILABLE_MESSAGE =
    "Open the IntelliGit commit graph first — the rating card renders inside it.";

/** Confirmation title. Localized at display time; also the lookup key in the l10n bundle. */
export const RESET_CONFIRM_MESSAGE = "Reset the IntelliGit rating prompt on this machine?";
/** Confirmation detail, stating plainly what is destroyed and what is not. */
export const RESET_CONFIRM_DETAIL =
    "This deletes the record of your rating decision and the usage counters behind it. It affects this machine only, and never touches a rating you already published.";
/** Confirmation action restoring the state a brand-new install starts from. */
export const RESET_FRESH_ACTION = "Reset to a fresh install";
/** Confirmation action that also seeds the counters one successful operation short of the gate. */
export const RESET_ARM_ACTION = "Reset and arm the next commit";

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
     * Shows the prompt on explicit user request.
     *
     * This is intentionally separate from the success hook: it does not increment usage
     * counters or spend a gated ask, but the Rate and Don't ask again actions still write
     * the same durable terminal decision.
     *
     * It deliberately ignores an existing decision. The command's whole purpose is to show
     * the prompt on demand, and the never-ask-again latch would otherwise silence it
     * permanently after the first answer — leaving no way to see the prompt again short of
     * deleting extension storage. Answering again is harmless: the latch is write-once, so
     * the original decision still wins.
     */
    showPromptNow(): void {
        if (!this.ready) return;
        this.askedThisSession = true;
        this.showPrompt();
    }

    /**
     * Renders the card itself, with no usage gating and no notification fallback.
     *
     * Separate from `showPromptNow`, which answers "show me the ask on whatever surface a
     * real user would get". This one answers "show me the card", the only useful question
     * while the card is being worked on. It says plainly when no graph view can host it,
     * because a silent no-op is indistinguishable from a broken build — the failure that
     * cost the most time getting this feature working.
     */
    showCardNow(): void {
        this.scheduled += 1;
        this.prompts = this.prompts.then(() =>
            this.askViaCard().catch((error) => logGitOpsWarning("reviewPrompt.card", error)),
        );
    }

    private async askViaCard(): Promise<void> {
        const host = findVisibleReviewPromptHost();
        if (!host) {
            await vscode.window.showWarningMessage(vscode.l10n.t(CARD_UNAVAILABLE_MESSAGE));
            return;
        }
        const result = await host.showReviewPrompt();
        if (result) await this.applyResult(result);
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

    /**
     * Clears this machine's rating record so the prompt can be exercised again.
     *
     * This is the one operation allowed to delete the terminal latch, and it exists only
     * because the latch is otherwise permanent by design: without it there is no way to
     * test the gated path twice on one machine, which is what the plan's acceptance run
     * used a throwaway source patch for. It runs on the cycle queue so it cannot interleave
     * with a counter update, and it is reachable only from an explicitly confirmed command.
     *
     * @param arm - Seeds the counters one successful operation short of the gate, so the
     *   next commit or push asks, instead of restoring the 14-day fresh-install wait.
     */
    resetState(arm: boolean): Promise<void> {
        const done = this.queue.then(() => this.clearState(arm));
        this.queue = done.catch(() => undefined);
        return done;
    }

    private async clearState(arm: boolean): Promise<void> {
        this.decided = false;
        this.askedThisSession = false;
        if (this.latchPath) await rm(this.latchPath, { force: true });

        const state = this.context.globalState;
        for (const key of Object.values(KEYS)) await state.update(key, undefined);
        if (!arm) return;

        // One short of every threshold, matching the seed the gating tests use, so the
        // very next successful commit or push crosses it.
        await state.update(KEYS.successOps, MIN_SUCCESS_OPS - 1);
        await state.update(KEYS.activeDays, MIN_ACTIVE_DAYS);
        await state.update(KEYS.lastActiveDay, dayKey(this.now()));
        await state.update(KEYS.installedAt, this.now() - MIN_INSTALL_AGE_MS - DAY_MS);
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

    /**
     * Presents the reserved ask on the best surface available.
     *
     * The centered card wins whenever a graph webview is on screen, because the ask budget is
     * three for the lifetime of the install and a notification is easy to miss. A surface that
     * vanished mid-request resolves `undefined` and falls through to the notification, so an
     * ask is never spent on a display nobody saw.
     */
    private async ask(): Promise<void> {
        const host = findVisibleReviewPromptHost();
        if (host) {
            const result = await host.showReviewPrompt();
            if (result) {
                await this.applyResult(result);
                return;
            }
        }
        await this.askViaNotification();
    }

    /**
     * Applies a card answer, recording the decision before opening anything.
     *
     * Ordering matters: `openExternal` moves focus out of the editor, and a decision that is
     * only durable after the browser returns would be lost to a crash in between.
     */
    private async applyResult(result: ReviewPromptResult): Promise<void> {
        if (result.decision !== "later") await this.recordDecision(result.decision);
        if (!result.open) return;
        const url = result.open === "feedback" ? FEEDBACK_URL : getReviewUrl(vscode.env.appName);
        await vscode.env.openExternal(vscode.Uri.parse(url));
    }

    private async askViaNotification(): Promise<void> {
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
        const initialized = service.init();

        context.subscriptions.push({
            dispose: () => {
                active = false;
                setGitSuccessListener(undefined);
            },
        });
        context.subscriptions.push(
            vscode.commands.registerCommand(SHOW_REVIEW_PROMPT_COMMAND, async () => {
                await initialized;
                if (active) service.showPromptNow();
            }),
        );
        context.subscriptions.push(
            vscode.commands.registerCommand(SHOW_REVIEW_PROMPT_CARD_COMMAND, async () => {
                await initialized;
                if (active) service.showCardNow();
            }),
        );
        context.subscriptions.push(
            vscode.commands.registerCommand(RESET_REVIEW_PROMPT_COMMAND, async () => {
                await initialized;
                if (!active) return;
                const arm = vscode.l10n.t(RESET_ARM_ACTION);
                const fresh = vscode.l10n.t(RESET_FRESH_ACTION);
                // Modal: this deletes a decision the extension otherwise treats as permanent,
                // so it must never be one stray palette entry away from happening.
                const choice = await vscode.window.showWarningMessage(
                    vscode.l10n.t(RESET_CONFIRM_MESSAGE),
                    { modal: true, detail: vscode.l10n.t(RESET_CONFIRM_DETAIL) },
                    arm,
                    fresh,
                );
                if (choice !== arm && choice !== fresh) return;
                await service.resetState(choice === arm);
            }),
        );

        await initialized;
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
