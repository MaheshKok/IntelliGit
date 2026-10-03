import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    preparePullUpdate,
    pullUpdateWithinGate,
    type PullUpdateContext,
} from "../../../src/git/updateWithLocalChanges";
import { removeScratchDirectoriesSync } from "../../helpers/scratchDirectories";

describe("pull with local changes contract", () => {
    let root: string;
    let expected: PullUpdateContext;
    let dirty: boolean;
    let branch: string;
    let stashName: string;
    let stashes: string;
    let applyCalls: number;
    const owned = "a".repeat(40);
    const other = "b".repeat(40);
    let intercept: (args: string[]) => Promise<string | undefined>;
    let run: ReturnType<typeof vi.fn<(args: string[]) => Promise<string>>>;

    beforeEach(() => {
        root = mkdtempSync(path.join(tmpdir(), "intelligit-update-unit-"));
        expected = {
            repositoryRoot: root,
            branch: "main",
            head: "c".repeat(40),
            upstream: "refs/remotes/origin/main",
            dirty: true,
        };
        dirty = true;
        branch = "main";
        stashName = "";
        stashes = "";
        applyCalls = 0;
        intercept = async () => undefined;
        run = vi.fn(async (args: string[]): Promise<string> => {
            const overridden = await intercept(args);
            if (overridden !== undefined) return overridden;
            if (args[0] === "rev-parse") {
                if (args[1] === "--show-toplevel" || args[1] === "--absolute-git-dir") return root;
                return expected.upstream;
            }
            if (args[0] === "status")
                return `# branch.oid ${expected.head}\0# branch.head ${branch}\0# branch.upstream origin/main\0${dirty ? "1 .M N... 100644 100644 100644 a b local.txt\0" : ""}`;
            if (args[0] === "stash" && args[1] === "list") return stashes;
            if (args[0] === "stash" && args[1] === "push") {
                stashName = args[4];
                stashes = `${owned}\0On main: ${stashName}\0${stashes}`;
                dirty = false;
            }
            if (args[0] === "stash" && args[1] === "apply") {
                applyCalls++;
                dirty = true;
            }
            return "";
        });
    });

    afterEach(() => removeScratchDirectoriesSync(root));

    /** Runs the approved transaction and checks the permanent no-deletion boundary on every case. */
    async function update(saveLocalChanges = true, strategy: "rebase" | "merge" = "rebase") {
        const result = await pullUpdateWithinGate(run, { expected, saveLocalChanges, strategy });
        expect(
            run.mock.calls.some(
                ([args]) => args[0] === "stash" && ["drop", "pop", "clear"].includes(args[1]),
            ),
            "no outcome may delete a stash",
        ).toBe(false);
        return result;
    }

    it.each([
        ["rebase", ["pull", "--rebase", "--no-autostash"]],
        ["merge", ["pull", "--no-rebase", "--no-autostash", "--no-edit", "--ff"]],
    ] as const)("uses the explicit %s integration command", async (strategy, args) => {
        expect(await update(true, strategy)).toMatchObject({ kind: "complete" });
        expect(run).toHaveBeenCalledWith([...args]);
        expect(run).toHaveBeenCalledWith(["stash", "apply", "--index", owned]);
        expect(applyCalls, "exactly one indexed restoration").toBe(1);
    });

    it("dirty work without consent requires confirmation without mutating", async () => {
        expect(await update(false)).toMatchObject({ kind: "confirmation-required" });
        expect(run.mock.calls.some(([args]) => ["stash", "pull"].includes(args[0]))).toBe(false);
    });

    it("changed branch after consent refuses before saving", async () => {
        branch = "another";
        expect(await update()).toEqual({ kind: "refused", reason: "context-changed" });
        expect(run.mock.calls.some(([args]) => args[0] === "stash")).toBe(false);
    });

    it("stash ownership survives newer entries and duplicate references to the owned object", async () => {
        stashes = `${other}\0On main: prior stash\0`;
        intercept = async (args) => {
            if (args[0] === "pull")
                stashes = `${other}\0On main: later user stash\0${stashes}${owned}\0On main: ${stashName}\0`;
            return undefined;
        };
        const result = await update();
        expect(result).toMatchObject({ kind: "complete", backup: { oid: owned } });
        expect(run).toHaveBeenCalledWith(["pull", "--rebase", "--no-autostash"]);
        expect(run).toHaveBeenCalledWith(["stash", "apply", "--index", owned]);
        expect(applyCalls, "exactly one indexed restoration").toBe(1);
        expect(stashes).toContain(other);
        expect(stashes).toContain(owned);
    });

    it("failed stash enumeration is never treated as an empty stack", async () => {
        intercept = async (args) => {
            if (args[0] === "stash" && args[1] === "list") throw new Error("cannot read reflog");
            return undefined;
        };
        expect(await update()).toMatchObject({
            kind: "failed",
            phase: "save",
            localChanges: "untouched",
        });
        expect(run.mock.calls.some(([args]) => args[1] === "push" || args[0] === "pull")).toBe(
            false,
        );
    });

    it("failed save reports a backup already created and never pulls or blindly restores", async () => {
        intercept = async (args) => {
            if (args[0] === "stash" && args[1] === "push") {
                stashes = `${owned}\0On main: ${args[4]}\0`;
                throw new Error("cleanup failed after writing stash");
            }
            return undefined;
        };
        expect(await update()).toMatchObject({
            kind: "failed",
            phase: "save",
            localChanges: "uncertain",
            backup: { oid: owned },
        });
        expect(run.mock.calls.some(([args]) => args[0] === "pull" || args[1] === "apply")).toBe(
            false,
        );
    });

    it("a no-change save cannot claim an older stash by English output", async () => {
        stashes = `${other}\0On main: old user stash\0`;
        intercept = async (args) =>
            args[0] === "stash" && args[1] === "push" ? "Saved working directory" : undefined;
        expect(await update()).toMatchObject({
            kind: "failed",
            phase: "save",
            backupName: expect.stringContaining("IntelliGit update:"),
        });
        expect(run.mock.calls.some(([args]) => args[0] === "pull" || args[1] === "apply")).toBe(
            false,
        );
    });

    it("failed ownership inspection preserves the searchable name", async () => {
        intercept = async (args) => {
            if (args[0] === "stash" && args[1] === "list" && stashName)
                throw new Error("interrupted after saving");
            return undefined;
        };
        expect(await update()).toMatchObject({
            kind: "failed",
            phase: "save",
            backupName: expect.stringContaining("IntelliGit update:"),
        });
        expect(run.mock.calls.some(([args]) => args[0] === "pull")).toBe(false);
    });

    it("residual dirt after saving prevents integration and automatic restoration", async () => {
        intercept = async (args) => {
            if (args[0] === "status" && stashName) dirty = true;
            return undefined;
        };
        expect(await update()).toMatchObject({
            kind: "failed",
            phase: "save",
            backup: { oid: owned },
        });
        expect(run.mock.calls.some(([args]) => args[0] === "pull" || args[1] === "apply")).toBe(
            false,
        );
    });

    it("failed pull and failed indexed restoration without unmerged paths reports both failures", async () => {
        const pullError = new Error("network is down");
        const restoreError = new Error("index application failed");
        intercept = async (args) => {
            if (args[0] === "pull") throw pullError;
            if (args[0] === "stash" && args[1] === "apply") throw restoreError;
            return undefined;
        };
        const result = await update();
        expect(result, "failed restoration must never become complete").toMatchObject({
            kind: "restore-failed",
            integration: "failed",
            integrationError: pullError,
            error: restoreError,
            hasUnmergedPaths: false,
            backup: { oid: owned },
        });
        expect(run.mock.calls.filter(([args]) => args[1] === "apply")).toEqual([
            [["stash", "apply", "--index", owned]],
        ]);
    });

    it("missing owned object never falls back to another stash", async () => {
        intercept = async (args) => {
            if (args[0] === "cat-file") throw new Error("missing saved object");
            return undefined;
        };
        expect(await update()).toMatchObject({ kind: "restore-failed", backup: { oid: owned } });
        expect(applyCalls).toBe(0);
    });

    it("active rebase after pull retains backup without applying", async () => {
        intercept = async (args) => {
            if (args[0] === "pull") writeFileSync(path.join(root, "REBASE_HEAD"), "irrelevant");
            if (args[0] === "pull") writeFileSync(path.join(root, "rebase-merge"), "active");
            return undefined;
        };
        const result = await update();
        expect(applyCalls, "must not restore into an active rebase").toBe(0);
        expect(result).toMatchObject({
            kind: "integration-conflict",
            backup: { oid: owned },
        });
    });

    it("branch change during restoration cannot produce complete", async () => {
        intercept = async (args) => {
            if (args[0] === "stash" && args[1] === "apply") branch = "changed";
            return undefined;
        };
        expect(await update()).toMatchObject({ kind: "restore-failed", integration: "succeeded" });
    });

    it.each(["branch", "dirty"])(
        "unexpected %s after integration retains backup without restoration",
        async (change) => {
            intercept = async (args) => {
                if (args[0] === "pull") {
                    if (change === "branch") branch = "another";
                    else dirty = true;
                }
                return undefined;
            };
            expect(await update()).toMatchObject({
                kind: "failed",
                phase: "pull",
                localChanges: "saved",
                backup: { oid: owned },
            });
            expect(applyCalls).toBe(0);
        },
    );

    it("interruption while probing before pull retains the identified backup", async () => {
        intercept = async (args) => {
            if (args[0] === "status" && stashName)
                throw new Error("interrupted before integration");
            return undefined;
        };
        expect(await update()).toMatchObject({
            kind: "failed",
            phase: "save",
            backup: { oid: owned },
        });
        expect(run.mock.calls.some(([args]) => args[0] === "pull" || args[1] === "apply")).toBe(
            false,
        );
    });

    it.each([
        "MERGE_HEAD",
        "CHERRY_PICK_HEAD",
        "REVERT_HEAD",
        "sequencer",
        "rebase-merge",
        "rebase-apply",
    ])("%s refuses before creating any backup", async (marker) => {
        writeFileSync(path.join(root, marker), "active");
        expect(await preparePullUpdate(run)).toEqual({
            kind: "refused",
            reason: "active-operation",
        });
        expect(await update()).toEqual({ kind: "refused", reason: "active-operation" });
        expect(run.mock.calls.some(([args]) => args[0] === "stash")).toBe(false);
    });
});
