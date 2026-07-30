import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { GitExecutor } from "../../../src/git/executor";
import type { RepositoryMutationGate } from "../../../src/git/repositoryMutationGate";

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

describe("GitExecutor", () => {
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

    itPosix("rejects a non-zero exit without stderr using a bounded command description", async () => {
        await expect(
            runFakeGit("exit 17", ["commit", "--message", "ignored-argument"]),
        ).rejects.toThrow("git commit --message exited with 17: (no stderr)");
    });

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

    itPosix("resolves capped output after the executor terminates a long-running Git process", async () => {
        const startedAt = Date.now();
        const output = await runFakeGit("printf 0123456789; exec sleep 5", ["diff"], {
            maxOutputBytes: 4,
        });

        expect(output.stdout).toEqual(Buffer.from("0123"));
        expect(output.truncated).toBe(true);
        expect(Date.now() - startedAt).toBeLessThan(2_000);
    });

    itPosix("rejects capped output when Git exits non-zero before the executor kill takes effect", async () => {
        await expect(
            runFakeGit(
                "trap 'printf boom >&2; exit 3' TERM; printf 0123456789; printf boom >&2; exit 3",
                ["diff"],
                { maxOutputBytes: 4 },
            ),
        ).rejects.toThrow("git diff exited with 3: boom");
    });

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
