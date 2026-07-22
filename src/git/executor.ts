import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import simpleGit, { SimpleGit } from "simple-git";
import { RepositoryMutationGate } from "./repositoryMutationGate";

/** Options for a binary Git process invocation. */
export interface GitBinaryRunOptions {
    input?: Buffer;
    expectedExitCodes?: readonly number[];
    outputFile?: string;
}

/** Raw process result for a binary Git invocation; streamed stdout is empty. */
export interface GitBinaryRunResult {
    stdout: Buffer;
    stderr: Buffer;
    exitCode: number;
}

/**
 * Owns the repository-scoped Simple Git instance used by extension Git operations.
 *
 * The executor is intentionally thin: callers provide raw Git arguments, and
 * higher layers remain responsible for validation, path safety, and workflow-
 * specific error handling. This class only binds invocations to the active
 * repository root while preserving the shared concurrency limit.
 */
export class GitExecutor {
    private git: SimpleGit;
    private repoRoot: string;

    /**
     * Creates an executor rooted at the repository path selected during activation.
     */
    constructor(repoRoot: string, private readonly mutationGate?: RepositoryMutationGate) {
        this.repoRoot = repoRoot;
        this.git = simpleGit(repoRoot, { maxConcurrentProcesses: 6 });
    }

    /**
     * Rebinds subsequent Git commands to a newly selected repository root.
     *
     * Existing callers use this when the active repository changes without
     * rebuilding every service that depends on the executor.
     */
    setRoot(repoRoot: string): void {
        this.repoRoot = repoRoot;
        this.git = simpleGit(repoRoot, { maxConcurrentProcesses: 6 });
    }

    /**
     * Creates a sibling executor for another repository root that shares this
     * executor's mutation gate, so derived executors stay serialized with the
     * activation-owned queue and cross-process lock.
     */
    deriveFor(repoRoot: string): GitExecutor {
        return new GitExecutor(repoRoot, this.mutationGate);
    }

    /**
     * Runs a raw Git command through Simple Git and returns stdout.
     *
     * Callers own argument validation, path safety, and user-facing error handling;
     * this method intentionally preserves Simple Git's rejection behavior so higher
     * layers can translate failures in workflow-specific ways.
     */
    async run(args: string[]): Promise<string> {
        if (this.mutationGate && isMutatingGitCommand(args)) {
            const commonDir = await this.git.raw(["rev-parse", "--git-common-dir"]);
            return this.mutationGate.run(this.repoRoot, this.mutationGate.resolveCommonDir(this.repoRoot, commonDir), () =>
                this.git.raw(args),
            );
        }
        return this.git.raw(args);
    }

    /** Runs Git without decoding stdout; output-file mode streams stdout and returns an empty buffer. */
    async runBinary(args: string[], options: GitBinaryRunOptions = {}): Promise<GitBinaryRunResult> {
        const expectedExitCodes = options.expectedExitCodes ?? [0];
        return new Promise<GitBinaryRunResult>((resolve, reject) => {
            const child = spawn("git", args, { cwd: this.repoRoot, stdio: "pipe" });
            const stdout: Buffer[] = [];
            const stderr: Buffer[] = [];
            const output = options.outputFile ? createWriteStream(options.outputFile) : undefined;
            const stdoutDone = output
                ? pipeline(child.stdout, output)
                : new Promise<void>((resolve) => {
                      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
                      child.stdout.once("end", resolve);
                  });
            void stdoutDone.catch(() => undefined);
            child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
            const finish = async (exitCode: number | null): Promise<void> => {
                try {
                    await stdoutDone;
                } catch (error) {
                    reject(error instanceof Error ? error : new Error(String(error)));
                    return;
                }
                const result = {
                    stdout: output ? Buffer.alloc(0) : Buffer.concat(stdout),
                    stderr: Buffer.concat(stderr),
                    exitCode: exitCode ?? -1,
                };
                if (expectedExitCodes.includes(result.exitCode)) return resolve(result);
                reject(
                    new Error(
                        `git ${args.join(" ")} exited with ${result.exitCode}: ${result.stderr.toString("utf8")}`,
                    ),
                );
            };
            child.once("error", reject);
            child.once("close", (exitCode) => {
                void finish(exitCode);
            });
            if (options.input) child.stdin.end(options.input);
            else child.stdin.end();
        });
    }
}

function isMutatingGitCommand(args: string[]): boolean {
    const command = args[0];
    if (!command) return false;
    if (
        [
            "add",
            "am",
            "apply",
            "cherry-pick",
            "checkout",
            "clean",
            "commit",
            "merge",
            "mv",
            "pull",
            "rebase",
            "reset",
            "restore",
            "revert",
            "rm",
            "switch",
            "tag",
        ].includes(command)
    )
        return true;
    if (command === "stash") return !["list", "show"].includes(args[1] ?? "");
    if (command === "branch") return !args.includes("--list") && args.length > 1;
    if (command === "push") return true;
    if (command === "worktree") return !["list"].includes(args[1] ?? "");
    return false;
}
