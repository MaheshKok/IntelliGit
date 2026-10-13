import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitExecutor } from "../../../src/git/executor";
import { RepositoryMutationGate } from "../../../src/git/repositoryMutationGate";

const spawnMock = vi.fn();

vi.mock("node:child_process", () => ({
    spawn: (...args: unknown[]): unknown => spawnMock(...args),
}));

/** Lets the executor run through its real environment and process-close handling. */
function successfulChild(): EventEmitter {
    const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdin: new PassThrough(),
        kill: vi.fn(() => true),
    });
    setImmediate(() => {
        child.stdout.end();
        child.stderr.end();
        child.emit("close", 0, null);
    });
    return child;
}

function spawnedEnvironment(): NodeJS.ProcessEnv {
    return spawnMock.mock.calls.at(-1)?.[2].env as NodeJS.ProcessEnv;
}

describe("GitExecutor optional index locks", () => {
    beforeEach(() => {
        vi.stubEnv("GIT_OPTIONAL_LOCKS", undefined);
        spawnMock.mockReset().mockImplementation(successfulChild);
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it.each([
        ["status", "--porcelain=v1", "-z"],
        ["--literal-pathspecs", "status", "--", "tracked.txt"],
        ["-c", "status.relativePaths=false", "status", "--porcelain"],
        ["-C", "worktree", "--git-dir", "repo.git", "status"],
        ["--git-dir=repo.git", "--work-tree=worktree", "status"],
    ])("skips optional index refreshes for %j", async (...args) => {
        await new GitExecutor(process.cwd()).runBinary(args);

        expect(spawnedEnvironment().GIT_OPTIONAL_LOCKS).toBe("0");
        expect(process.env.GIT_OPTIONAL_LOCKS).toBeUndefined();
        expect(spawnMock.mock.calls[0]?.[1]).toEqual(args);
    });

    it.each([
        ["add", "--", "status"],
        ["commit", "-m", "status"],
        ["stash", "push"],
        ["stash", "pop"],
        ["branch", "status"],
        ["worktree", "add", "status"],
        ["update-index", "--refresh"],
        ["hash-object", "-w", "--stdin"],
        ["config", "user.name", "status"],
        ["-c", "alias.s=status", "s"],
        ["-C", "status", "add", "."],
        ["--literal-pathspecs", "commit", "-m", "diff"],
        ["rev-parse", "HEAD"],
        ["diff", "--numstat"],
        ["--literal-pathspecs"],
        [],
    ])("leaves optional locking unchanged for %j", async (...args) => {
        await new GitExecutor(process.cwd()).runBinary(args);

        expect(spawnedEnvironment().GIT_OPTIONAL_LOCKS).toBeUndefined();
    });

    it.each(["0", "1", "true", ""])(
        "preserves an explicit inherited setting of %j",
        async (setting) => {
            vi.stubEnv("GIT_OPTIONAL_LOCKS", setting);
            await new GitExecutor(process.cwd()).run(["status", "--porcelain"]);

            expect(spawnedEnvironment().GIT_OPTIONAL_LOCKS).toBe(setting);
            expect(process.env.GIT_OPTIONAL_LOCKS).toBe(setting);
        },
    );

    it("preserves executor defaults and innermost per-call overrides", async () => {
        vi.stubEnv("GIT_OPTIONAL_LOCKS", "0");
        const defaults = { GIT_OPTIONAL_LOCKS: "1" };
        const override = { GIT_OPTIONAL_LOCKS: "false" };
        const executor = new GitExecutor(process.cwd(), undefined, defaults);

        await executor.run(["status"]);
        expect(spawnedEnvironment().GIT_OPTIONAL_LOCKS).toBe("1");
        await executor.runBinary(["status"], { env: override });
        expect(spawnedEnvironment().GIT_OPTIONAL_LOCKS).toBe("false");
        expect(defaults).toEqual({ GIT_OPTIONAL_LOCKS: "1" });
        expect(override).toEqual({ GIT_OPTIONAL_LOCKS: "false" });
        expect(process.env.GIT_OPTIONAL_LOCKS).toBe("0");
    });

    it("keeps default read settings separate from gated mutations", async () => {
        const gate = {
            resolveCommonDir: () => process.cwd(),
            run: vi.fn(async (_root, _commonDir, operation) => operation()),
        } as unknown as RepositoryMutationGate;
        const executor = new GitExecutor(process.cwd(), gate);

        await executor.run(["status", "--porcelain"]);
        expect(spawnedEnvironment().GIT_OPTIONAL_LOCKS).toBe("0");
        expect(gate.run).not.toHaveBeenCalled();

        await executor.run(["stash", "push"]);
        expect(spawnedEnvironment().GIT_OPTIONAL_LOCKS).toBeUndefined();
        expect(gate.run).toHaveBeenCalledOnce();
    });

    it("applies the read default in derived executors and read-then-write sequences", async () => {
        const executor = new GitExecutor(process.cwd()).deriveFor(process.cwd());
        await executor.runWithinMutationGate(async (run) => {
            await run(["status"]);
            expect(spawnedEnvironment().GIT_OPTIONAL_LOCKS).toBe("0");
            await run(["add", "."]);
            expect(spawnedEnvironment().GIT_OPTIONAL_LOCKS).toBeUndefined();
        });
    });
});
