import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GitExecutor } from "../../../src/git/executor";
import type { RepositoryMutationGate } from "../../../src/git/repositoryMutationGate";

interface GateProbe {
    gate: RepositoryMutationGate;
    gatedRuns: number[];
}

function gateProbe(): GateProbe {
    const gatedRuns: number[] = [];
    const gate = {
        run: async <T>(_repoRoot: string, _commonDir: string, operation: () => Promise<T>): Promise<T> => {
            gatedRuns.push(gatedRuns.length);
            return operation();
        },
        resolveCommonDir: (_repoRoot: string, commonDir: string): string => commonDir.trim(),
    } as unknown as RepositoryMutationGate;
    return { gate, gatedRuns };
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

        const output = await executor.runBinary(["diff", "--no-index", "--", "/dev/null", "package.json"], {
            expectedExitCodes: [0, 1],
        });

        expect(output.exitCode).toBe(1);
    });

    it("streams binary stdout exclusively to the output file", async () => {
        const directory = await mkdtemp(join(tmpdir(), "intelligit-executor-"));
        const outputFile = join(directory, "archive");

        try {
            const output = await new GitExecutor(process.cwd()).runBinary(["hash-object", "--stdin"], {
                input: Buffer.from([0, 255, 1]),
                outputFile,
            });

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
});
