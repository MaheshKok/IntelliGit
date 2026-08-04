import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { RepositoryMutationGate } from "./repositoryMutationGate";

/** Options for a binary Git process invocation. */
export interface GitBinaryRunOptions {
    input?: Buffer;
    expectedExitCodes?: readonly number[];
    outputFile?: string;
    /** Environment variables merged over the parent process only for this Git invocation. */
    env?: Record<string, string>;
    /** Stops stdout acquisition after this many bytes, retaining only the bounded prefix. */
    maxOutputBytes?: number;
}

/** Raw process result for a binary Git invocation; streamed stdout is empty. */
export interface GitBinaryRunResult {
    stdout: Buffer;
    stderr: Buffer;
    exitCode: number;
    /** True when stdout reached `maxOutputBytes` and the Git process was stopped. */
    truncated: boolean;
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
     *
     * `options.env` merges over a copy of the parent environment for this invocation
     * only — `process.env` is never mutated — and is forwarded on both the gated
     * (mutating) and ungated paths.
     */
    async run(args: string[], options: Pick<GitBinaryRunOptions, "env"> = {}): Promise<string> {
        await this.processSemaphore.acquire();
        try {
            const output = await this.runGated(args, options);
            notifyGitSuccessSafely(args);
            return output;
        } finally {
            this.processSemaphore.release();
        }
    }

    /** Routes mutating commands through the repository mutation gate; others run directly. */
    private async runGated(
        args: string[],
        options: Pick<GitBinaryRunOptions, "env"> = {},
    ): Promise<string> {
        const runText = async (): Promise<string> =>
            (await this.runBinary(args, options)).stdout.toString("utf8");
        if (!this.mutationGate || !isMutatingGitCommand(args)) return await runText();

        const commonDir = (await this.runBinary(["rev-parse", "--git-common-dir"])).stdout.toString(
            "utf8",
        );
        return await this.mutationGate.run(
            this.repoRoot,
            this.mutationGate.resolveCommonDir(this.repoRoot, commonDir),
            runText,
        );
    }

    /** Runs Git without decoding stdout; output-file mode streams stdout and returns an empty buffer. */
    async runBinary(
        args: string[],
        options: GitBinaryRunOptions = {},
    ): Promise<GitBinaryRunResult> {
        const expectedExitCodes = options.expectedExitCodes ?? [0];
        if (options.outputFile && options.maxOutputBytes !== undefined) {
            throw new Error(
                "Git binary output cannot be both streamed to a file and byte-limited.",
            );
        }
        return new Promise<GitBinaryRunResult>((resolve, reject) => {
            const child = spawn("git", args, {
                cwd: this.repoRoot,
                stdio: "pipe",
                env: { ...process.env, ...options.env },
            });
            const stdout: Buffer[] = [];
            const stderr: Buffer[] = [];
            const output = options.outputFile ? createWriteStream(options.outputFile) : undefined;
            let stdoutBytes = 0;
            let truncated = false;
            let terminatedForOutputLimit = false;
            const stdoutDone = output
                ? pipeline(child.stdout, output)
                : new Promise<void>((resolve) => {
                      child.stdout.on("data", (chunk: Buffer) => {
                          const maxOutputBytes = options.maxOutputBytes;
                          if (maxOutputBytes === undefined) {
                              stdout.push(chunk);
                              return;
                          }
                          const remainingBytes = maxOutputBytes - stdoutBytes;
                          if (remainingBytes > 0) {
                              stdout.push(chunk.subarray(0, remainingBytes));
                              stdoutBytes += Math.min(chunk.length, remainingBytes);
                          }
                          if (chunk.length > remainingBytes) {
                              truncated = true;
                              terminatedForOutputLimit = child.kill();
                          }
                      });
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
                    truncated,
                };
                if (
                    result.truncated &&
                    (result.exitCode === 0 || (terminatedForOutputLimit && signal !== null))
                ) {
                    return resolve(result);
                }
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

/** Called after a Git command the user initiated has completed successfully. */
export type GitSuccessListener = (subcommand: string, argv: readonly string[]) => void;

/**
 * Subcommands the success hook reports.
 *
 * Deliberately narrow: IntelliGit runs read-only Git commands constantly, and a hook
 * that fired on all of them would put listener code on a hot path it has no business
 * being on. Widen this only with a reason.
 */
const NOTIFIED_SUBCOMMANDS: ReadonlySet<string> = new Set(["commit", "push"]);

let gitSuccessListener: GitSuccessListener | undefined;

/** Installs the process-wide success listener, or clears it when passed `undefined`. */
export function setGitSuccessListener(listener: GitSuccessListener | undefined): void {
    gitSuccessListener = listener;
}

/**
 * Reports a successful Git command to the installed listener, if any.
 *
 * Exported because `publishService` spawns its authenticated push directly and would
 * otherwise bypass the executor. A listener fault is swallowed on purpose: a Git command
 * that already succeeded must never be reported to the user as failed.
 */
export function notifyGitSuccessSafely(argv: readonly string[]): void {
    const subcommand = argv[0];
    if (!subcommand || !NOTIFIED_SUBCOMMANDS.has(subcommand)) return;
    try {
        gitSuccessListener?.(subcommand, argv);
    } catch {
        // Intentionally ignored — see the doc comment above.
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
    if (command === "branch") return isBranchMutation(args);
    if (command === "push") return true;
    if (command === "worktree") return !["list"].includes(args[1] ?? "");
    return false;
}

/** `git branch` options that write refs or config even without naming a branch. */
const BRANCH_WRITE_FLAGS = [
    "-d",
    "-D",
    "--delete",
    "-m",
    "-M",
    "--move",
    "-c",
    "-C",
    "--copy",
    "-f",
    "--force",
    "-u",
    "--set-upstream",
    "--set-upstream-to",
    "--unset-upstream",
    "--edit-description",
];

/**
 * Classifies one `git branch` invocation, defaulting to a mutation when unsure.
 *
 * Listing branches is a read, and gating reads is not merely wasteful: the mutation
 * queue has no timeout, so a listing issued while a long mutation holds the gate —
 * a push whose pre-push hooks take minutes — waits for that mutation to finish.
 * A bare positional argument names a branch to create or rename, except under
 * `--list`, where positionals are name patterns.
 */
function isBranchMutation(args: string[]): boolean {
    const options = args.slice(1);
    if (
        options.some((option) =>
            BRANCH_WRITE_FLAGS.some((flag) => option === flag || option.startsWith(`${flag}=`)),
        )
    )
        return true;
    if (options.includes("--list") || options.includes("-l")) return false;
    return options.some((option) => !option.startsWith("-"));
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
