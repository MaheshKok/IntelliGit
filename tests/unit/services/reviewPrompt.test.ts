import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The unreadable-storage cases rely on POSIX directory permissions. */
const itPosix = process.platform === "win32" ? it.skip : it;

const vscodeMock = vi.hoisted(() => ({
    window: {
        createOutputChannel: vi.fn(() => ({ appendLine: vi.fn() })),
        showInformationMessage: vi.fn(),
        showWarningMessage: vi.fn(),
    },
    workspace: {
        getConfiguration: vi.fn(() => ({ get: vi.fn(() => true) })),
    },
    commands: {
        registerCommand: vi.fn(() => ({ dispose: vi.fn() })),
    },
    env: {
        appName: "Visual Studio Code",
        openExternal: vi.fn(async () => true),
    },
    Uri: { parse: (value: string) => ({ toString: () => value }) },
    l10n: { t: (message: string) => message },
}));

vi.mock("vscode", () => vscodeMock);

import { notifyGitSuccessSafely, setGitSuccessListener } from "../../../src/git/executor";
import {
    registerReviewPromptHost,
    resetReviewPromptHosts,
    type ReviewPromptResult,
} from "../../../src/services/reviewPromptHost";
import {
    CARD_UNAVAILABLE_MESSAGE,
    FEEDBACK_URL,
    LATER_ACTION,
    MARKETPLACE_REVIEW_URL,
    NEVER_ACTION,
    OPEN_VSX_REVIEW_URL,
    PROMPT_MESSAGE,
    RATE_ACTION,
    RESET_ARM_ACTION,
    RESET_CONFIRM_DETAIL,
    RESET_CONFIRM_MESSAGE,
    RESET_FRESH_ACTION,
    RESET_REVIEW_PROMPT_COMMAND,
    ReviewPromptService,
    SHOW_REVIEW_PROMPT_CARD_COMMAND,
    SHOW_REVIEW_PROMPT_COMMAND,
    countsAsSuccess,
    getReviewUrl,
    registerReviewPrompt,
} from "../../../src/services/reviewPrompt";
import { removeScratchDirectories } from "../../helpers/scratchDirectories";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Well clear of the 14-day install age and the 30-day snooze horizon. */
const NOW = Date.UTC(2026, 6, 1, 12, 0, 0);
const KEY = {
    status: "intelligit.reviewPrompt.status",
    askCount: "intelligit.reviewPrompt.askCount",
    snoozedUntil: "intelligit.reviewPrompt.snoozedUntil",
    lastAskAt: "intelligit.reviewPrompt.lastAskAt",
    successOps: "intelligit.reviewPrompt.successOps",
    activeDays: "intelligit.reviewPrompt.activeDays",
    lastActiveDay: "intelligit.reviewPrompt.lastActiveDay",
    installedAt: "intelligit.reviewPrompt.installedAt",
} as const;

class MemoryMemento {
    private readonly values = new Map<string, unknown>();
    readonly synced: string[] = [];

    get<T>(key: string, defaultValue?: T): T | undefined {
        const stored = this.values.get(key) as T | undefined;
        return stored === undefined ? defaultValue : stored;
    }

    async update(key: string, value: unknown): Promise<void> {
        if (value === undefined) this.values.delete(key);
        else this.values.set(key, value);
    }

    setKeysForSync(keys: readonly string[]): void {
        this.synced.push(...keys);
    }
}

