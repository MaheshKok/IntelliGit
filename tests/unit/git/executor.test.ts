import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { GitExecutor } from "../../../src/git/executor";
import { RepositoryMutationCoordinator } from "../../../src/git/mutationCoordinator";
import { RepositoryLock } from "../../../src/git/repositoryLock";
import { RepositoryMutationGate } from "../../../src/git/repositoryMutationGate";

const itPosix = process.platform === "win32" ? it.skip : it;

interface GateProbe {
    gate: RepositoryMutationGate;
    gatedRuns: number[];
}

function gateProbe(): GateProbe {
    const gatedRuns: number[] = [];
    const gate = {
        run: async <T>(
            _repoRoot: string,
            _commonDir: string,
            operation: () => Promise<T>,
        ): Promise<T> => {
            gatedRuns.push(gatedRuns.length);
            return operation();
        },
        resolveCommonDir: (_repoRoot: string, commonDir: string): string => commonDir.trim(),
    } as unknown as RepositoryMutationGate;
    return { gate, gatedRuns };
}

/** Runs the executor against a real temporary Git executable with controlled process behavior. */
async function runFakeGit(
    script: string,
    args: string[],
    options: Parameters<GitExecutor["runBinary"]>[1] = {},
): Promise<Awaited<ReturnType<GitExecutor["runBinary"]>>> {
    const directory = await mkdtemp(join(tmpdir(), "intelligit-fake-git-"));
    const executable = join(directory, "git");
    const originalPath = process.env.PATH;
    await writeFile(executable, `#!/bin/sh\n${script}\n`, "utf8");
    await chmod(executable, 0o755);
    process.env.PATH = `${directory}${delimiter}${originalPath ?? ""}`;
    try {
        return await new GitExecutor(process.cwd()).runBinary(args, options);
    } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
        await rm(directory, { force: true, recursive: true });
    }
}

/** Runs text-mode executor commands against a temporary Git executable. */
async function runFakeGitText(
    script: string,
    args: string[],
    options: Parameters<GitExecutor["run"]>[1] = {},
    gate?: RepositoryMutationGate,
): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "intelligit-fake-git-"));
    const executable = join(directory, "git");
    const originalPath = process.env.PATH;
    await writeFile(executable, `#!/bin/sh\n${script}\n`, "utf8");
    await chmod(executable, 0o755);
    process.env.PATH = `${directory}${delimiter}${originalPath ?? ""}`;
    try {
        return await new GitExecutor(process.cwd(), gate).run(args, options);
    } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
        await rm(directory, { force: true, recursive: true });
    }
}

/**
 * Reports how many times `args` reached the mutation gate, running against a stub
 * `git` so write-shaped commands are classified without touching a real repository.
 */
async function gatedRunCount(args: string[]): Promise<number> {
    const directory = await mkdtemp(join(tmpdir(), "intelligit-classify-git-"));
    const executable = join(directory, "git");
    const originalPath = process.env.PATH;
    await writeFile(executable, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(executable, 0o755);
    process.env.PATH = `${directory}${delimiter}${originalPath ?? ""}`;
    try {
        const { gate, gatedRuns } = gateProbe();
        await new GitExecutor(process.cwd(), gate).run(args);
        return gatedRuns.length;
    } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
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

    it("returns binary stdout without decoding it", async () => {
        const executor = new GitExecutor(process.cwd());

        const output = await executor.runBinary(["hash-object", "--stdin"], {
            input: Buffer.from([0, 255, 1]),
        });

        expect(Buffer.isBuffer(output.stdout)).toBe(true);
        expect(output.stdout.toString("utf8")).toMatch(/^[a-f0-9]{40}\n$/);
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
        const originalPath = process.env.PATH;
        await writeFile(
            join(directory, "git"),
            `#!/bin/sh\nif [ "$1" = "push" ]; then\n  : > "${started}"\n  while [ ! -f "${release}" ]; do sleep 0.05; done\nfi\nexit 0\n`,
            "utf8",
        );
        await chmod(join(directory, "git"), 0o755);
        process.env.PATH = `${directory}${delimiter}${originalPath ?? ""}`;
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
            if (originalPath === undefined) delete process.env.PATH;
            else process.env.PATH = originalPath;
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
        const executable = join(directory, "git");
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
        await writeFile(executable, `#!/bin/sh\n${script}\n`, "utf8");
        await chmod(executable, 0o755);

        const originalPath = process.env.PATH;
        process.env.PATH = `${directory}${delimiter}${originalPath ?? ""}`;
        const commandCount = 10;
        try {
            const executor = new GitExecutor(process.cwd());
            await Promise.all(
                Array.from({ length: commandCount }, (_, index) => executor.run([String(index)])),
            );
        } finally {
            if (originalPath === undefined) delete process.env.PATH;
            else process.env.PATH = originalPath;
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
});
