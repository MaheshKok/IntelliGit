import { existsSync } from "node:fs";
import { mkdir, mkdtemp, open, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { GitExecutor, setGitSuccessListener } from "../../../src/git/executor";
import { RepositoryMutationCoordinator } from "../../../src/git/mutationCoordinator";
import { RepositoryLock } from "../../../src/git/repositoryLock";
import { RepositoryMutationGate } from "../../../src/git/repositoryMutationGate";

const itPosix = process.platform === "win32" ? it.skip : it;

interface GateProbe {
    gate: RepositoryMutationGate;
    gatedRuns: number[];
    /** Every common directory the executor's `rev-parse` probe reported. */
    commonDirs: string[];
}

function gateProbe(): GateProbe {
    const gatedRuns: number[] = [];
    const commonDirs: string[] = [];
    const gate = {
        run: async <T>(
            _repoRoot: string,
            _commonDir: string,
            operation: () => Promise<T>,
        ): Promise<T> => {
            gatedRuns.push(gatedRuns.length);
            return operation();
        },
        resolveCommonDir: (_repoRoot: string, commonDir: string): string => {
            commonDirs.push(commonDir.trim());
            return commonDir.trim();
        },
    } as unknown as RepositoryMutationGate;
    return { gate, gatedRuns, commonDirs };
}

/** The checked-in `git` stand-in every fake-git test puts on PATH. */
const FAKE_GIT_TRAMPOLINE = fileURLToPath(new URL("../../fixtures/bin/git", import.meta.url));

/**
 * Puts a fake `git` running `script` on PATH inside `directory`, and returns the undo.
 *
 * The executable on PATH is a symlink to a checked-in trampoline, never a file this process
 * just wrote. `execve` refuses a target that any process still holds open for writing and
 * reports ETXTBSY, and vitest's `threads` pool shares one file-descriptor table across the
 * test files running concurrently -- so a sibling file forking mid-write can hold our
 * descriptor past the exec. That is a real race, not a theoretical one: it took down CI as
 * `spawn ETXTBSY` in whichever test lost, while every local macOS run stayed green because
 * macOS does not enforce ETXTBSY here. The generated script is only ever read, by the `sh`
 * the trampoline execs, and reading is never refused.
 */
async function installFakeGit(directory: string, script: string): Promise<() => void> {
    const scriptPath = join(directory, "fake-git.sh");
    await writeFile(scriptPath, `${script}\n`, "utf8");
    await symlink(FAKE_GIT_TRAMPOLINE, join(directory, "git"));
    const originalPath = process.env.PATH;
    const originalScript = process.env.INTELLIGIT_FAKE_GIT_SCRIPT;
    process.env.PATH = `${directory}${delimiter}${originalPath ?? ""}`;
    process.env.INTELLIGIT_FAKE_GIT_SCRIPT = scriptPath;
    return () => {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
        if (originalScript === undefined) delete process.env.INTELLIGIT_FAKE_GIT_SCRIPT;
        else process.env.INTELLIGIT_FAKE_GIT_SCRIPT = originalScript;
    };
}

/** Runs one callback against a temporary Git executable with a restored process PATH. */
async function withFakeGit<T>(
    script: string,
    run: (executor: GitExecutor) => Promise<T>,
    gate?: RepositoryMutationGate,
): Promise<T> {
    const directory = await mkdtemp(join(tmpdir(), "intelligit-fake-git-"));
    const restoreEnv = await installFakeGit(directory, script);
    try {
        return await run(new GitExecutor(process.cwd(), gate));
    } finally {
        restoreEnv();
        await rm(directory, { force: true, recursive: true });
    }
}

/** Runs the executor against a real temporary Git executable with controlled process behavior. */
async function runFakeGit(
    script: string,
    args: string[],
    options: Parameters<GitExecutor["runBinary"]>[1] = {},
): Promise<Awaited<ReturnType<GitExecutor["runBinary"]>>> {
    return withFakeGit(script, (executor) => executor.runBinary(args, options));
}

/** Runs text-mode executor commands against a temporary Git executable. */
async function runFakeGitText(
    script: string,
    args: string[],
    options: Parameters<GitExecutor["run"]>[1] = {},
    gate?: RepositoryMutationGate,
): Promise<string> {
    return withFakeGit(script, (executor) => executor.run(args, options), gate);
}

/**
 * Reports how many times `args` reached the mutation gate, running against a stub
 * `git` so write-shaped commands are classified without touching a real repository.
 */
async function gatedRunCount(args: string[]): Promise<number> {
    const directory = await mkdtemp(join(tmpdir(), "intelligit-classify-git-"));
    const restoreEnv = await installFakeGit(directory, "exit 0");
    try {
        const { gate, gatedRuns } = gateProbe();
        await new GitExecutor(process.cwd(), gate).run(args);
        return gatedRuns.length;
    } finally {
        restoreEnv();
        await rm(directory, { force: true, recursive: true });
    }
}

/** Runs `run()` against a stub `git`, so the success hook is observable without a repository. */
async function runWithStubGit(args: string[], script = "exit 0"): Promise<void> {
    const directory = await mkdtemp(join(tmpdir(), "intelligit-hook-git-"));
    const restoreEnv = await installFakeGit(directory, script);
    try {
        await new GitExecutor(process.cwd()).run(args);
    } finally {
        restoreEnv();
        await rm(directory, { force: true, recursive: true });
    }
}

describe("GitExecutor", () => {
    itPosix("merges custom environment variables without mutating process.env", async () => {
        const variable = "INTELLIGIT_EXECUTOR_ENV_TEST";
        const original = process.env[variable];
        process.env[variable] = "parent";

        try {
            await expect(
                runFakeGitText(`printf '%s' \"$${variable}\"`, ["rebase", "--continue"], {
                    env: { [variable]: "scoped" },
                }),
            ).resolves.toBe("scoped");
            expect(process.env[variable]).toBe("parent");
        } finally {
            if (original === undefined) delete process.env[variable];
            else process.env[variable] = original;
        }
    });

    itPosix("merges custom environment variables through the mutation gate", async () => {
        const variable = "INTELLIGIT_EXECUTOR_GATED_ENV_TEST";
        const { gate, gatedRuns } = gateProbe();

        await expect(
            runFakeGitText(
                `printf '%s' \"$${variable}\"`,
                ["rebase", "--continue"],
                { env: { [variable]: "scoped" } },
                gate,
            ),
        ).resolves.toBe("scoped");

        expect(gatedRuns).toHaveLength(1);
    });

    itPosix("probes the common directory with the caller's environment", async () => {
        // The gate locks whichever repository the probe resolves. A caller that
        // overrides GIT_DIR or GIT_COMMON_DIR would otherwise have its mutation
        // gated against the default repository while running against another.
        const variable = "INTELLIGIT_EXECUTOR_PROBE_ENV_TEST";
        const { gate, commonDirs } = gateProbe();

        await runFakeGitText(
            `if [ "$1" = "rev-parse" ]; then printf '%s' "$${variable}"; else printf 'ok'; fi`,
            ["rebase", "--continue"],
            { env: { [variable]: "/scoped/common/dir" } },
            gate,
        );

        expect(commonDirs).toEqual(["/scoped/common/dir"]);
    });

    it("returns binary stdout without decoding it", async () => {
        const executor = new GitExecutor(process.cwd());

        const output = await executor.runBinary(["hash-object", "--stdin"], {
            input: Buffer.from([0, 255, 1]),
        });

        expect(Buffer.isBuffer(output.stdout)).toBe(true);
        expect(output.stdout.toString("utf8")).toMatch(/^[a-f0-9]{40}\n$/);
    });

    itPosix("settles from the child's exit when a large input breaks the stdin pipe", async () => {
        // The fake git exits without ever reading stdin, and an input far larger than the OS
        // pipe buffer cannot be absorbed by it, so closing stdin fails with EPIPE once the
        // child is gone. `child.once("error")` listens on the process, not on the stdin
        // stream, and an unhandled stream error is an uncatchable crash rather than a
        // rejected promise: it turned a CI run red while all 4023 tests in it passed.
        //
        // Which is exactly why the exit code cannot be the oracle here -- it is 0 whether or
        // not the stream error is handled, because the crash is asynchronous and takes the
        // RUN down rather than this test. Observing it needs a listener of our own: attaching
        // one also suppresses the default crash, so an unhandled EPIPE lands in `uncaught`
        // instead of aborting the process, and the assertion below can name it.
        const uncaught: Error[] = [];
        const collect = (error: Error): void => void uncaught.push(error);
        process.on("uncaughtException", collect);
        try {
            const output = await runFakeGit("exit 0", ["hash-object", "--stdin"], {
                input: Buffer.alloc(1024 * 1024, 0x61),
            });
            // The write races the child's exit, so the failure can land after `close` resolves.
            await new Promise<void>((resolve) => setTimeout(resolve, 50));

            expect(output.exitCode).toBe(0);
            expect(
                uncaught.map((error) => (error as NodeJS.ErrnoException).code ?? error.message),
                "a broken stdin pipe must not escape as an uncaught exception",
            ).toEqual([]);
        } finally {
            process.off("uncaughtException", collect);
        }
    });

    it("accepts an explicitly expected non-zero Git exit code", async () => {
        const executor = new GitExecutor(process.cwd());

        const output = await executor.runBinary(
            ["diff", "--no-index", "--", "/dev/null", "package.json"],
            {
                expectedExitCodes: [0, 1],
            },
        );

        expect(output.exitCode).toBe(1);
    });

    itPosix(
        "rejects a non-zero exit without stderr using a bounded command description",
        async () => {
            await expect(
                runFakeGit("exit 17", ["commit", "--message", "ignored-argument"]),
            ).rejects.toThrow("git commit --message exited with 17: (no stderr)");
        },
    );

    itPosix("preserves trimmed stderr when a Git command exits non-zero", async () => {
        await expect(
            runFakeGit("printf 'hook failure\\n' >&2; exit 17", [
                "commit",
                "--message",
                "ignored-argument",
            ]),
        ).rejects.toThrow("git commit --message exited with 17: hook failure");
    });

    itPosix("returns stdout when a zero-exit Git command writes to stderr", async () => {
        const output = await runFakeGit("printf stdout; printf 'advice\\n' >&2; exit 0", [
            "status",
        ]);

        expect(output.stdout).toEqual(Buffer.from("stdout"));
        expect(output.stderr).toEqual(Buffer.from("advice\n"));
    });

    itPosix(
        "resolves capped output after the executor terminates a long-running Git process",
        async () => {
            const startedAt = Date.now();
            const output = await runFakeGit("printf 0123456789; exec sleep 5", ["diff"], {
                maxOutputBytes: 4,
            });

            expect(output.stdout).toEqual(Buffer.from("0123"));
            expect(output.truncated).toBe(true);
            expect(Date.now() - startedAt).toBeLessThan(2_000);
        },
    );

    itPosix(
        "rejects capped output when Git exits non-zero before the executor kill takes effect",
        async () => {
            await expect(
                runFakeGit(
                    "trap 'printf boom >&2; exit 3' TERM; printf 0123456789; printf boom >&2; exit 3",
                    ["diff"],
                    { maxOutputBytes: 4 },
                ),
            ).rejects.toThrow("git diff exited with 3: boom");
        },
    );

    itPosix("resolves capped output when Git exits cleanly", async () => {
        const output = await runFakeGit("printf 0123456789; exit 0", ["diff"], {
            maxOutputBytes: 4,
        });

        expect(output.stdout).toEqual(Buffer.from("0123"));
        expect(output.truncated).toBe(true);
    });

    itPosix("names the terminating signal when the Git process is killed", async () => {
        await expect(runFakeGit("kill -TERM $$", ["commit"])).rejects.toThrow(
            "git commit was terminated by signal SIGTERM",
        );
    });

    it("streams binary stdout exclusively to the output file", async () => {
        const directory = await mkdtemp(join(tmpdir(), "intelligit-executor-"));
        const outputFile = join(directory, "archive");

        try {
            const output = await new GitExecutor(process.cwd()).runBinary(
                ["hash-object", "--stdin"],
                {
                    input: Buffer.from([0, 255, 1]),
                    outputFile,
                },
            );

            expect(output.stdout).toEqual(Buffer.alloc(0));
            expect((await readFile(outputFile)).toString("utf8")).toMatch(/^[a-f0-9]{40}\n$/);
        } finally {
            await rm(directory, { force: true, recursive: true });
        }
    });

    it("rejects when the output stream cannot be opened", async () => {
        const directory = await mkdtemp(join(tmpdir(), "intelligit-executor-"));

        try {
            await expect(
                new GitExecutor(process.cwd()).runBinary(["hash-object", "--stdin"], {
                    input: Buffer.from([0, 255, 1]),
                    outputFile: join(directory, "missing", "archive"),
                }),
            ).rejects.toMatchObject({ code: "ENOENT" });
        } finally {
            await rm(directory, { force: true, recursive: true });
        }
    });

    it("routes mutating commands through the shared mutation gate", async () => {
        const { gate, gatedRuns } = gateProbe();
        const executor = new GitExecutor(process.cwd(), gate);

        await executor.run(["status", "--porcelain"]);
        expect(gatedRuns).toHaveLength(0);

        await expect(executor.run(["revert", "--abort"])).rejects.toThrow();
        expect(gatedRuns).toHaveLength(1);
    });

    it("keeps read-only stash and branch listings outside the gate", async () => {
        const { gate, gatedRuns } = gateProbe();
        const executor = new GitExecutor(process.cwd(), gate);

        await executor.run(["stash", "list"]);
        await executor.run(["branch", "--list"]);

        expect(gatedRuns).toHaveLength(0);
    });

    itPosix("keeps branch queries off the gate and branch writes on it", async () => {
        // `getBranches()` issues exactly this, and it runs on every panel refresh. Gating
        // it queues the refresh behind whatever mutation holds the gate, so a push with
        // slow pre-push hooks leaves the panel empty until the hooks finish.
        expect(await gatedRunCount(["branch", "-a", "--format=%(refname)"])).toBe(0);
        expect(await gatedRunCount(["branch"])).toBe(0);
        expect(await gatedRunCount(["branch", "--list", "feature/*"])).toBe(0);
        expect(await gatedRunCount(["branch", "-vv", "--no-color"])).toBe(0);

        expect(await gatedRunCount(["branch", "-d", "gone"])).toBe(1);
        expect(await gatedRunCount(["branch", "-m", "old", "new"])).toBe(1);
        expect(await gatedRunCount(["branch", "topic", "HEAD"])).toBe(1);
        // Writes that name no branch still mutate the checked-out one.
        expect(await gatedRunCount(["branch", "--unset-upstream"])).toBe(1);
        expect(await gatedRunCount(["branch", "--set-upstream-to=origin/main", "topic"])).toBe(1);
    });

    itPosix("serves a branch listing while a long push holds the mutation gate", async () => {
        const directory = await mkdtemp(join(tmpdir(), "intelligit-blocking-git-"));
        const started = join(directory, "push-started");
        const release = join(directory, "push-release");
        const restoreEnv = await installFakeGit(
            directory,
            `if [ "$1" = "push" ]; then\n  : > "${started}"\n  while [ ! -f "${release}" ]; do sleep 0.05; done\nfi\nexit 0`,
        );
        const executor = new GitExecutor(
            directory,
            new RepositoryMutationGate(new RepositoryMutationCoordinator(), new RepositoryLock()),
        );
        const push = executor.run(["push"]);
        try {
            const deadline = Date.now() + 5_000;
            while (!existsSync(started) && Date.now() < deadline) {
                await new Promise<void>((resolve) => setTimeout(resolve, 10));
            }
            expect(existsSync(started)).toBe(true);

            // The mutation queue has no timeout, so a listing routed through it would only
            // resolve once the push does — the panel stays empty for the whole hook run.
            const blocked = "blocked-by-push";
            const outcome = await Promise.race([
                executor.run(["branch", "-a", "--format=%(refname)"]),
                new Promise<string>((resolve) => setTimeout(() => resolve(blocked), 1_000)),
            ]);
            expect(outcome).not.toBe(blocked);
        } finally {
            await writeFile(release, "", "utf8");
            await push.catch(() => undefined);
            restoreEnv();
            await rm(directory, { force: true, recursive: true });
        }
    });

    it("shares the mutation gate with derived executors", async () => {
        const { gate, gatedRuns } = gateProbe();
        const executor = new GitExecutor(process.cwd(), gate).deriveFor(process.cwd());

        await expect(executor.run(["cherry-pick", "--abort"])).rejects.toThrow();

        expect(gatedRuns).toHaveLength(1);
    });

    itPosix("caps concurrent spawned processes at 6 per executor instance", async () => {
        const directory = await mkdtemp(join(tmpdir(), "intelligit-fake-git-concurrency-"));
        const activeDir = join(directory, "active");
        const resultsDir = join(directory, "results");
        await mkdir(activeDir);
        await mkdir(resultsDir);
        const script = [
            `id="$1"`,
            `touch "${activeDir}/$id"`,
            `set -- "${activeDir}"/*`,
            `count=$#`,
            `echo "$count" > "${resultsDir}/$id"`,
            `sleep 1`,
            `rm -f "${activeDir}/$id"`,
        ].join("\n");
        const restoreEnv = await installFakeGit(directory, script);

        const commandCount = 10;
        try {
            const executor = new GitExecutor(process.cwd());
            await Promise.all(
                Array.from({ length: commandCount }, (_, index) => executor.run([String(index)])),
            );
        } finally {
            restoreEnv();
        }

        const counts = await Promise.all(
            Array.from({ length: commandCount }, (_, index) =>
                readFile(join(resultsDir, String(index)), "utf8"),
            ),
        );
        await rm(directory, { force: true, recursive: true });
        const observedMaxConcurrency = Math.max(...counts.map((count) => Number(count.trim())));

        expect(observedMaxConcurrency).toBeGreaterThan(1);
        expect(observedMaxConcurrency).toBeLessThanOrEqual(6);
    });

    itPosix("runs a fake git whose script is still held open for writing", async () => {
        // The reproduction of a CI-only `spawn ETXTBSY`. `execve` refuses any target a
        // process still holds open for writing, and vitest's `threads` pool shares one
        // file-descriptor table across concurrent test files -- so a sibling file forking
        // mid-write kept a freshly written stub open past this exec, and whichever test
        // lost that race died with `spawn ETXTBSY`. Holding the descriptor open here makes
        // that condition deterministic instead of rare.
        //
        // Only Linux can fail this: macOS does not enforce ETXTBSY for these execs, which
        // is exactly why the original defect was green on every developer machine.
        const directory = await mkdtemp(join(tmpdir(), "intelligit-fake-git-busy-"));
        const restoreEnv = await installFakeGit(directory, "echo held-open-ok");
        const scriptPath = process.env.INTELLIGIT_FAKE_GIT_SCRIPT;
        if (scriptPath === undefined) throw new Error("installFakeGit named no script");
        const writer = await open(scriptPath, "r+");
        try {
            const output = await new GitExecutor(process.cwd()).run(["status"]);
            expect(output).toContain("held-open-ok");
        } finally {
            await writer.close();
            restoreEnv();
            await rm(directory, { force: true, recursive: true });
        }
    });
});

describe("git success hook", () => {
    afterEach(() => {
        setGitSuccessListener(undefined);
    });

    itPosix("reports a successful commit with its full argument list", async () => {
        const seen: Array<[string, readonly string[]]> = [];
        setGitSuccessListener((subcommand, argv) => seen.push([subcommand, argv]));

        await runWithStubGit(["commit", "-m", "msg"]);

        expect(seen).toEqual([["commit", ["commit", "-m", "msg"]]]);
    });

    itPosix("finds the subcommand behind Git's leading global options", async () => {
        const seen: Array<[string, readonly string[]]> = [];
        setGitSuccessListener((subcommand, argv) => seen.push([subcommand, argv]));

        // The exact shape a path-scoped panel commit produces via `withLiteralPathspecs`.
        const argv = ["--literal-pathspecs", "commit", "-m", "msg", "--only", "--", "a.ts"];
        await runWithStubGit(argv);

        expect(seen).toEqual([["commit", argv]]);
    });

    itPosix("skips the value of a global option that takes one", async () => {
        const seen: string[] = [];
        setGitSuccessListener((subcommand) => seen.push(subcommand));

        // `user.name=push` is a value, not a subcommand: taking it as one would both
        // miss the real commit and report a push that never happened.
        await runWithStubGit(["-c", "user.name=push", "commit", "-m", "msg"]);

        expect(seen).toEqual(["commit"]);
    });

    itPosix("stays silent when options are all there is", async () => {
        const seen: string[] = [];
        setGitSuccessListener((subcommand) => seen.push(subcommand));

        await runWithStubGit(["--literal-pathspecs"]);

        expect(seen).toEqual([]);
    });

    itPosix("stays silent for subcommands outside the hook's narrow set", async () => {
        const seen: string[] = [];
        setGitSuccessListener((subcommand) => seen.push(subcommand));

        await runWithStubGit(["status", "--porcelain"]);

        expect(seen).toEqual([]);
    });

    itPosix("stays silent when the command fails", async () => {
        const seen: string[] = [];
        setGitSuccessListener((subcommand) => seen.push(subcommand));

        await expect(runWithStubGit(["push"], "exit 1")).rejects.toThrow();

        expect(seen).toEqual([]);
    });

    itPosix("never turns a listener fault into a failed Git command", async () => {
        setGitSuccessListener(() => {
            throw new Error("listener exploded");
        });

        await expect(runWithStubGit(["push"])).resolves.toBeUndefined();
    });

    itPosix("stops reporting once the listener is cleared", async () => {
        const seen: string[] = [];
        setGitSuccessListener((subcommand) => seen.push(subcommand));
        await runWithStubGit(["commit"]);
        setGitSuccessListener(undefined);

        await runWithStubGit(["commit"]);

        expect(seen).toEqual(["commit"]);
    });
});
