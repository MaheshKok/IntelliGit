import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitOps } from "../../../src/git/operations";

const hashA = "a".repeat(40);
const hashB = "b".repeat(40);
const stash = (index: number, hash: string) => ({
    index,
    hash,
    message: "On main: work",
    date: "today",
});
const mocks = vi.hoisted(() => {
    class Uri {
        constructor(
            readonly fsPath: string,
            readonly scheme = "file",
        ) {}
    }
    return {
        Uri,
        activeUri: new Uri("/repo-a/active.txt") as Uri | undefined,
        realpath: vi.fn(async (value: string) => value),
        discover: vi.fn(async () => "/repo-b\n"),
        operation: vi.fn(async () => "none"),
        dirty: vi.fn(async () => false),
        list: vi.fn(async () => [] as ReturnType<typeof stash>[]),
        apply: vi.fn(async () => ""),
        branch: vi.fn(async () => ""),
        drop: vi.fn(async () => ""),
        branches: vi.fn(async () => [] as { name: string; isRemote: boolean }[]),
        conflicts: vi.fn(async () => [] as { path: string }[]),
        activeOperation: vi.fn(async () => "none"),
        activeDirty: vi.fn(async () => false),
        activeList: vi.fn(async () => [] as ReturnType<typeof stash>[]),
        activeApply: vi.fn(async () => ""),
        activeBranch: vi.fn(async () => ""),
        activeDrop: vi.fn(async () => ""),
        activeBranches: vi.fn(async () => [] as { name: string; isRemote: boolean }[]),
        activeConflicts: vi.fn(async () => [] as { path: string }[]),
        quickPick: vi.fn(),
        input: vi.fn(async () => "feature/unstash" as string | undefined),
        error: vi.fn(),
        info: vi.fn(),
        warning: vi.fn(),
        timedInfo: vi.fn(),
        timedWarning: vi.fn(),
    };
});

vi.mock("node:fs/promises", () => ({ realpath: mocks.realpath }));
vi.mock("vscode", () => ({
    Uri: mocks.Uri,
    window: {
        get activeTextEditor() {
            return { document: { uri: mocks.activeUri } };
        },
        showQuickPick: mocks.quickPick,
        showInputBox: mocks.input,
        showErrorMessage: mocks.error,
        showInformationMessage: mocks.info,
        showWarningMessage: mocks.warning,
    },
    l10n: {
        t: (message: string, args?: Record<string, unknown>) =>
            Object.entries(args ?? {}).reduce(
                (text, [key, value]) => text.replaceAll(`{${key}}`, String(value)),
                message,
            ),
    },
}));
vi.mock("../../../src/git/executor", () => ({
    GitExecutor: class {
        run = mocks.discover;
    },
}));
vi.mock("../../../src/services/diffService", () => ({}));
vi.mock("../../../src/utils/notifications", () => ({
    showTimedInformationMessage: mocks.timedInfo,
    showTimedWarningMessage: mocks.timedWarning,
}));

import { unstashChangesFromContext } from "../../../src/commands/fileContextCommands";

const scoped = {
    getActiveOperation: mocks.operation,
    hasUncommittedChanges: mocks.dirty,
    listStashesOrThrow: mocks.list,
    stashApplyByHash: mocks.apply,
    stashBranchByHash: mocks.branch,
    stashDeleteIfHashMatches: mocks.drop,
    getBranches: mocks.branches,
    getConflictFilesDetailed: mocks.conflicts,
} as unknown as GitOps;
const deriveFor = vi.fn(() => scoped);
const gitOps = {
    deriveFor,
    getActiveOperation: mocks.activeOperation,
    hasUncommittedChanges: mocks.activeDirty,
    listStashesOrThrow: mocks.activeList,
    stashApplyByHash: mocks.activeApply,
    stashBranchByHash: mocks.activeBranch,
    stashDeleteIfHashMatches: mocks.activeDrop,
    getBranches: mocks.activeBranches,
    getConflictFilesDetailed: mocks.activeConflicts,
} as unknown as GitOps;
const refresh = vi.fn(async (_root: string) => undefined);
const openConflicts = vi.fn(async (_ops: GitOps, _root: string) => undefined);
const selected = () => new mocks.Uri("/repo-b/selected.txt");
const run = () =>
    unstashChangesFromContext(selected(), gitOps, { refresh, openConflictSession: openConflicts });
let choices: Array<number | undefined>;

