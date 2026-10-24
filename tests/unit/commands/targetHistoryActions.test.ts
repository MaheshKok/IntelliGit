import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const vscodeMock = vi.hoisted(() => ({
    l10n: {
        t: (message: string, args?: Record<string, string | number>) =>
            args
                ? Object.entries(args).reduce(
                      (text, [key, value]) => text.replaceAll(`{${key}}`, String(value)),
                      message,
                  )
                : message,
    },
    window: {
        showErrorMessage: vi.fn(),
        showInformationMessage: vi.fn(),
        showWarningMessage: vi.fn(),
    },
}));

vi.mock("vscode", () => vscodeMock);
vi.mock("../../../src/utils/notifications", () => ({ showTimedInformationMessage: vi.fn() }));
vi.mock("../../../src/services/gitHelpers", () => ({ pickMainlineParent: vi.fn() }));
vi.mock("../../../src/commands/changelistTarget", () => ({ pickChangelistTarget: vi.fn() }));

import * as vscode from "vscode";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ABSENT_GIT_CONFIG_GLOBAL } from "../../helpers/gitConfigIsolation";
import {
    cherryPickToChangelist,
    revertToChangelist,
    undoCommitRoute,
} from "../../../src/commands/targetHistoryActions";
import { ChangelistStore } from "../../../src/changes/changelistStore";
import { GitExecutor } from "../../../src/git/executor";
import { GitOps } from "../../../src/git/operations";
import { removeScratchDirectories } from "../../helpers/scratchDirectories";
import { pickChangelistTarget } from "../../../src/commands/changelistTarget";
import { pickMainlineParent } from "../../../src/services/gitHelpers";
import { showTimedInformationMessage } from "../../../src/utils/notifications";
import type { CommitActionContext } from "../../../src/commands/commitActionContext";
import type { TargetHistoryRequest } from "../../../src/git/targetHistoryOperation";
import type { ChangelistState } from "../../../src/webviews/protocol/changeSelection";

const HASH = "a".repeat(40);
const HEAD = "b".repeat(40);
const STATE = { revision: 7, lists: [] } as unknown as ChangelistState;
const TARGET = { kind: "existing" as const, id: "default", revision: 7 };

function asMock(fn: unknown): Mock {
    return fn as unknown as Mock;
}

/** The fake GitOps runs the real prompt callback and records the single request it produced. */
function contextFor(outcome: "applied" | "notApplied" = "applied") {
    const requests: TargetHistoryRequest[] = [];
    const run = vi.fn(async (args: string[]) => (args[0] === "rev-parse" ? `${HEAD}\n` : ""));
    const applyTargetHistory = vi.fn(
        async (
            _root: string,
            _store: unknown,
            prompt: (state: ChangelistState) => Promise<TargetHistoryRequest | undefined>,
        ) => {
            const request = await prompt(STATE);
            if (!request) return { status: "cancelled" as const };
            requests.push(request);
            return {
                status: "handled" as const,
                result: { id: request.id, outcome, reason: "refused for test" },
            };
        },
    );
    const refreshAll = vi.fn(async () => undefined);
    const context = {
        validatedHash: HASH,
        short: HASH.slice(0, 8),
        executor: { run },
        gitOps: { applyTargetHistory },
        repoRoot: "/repo",
        changelists: {},
        refreshAll,
    } as unknown as CommitActionContext;
    return { context, requests, run, applyTargetHistory, refreshAll };
}

beforeEach(() => {
    vi.clearAllMocks();
    asMock(pickMainlineParent).mockResolvedValue({ kind: "notMerge" });
    asMock(pickChangelistTarget).mockResolvedValue({ target: TARGET });
});

