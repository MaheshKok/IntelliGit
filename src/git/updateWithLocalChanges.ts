import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import path from "node:path";
import type { GitExecutor } from "./executor";
import { WHOLE_INDEX_OPERATION_MARKERS } from "./wholeIndexOperationWatcher";

type RunGit = Parameters<Parameters<GitExecutor["runWithinMutationGate"]>[0]>[0];

/** The repository identity approved before a dialog; HEAD changes invalidate that approval. */
export interface PullUpdateContext {
    repositoryRoot: string;
    branch: string;
    head: string;
    upstream: string;
    dirty: boolean;
}

/** A retained recovery copy. Only its immutable object ID is ever used for restoration. */
interface PullUpdateBackup {
    oid: string;
    message: string;
}

/** Unsupported starting states are refused without saving or integrating anything. */
export type PullUpdateRefusal =
    | "detached"
    | "unborn"
    | "no-upstream"
    | "active-operation"
    | "unmerged"
    | "unsupported-submodule"
    | "nested-repository"
    | "context-changed";

/** Failures retain diagnostics and distinguish restored work from uncertain partial mutations. */
interface PullUpdateFailure {
    kind: "failed";
    phase: "preflight" | "save" | "pull" | "restore";
    error: unknown;
    localChanges: "untouched" | "restored" | "saved" | "uncertain";
    backup?: PullUpdateBackup;
    /** A save can create a recoverable entry even when reading its identity subsequently fails. */
    backupName?: string;
}

/** Read-only preparation captures the command's repository ownership before user consent. */
export type PullUpdatePreparation =
    | { kind: "ready"; context: PullUpdateContext }
    | { kind: "refused"; reason: PullUpdateRefusal }
    | PullUpdateFailure;

/** Git outcomes are returned before UI work; neither conflicts nor failures trigger a retry. */
export type PullUpdateResult =
    | { kind: "complete"; backup?: PullUpdateBackup }
    | { kind: "confirmation-required"; context: PullUpdateContext }
    | { kind: "refused"; reason: PullUpdateRefusal }
    | {
          kind: "integration-conflict";
          error: unknown;
          backup?: PullUpdateBackup;
          hasUnmergedPaths: boolean;
      }
    | {
          kind: "restore-failed";
          integration: "succeeded" | "failed";
          integrationError?: unknown;
          error: unknown;
          backup: PullUpdateBackup;
          hasUnmergedPaths: boolean;
      }
    | PullUpdateFailure;

/** Selects how incoming commits are integrated after local work has been saved. */
export type PullUpdateStrategy = "rebase" | "merge";

/** Consent permits saving Git-reported on-disk changes, excluding ignored files and editor buffers. */
export interface PullUpdateOptions {
    expected: PullUpdateContext;
    saveLocalChanges: boolean;
    /** Captured before consent; Git configuration cannot override this integration choice. */
    strategy: PullUpdateStrategy;
    onProgress?: (phase: "saving" | "pulling" | "restoring") => void;
}

interface UpdateState extends PullUpdateContext {
    activeOperation: boolean;
    hasUnmergedPaths: boolean;
    unsupportedSubmodule: boolean;
    nestedRepository: boolean;
}

/** Distinguishes absent metadata from inaccessible metadata; inspection errors must stop mutation. */
async function exists(file: string): Promise<boolean> {
    try {
        await lstat(file);
        return true;
    } catch (error) {
        if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? ""))
            return false;
        throw error;
    }
}

