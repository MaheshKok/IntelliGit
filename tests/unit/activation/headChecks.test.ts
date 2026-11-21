import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { removeScratchDirectories } from "../../helpers/scratchDirectories";

const vscodeMock = vi.hoisted(() => ({
    commands: new Map<string, (...args: unknown[]) => unknown>(),
    executeCommand: vi.fn(async (..._args: unknown[]) => undefined),
    showInformationMessage: vi.fn(
        async (..._args: unknown[]): Promise<string | undefined> => undefined,
    ),
    showErrorMessage: vi.fn(async (..._args: unknown[]) => undefined),
    answerCiLogMessage: vi.fn(),
}));

vi.mock("vscode", () => ({
    window: {
        state: { focused: true },
        createStatusBarItem: () => ({
            show: () => undefined,
            hide: () => undefined,
            dispose: () => undefined,
        }),
        onDidChangeWindowState: () => ({ dispose: () => undefined }),
        showInformationMessage: vscodeMock.showInformationMessage,
        showErrorMessage: vscodeMock.showErrorMessage,
    },
    workspace: {
        getConfiguration: () => ({ get: (_key: string, fallback?: unknown) => fallback }),
        onDidChangeConfiguration: () => ({ dispose: () => undefined }),
    },
    commands: {
        registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => {
            vscodeMock.commands.set(id, handler);
            return { dispose: () => undefined };
        },
        executeCommand: vscodeMock.executeCommand,
    },
    StatusBarAlignment: { Left: 1 },
    l10n: { t: (message: string) => message },
}));

vi.mock("../../../src/e2e/activationState", () => ({ isE2eControlChannelActive: () => true }));
vi.mock("../../../src/views/ciLogHandler", () => ({
    answerCiLogMessage: vscodeMock.answerCiLogMessage,
}));

import { headCooldownEnd, registerHeadChecks } from "../../../src/activation/headChecks";
import { CiActionFenceStore } from "../../../src/services/commitChecks/ciActionFence";
import { CiGenerations } from "../../../src/services/commitChecks/ciGenerations";
import { HttpError } from "../../../src/services/commitChecks/http";
import {
    PENDING_OBSERVED_KEY,
    REFRESH_HEAD_CHECKS_COMMAND,
    SHOW_HEAD_CHECKS_COMMAND,
} from "../../../src/services/commitChecks/headStatus";
import { CommitChecksRequestGateRegistry } from "../../../src/services/commitChecks/requestGate";
import { NO_CI_CAPABILITIES } from "../../../src/shared/ci/capabilities";
import type { CommitCiDetail } from "../../../src/types";

const HASH = "a".repeat(40);

describe("headCooldownEnd", () => {
    it("a GitLab cooldown does not pause an unrelated healthy GitHub HEAD", async () => {
        const gates = new CommitChecksRequestGateRegistry("cooling down", () => 1_000);
        await expect(
            gates.run("gitlab", "https://gitlab.com/api/v4/projects/o%2Fr", async () => {
                throw new HttpError(429, "HTTP 429", { "retry-after": "60" });
            }),
        ).rejects.toThrow();
        const gitlab = {
            requestBucket: async () => ({
                providerId: "gitlab" as const,
                url: "https://gitlab.com/api/v4/x",
            }),
        };
        const github = {
            requestBucket: async () => ({
                providerId: "github" as const,
                url: "https://api.github.com",
            }),
        };
        await expect(headCooldownEnd(gitlab, gates, HASH)).resolves.toBe(61_000);
        await expect(headCooldownEnd(github, gates, HASH)).resolves.toBe(0);
    });

    it("is 0 when HEAD has no provider bucket", async () => {
        const gates = new CommitChecksRequestGateRegistry("cooling down", () => 1_000);
        const none = { requestBucket: vi.fn(async () => undefined) };
        await expect(headCooldownEnd(none, gates, HASH)).resolves.toBe(0);
        expect(none.requestBucket).toHaveBeenCalledWith(HASH);
    });
});