beforeEach(() => {
    vi.clearAllMocks();
    choices = [0, 0, 0];
    mocks.activeUri = new mocks.Uri("/repo-a/active.txt");
    mocks.discover.mockResolvedValue("/repo-b\n");
    mocks.operation.mockResolvedValue("none");
    mocks.dirty.mockResolvedValue(false);
    mocks.list.mockResolvedValue([stash(0, hashA)]);
    mocks.branches.mockResolvedValue([]);
    mocks.activeOperation.mockResolvedValue("none");
    mocks.activeDirty.mockResolvedValue(false);
    mocks.activeList.mockResolvedValue([stash(0, hashB)]);
    mocks.activeBranches.mockResolvedValue([]);
    mocks.input.mockResolvedValue("feature/unstash");
    mocks.quickPick.mockImplementation(async (items: unknown[]) => {
        const choice = choices.shift();
        return choice === undefined ? undefined : items[choice];
    });
});

describe("native Unstash Changes repository contract", () => {
    it("contributes exactly once after Stash in both submenus and all three native contexts", () => {
        const manifest = JSON.parse(
            readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
        );
        expect(
            manifest.contributes.commands.filter(
                (item: { command: string }) =>
                    item.command === "intelligit.fileContextUnstashChanges",
            ),
        ).toHaveLength(1);
        for (const menu of ["intelligit.fileContext", "intelligit.editorContext"]) {
            const entries = manifest.contributes.menus[menu];
            const index = entries.findIndex(
                (item: { command: string }) => item.command === "intelligit.fileStashChanges",
            );
            expect(entries[index + 1], `${menu} follows Stash`).toEqual({
                command: "intelligit.fileContextUnstashChanges",
                when: "resourceScheme == file",
                group: "4_branch@8",
            });
        }
        for (const menu of ["explorer/context", "editor/title/context", "editor/context"]) {
            expect(
                manifest.contributes.menus[menu].some(
                    (item: { submenu?: string }) =>
                        item.submenu ===
                        (menu === "editor/context"
                            ? "intelligit.editorContext"
                            : "intelligit.fileContext"),
                ),
            ).toBe(true);
        }
    });

    it("applies clicked B by full OID, keeps its stash and A untouched", async () => {
        await run();
        expect(deriveFor, "clicked B derives one scoped executor").toHaveBeenCalledExactlyOnceWith(
            "/repo-b",
        );
        expect(mocks.activeApply, "active A must not mutate").not.toHaveBeenCalled();
        expect(mocks.quickPick).toHaveBeenCalledTimes(3);
        expect(mocks.quickPick.mock.calls[0][0][0]).toEqual(
            expect.objectContaining({
                label: "stash@{0}",
                description: "On main: work",
                hash: hashA,
                detail: expect.stringContaining("/repo-b"),
            }),
        );
        expect(mocks.apply).toHaveBeenCalledExactlyOnceWith(hashA, false);
        expect(mocks.drop).not.toHaveBeenCalled();
        expect(refresh).toHaveBeenCalledExactlyOnceWith("/repo-b");
        expect(mocks.timedInfo).toHaveBeenCalledWith("Stash applied. The stash was kept.");
    });

    it("uses the selected OID after a newer stash renumbers its selector during prompts", async () => {
        mocks.quickPick.mockImplementationOnce(async (items: unknown[]) => {
            mocks.list.mockResolvedValue([stash(0, hashB), stash(1, hashA)]);
            return items[0];
        });
        await run();
        expect(mocks.apply, "original OID despite ordinal shift").toHaveBeenCalledWith(
            hashA,
            false,
        );
    });

    it("rejects a missing selected OID before mutation", async () => {
        mocks.list
            .mockResolvedValueOnce([stash(0, hashA)])
            .mockResolvedValueOnce([stash(0, hashB)]);
        await run();
        expect(mocks.apply).not.toHaveBeenCalled();
        expect(mocks.error).toHaveBeenCalledWith(expect.stringContaining("selected stash changed"));
    });

    it("rejects duplicate selected OIDs before mutation", async () => {
        mocks.list
            .mockResolvedValueOnce([stash(0, hashA)])
            .mockResolvedValueOnce([stash(0, hashA), stash(1, hashA)]);
        await run();
        expect(mocks.apply).not.toHaveBeenCalled();
        expect(mocks.error).toHaveBeenCalledWith(expect.stringContaining("uniquely available"));
    });

    it.each([0, 1, 2])("cancels prompt %i without any mutation or refresh", async (cancelAt) => {
        choices[cancelAt] = undefined;
        await run();
        expect(mocks.apply).not.toHaveBeenCalled();
        expect(mocks.branch).not.toHaveBeenCalled();
        expect(mocks.drop).not.toHaveBeenCalled();
        expect(refresh).not.toHaveBeenCalled();
    });

    it("rejects dirty B before prompts and after prompts", async () => {
        mocks.dirty.mockResolvedValueOnce(true);
        await run();
        expect(mocks.quickPick).not.toHaveBeenCalled();
        mocks.dirty.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
        await run();
        expect(mocks.apply).not.toHaveBeenCalled();
        expect(refresh).not.toHaveBeenCalled();
    });

    it("rechecks the operation fence after prompts", async () => {
        mocks.operation.mockResolvedValueOnce("none").mockResolvedValueOnce("merge");
        await run();
        expect(mocks.apply, "post-prompt operation fence").not.toHaveBeenCalled();
        expect(refresh).not.toHaveBeenCalled();
    });

    it("reports strict list failure separately from an empty stash stack", async () => {
        mocks.list.mockRejectedValueOnce(new Error("list failed"));
        await run();
        expect(mocks.error).toHaveBeenCalledWith(expect.stringContaining("list failed"));
        expect(mocks.info).not.toHaveBeenCalledWith(expect.stringContaining("No stashes"));
        mocks.list.mockResolvedValueOnce([]);
        await run();
        expect(mocks.info).toHaveBeenCalledWith("No stashes found in /repo-b.");
        expect(mocks.apply).not.toHaveBeenCalled();
    });

    it("reinstate index sends true only on explicit second choice", async () => {
        choices = [0, 0, 1];
        await run();
        expect(mocks.apply).toHaveBeenCalledExactlyOnceWith(hashA, true);
    });

    it("Pop applies then verifies the current selector and drops only after success", async () => {
        choices = [0, 1, 0];
        mocks.list
            .mockResolvedValueOnce([stash(0, hashA)])
            .mockResolvedValueOnce([stash(0, hashA)])
            .mockResolvedValueOnce([stash(0, hashB), stash(1, hashA)]);
        await run();
        expect(mocks.apply).toHaveBeenCalledExactlyOnceWith(hashA, false);
        expect(mocks.drop).toHaveBeenCalledExactlyOnceWith(1, hashA);
        expect(mocks.timedInfo).toHaveBeenCalledWith("Stash applied and removed.");
    });

    it("failed apply keeps the stash, opens B conflicts and refreshes once", async () => {
        choices = [0, 1, 0];
        mocks.apply.mockRejectedValueOnce(new Error("conflict"));
        mocks.conflicts.mockResolvedValueOnce([{ path: "selected.txt" }]);
        await run();
        expect(openConflicts).toHaveBeenCalledExactlyOnceWith(scoped, "/repo-b");
        expect(mocks.drop).not.toHaveBeenCalled();
        expect(refresh).toHaveBeenCalledExactlyOnceWith("/repo-b");
        expect(mocks.timedInfo).not.toHaveBeenCalled();
    });

    it("reports a failed conflict view separately from successful conflict inspection", async () => {
        mocks.apply.mockRejectedValueOnce(new Error("Git found conflicts"));
        mocks.conflicts.mockResolvedValueOnce([{ path: "selected.txt" }]);
        openConflicts.mockRejectedValueOnce(new Error("view unavailable"));
        await run();
        expect(mocks.error).toHaveBeenCalledWith(
            expect.stringContaining("Unable to open conflict view: view unavailable"),
        );
        expect(mocks.error).toHaveBeenCalledWith(expect.stringContaining("Git found conflicts"));
        expect(mocks.error).not.toHaveBeenCalledWith(
            expect.stringContaining("Unable to inspect conflicts"),
        );
        expect(mocks.drop).not.toHaveBeenCalled();
        expect(refresh).toHaveBeenCalledExactlyOnceWith("/repo-b");
    });

    it("reports post-apply list failure as partial success without deletion", async () => {
        choices = [0, 1, 0];
        mocks.list
            .mockResolvedValueOnce([stash(0, hashA)])
            .mockResolvedValueOnce([stash(0, hashA)])
            .mockRejectedValueOnce(new Error("list failed"));
        await run();
        expect(mocks.drop).not.toHaveBeenCalled();
        expect(mocks.timedWarning).toHaveBeenCalledWith(expect.stringContaining("list failed"));
        expect(mocks.timedInfo).not.toHaveBeenCalled();
    });

    it("does not drop after failed apply or unsafe post-apply identity", async () => {
        choices = [0, 1, 0];
        mocks.apply.mockRejectedValueOnce(new Error("apply failed"));
        await run();
        expect(mocks.drop, "failed apply retains stash").not.toHaveBeenCalled();
        choices = [0, 1, 0];
        mocks.list
            .mockResolvedValueOnce([stash(0, hashA)])
            .mockResolvedValueOnce([stash(0, hashA)])
            .mockResolvedValueOnce([stash(0, hashB)]);
        await run();
        expect(mocks.drop, "missing selected OID retains stash").not.toHaveBeenCalled();
        expect(mocks.timedWarning).toHaveBeenCalledWith(
            expect.stringContaining("could not be safely removed"),
        );
    });

    it("reports checked drop failure without retrying apply or claiming removal", async () => {
        choices = [0, 1, 0];
        mocks.drop.mockRejectedValueOnce(new Error("selector changed"));
        await run();
        expect(mocks.apply).toHaveBeenCalledOnce();
        expect(mocks.drop).toHaveBeenCalledOnce();
        expect(mocks.timedInfo).not.toHaveBeenCalled();
        expect(mocks.timedWarning).toHaveBeenCalledWith(
            expect.stringContaining("selector changed"),
        );
    });

    it("new branch validates the name and uses full OID, then checked removal", async () => {
        choices = [0, 2];
        await run();
        const options = mocks.input.mock.calls[0][0];
        expect(await options.validateInput("--bad")).toBeTruthy();
        mocks.branches.mockResolvedValueOnce([{ name: "feature/existing", isRemote: false }]);
        expect(await options.validateInput("feature/existing")).toBeTruthy();
        expect(mocks.branch).toHaveBeenCalledExactlyOnceWith("feature/unstash", hashA);
        expect(mocks.drop).toHaveBeenCalledExactlyOnceWith(0, hashA);
        expect(mocks.quickPick).toHaveBeenCalledTimes(2);
    });

    it("failed branch restore warns HEAD may have changed and retains the stash", async () => {
        choices = [0, 2];
        mocks.branch.mockRejectedValueOnce(new Error("branch restore failed"));
        await run();
        expect(mocks.error, "partial branch outcome is disclosed").toHaveBeenCalledWith(
            expect.stringContaining("Branch or HEAD may have changed"),
        );
        expect(mocks.error).toHaveBeenCalledWith(expect.stringContaining("branch restore failed"));
        expect(mocks.drop).not.toHaveBeenCalled();
        expect(refresh).toHaveBeenCalledExactlyOnceWith("/repo-b");
        expect(mocks.timedInfo, "failed branch never claims success").not.toHaveBeenCalled();
    });

    it("a branch probe changing B dirty state cannot bypass the final guard", async () => {
        choices = [0, 2];
        mocks.branches.mockImplementationOnce(async () => {
            mocks.dirty.mockResolvedValueOnce(true);
            return [];
        });
        await run();
        expect(mocks.branch, "post-probe dirty guard").not.toHaveBeenCalled();
    });

    it("rejects a branch that appeared during the input prompt", async () => {
        choices = [0, 2];
        mocks.branches.mockResolvedValueOnce([{ name: "feature/unstash", isRemote: false }]);
        await run();
        expect(mocks.branch).not.toHaveBeenCalled();
        expect(mocks.error).toHaveBeenCalledWith(expect.stringContaining("already exists"));
    });

    it("reports refresh failure after successful application without retrying Git", async () => {
        refresh.mockRejectedValueOnce(new Error("panel failed"));
        await run();
        expect(mocks.apply).toHaveBeenCalledOnce();
        expect(mocks.error).toHaveBeenCalledWith(
            expect.stringContaining("refreshing IntelliGit failed: panel failed"),
        );
        expect(mocks.timedInfo, "refresh failure never claims success").not.toHaveBeenCalled();
    });

    it("does not report success when refreshing rejects with an empty message", async () => {
        refresh.mockRejectedValueOnce(new Error(""));
        await run();
        expect(mocks.timedInfo).not.toHaveBeenCalled();
        expect(mocks.error).toHaveBeenCalledWith(
            expect.stringContaining("refreshing IntelliGit failed"),
        );
    });

    it("reports failed apply and failed refresh without claiming application", async () => {
        mocks.apply.mockRejectedValueOnce(new Error("apply failed"));
        refresh.mockRejectedValueOnce(new Error("panel failed"));
        await run();
        expect(mocks.error).toHaveBeenCalledWith(expect.stringContaining("apply failed"));
        expect(mocks.error).toHaveBeenCalledWith("Refreshing IntelliGit also failed: panel failed");
        expect(mocks.error).not.toHaveBeenCalledWith(
            expect.stringContaining("Changes were applied"),
        );
    });
});