/** Reads NUL-delimited status so whitespace and Unicode paths do not change preflight meaning. */
async function readState(run: RunGit): Promise<UpdateState> {
    const [root, gitDir, output] = await Promise.all([
        run(["rev-parse", "--show-toplevel"]),
        run(["rev-parse", "--absolute-git-dir"]),
        run([
            "status",
            "--porcelain=v2",
            "--branch",
            "--untracked-files=all",
            "--ignore-submodules=none",
            "-z",
        ]),
    ]);
    const records = output.split("\0");
    const header = (name: string): string =>
        records.find((entry) => entry.startsWith(`# branch.${name} `))?.slice(name.length + 10) ??
        "";
    const branch = header("head");
    const head = header("oid");
    if (!branch || !head) throw new Error("Git did not report branch ownership.");
    const repositoryRoot = path.resolve(root.trim());
    const entries: string[] = [];
    for (let index = 0; index < records.length; index++) {
        const record = records[index];
        if (!record || record.startsWith("# ")) continue;
        entries.push(record);
        if (record.startsWith("2 ")) index++;
    }
    let nestedRepository = false;
    for (const entry of entries.filter((record) => record.startsWith("? "))) {
        const parts = entry.slice(2).split("/").filter(Boolean);
        const directoryCount = entry.endsWith("/") ? parts.length : parts.length - 1;
        for (let length = 1; length <= directoryCount; length++) {
            if (await exists(path.join(repositoryRoot, ...parts.slice(0, length), ".git"))) {
                nestedRepository = true;
                break;
            }
        }
    }
    const markers = await Promise.all(
        WHOLE_INDEX_OPERATION_MARKERS.map((marker) => exists(path.join(gitDir.trim(), marker))),
    );
    return {
        repositoryRoot,
        branch,
        head,
        upstream: header("upstream")
            ? (await run(["rev-parse", "--symbolic-full-name", "@{upstream}"])).trim()
            : "",
        dirty: entries.length > 0,
        activeOperation: markers.some(Boolean),
        hasUnmergedPaths: entries.some((entry) => entry.startsWith("u ")),
        unsupportedSubmodule: entries.some((entry) => {
            const fields = entry.split(" ");
            return (
                (fields[0] === "1" || fields[0] === "2") &&
                (fields[2].startsWith("S") || fields.slice(3, 6).includes("160000"))
            );
        }),
        nestedRepository,
    };
}

/** Refuses only unsupported states; ordinary dirty files instead require explicit consent. */
function refusal(state: UpdateState): PullUpdateRefusal | undefined {
    if (state.branch === "(detached)") return "detached";
    if (state.head === "(initial)") return "unborn";
    if (state.activeOperation) return "active-operation";
    if (state.hasUnmergedPaths) return "unmerged";
    if (!state.upstream) return "no-upstream";
    if (state.unsupportedSubmodule) return "unsupported-submodule";
    if (state.nestedRepository) return "nested-repository";
    return undefined;
}

/** Compares the approved repository, branch and tracking ref; callers choose whether HEAD may move. */
function sameContext(
    actual: PullUpdateContext,
    expected: PullUpdateContext,
    compareHead: boolean,
): boolean {
    return (
        actual.repositoryRoot === expected.repositoryRoot &&
        actual.branch === expected.branch &&
        actual.upstream === expected.upstream &&
        (!compareHead || actual.head === expected.head)
    );
}

/** Performs no mutations and propagates read failures as explicit preflight outcomes. */
export async function preparePullUpdate(run: RunGit): Promise<PullUpdatePreparation> {
    try {
        const state = await readState(run);
        const reason = refusal(state);
        if (reason) return { kind: "refused", reason };
        const { repositoryRoot, branch, head, upstream, dirty } = state;
        return { kind: "ready", context: { repositoryRoot, branch, head, upstream, dirty } };
    } catch (error) {
        return { kind: "failed", phase: "preflight", error, localChanges: "untouched" };
    }
}

/** Lists full immutable stash identities; malformed or unreadable lists never mean an empty stack. */
async function listStashes(run: RunGit): Promise<PullUpdateBackup[]> {
    const fields = (await run(["stash", "list", "-z", "--format=%H%x00%gs"])).split("\0");
    if (fields.at(-1) === "") fields.pop();
    if (fields.length % 2) throw new Error("Cannot verify stash identities.");
    const entries: PullUpdateBackup[] = [];
    for (let index = 0; index < fields.length; index += 2) {
        if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(fields[index]))
            throw new Error("Cannot verify stash identity.");
        entries.push({ oid: fields[index], message: fields[index + 1] });
    }
    return entries;
}

/** Progress is presentation-only and cannot interrupt saving or change a verified Git result. */
function progress(options: PullUpdateOptions, phase: "saving" | "pulling" | "restoring"): void {
    try {
        options.onProgress?.(phase);
    } catch {
        /* Continue the transaction if a disposed UI rejects progress. */
    }
}

