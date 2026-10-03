import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitExecutor } from "../../../src/git/executor";
import { GitOps } from "../../../src/git/operations";
import { RepositoryMutationGate } from "../../../src/git/repositoryMutationGate";
import { RepositoryMutationCoordinator } from "../../../src/git/mutationCoordinator";
import { RepositoryLock } from "../../../src/git/repositoryLock";
import { removeScratchDirectoriesSync } from "../../helpers/scratchDirectories";

const gitEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
};

/** Runs fixture-only Git commands without user configuration or a network remote. */
function git(root: string, ...args: string[]): string {
    return execFileSync("git", args, {
        cwd: root,
        env: gitEnv,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    }).trimEnd();
}

describe("pull with local changes using real Git", () => {
    let parent: string;
    let origin: string;
    let local: string;
    let upstream: string;
    let ops: GitOps;
    let executor: GitExecutor;

    beforeEach(() => {
        parent = mkdtempSync(path.join(tmpdir(), "intelligit-update-"));
        origin = path.join(parent, "origin.git");
        upstream = path.join(parent, "upstream");
        local = path.join(parent, "local");
        git(parent, "init", "--bare", "--initial-branch=main", origin);
        git(parent, "clone", origin, upstream);
        git(upstream, "config", "user.name", "Fixture");
        git(upstream, "config", "user.email", "fixture@example.test");
        writeFileSync(path.join(upstream, "local.txt"), "base\n");
        writeFileSync(path.join(upstream, "remote.txt"), "base remote\n");
        writeFileSync(path.join(upstream, "saved.txt"), "base saved\n");
        git(upstream, "add", ".");
        git(upstream, "commit", "-m", "base");
        git(upstream, "push", "-u", "origin", "main");
        git(parent, "clone", origin, local);
        git(local, "config", "user.name", "Fixture");
        git(local, "config", "user.email", "fixture@example.test");
        executor = new GitExecutor(local, undefined, gitEnv);
        ops = new GitOps(executor);
        writeFileSync(path.join(upstream, "remote.txt"), "received upstream\n");
        git(upstream, "add", ".");
        git(upstream, "commit", "-m", "incoming");
        git(upstream, "push");
    });

    afterEach(() => {
        vi.restoreAllMocks();
        removeScratchDirectoriesSync(parent);
    });

    /** Captures the exact context that a command must retain across its consent dialog. */
    async function update(saveLocalChanges = true, strategy: "rebase" | "merge" = "rebase") {
        const preparation = await ops.preparePullWithLocalChanges();
        expect(preparation).toMatchObject({ kind: "ready" });
        if (preparation.kind !== "ready") throw new Error("Expected ready fixture");
        return ops.pullPreservingLocalChanges({
            expected: preparation.context,
            saveLocalChanges,
            strategy,
        });
    }

    it.each(["rebase", "merge"] as const)(
        "%s produces the selected divergent history and restores exact local work",
        async (strategy) => {
            executor = new GitExecutor(local, undefined, {
                ...gitEnv,
                GIT_EDITOR: "false",
                GIT_SEQUENCE_EDITOR: "false",
            });
            ops = new GitOps(executor);
            git(local, "config", "pull.rebase", strategy === "merge" ? "true" : "false");
            git(local, "config", "pull.ff", "only");
            git(local, "config", "merge.ff", "only");
            git(local, "config", "rebase.autoStash", "true");
            git(local, "config", "merge.autoStash", "true");
            writeFileSync(path.join(local, "committed-local.txt"), "local commit\n");
            git(local, "add", "committed-local.txt");
            git(local, "commit", "-m", "local only");
            const localHead = git(local, "rev-parse", "HEAD");
            const incomingHead = git(upstream, "rev-parse", "HEAD");
            writeFileSync(path.join(local, "local.txt"), "staged\n");
            git(local, "add", "local.txt");
            writeFileSync(path.join(local, "local.txt"), "staged\nunstaged\n");
            writeFileSync(path.join(local, "new file.txt"), "untracked bytes\n");
            const staged = git(local, "diff", "--cached", "--binary");
            const unstaged = git(local, "diff", "--binary");
            const originRefs = git(origin, "show-ref");
            const result = await update(true, strategy);
            expect(
                result.kind,
                "selected strategy must integrate despite opposite Git config",
            ).toBe("complete");
            expect(
                git(local, "show", "-s", "--format=%P", "HEAD").split(" "),
                `${strategy} must create the selected history topology`,
            ).toEqual(strategy === "merge" ? [localHead, incomingHead] : [incomingHead]);
            expect(git(local, "diff", "--cached", "--binary")).toBe(staged);
            expect(git(local, "diff", "--binary")).toBe(unstaged);
            expect(readFileSync(path.join(local, "new file.txt"), "utf8")).toBe(
                "untracked bytes\n",
            );
            expect(readFileSync(path.join(local, "committed-local.txt"), "utf8")).toBe(
                "local commit\n",
            );
            expect(git(origin, "show-ref")).toBe(originRefs);
            expect(result).toHaveProperty("backup.oid", git(local, "rev-parse", "refs/stash"));
            expect(git(local, "stash", "list", "--format=%H").split("\n")).toHaveLength(1);
        },
    );

    it("merge fast-forwards a clean repository without an extra commit or stash", async () => {
        git(local, "config", "pull.ff", "false");
        git(local, "config", "merge.ff", "false");
        const incomingHead = git(upstream, "rev-parse", "HEAD");
        expect(await update(false, "merge")).toEqual({ kind: "complete" });
        expect(git(local, "rev-parse", "HEAD"), "Merge must fast-forward when possible").toBe(
            incomingHead,
        );
        expect(git(local, "stash", "list")).toBe("");
    });

    it("merge conflicts retain saved work without applying it into the active merge", async () => {
        writeFileSync(path.join(local, "remote.txt"), "conflicting local commit\n");
        git(local, "add", "remote.txt");
        git(local, "commit", "-m", "local conflict");
        const localHead = git(local, "rev-parse", "HEAD");
        writeFileSync(path.join(local, "saved.txt"), "saved staged bytes\n");
        git(local, "add", "saved.txt");
        writeFileSync(path.join(local, "saved.txt"), "saved unstaged bytes\n");
        writeFileSync(path.join(local, "new.txt"), "saved untracked bytes\n");
        const result = await update(true, "merge");
        expect(result).toMatchObject({ kind: "integration-conflict", hasUnmergedPaths: true });
        expect(git(local, "rev-parse", "MERGE_HEAD")).toBe(git(upstream, "rev-parse", "HEAD"));
        expect(git(local, "rev-parse", "HEAD")).toBe(localHead);
        expect(git(local, "show", ":saved.txt")).toBe("base saved");
        expect(readFileSync(path.join(local, "saved.txt"), "utf8")).toBe("base saved\n");
        const backup = git(local, "rev-parse", "refs/stash");
        expect(result).toHaveProperty("backup.oid", backup);
        expect(git(local, "show", `${backup}^2:saved.txt`)).toBe("saved staged bytes");
        expect(git(local, "show", `${backup}:saved.txt`)).toBe("saved unstaged bytes");
        expect(git(local, "show", `${backup}^3:new.txt`)).toBe("saved untracked bytes");
        expect(() => readFileSync(path.join(local, "new.txt"))).toThrow();
    });

    it("clean update creates no stash and never changes origin refs", async () => {
        const before = git(origin, "show-ref");
        const result = await update(false);
        expect(result.kind).toBe("complete");
        expect(result).not.toHaveProperty("backup");
        expect(git(local, "stash", "list")).toBe("");
        expect(readFileSync(path.join(local, "remote.txt"), "utf8")).toBe("received upstream\n");
        expect(git(origin, "show-ref")).toBe(before);
    });

    it("same-file staged and unstaged changes retain their exact split and named backup", async () => {
        writeFileSync(path.join(local, "local.txt"), "staged\n");
        git(local, "add", "local.txt");
        writeFileSync(path.join(local, "local.txt"), "staged\nunstaged\n");
        writeFileSync(path.join(local, "new file.txt"), "untracked bytes\n");
        const staged = git(local, "diff", "--cached", "--binary");
        const unstaged = git(local, "diff", "--binary");
        const originRefs = git(origin, "show-ref");
        const result = await update();
        expect(result.kind).toBe("complete");
        expect(
            git(local, "diff", "--cached", "--binary"),
            "indexed local edit must stay staged",
        ).toBe(staged);
        expect(git(local, "diff", "--binary"), "unstaged local edit must stay unstaged").toBe(
            unstaged,
        );
        expect(readFileSync(path.join(local, "new file.txt"), "utf8")).toBe("untracked bytes\n");
        expect(readFileSync(path.join(local, "remote.txt"), "utf8")).toBe("received upstream\n");
        expect(git(local, "branch", "--show-current")).toBe("main");
        expect(git(local, "rev-parse", "--symbolic-full-name", "@{upstream}")).toBe(
            "refs/remotes/origin/main",
        );
        expect(git(origin, "show-ref")).toBe(originRefs);
        expect(result).toHaveProperty("backup.oid", git(local, "rev-parse", "refs/stash"));
        expect(git(local, "stash", "list")).toContain("IntelliGit update:");
    });

    it("untracked-only work is restored while prior stashes survive", async () => {
        writeFileSync(path.join(local, "local.txt"), "prior stash\n");
        git(local, "stash", "push", "-m", "prior user stash");
        const prior = git(local, "rev-parse", "refs/stash");
        writeFileSync(path.join(local, "ユニコード space.bin"), Buffer.from([0, 1, 254, 255]));
        const result = await update();
        expect(result.kind).toBe("complete");
        expect(readFileSync(path.join(local, "ユニコード space.bin"))).toEqual(
            Buffer.from([0, 1, 254, 255]),
        );
        expect(git(local, "stash", "list", "--format=%H").split("\n")).toContain(prior);
        expect(git(local, "stash", "list", "--format=%H").split("\n")).toHaveLength(2);
    });

    it("renames, deletions, executable mode and symlink changes preserve their staged split", async () => {
        symlinkSync("local.txt", path.join(local, "link"));
        git(local, "add", "link");
        git(local, "commit", "-m", "tracked symlink");
        git(local, "mv", "local.txt", "renamed space.txt");
        chmodSync(path.join(local, "renamed space.txt"), 0o755);
        git(local, "add", "renamed space.txt");
        writeFileSync(path.join(local, "renamed space.txt"), "unstaged after rename\n");
        rmSync(path.join(local, "saved.txt"));
        rmSync(path.join(local, "link"));
        symlinkSync("remote.txt", path.join(local, "link"));
        const staged = git(local, "diff", "--cached", "--binary");
        const unstaged = git(local, "diff", "--binary");
        expect(await update()).toMatchObject({ kind: "complete" });
        expect(git(local, "diff", "--cached", "--binary")).toBe(staged);
        expect(git(local, "diff", "--binary")).toBe(unstaged);
    });

    it.each(["no-upstream", "detached", "unborn"])("%s refuses before stash", async (reason) => {
        if (reason === "no-upstream") git(local, "branch", "--unset-upstream");
        if (reason === "detached") git(local, "checkout", "--detach");
        if (reason === "unborn") git(local, "checkout", "--orphan", "unborn");
        expect(await ops.preparePullWithLocalChanges()).toEqual({ kind: "refused", reason });
        expect(git(local, "stash", "list")).toBe("");
    });

    it("an untracked nested repository refuses before stash", async () => {
        git(local, "init", "nested repo");
        writeFileSync(path.join(local, "nested repo", "work.txt"), "nested work\n");
        expect(await ops.preparePullWithLocalChanges()).toEqual({
            kind: "refused",
            reason: "nested-repository",
        });
        expect(git(local, "stash", "list")).toBe("");
        expect(readFileSync(path.join(local, "nested repo", "work.txt"), "utf8")).toBe(
            "nested work\n",
        );
    });

    it("clean initialized submodules are supported but dirty submodules refuse before stash", async () => {
        git(local, "-c", "protocol.file.allow=always", "submodule", "add", origin, "module");
        git(local, "commit", "-m", "clean submodule");
        expect(await update()).toMatchObject({ kind: "complete" });
        writeFileSync(path.join(local, "module", "untracked.txt"), "module work\n");
        expect(await ops.preparePullWithLocalChanges()).toEqual({
            kind: "refused",
            reason: "unsupported-submodule",
        });
        expect(git(local, "stash", "list")).toBe("");
    });

    it("staged gitlink changes are explicitly unsupported", async () => {
        git(local, "-c", "protocol.file.allow=always", "submodule", "add", origin, "module");
        expect(await ops.preparePullWithLocalChanges()).toEqual({
            kind: "refused",
            reason: "unsupported-submodule",
        });
        expect(git(local, "stash", "list")).toBe("");
    });

    it("intent-to-add save failure never proceeds to pull", async () => {
        writeFileSync(path.join(local, "intent.txt"), "not staged content\n");
        git(local, "add", "--intent-to-add", "intent.txt");
        const before = git(local, "rev-parse", "HEAD");
        const result = await update();
        expect(result).toMatchObject({ kind: "failed", phase: "save" });
        expect(git(local, "rev-parse", "HEAD")).toBe(before);
        expect(readFileSync(path.join(local, "intent.txt"), "utf8")).toBe("not staged content\n");
    });

    it("network failure restores saved work when repository is still safe", async () => {
        writeFileSync(path.join(local, "local.txt"), "saved edit\n");
        git(local, "add", "local.txt");
        git(local, "remote", "set-url", "origin", path.join(parent, "unavailable"));
        const result = await update();
        expect(result).toMatchObject({
            kind: "failed",
            phase: "pull",
            localChanges: "restored",
            backup: { oid: expect.any(String) },
        });
        expect(git(local, "show", ":local.txt")).toBe("saved edit");
        expect(git(local, "stash", "list")).toContain("IntelliGit update:");
    });

    it("untracked collision is a restoration failure with both versions recoverable", async () => {
        writeFileSync(path.join(local, "collision.txt"), "my untracked bytes\n");
        writeFileSync(path.join(upstream, "collision.txt"), "upstream tracked bytes\n");
        git(upstream, "add", ".");
        git(upstream, "commit", "-m", "incoming collision");
        git(upstream, "push");
        const result = await update();
        expect(result).toMatchObject({
            kind: "restore-failed",
            integration: "succeeded",
            hasUnmergedPaths: false,
        });
        if (result.kind !== "restore-failed") throw new Error("Expected restoration failure");
        expect(readFileSync(path.join(local, "collision.txt"), "utf8")).toBe(
            "upstream tracked bytes\n",
        );
        expect(git(local, "show", `${result.backup.oid}^3:collision.txt`)).toBe(
            "my untracked bytes",
        );
        expect(git(local, "stash", "list", "--format=%H")).toBe(result.backup.oid);
    });

    it("index restoration failure is not reported as success", async () => {
        writeFileSync(path.join(local, "local.txt"), "my staged bytes\n");
        git(local, "add", "local.txt");
        writeFileSync(path.join(upstream, "local.txt"), "upstream bytes\n");
        git(upstream, "add", ".");
        git(upstream, "commit", "-m", "index conflict");
        git(upstream, "push");
        const result = await update();
        expect(result).toMatchObject({
            kind: "restore-failed",
            integration: "succeeded",
            hasUnmergedPaths: false,
        });
        if (result.kind !== "restore-failed") throw new Error("Expected restoration failure");
        expect(git(local, "show", `${result.backup.oid}^2:local.txt`)).toBe("my staged bytes");
        expect(readFileSync(path.join(local, "local.txt"), "utf8")).toBe("upstream bytes\n");
    });

    it("unstaged restoration conflicts retain the backup and unmerged state", async () => {
        writeFileSync(path.join(local, "local.txt"), "my unstaged bytes\n");
        writeFileSync(path.join(upstream, "local.txt"), "upstream bytes\n");
        git(upstream, "add", ".");
        git(upstream, "commit", "-m", "worktree conflict");
        git(upstream, "push");
        const result = await update();
        expect(result).toMatchObject({
            kind: "restore-failed",
            integration: "succeeded",
            hasUnmergedPaths: true,
        });
        expect(git(local, "diff", "--name-only", "--diff-filter=U")).toBe("local.txt");
        expect(git(local, "stash", "list")).toContain("IntelliGit update:");
    });

    it.each(["continue", "abort"])(
        "retained backup survives restart and is recoverable after rebase %s",
        async (recovery) => {
            writeFileSync(path.join(local, "local.txt"), "local commit\n");
            git(local, "add", "local.txt");
            git(local, "commit", "-m", "local conflict");
            writeFileSync(path.join(upstream, "local.txt"), "incoming commit\n");
            git(upstream, "add", ".");
            git(upstream, "commit", "-m", "incoming conflict");
            git(upstream, "push");
            writeFileSync(path.join(local, "saved.txt"), "staged saved\n");
            git(local, "add", "saved.txt");
            writeFileSync(path.join(local, "saved.txt"), "staged saved\nunstaged saved\n");
            writeFileSync(path.join(local, "new.txt"), "untracked saved\n");
            const result = await update();
            expect(result).toMatchObject({ kind: "integration-conflict", hasUnmergedPaths: true });
            if (result.kind !== "integration-conflict" || !result.backup)
                throw new Error("Expected retained backup");
            expect(
                readFileSync(path.join(local, "saved.txt"), "utf8"),
                "active rebase must not receive saved edits",
            ).toBe("base saved\n");
            expect(
                (await new GitOps(new GitExecutor(local)).listStashesOrThrow()).map(
                    (entry) => entry.hash,
                ),
            ).toContain(result.backup.oid);
            if (recovery === "continue") {
                writeFileSync(path.join(local, "local.txt"), "resolved commit\n");
                git(local, "add", "local.txt");
                git(local, "-c", "core.editor=true", "rebase", "--continue");
            } else git(local, "rebase", "--abort");
            expect(git(local, "status", "--porcelain")).toBe("");
            git(local, "stash", "apply", "--index", result.backup.oid);
            expect(git(local, "show", ":saved.txt")).toBe("staged saved");
            expect(readFileSync(path.join(local, "saved.txt"), "utf8")).toBe(
                "staged saved\nunstaged saved\n",
            );
            expect(readFileSync(path.join(local, "new.txt"), "utf8")).toBe("untracked saved\n");
        },
    );

    it("a newer external stash cannot change the owned-backup content being restored", async () => {
        writeFileSync(path.join(local, "local.txt"), "owned local bytes\n");
        const original = GitExecutor.prototype.runBinary;
        const calls: string[][] = [];
        vi.spyOn(GitExecutor.prototype, "runBinary").mockImplementation(async function (
            this: GitExecutor,
            args,
            options,
        ) {
            calls.push(args);
            const result = await original.call(this, args, options);
            if (args[0] === "pull") {
                writeFileSync(path.join(local, "local.txt"), "later external bytes\n");
                git(local, "stash", "push", "-m", "later external stash");
            }
            return result;
        });
        const result = await update();
        expect(result).toMatchObject({ kind: "complete" });
        expect(
            readFileSync(path.join(local, "local.txt"), "utf8"),
            "must restore the owned backup rather than the current top stash",
        ).toBe("owned local bytes\n");
        expect(git(local, "stash", "list")).toContain("later external stash");
        expect(git(local, "stash", "list")).toContain("IntelliGit update:");
        expect(
            calls.filter(
                (args) => args[0] === "stash" && ["drop", "pop", "clear"].includes(args[1]),
            ),
        ).toEqual([]);
    });

    it("linked-worktree update holds the common-directory gate through backup restoration", async () => {
        const sibling = path.join(parent, "linked");
        git(local, "worktree", "add", "-b", "sibling", sibling);
        const gate = new RepositoryMutationGate(
            new RepositoryMutationCoordinator(),
            new RepositoryLock(),
            { acquireRetryDelayMs: 10 },
        );
        const first = new GitOps(new GitExecutor(local, gate, gitEnv));
        const second = new GitExecutor(sibling, gate, gitEnv);
        writeFileSync(path.join(local, "local.txt"), "owned first worktree\n");
        writeFileSync(path.join(sibling, "saved.txt"), "second worktree bytes\n");
        const preparation = await first.preparePullWithLocalChanges();
        if (preparation.kind !== "ready") throw new Error("Expected ready fixture");
        let releasePull!: () => void;
        let sawPull!: () => void;
        const reachedPull = new Promise<void>((resolve) => {
            sawPull = resolve;
        });
        const pausedPull = new Promise<void>((resolve) => {
            releasePull = resolve;
        });
        let releaseApply!: () => void;
        let sawApply!: () => void;
        const reachedApply = new Promise<void>((resolve) => {
            sawApply = resolve;
        });
        const pausedApply = new Promise<void>((resolve) => {
            releaseApply = resolve;
        });
        let secondEntered = false;
        let applyFinished = false;
        let enteredBeforeApplyFinished = false;
        let saved = false;
        const original = GitExecutor.prototype.runBinary;
        vi.spyOn(GitExecutor.prototype, "runBinary").mockImplementation(async function (
            this: GitExecutor,
            args,
            options,
        ) {
            if (args[0] === "status" && saved) {
                sawPull();
                await pausedPull;
            }
            if (args[0] === "stash" && args[1] === "apply") {
                sawApply();
                await pausedApply;
            }
            const result = await original.call(this, args, options);
            if (args[0] === "stash" && args[1] === "push") saved = true;
            if (args[0] === "stash" && args[1] === "apply") applyFinished = true;
            return result;
        });
        const updating = first.pullPreservingLocalChanges({
            strategy: "rebase",
            expected: preparation.context,
            saveLocalChanges: true,
        });
        await reachedPull;
        const competing = second.runWithinMutationGate(async (run) => {
            secondEntered = true;
            enteredBeforeApplyFinished = !applyFinished;
            return run(["add", "saved.txt"]);
        });
        // Yield through the actual lock attempt, not a timeout-based assertion.
        const originalAcquire = RepositoryLock.prototype.acquire;
        const lockAttempt = vi.spyOn(RepositoryLock.prototype, "acquire");
        await vi.waitFor(() => expect(lockAttempt).toHaveBeenCalled());
        const enteredBeforeRestore = secondEntered;
        releasePull();
        await reachedApply;
        // Observe a completed competing lock attempt while apply is blocked. A successful
        // attempt drains its microtasks before the snapshot; a busy attempt proves contention.
        lockAttempt.mockRestore();
        let observedAttempt!: () => void;
        const attemptedDuringApply = new Promise<void>((resolve) => {
            observedAttempt = resolve;
        });
        vi.spyOn(RepositoryLock.prototype, "acquire").mockImplementation(async function (
            this: RepositoryLock,
            commonDir,
        ) {
            try {
                return await originalAcquire.call(this, commonDir);
            } finally {
                observedAttempt();
            }
        });
        await Promise.race([attemptedDuringApply, competing.then(() => undefined)]);
        await new Promise<void>((resolve) => setImmediate(resolve));
        const enteredWhileApplyBlocked = secondEntered;
        releaseApply();
        const [result] = await Promise.all([updating, competing]);
        expect(
            enteredBeforeRestore,
            "the second worktree must stay outside the entire update transaction",
        ).toBe(false);
        expect(
            enteredWhileApplyBlocked,
            "a competing worktree must not enter while stash apply is blocked",
        ).toBe(false);
        expect(
            enteredBeforeApplyFinished,
            "a competing worktree must wait until stash apply finishes",
        ).toBe(false);
        expect(result).toMatchObject({ kind: "complete" });
        expect(secondEntered).toBe(true);
        expect(readFileSync(path.join(local, "local.txt"), "utf8")).toBe("owned first worktree\n");
        expect(git(sibling, "show", ":saved.txt")).toBe("second worktree bytes");
        expect(git(local, "show", ":saved.txt")).toBe("base saved");
    }, 10_000);
});
