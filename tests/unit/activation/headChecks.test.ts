import { describe, expect, it, vi } from "vitest";

const vscodeMock = vi.hoisted(() => ({
    commands: new Map<string, (...args: unknown[]) => unknown>(),
    executeCommand: vi.fn(async (..._args: unknown[]) => undefined),
}));

vi.mock("vscode", () => ({
    window: {
        state: { focused: true },
        createStatusBarItem: () => ({ show: () => undefined, hide: () => undefined }),
        onDidChangeWindowState: () => ({ dispose: () => undefined }),
        showInformationMessage: async () => undefined,
        showErrorMessage: async () => undefined,
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

import { headCooldownEnd, registerHeadChecks } from "../../../src/activation/headChecks";
import { CiGenerations } from "../../../src/services/commitChecks/ciGenerations";
import { HttpError } from "../../../src/services/commitChecks/http";
import {
    REFRESH_HEAD_CHECKS_COMMAND,
    SHOW_HEAD_CHECKS_COMMAND,
} from "../../../src/services/commitChecks/headStatus";
import { CommitChecksRequestGateRegistry } from "../../../src/services/commitChecks/requestGate";

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
    function register() {
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
            ciDetailSource: () => ({}),
            headChecksSource: () => checks,
            openChecksTab: vi.fn(),
        };
        const monitor = registerHeadChecks({
            context: {
                subscriptions: [],
                globalStorageUri: { fsPath: "/storage" },
                workspaceState: { get: () => undefined, update: async () => undefined },
            } as never,
            commitGraph: commitGraph as never,
            gitOps: {} as never,
            executor: { run: async () => `${HASH}\n` } as never,
            repoRoot: () => "/repo",
            generations: new CiGenerations(),
            requestGates: new CommitChecksRequestGateRegistry("cooling down"),
            fences: undefined,
            trace: () => undefined,
        });
        return { checks, commitGraph, monitor };
    }

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
});
