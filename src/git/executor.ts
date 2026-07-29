import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
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
 * Owns the repository-scoped Git process runner used by extension Git operations.
 *
 * The executor is intentionally thin: callers provide raw Git arguments, and
 * higher layers remain responsible for validation, path safety, and workflow-
 * specific error handling. This class only binds invocations to the active
 * repository root for every invocation.
 */
export class GitExecutor {
    private repoRoot: string;
    private readonly processSemaphore = new Semaphore(MAX_CONCURRENT_PROCESSES);

    /**
     * Creates an executor rooted at the repository path selected during activation.
     */
    constructor(
        repoRoot: string,
        private readonly mutationGate?: RepositoryMutationGate,
    ) {
        this.repoRoot = repoRoot;
    }

    /**
     * Rebinds subsequent Git commands to a newly selected repository root.
     *
     * Existing callers use this when the active repository changes without
     * rebuilding every service that depends on the executor.
     */
    setRoot(repoRoot: string): void {
        this.repoRoot = repoRoot;
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
     * Runs a raw Git command and returns stdout.
     *
     * Callers own argument validation, path safety, and user-facing error handling;
     * this method rejects every unexpected process exit so higher layers can
     * translate failures in workflow-specific ways. At most MAX_CONCURRENT_PROCESSES
     * spawned Git processes run concurrently per executor instance, matching the
     * previous Simple Git concurrency cap.
     */
    async run(args: string[]): Promise<string> {
        await this.processSemaphore.acquire();
        try {
            const runText = async (): Promise<string> =>
                (await this.runBinary(args)).stdout.toString("utf8");
            if (this.mutationGate && isMutatingGitCommand(args)) {
                const commonDir = (
                    await this.runBinary(["rev-parse", "--git-common-dir"])
                ).stdout.toString("utf8");
                return await this.mutationGate.run(
                    this.repoRoot,
                    this.mutationGate.resolveCommonDir(this.repoRoot, commonDir),
                    runText,
                );
            }
            return await runText();
        } finally {
            this.processSemaphore.release();
        }
    }

    /** Runs Git without decoding stdout; output-file mode streams stdout and returns an empty buffer. */
    async runBinary(
        args: string[],
        options: GitBinaryRunOptions = {},
    ): Promise<GitBinaryRunResult> {
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
            const finish = async (
                exitCode: number | null,
                signal: NodeJS.Signals | null,
            ): Promise<void> => {
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
                if (!signal && expectedExitCodes.includes(result.exitCode)) return resolve(result);
                const command = args.slice(0, 2).join(" ") || "(no subcommand)";
                const stderrText = result.stderr.toString("utf8").trim() || "(no stderr)";
                const outcome = signal
                    ? `was terminated by signal ${signal}`
                    : `exited with ${result.exitCode}`;
                reject(new Error(`git ${command} ${outcome}: ${stderrText}`));
            };
            child.once("error", reject);
            child.once("close", (exitCode, signal) => {
                void finish(exitCode, signal);
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

/** Matches the previous Simple Git `maxConcurrentProcesses` cap. */
const MAX_CONCURRENT_PROCESSES = 6;

/** Tiny FIFO semaphore bounding how many Git processes one executor spawns concurrently. */
class Semaphore {
    private active = 0;
    private readonly queue: Array<() => void> = [];

    constructor(private readonly limit: number) {}

    async acquire(): Promise<void> {
        if (this.active < this.limit) {
            this.active += 1;
            return;
        }
        await new Promise<void>((resolve) => this.queue.push(resolve));
    }

    release(): void {
        const next = this.queue.shift();
        if (next) {
            next();
            return;
        }
        this.active -= 1;
    }
}