describe("reviewPrompt", () => {
    let storageDir: string;
    let state: MemoryMemento;
    let clock: number;

    const makeService = (): ReviewPromptService =>
        new ReviewPromptService(
            {
                globalState: state as unknown as never,
                globalStorageUri: { fsPath: storageDir } as unknown as never,
            } as never,
            { now: () => clock },
        );

    const latchPath = (): string => path.join(storageDir, "reviewPrompt", "terminal.json");
    const readLatch = async (): Promise<unknown> => JSON.parse(await readFile(latchPath(), "utf8"));

    /** Seeds a profile one successful operation short of the ask threshold. */
    const eligibleSeed = (overrides: Record<string, unknown> = {}): void => {
        void state.update(KEY.successOps, 29);
        void state.update(KEY.activeDays, 5);
        void state.update(KEY.lastActiveDay, "2026-06-30");
        void state.update(KEY.installedAt, NOW - 30 * DAY_MS);
        for (const [key, value] of Object.entries(overrides)) void state.update(key, value);
    };

    beforeEach(async () => {
        vi.clearAllMocks();
        vscodeMock.env.appName = "Visual Studio Code";
        vscodeMock.workspace.getConfiguration.mockReturnValue({ get: vi.fn(() => true) });
        vscodeMock.window.showInformationMessage.mockResolvedValue(undefined);
        storageDir = await mkdtemp(path.join(tmpdir(), "intelligit-review-"));
        state = new MemoryMemento();
        clock = NOW;
    });

    afterEach(async () => {
        setGitSuccessListener(undefined);
        resetReviewPromptHosts();
        await removeScratchDirectories(storageDir);
    });

    describe("countsAsSuccess", () => {
        it("counts commits and ordinary pushes", () => {
            expect(countsAsSuccess("commit", ["commit", "-m", "msg"])).toBe(true);
            expect(countsAsSuccess("push", ["push"])).toBe(true);
            expect(countsAsSuccess("push", ["push", "-u", "origin", "feature"])).toBe(true);
        });

        it("ignores branch deletions in every shape the repository uses", () => {
            expect(countsAsSuccess("push", ["push", "origin", "--delete", "feature"])).toBe(false);
            expect(countsAsSuccess("push", ["push", "origin", "-d", "feature"])).toBe(false);
            expect(countsAsSuccess("push", ["push", "origin", ":feature"])).toBe(false);
        });

        it("ignores dry runs including the -n alias", () => {
            expect(countsAsSuccess("push", ["push", "--dry-run"])).toBe(false);
            expect(countsAsSuccess("push", ["push", "-n"])).toBe(false);
            expect(countsAsSuccess("commit", ["commit", "--dry-run"])).toBe(false);
        });

        it("counts a commit with -n, which means --no-verify rather than dry run", () => {
            expect(countsAsSuccess("commit", ["commit", "-n", "-m", "msg"])).toBe(true);
        });

        it("does not mistake a colon inside a refspec source for a deletion", () => {
            expect(countsAsSuccess("push", ["push", "origin", "HEAD:main"])).toBe(true);
        });

        it("ignores every non commit-or-push subcommand", () => {
            for (const command of ["merge", "checkout", "stash", "rebase", "fetch"]) {
                expect(countsAsSuccess(command, [command])).toBe(false);
            }
        });
    });

    describe("getReviewUrl", () => {
        it("routes official builds to the VS Marketplace", () => {
            expect(getReviewUrl("Visual Studio Code")).toBe(MARKETPLACE_REVIEW_URL);
            expect(getReviewUrl("Visual Studio Code - Insiders")).toBe(MARKETPLACE_REVIEW_URL);
        });

        it("routes forks to Open VSX, including names prefixed with the official name", () => {
            expect(getReviewUrl("Cursor")).toBe(OPEN_VSX_REVIEW_URL);
            expect(getReviewUrl("Visual Studio Code Fork")).toBe(OPEN_VSX_REVIEW_URL);
            expect(getReviewUrl("")).toBe(OPEN_VSX_REVIEW_URL);
        });
    });

    describe("gating", () => {
        it("asks once the final threshold is crossed", async () => {
            eligibleSeed();
            const service = makeService();
            await service.init();

            service.handleGitSuccess("commit", ["commit", "-m", "msg"]);
            await service.whenIdle();

            expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledWith(
                PROMPT_MESSAGE,
                RATE_ACTION,
                LATER_ACTION,
                NEVER_ACTION,
            );
        });

        it("crosses the active-day boundary from four to five", async () => {
            eligibleSeed({ [KEY.successOps]: 40, [KEY.activeDays]: 4 });
            const service = makeService();
            await service.init();

            service.handleGitSuccess("push", ["push"]);
            await service.whenIdle();

            expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledTimes(1);
        });

        it("stays silent below each threshold", async () => {
            const belowThreshold: Array<Record<string, unknown>> = [
                { [KEY.successOps]: 5 },
                { [KEY.activeDays]: 3 },
                { [KEY.installedAt]: NOW - 3 * DAY_MS },
            ];
            for (const override of belowThreshold) {
                state = new MemoryMemento();
                eligibleSeed(override);
                const service = makeService();
                await service.init();

                service.handleGitSuccess("commit", ["commit"]);
                await service.whenIdle();
            }

            expect(vscodeMock.window.showInformationMessage).not.toHaveBeenCalled();
        });

        it("never asks on a fresh install", async () => {
            const service = makeService();
            await service.init();

            service.handleGitSuccess("commit", ["commit"]);
            await service.whenIdle();

            expect(vscodeMock.window.showInformationMessage).not.toHaveBeenCalled();
            expect(state.get<number>(KEY.installedAt)).toBe(NOW);
        });

        it("does not count a non-countable command", async () => {
            eligibleSeed();
            const service = makeService();
            await service.init();

            service.handleGitSuccess("push", ["push", "--dry-run"]);
            await service.whenIdle();

            expect(state.get<number>(KEY.successOps)).toBe(29);
            expect(vscodeMock.window.showInformationMessage).not.toHaveBeenCalled();
        });

        it("stays silent when the setting is disabled", async () => {
            vscodeMock.workspace.getConfiguration.mockReturnValue({ get: vi.fn(() => false) });
            eligibleSeed();
            const service = makeService();
            await service.init();

            service.handleGitSuccess("commit", ["commit"]);
            await service.whenIdle();

            expect(vscodeMock.window.showInformationMessage).not.toHaveBeenCalled();
        });

        it("asks at most once per window session", async () => {
            eligibleSeed({ [KEY.successOps]: 100 });
            const service = makeService();
            await service.init();

            service.handleGitSuccess("commit", ["commit"]);
            service.handleGitSuccess("commit", ["commit"]);
            await service.whenIdle();

            expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledTimes(1);
        });

        it("honours the snooze window and re-arms once it lapses", async () => {
            eligibleSeed({
                [KEY.successOps]: 100,
                [KEY.askCount]: 1,
                [KEY.snoozedUntil]: NOW + 10 * DAY_MS,
            });
            const snoozed = makeService();
            await snoozed.init();
            snoozed.handleGitSuccess("commit", ["commit"]);
            await snoozed.whenIdle();
            expect(vscodeMock.window.showInformationMessage).not.toHaveBeenCalled();

            clock = NOW + 11 * DAY_MS;
            const rearmed = makeService();
            await rearmed.init();
            rearmed.handleGitSuccess("commit", ["commit"]);
            await rearmed.whenIdle();

            expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledTimes(1);
        });

        it("stops permanently after three asks", async () => {
            eligibleSeed({ [KEY.successOps]: 100, [KEY.askCount]: 3 });
            const service = makeService();
            await service.init();

            service.handleGitSuccess("commit", ["commit"]);
            await service.whenIdle();

            expect(vscodeMock.window.showInformationMessage).not.toHaveBeenCalled();
        });

        it("counts an active day only once per calendar day", async () => {
            eligibleSeed({ [KEY.successOps]: 100, [KEY.activeDays]: 1 });
            const service = makeService();
            await service.init();

            service.handleGitSuccess("commit", ["commit"]);
            service.handleGitSuccess("commit", ["commit"]);
            await service.whenIdle();

            expect(state.get<number>(KEY.activeDays)).toBe(2);
            expect(state.get<number>(KEY.successOps)).toBe(102);
        });
    });

    describe("reservation ordering", () => {
        it("persists the reservation before the notification is shown", async () => {
            eligibleSeed();
            let askCountWhenShown: number | undefined;
            vscodeMock.window.showInformationMessage.mockImplementation(async () => {
                askCountWhenShown = state.get<number>(KEY.askCount);
                return undefined;
            });
            const service = makeService();
            await service.init();

            service.handleGitSuccess("commit", ["commit"]);
            await service.whenIdle();

            expect(askCountWhenShown).toBe(1);
            expect(state.get<number>(KEY.snoozedUntil)).toBe(NOW + 30 * DAY_MS);
            expect(state.get<number>(KEY.lastAskAt)).toBe(NOW);
        });

        it("does not show a toast when a decision lands after the reservation", async () => {
            eligibleSeed();
            const service = makeService();
            await service.init();
            const passThrough = state.update.bind(state);
            vi.spyOn(state, "update").mockImplementation(async (key, value) => {
                await passThrough(key, value);
                if (key === KEY.askCount) {
                    await writeFile(latchPath(), JSON.stringify({ status: "rated" }), "utf8");
                }
            });

            service.handleGitSuccess("commit", ["commit"]);
            await service.whenIdle();

            expect(vscodeMock.window.showInformationMessage).not.toHaveBeenCalled();
        });

        it("treats a dismissal as a spent ask without recording a decision", async () => {
            eligibleSeed();
            const service = makeService();
            await service.init();

            service.handleGitSuccess("commit", ["commit"]);
            await service.whenIdle();

            expect(state.get<number>(KEY.askCount)).toBe(1);
            expect(state.get(KEY.status)).toBeUndefined();
            expect(vscodeMock.env.openExternal).not.toHaveBeenCalled();
        });

        it("treats Later as a snooze, not a decision", async () => {
            eligibleSeed();
            vscodeMock.window.showInformationMessage.mockResolvedValue(LATER_ACTION);
            const service = makeService();
            await service.init();

            service.handleGitSuccess("commit", ["commit"]);
            await service.whenIdle();

            expect(state.get(KEY.status)).toBeUndefined();
            expect(state.get<number>(KEY.snoozedUntil)).toBe(NOW + 30 * DAY_MS);
            expect(vscodeMock.env.openExternal).not.toHaveBeenCalled();
        });
    });

    describe("terminal latch", () => {
        it("records a rating, opens the marketplace, and never asks again", async () => {
            eligibleSeed();
            vscodeMock.window.showInformationMessage.mockResolvedValue(RATE_ACTION);
            const service = makeService();
            await service.init();

            service.handleGitSuccess("commit", ["commit"]);
            await service.whenIdle();

            expect(await readLatch()).toMatchObject({ status: "rated" });
            expect(state.get(KEY.status)).toBe("rated");
            expect(vscodeMock.env.openExternal).toHaveBeenCalledTimes(1);

            const next = makeService();
            await next.init();
            next.handleGitSuccess("commit", ["commit"]);
            await next.whenIdle();

            expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledTimes(1);
        });

        it("records a decline without opening a browser", async () => {
            eligibleSeed();
            vscodeMock.window.showInformationMessage.mockResolvedValue(NEVER_ACTION);
            const service = makeService();
            await service.init();

            service.handleGitSuccess("commit", ["commit"]);
            await service.whenIdle();

            expect(await readLatch()).toMatchObject({ status: "declined" });
            expect(state.get(KEY.status)).toBe("declined");
            expect(vscodeMock.env.openExternal).not.toHaveBeenCalled();
        });

        it("keeps the first decision when a second writer loses the race", async () => {
            await mkdir(path.dirname(latchPath()), { recursive: true });
            await writeFile(latchPath(), JSON.stringify({ status: "declined" }), "utf8");
            eligibleSeed();
            const service = makeService();
            await service.init();

            await service.recordDecision("rated");

            expect(await readLatch()).toMatchObject({ status: "declined" });
            expect(state.get(KEY.status)).toBe("declined");
        });

        it("treats an empty latch left by a crashed writer as a decision", async () => {
            await mkdir(path.dirname(latchPath()), { recursive: true });
            await writeFile(latchPath(), "", "utf8");
            eligibleSeed();
            const service = makeService();
            await service.init();

            service.handleGitSuccess("commit", ["commit"]);
            await service.whenIdle();

            expect(vscodeMock.window.showInformationMessage).not.toHaveBeenCalled();
            expect(await readFile(latchPath(), "utf8")).toBe("");
        });

        it("still opens the review page when mirroring the decision fails", async () => {
            // The latch already carries the decision, so a Memento rejection must not
            // escape recordDecision: the user who clicked Rate would be silenced
            // forever and never reach the review page.
            eligibleSeed();
            vscodeMock.window.showInformationMessage.mockResolvedValue(RATE_ACTION);
            const write = state.update.bind(state);
            state.update = async (key: string, value: unknown): Promise<void> => {
                if (key === KEY.status) throw new Error("globalState unavailable");
                return write(key, value);
            };
            const service = makeService();
            await service.init();

            service.handleGitSuccess("commit", ["commit"]);
            await service.whenIdle();

            expect(await readLatch()).toMatchObject({ status: "rated" });
            expect(state.get(KEY.status)).toBeUndefined();
            expect(vscodeMock.env.openExternal).toHaveBeenCalledTimes(1);
        });

        itPosix("treats an unreadable latch as a decision, not a fresh start", async () => {
            // Only ENOENT proves no decision was ever recorded. A globalStorage the
            // process cannot descend into must not re-prompt someone who declined.
            const latchDir = path.dirname(latchPath());
            await mkdir(latchDir, { recursive: true });
            await writeFile(latchPath(), JSON.stringify({ status: "declined" }), "utf8");
            await chmod(latchDir, 0o000);
            try {
                eligibleSeed();
                const service = makeService();
                await service.init();

                service.handleGitSuccess("commit", ["commit"]);
                await service.whenIdle();

                expect(vscodeMock.window.showInformationMessage).not.toHaveBeenCalled();
            } finally {
                await chmod(latchDir, 0o755);
            }
        });

        itPosix("treats an unprobeable latch as a decision, not a fresh start", async () => {
            // The same rule on the access() path: the gate runs long after init, and
            // storage can become unreadable in between.
            eligibleSeed();
            const service = makeService();
            await service.init();
            const latchDir = path.dirname(latchPath());
            await chmod(latchDir, 0o000);
            try {
                service.handleGitSuccess("commit", ["commit"]);
                await service.whenIdle();

                expect(vscodeMock.window.showInformationMessage).not.toHaveBeenCalled();
            } finally {
                await chmod(latchDir, 0o755);
            }
        });
    });

    describe("durability", () => {
        it("falls back to synced state when the latch cannot be written, and recovers on restart", async () => {
            eligibleSeed();
            vscodeMock.window.showInformationMessage.mockResolvedValue(RATE_ACTION);
            const service = makeService();
            await service.init();
            await removeScratchDirectories(path.join(storageDir, "reviewPrompt"));
            await writeFile(path.join(storageDir, "reviewPrompt"), "not a directory", "utf8");

            service.handleGitSuccess("commit", ["commit"]);
            await service.whenIdle();

            expect(state.get(KEY.status)).toBe("rated");
            expect(vscodeMock.env.openExternal).toHaveBeenCalledTimes(1);

            await rm(path.join(storageDir, "reviewPrompt"), { force: true });
            const restarted = makeService();
            await restarted.init();
            restarted.handleGitSuccess("commit", ["commit"]);
            await restarted.whenIdle();

            expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledTimes(1);
            expect(await readLatch()).toMatchObject({ status: "rated" });
        });

        it("seeds the latch from a decision synced by another machine", async () => {
            eligibleSeed({ [KEY.status]: "rated" });
            const service = makeService();
            await service.init();

            service.handleGitSuccess("commit", ["commit"]);
            await service.whenIdle();

            expect(vscodeMock.window.showInformationMessage).not.toHaveBeenCalled();
            expect(await readLatch()).toMatchObject({ status: "rated" });
        });

        it("registers the decision keys for Settings Sync", async () => {
            const service = makeService();
            await service.init();

            expect(state.synced).toEqual([
                KEY.status,
                KEY.askCount,
                KEY.snoozedUntil,
                KEY.lastAskAt,
            ]);
        });

        it("never lets a later decision overwrite a recorded one", async () => {
            eligibleSeed({ [KEY.status]: "declined" });
            const service = makeService();
            await service.init();

            await service.recordDecision("rated");

            expect(state.get(KEY.status)).toBe("declined");
            expect(await readLatch()).toMatchObject({ status: "declined" });
        });
    });

    describe("registration", () => {
        it("registers an explicit command that shows the same prompt without usage gating", async () => {
            const subscriptions: Array<{ dispose: () => void }> = [];
            await registerReviewPrompt({
                globalState: state as unknown as never,
                globalStorageUri: { fsPath: storageDir } as unknown as never,
                subscriptions,
            } as never);

            const registration = vscodeMock.commands.registerCommand.mock.calls.find(
                ([command]) => command === SHOW_REVIEW_PROMPT_COMMAND,
            );
            expect(registration).toBeDefined();
            (registration?.[1] as () => void)();

            await vi.waitFor(() =>
                expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledWith(
                    PROMPT_MESSAGE,
                    RATE_ACTION,
                    LATER_ACTION,
                    NEVER_ACTION,
                ),
            );
            expect(state.get(KEY.successOps)).toBeUndefined();
        });

        it("does not spend an automatic ask or snooze when the explicit prompt is deferred", async () => {
            vscodeMock.window.showInformationMessage.mockResolvedValue(LATER_ACTION);
            const subscriptions: Array<{ dispose: () => void }> = [];
            await registerReviewPrompt({
                globalState: state as unknown as never,
                globalStorageUri: { fsPath: storageDir } as unknown as never,
                subscriptions,
            } as never);

            const registration = vscodeMock.commands.registerCommand.mock.calls.find(
                ([command]) => command === SHOW_REVIEW_PROMPT_COMMAND,
            );
            (registration?.[1] as () => void)();

            await vi.waitFor(() =>
                expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledTimes(1),
            );
            expect(state.get(KEY.askCount)).toBeUndefined();
            expect(state.get(KEY.snoozedUntil)).toBeUndefined();
            expect(state.get(KEY.successOps)).toBeUndefined();
        });

        it("still shows the explicit prompt after a decision, without reopening it to the gates", async () => {
            await mkdir(path.dirname(latchPath()), { recursive: true });
            await writeFile(
                latchPath(),
                JSON.stringify({ status: "rated", decidedAt: NOW - DAY_MS }),
                "utf8",
            );
            const subscriptions: Array<{ dispose: () => void }> = [];
            await registerReviewPrompt({
                globalState: state as unknown as never,
                globalStorageUri: { fsPath: storageDir } as unknown as never,
                subscriptions,
            } as never);

            const registration = vscodeMock.commands.registerCommand.mock.calls.find(
                ([command]) => command === SHOW_REVIEW_PROMPT_COMMAND,
            );
            (registration?.[1] as () => void)();

            await vi.waitFor(() =>
                expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledTimes(1),
            );
            // The decision still stands for the automatic path: a success must stay silent.
            notifyGitSuccessSafely(["commit", "-m", "msg"]);
            await new Promise((resolve) => setTimeout(resolve, 10));
            expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledTimes(1);
            expect(await readLatch()).toMatchObject({ status: "rated" });
        });

        it("clears the latch and the counters, and asks again on the next success when armed", async () => {
            eligibleSeed();
            const service = makeService();
            await service.init();
            service.handleGitSuccess("commit", ["commit"]);
            await service.whenIdle();
            await service.recordDecision("declined");
            expect(await readLatch()).toMatchObject({ status: "declined" });

            await service.resetState(true);

            expect(existsSync(latchPath())).toBe(false);
            expect(state.get(KEY.status)).toBeUndefined();
            expect(state.get(KEY.askCount)).toBeUndefined();
            expect(state.get(KEY.snoozedUntil)).toBeUndefined();

            vscodeMock.window.showInformationMessage.mockClear();
            service.handleGitSuccess("commit", ["commit"]);
            await service.whenIdle();

            expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledTimes(1);
        });

        it("restores the fresh-install wait when the reset is not armed", async () => {
            eligibleSeed();
            const service = makeService();
            await service.init();
            await service.recordDecision("rated");

            await service.resetState(false);

            expect(existsSync(latchPath())).toBe(false);
            expect(state.get(KEY.successOps)).toBeUndefined();
            expect(state.get(KEY.installedAt)).toBeUndefined();

            vscodeMock.window.showInformationMessage.mockClear();
            service.handleGitSuccess("commit", ["commit"]);
            await service.whenIdle();

            // One operation of credit, no install age: the gate holds exactly as on day one.
            expect(vscodeMock.window.showInformationMessage).not.toHaveBeenCalled();
            expect(state.get(KEY.successOps)).toBe(1);
        });

        it("resets only after the modal is confirmed", async () => {
            const subscriptions: Array<{ dispose: () => void }> = [];
            await mkdir(path.dirname(latchPath()), { recursive: true });
            await writeFile(latchPath(), JSON.stringify({ status: "rated" }), "utf8");
            await registerReviewPrompt({
                globalState: state as unknown as never,
                globalStorageUri: { fsPath: storageDir } as unknown as never,
                subscriptions,
            } as never);
            const reset = vscodeMock.commands.registerCommand.mock.calls.find(
                ([command]) => command === RESET_REVIEW_PROMPT_COMMAND,
            );
            expect(reset).toBeDefined();

            vscodeMock.window.showWarningMessage.mockResolvedValueOnce(undefined);
            await (reset?.[1] as () => Promise<void>)();
            expect(existsSync(latchPath())).toBe(true);

            vscodeMock.window.showWarningMessage.mockResolvedValueOnce(RESET_FRESH_ACTION);
            await (reset?.[1] as () => Promise<void>)();
            expect(existsSync(latchPath())).toBe(false);
            expect(vscodeMock.window.showWarningMessage).toHaveBeenLastCalledWith(
                RESET_CONFIRM_MESSAGE,
                { modal: true, detail: RESET_CONFIRM_DETAIL },
                RESET_ARM_ACTION,
                RESET_FRESH_ACTION,
            );
        });

        it("connects to the Git success hook and disconnects on disposal", async () => {
            const subscriptions: Array<{ dispose: () => void }> = [];
            await registerReviewPrompt({
                globalState: state as unknown as never,
                globalStorageUri: { fsPath: storageDir } as unknown as never,
                subscriptions,
            } as never);

            notifyGitSuccessSafely(["commit", "-m", "msg"]);
            await vi.waitFor(() => expect(state.get<number>(KEY.successOps)).toBe(1));

            for (const subscription of subscriptions) subscription.dispose();
            notifyGitSuccessSafely(["commit", "-m", "msg"]);
            await new Promise((resolve) => setTimeout(resolve, 10));

            expect(state.get<number>(KEY.successOps)).toBe(1);
        });

        it("counts the path-scoped commit the panel actually runs", async () => {
            const subscriptions: Array<{ dispose: () => void }> = [];
            await registerReviewPrompt({
                globalState: state as unknown as never,
                globalStorageUri: { fsPath: storageDir } as unknown as never,
                subscriptions,
            } as never);

            // Checking files in the panel prepends a global option, which pushed the
            // subcommand off argv[0] and hid every such commit from this hook.
            notifyGitSuccessSafely([
                "--literal-pathspecs",
                "commit",
                "-m",
                "msg",
                "--only",
                "--",
                "a.ts",
            ]);

            await vi.waitFor(() => expect(state.get<number>(KEY.successOps)).toBe(1));
        });

        it("survives a context that exposes no global storage", async () => {
            await expect(
                registerReviewPrompt({
                    globalState: state as unknown as never,
                    subscriptions: [],
                } as never),
            ).resolves.toBeUndefined();

            notifyGitSuccessSafely(["commit", "-m", "msg"]);
            await new Promise((resolve) => setTimeout(resolve, 10));

            expect(state.get<number>(KEY.successOps)).toBeUndefined();
        });
    });

    describe("containment", () => {
        it("disables itself instead of failing activation when storage is unusable", async () => {
            await removeScratchDirectories(storageDir);
            await writeFile(storageDir, "not a directory", "utf8");
            const service = makeService();

            await expect(service.init()).resolves.toBeUndefined();

            eligibleSeed();
            service.handleGitSuccess("commit", ["commit"]);
            await service.whenIdle();

            expect(vscodeMock.window.showInformationMessage).not.toHaveBeenCalled();
        });

        it("contains a rejection from the notification itself", async () => {
            eligibleSeed();
            vscodeMock.window.showInformationMessage.mockRejectedValue(new Error("boom"));
            const service = makeService();
            await service.init();

            service.handleGitSuccess("commit", ["commit"]);

            await expect(service.whenIdle()).resolves.toBeUndefined();
            expect(state.get<number>(KEY.askCount)).toBe(1);
        });
    });

    describe("card presentation", () => {
        /** Registers a surface that answers with `result`, or reports itself off screen. */
        const registerHost = (
            result: ReviewPromptResult | undefined,
            visible = true,
        ): { shown: () => number } => {
            let shown = 0;
            registerReviewPromptHost({
                canShowReviewPrompt: () => visible,
                showReviewPrompt: async () => {
                    shown += 1;
                    return result;
                },
            });
            return { shown: () => shown };
        };

        const ask = async (): Promise<ReviewPromptService> => {
            eligibleSeed();
            const service = makeService();
            await service.init();
            service.handleGitSuccess("commit", ["commit", "-m", "msg"]);
            await service.whenIdle();
            return service;
        };

        it("forces the card on command, spending no ask and touching no counter", async () => {
            const host = registerHost({ decision: "later" });
            const service = makeService();
            await service.init();

            service.showCardNow();
            await service.whenIdle();

            expect(host.shown()).toBe(1);
            expect(vscodeMock.window.showInformationMessage).not.toHaveBeenCalled();
            expect(state.get(KEY.askCount)).toBeUndefined();
            expect(state.get(KEY.successOps)).toBeUndefined();
            expect(state.get(KEY.snoozedUntil)).toBeUndefined();
        });

        it("records a decision taken from the forced card", async () => {
            registerHost({ decision: "declined" });
            const service = makeService();
            await service.init();

            service.showCardNow();
            await service.whenIdle();

            expect(await readLatch()).toMatchObject({ status: "declined" });
        });

        it("says why nothing appeared instead of falling back to the notification", async () => {
            const host = registerHost({ decision: "later" }, false);
            const service = makeService();
            await service.init();

            service.showCardNow();
            await service.whenIdle();

            expect(host.shown()).toBe(0);
            expect(vscodeMock.window.showInformationMessage).not.toHaveBeenCalled();
            expect(vscodeMock.window.showWarningMessage).toHaveBeenCalledWith(
                CARD_UNAVAILABLE_MESSAGE,
            );
        });

        it("registers the card command and routes it to the service", async () => {
            const host = registerHost({ decision: "later" });
            await registerReviewPrompt({
                globalState: state as unknown as never,
                globalStorageUri: { fsPath: storageDir } as unknown as never,
                subscriptions: [],
            } as never);

            const registration = vscodeMock.commands.registerCommand.mock.calls.find(
                ([command]) => command === SHOW_REVIEW_PROMPT_CARD_COMMAND,
            );
            await (registration?.[1] as () => Promise<void>)();

            await vi.waitFor(() => expect(host.shown()).toBe(1));
        });

        it("prefers the visible card over the notification", async () => {
            const host = registerHost({ decision: "rated", open: "marketplace" });

            await ask();

            expect(host.shown()).toBe(1);
            expect(vscodeMock.window.showInformationMessage).not.toHaveBeenCalled();
            expect(await readLatch()).toMatchObject({ status: "rated" });
            expect(vscodeMock.env.openExternal).toHaveBeenCalledWith(
                expect.objectContaining({ toString: expect.any(Function) }),
            );
            expect(vscodeMock.env.openExternal.mock.calls[0][0].toString()).toBe(
                MARKETPLACE_REVIEW_URL,
            );
        });

        it("routes a low rating that chose feedback to the issue tracker", async () => {
            registerHost({ decision: "declined", open: "feedback" });

            await ask();

            expect(await readLatch()).toMatchObject({ status: "declined" });
            expect(vscodeMock.env.openExternal.mock.calls[0][0].toString()).toBe(FEEDBACK_URL);
        });

        it("still opens the review page for a low rating that asked to rate anyway", async () => {
            registerHost({ decision: "declined", open: "marketplace" });

            await ask();

            expect(await readLatch()).toMatchObject({ status: "declined" });
            expect(vscodeMock.env.openExternal.mock.calls[0][0].toString()).toBe(
                MARKETPLACE_REVIEW_URL,
            );
        });

        it("leaves no decision and opens nothing when the card is deferred", async () => {
            registerHost({ decision: "later" });

            await ask();

            await expect(readLatch()).rejects.toThrow();
            expect(vscodeMock.env.openExternal).not.toHaveBeenCalled();
            expect(state.get<number>(KEY.askCount)).toBe(1);
        });

        it("falls back to the notification when no surface is on screen", async () => {
            const host = registerHost({ decision: "rated" }, false);

            await ask();

            expect(host.shown()).toBe(0);
            expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledWith(
                PROMPT_MESSAGE,
                RATE_ACTION,
                LATER_ACTION,
                NEVER_ACTION,
            );
        });

        it("falls back to the notification when the surface vanished before answering", async () => {
            const host = registerHost(undefined);

            await ask();

            expect(host.shown()).toBe(1);
            expect(vscodeMock.window.showInformationMessage).toHaveBeenCalled();
        });
    });
});