describe("registerHeadChecks commands", () => {
    function register(
        fences?: unknown,
        extra: { storage?: string; workspaceState?: unknown; source?: unknown } = {},
    ) {
        vscodeMock.commands.clear();
        vscodeMock.executeCommand.mockClear();
        const checks = {
            getChecks: vi.fn(),
            getDetail: vi.fn(),
            invalidateDetail: vi.fn(),
            capabilities: vi.fn(),
            requestBucket: vi.fn(async () => undefined),
        };
        const commitGraph = {
            ciDetailSource: () => extra.source ?? {},
            headChecksSource: () => checks,
            openChecksTab: vi.fn(),
        };
        const monitor = registerHeadChecks({
            context: {
                subscriptions: [],
                globalStorageUri: { fsPath: extra.storage ?? "/storage" },
                workspaceState: extra.workspaceState ?? {
                    get: () => undefined,
                    update: async () => undefined,
                },
            } as never,
            commitGraph: commitGraph as never,
            gitOps: { getUnpushedCommitHashes: async () => [] } as never,
            executor: { run: async () => `${HASH}\n` } as never,
            repoRoot: () => "/repo",
            generations: new CiGenerations(),
            requestGates: new CommitChecksRequestGateRegistry("cooling down"),
            fences: fences as never,
            trace: () => undefined,
        });
        return { checks, commitGraph, monitor };
    }

    it("a new HEAD action fence wakes a monitor that already stopped on a settled HEAD", async () => {
        let onFence: ((change: { repoKey: string; hash: string }) => void) | undefined;
        const disposeListener = vi.fn();
        const { checks, monitor } = register({
            isFenced: () => false,
            onDidBegin: (listener: typeof onFence) => {
                onFence = listener;
                return { dispose: disposeListener };
            },
        });
        checks.capabilities.mockResolvedValue({ runs: true, jobs: true });
        checks.getChecks.mockResolvedValue({
            hash: HASH,
            state: "success",
            summary: "",
            items: [],
        });
        await monitor?.onRepositoryChanged();
        await new Promise((resolve) => setImmediate(resolve));
        expect(monitor?.isPolling(), "a settled HEAD stops the monitor").toBe(false);
        const before = checks.getChecks.mock.calls.length;
        onFence?.({ repoKey: "/repo", hash: HASH });
        await new Promise((resolve) => setImmediate(resolve));
        expect(
            checks.getChecks.mock.calls.length,
            "a new HEAD action fence must wake the settled monitor",
        ).toBeGreaterThan(before);
        monitor?.dispose();
    });

    it("real fence begin wakes a monitor that already stopped on a settled HEAD", async () => {
        const values = new Map<string, unknown>();
        const fences = new CiActionFenceStore({
            get: <T>(key: string) => values.get(key) as T | undefined,
            keys: () => [...values.keys()],
            update: async (key, value) => {
                values.set(key, value);
            },
        });
        const { checks, monitor } = register(fences);
        checks.capabilities.mockResolvedValue({ runs: true, jobs: true });
        checks.getChecks.mockResolvedValue({
            hash: HASH,
            state: "success",
            summary: "",
            items: [],
        });
        await monitor?.onRepositoryChanged();
        await new Promise((resolve) => setImmediate(resolve));
        expect(monitor?.isPolling(), "a settled HEAD stops the monitor").toBe(false);
        const before = checks.getChecks.mock.calls.length;
        await fences.begin({
            repoKey: "/repo",
            hash: HASH,
            provider: "github",
            action: "rerunFailed",
            targetId: "77",
            runId: "77",
            before: { attempt: 1, state: "failure" },
            evidence: "runAttempt",
        });
        await new Promise((resolve) => setImmediate(resolve));
        expect(
            checks.getChecks.mock.calls.length,
            "a new HEAD action fence on the real store must wake the settled monitor",
        ).toBeGreaterThan(before);
        monitor?.dispose();
        fences.dispose();
    });

    it("Show HEAD checks opens the Git Log and posts openChecksTab for HEAD", async () => {
        const { commitGraph, monitor } = register();
        await vscodeMock.commands.get(SHOW_HEAD_CHECKS_COMMAND)?.();
        expect(
            vscodeMock.executeCommand,
            "Show HEAD checks opens the Git Log first",
        ).toHaveBeenCalledWith("intelligit.showGitLog");
        expect(
            commitGraph.openChecksTab,
            "Show HEAD checks posts openChecksTab with HEAD's hash",
        ).toHaveBeenCalledWith(HASH);
        monitor?.dispose();
    });

    it("Show HEAD checks is not a refresh: it sends no CI request", async () => {
        const { checks, commitGraph, monitor } = register();
        const refresh = vi.spyOn(monitor!, "refresh");
        await vscodeMock.commands.get(SHOW_HEAD_CHECKS_COMMAND)?.();
        expect(refresh, "Show HEAD checks must not run the refresh command").not.toHaveBeenCalled();
        expect(checks.getChecks).not.toHaveBeenCalled();
        expect(
            commitGraph.openChecksTab,
            "Show HEAD checks opens the Checks tab",
        ).toHaveBeenCalledTimes(1);
        await vscodeMock.commands.get(REFRESH_HEAD_CHECKS_COMMAND)?.();
        expect(refresh, "Refresh HEAD checks runs the refresh").toHaveBeenCalledTimes(1);
        monitor?.dispose();
    });

    describe("forge text in error notifications", () => {
        // VS Code turns "[label](command:...)" in a notification into a link that runs the command.
        const LINK = "[Open Checks](command:workbench.action.terminal.new)";
        const PLAIN = "Open Checks(command:workbench.action.terminal.new)";

        function failedDetail(): CommitCiDetail {
            return {
                hash: HASH,
                provider: "github",
                complete: true,
                outcome: "failure",
                runs: [
                    {
                        id: "run-1",
                        name: "CI",
                        state: "failure",
                        jobs: [
                            {
                                id: "job-0",
                                logicalId: "ci/job-0",
                                name: "job-0",
                                checkName: "job-0",
                                state: "failure",
                                steps: [],
                            },
                        ],
                        jobsCoverage: "full",
                    },
                ],
                runsCoverage: "full",
                otherChecks: [],
                otherChecksCoverage: "full",
                capabilities: {
                    ...NO_CI_CAPABILITIES,
                    runs: true,
                    jobs: true,
                    logs: true,
                    rerunFailed: true,
                },
                repoKey: "/repo",
            };
        }

        /** Settles HEAD as failed, the user picks `choice` on the toast, and returns the error texts shown. */
        async function chooseOnFailedToast(choice: string, source: unknown): Promise<unknown[]> {
            const storage = await mkdtemp(path.join(os.tmpdir(), "intelligit-head-checks-"));
            try {
                const values = new Map<string, unknown>([
                    [
                        PENDING_OBSERVED_KEY,
                        [{ repoKey: "/repo", hash: HASH, observedAt: Date.now() }],
                    ],
                ]);
                const workspaceState = {
                    get: (key: string) => values.get(key),
                    update: async (key: string, value: unknown) => {
                        values.set(key, value);
                    },
                };
                vscodeMock.showErrorMessage.mockClear();
                vscodeMock.showInformationMessage.mockClear();
                vscodeMock.showInformationMessage.mockResolvedValueOnce(choice);
                const { checks, monitor } = register(undefined, {
                    storage,
                    workspaceState,
                    source,
                });
                checks.capabilities.mockResolvedValue(failedDetail().capabilities);
                checks.getChecks.mockResolvedValue({
                    hash: HASH,
                    state: "failure",
                    summary: "",
                    items: [
                        { name: "job-0", description: "", state: "failure", source: "check-run" },
                    ],
                });
                checks.getDetail.mockResolvedValue(failedDetail());
                await monitor?.onRepositoryChanged();
                for (let i = 0; i < 10; i += 1)
                    await new Promise((resolve) => setImmediate(resolve));
                expect(
                    vscodeMock.showInformationMessage,
                    "the failed HEAD must show its settle toast",
                ).toHaveBeenCalledTimes(1);
                monitor?.dispose();
                return vscodeMock.showErrorMessage.mock.calls.map((call) => call[0]);
            } finally {
                await removeScratchDirectories(storage);
            }
        }

        it("a log-open error holding a command link is shown without brackets", async () => {
            vscodeMock.answerCiLogMessage.mockImplementationOnce(
                async (_source: unknown, _message: unknown, reply: (r: unknown) => void) => {
                    reply({ outcome: "failed", message: LINK });
                },
            );
            const shown = await chooseOnFailedToast("Open log", {});
            expect(
                shown,
                "headChecks openLog reply.message must reach the error notification as plain text",
            ).toEqual([PLAIN]);
        });

        it.each(["failed", "signedOut"])(
            "a %s re-run error holding a command link is shown without brackets",
            async (outcome) => {
                const source = {
                    actions: { run: vi.fn(async () => ({ outcome, message: LINK })) },
                };
                const shown = await chooseOnFailedToast("Re-run failed", source);
                expect(
                    shown,
                    "headChecks rerunFailed result.message must reach the error notification as plain text",
                ).toEqual([PLAIN]);
            },
        );
    });
});