/** Applies the owned object once and keeps integration failure independent from restore failure. */
async function restoreBackup(
    run: RunGit,
    options: PullUpdateOptions,
    backup: PullUpdateBackup,
    restoredHead: string,
    integrationError: unknown,
): Promise<PullUpdateResult> {
    try {
        await run(["cat-file", "-e", `${backup.oid}^{commit}`]);
        progress(options, "restoring");
        await run(["stash", "apply", "--index", backup.oid]);
        const state = await readState(run);
        if (
            state.activeOperation ||
            state.hasUnmergedPaths ||
            !sameContext(state, { ...options.expected, head: restoredHead }, true)
        ) {
            throw new Error(
                "Repository changed during restoration; inspect current files and the retained backup.",
            );
        }
    } catch (error) {
        let hasUnmergedPaths = false;
        try {
            hasUnmergedPaths = (await readState(run)).hasUnmergedPaths;
        } catch {
            /* The original restore failure remains authoritative. */
        }
        return {
            kind: "restore-failed",
            integration: integrationError ? "failed" : "succeeded",
            integrationError,
            error,
            backup,
            hasUnmergedPaths,
        };
    }
    return integrationError
        ? {
              kind: "failed",
              phase: "pull",
              error: integrationError,
              localChanges: "restored",
              backup,
          }
        : { kind: "complete", backup };
}

/**
 * Saves, integrates with the selected strategy, and applies one owned stash under the held gate.
 * The supplied runner must be ungated and pinned to the captured worktree. Every backup remains
 * in the stash list, including after success; conflicts require deliberate manual recovery.
 */
export async function pullUpdateWithinGate(
    run: RunGit,
    options: PullUpdateOptions,
): Promise<PullUpdateResult> {
    const pullArgs = {
        rebase: ["pull", "--rebase", "--no-autostash"],
        merge: ["pull", "--no-rebase", "--no-autostash", "--no-edit", "--ff"],
    }[options.strategy];
    let phase: PullUpdateFailure["phase"] = "preflight";
    let backup: PullUpdateBackup | undefined;
    let backupName: string | undefined;
    let saveAttempted = false;
    try {
        let state = await readState(run);
        const reason = refusal(state);
        if (reason) return { kind: "refused", reason };
        if (!sameContext(state, options.expected, true))
            return { kind: "refused", reason: "context-changed" };
        if (state.dirty && !options.saveLocalChanges)
            return { kind: "confirmation-required", context: state };
        if (state.dirty) {
            phase = "save";
            const before = new Set((await listStashes(run)).map((entry) => entry.oid));
            backupName = `IntelliGit update: ${state.branch} ${new Date().toISOString()} [${randomUUID()}]`;
            progress(options, "saving");
            saveAttempted = true;
            let saveError: unknown;
            try {
                await run(["stash", "push", "--include-untracked", "--message", backupName]);
            } catch (error) {
                saveError = error;
            }
            const owned = (await listStashes(run)).filter(
                (entry) => entry.message.endsWith(`: ${backupName}`) && !before.has(entry.oid),
            );
            const identities = new Set(owned.map((entry) => entry.oid));
            if (identities.size === 1) backup = { oid: owned[0].oid, message: backupName };
            if (saveError)
                return {
                    kind: "failed",
                    phase,
                    error: saveError,
                    localChanges: "uncertain",
                    backup,
                    backupName,
                };
            if (!backup)
                throw new Error(
                    "Cannot identify the new named backup; inspect the stash list before recovery.",
                );
            state = await readState(run);
            if (refusal(state) || state.dirty || !sameContext(state, options.expected, true)) {
                throw new Error(
                    "Repository changed while saving local changes; inspect the retained backup and current files.",
                );
            }
        }
        phase = "pull";
        progress(options, "pulling");
        let integrationError: unknown;
        try {
            await run(pullArgs);
        } catch (error) {
            integrationError = error;
        }
        state = await readState(run);
        if (state.activeOperation || state.hasUnmergedPaths) {
            return {
                kind: "integration-conflict",
                error: integrationError,
                backup,
                hasUnmergedPaths: state.hasUnmergedPaths,
            };
        }
        if (!sameContext(state, options.expected, false) || state.dirty) {
            return {
                kind: "failed",
                phase,
                error:
                    integrationError ??
                    new Error(
                        "Repository changed during pull; automatic restoration was not attempted.",
                    ),
                localChanges: backup ? "saved" : "uncertain",
                backup,
            };
        }
        if (backup) {
            return restoreBackup(run, options, backup, state.head, integrationError);
        }
        if (integrationError)
            return {
                kind: "failed",
                phase: "pull",
                error: integrationError,
                localChanges: "untouched",
            };
        return { kind: "complete" };
    } catch (error) {
        return {
            kind: "failed",
            phase,
            error,
            localChanges: saveAttempted ? "uncertain" : "untouched",
            backup,
            backupName,
        };
    }
}