describe("targeted history commands", () => {
    it.each([
        ["cherryPick", cherryPickToChangelist, "Cherry-pick Without Committing"],
        ["revert", revertToChangelist, "Revert Without Committing"],
    ] as const)(
        "targeted %s sends one captured uncommitted intent to the chosen changelist",
        async (kind, action, label) => {
            asMock(vscode.window.showWarningMessage).mockResolvedValue(label);
            asMock(pickMainlineParent).mockResolvedValue({ kind: "selected", parentNumber: 2 });
            const f = contextFor();
            await action(f.context);
            expect(f.requests).toHaveLength(1);
            expect(f.requests[0], "the request carries the HEAD captured before prompts").toEqual(
                expect.objectContaining({
                    kind,
                    commit: HASH,
                    head: HEAD,
                    mainline: 2,
                    target: TARGET,
                }),
            );
            expect(
                asMock(f.run).mock.invocationCallOrder[0],
                "HEAD is read before the confirmation prompt",
            ).toBeLessThan(asMock(vscode.window.showWarningMessage).mock.invocationCallOrder[0]);
            expect(f.applyTargetHistory.mock.calls[0][0]).toBe("/repo");
            expect(
                f.run.mock.calls.filter(([args]) => args[0] !== "rev-parse"),
                "the command layer never runs history Git itself",
            ).toHaveLength(0);
            expect(showTimedInformationMessage).toHaveBeenCalledTimes(1);
            expect(f.refreshAll).toHaveBeenCalledTimes(1);
        },
    );

    it("cancelled target leaves Git and views untouched", async () => {
        asMock(vscode.window.showWarningMessage).mockResolvedValue(
            "Cherry-pick Without Committing",
        );
        asMock(pickChangelistTarget).mockResolvedValue(undefined);
        const f = contextFor();
        await cherryPickToChangelist(f.context);
        expect(f.requests).toHaveLength(0);
        expect(f.refreshAll).not.toHaveBeenCalled();
        expect(showTimedInformationMessage).not.toHaveBeenCalled();
    });

    it("dismissed confirmation never asks for a target", async () => {
        asMock(vscode.window.showWarningMessage).mockResolvedValue(undefined);
        const f = contextFor();
        await revertToChangelist(f.context);
        expect(f.applyTargetHistory).not.toHaveBeenCalled();
        expect(pickMainlineParent).not.toHaveBeenCalled();
    });

    it("a refused intent reports its reason and is not shown as success", async () => {
        asMock(vscode.window.showWarningMessage).mockResolvedValue(
            "Cherry-pick Without Committing",
        );
        const f = contextFor("notApplied");
        await cherryPickToChangelist(f.context);
        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining("refused for test"),
        );
        expect(showTimedInformationMessage).not.toHaveBeenCalled();
    });
});

it("undoCommitRoute connects the captured root and runs the plain undo there", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "undo-route-")));
    try {
        const executor = new GitExecutor(root, undefined, {
            GIT_CONFIG_GLOBAL: ABSENT_GIT_CONFIG_GLOBAL,
            GIT_CONFIG_NOSYSTEM: "1",
        });
        await executor.run(["init", "-q"]);
        await executor.run(["config", "user.name", "Fixture"]);
        await executor.run(["config", "user.email", "fixture@example.invalid"]);
        await writeFile(path.join(root, "file"), "base\n");
        await executor.run(["add", "file"]);
        await executor.run(["commit", "-qm", "base"]);
        const parent = (await executor.run(["rev-parse", "HEAD"])).trim();
        await writeFile(path.join(root, "file"), "change\n");
        await executor.run(["commit", "-qam", "change"]);
        const head = (await executor.run(["rev-parse", "HEAD"])).trim();
        await writeFile(path.join(root, "file"), "local edit\n");
        const context = {
            executor,
            gitOps: new GitOps(executor),
            repoRoot: root,
            changelists: new ChangelistStore(),
        } as unknown as CommitActionContext;
        expect(
            await undoCommitRoute(context, { commit: head, head }),
            "an unconnected store is connected at the captured root before the decision",
        ).toEqual({ route: "plainReset", path: "file", reason: "localChanges" });
        expect((await executor.run(["rev-parse", "HEAD"])).trim()).toBe(parent);
        expect(await readFile(path.join(root, "file"), "utf8")).toBe("local edit\n");
    } finally {
        await removeScratchDirectories(root);
    }
}, 30_000);
