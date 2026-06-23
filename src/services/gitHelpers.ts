// Git helper functions extracted from extension.ts.
// Provides branch resolution, hash validation, and commit utilities
// used by multiple command modules.

import * as vscode from "vscode";
import { GitExecutor } from "../git/executor";
import { GitOps } from "../git/operations";
import type { Branch } from "../types";
import { getErrorMessage } from "../utils/errors";
import { EMPTY_TREE_HASH } from "../utils/constants";
import { runWithNotificationProgress, showTimedInformationMessage } from "../utils/notifications";
import { assertRepoRelativePath } from "../utils/fileOps";
import {
    assertValidBranchName,
    assertValidRemoteName,
    isValidBranchName as isValidBranchNameValue,
    isValidRemoteName,
} from "../utils/gitRefs";

/**
 * Re-exports branch-name validation for command modules that already depend on service helpers.
 */
export { isValidBranchName } from "../utils/gitRefs";

/**
 * Result from a merge-commit mainline picker.
 *
 * `parentNumber` is one-based to match Git's `-m` argument and is present only
 * when the user selected a parent. Callers should treat `cancelled` as a no-op,
 * not as an error.
 */
export interface MainlineParentPickResult {
    kind: "notMerge" | "cancelled" | "selected";
    parentNumber?: number;
}

/**
 * Checks whether a value is a plausible abbreviated or full Git object hash.
 *
 * The check is intentionally syntactic and accepts 7-40 hexadecimal characters;
 * it does not prove the object exists in the active repository.
 */
export function isValidGitHash(value: string): boolean {
    return /^[0-9a-fA-F]{7,40}$/.test(value);
}

/**
 * Validates a tag name with the same pure TypeScript ref rules used for branch names.
 *
 * This avoids spawning Git from UI validators while preserving the same safety
 * expectations as branch creation and checkout prompts.
 */
export function isValidTagName(value: string): boolean {
    return isValidBranchNameValue(value);
}

/**
 * Compares commit hashes with abbreviation support while avoiding full-hash prefix collisions.
 *
 * When both values are full 40-character hashes they must be exactly equal;
 * otherwise either value may be the prefix selected by a UI list or Git command.
 */
export function isHashMatch(a: string, b: string): boolean {
    // Use exact equality when both are full-length hashes to avoid
    // prefix collision on large repos.
    if (a.length === 40 && b.length === 40) return a === b;
    return a.startsWith(b) || b.startsWith(a);
}

/**
 * Strips the remote prefix from a slash-separated remote branch name.
 *
 * Callers should validate the resulting branch name before passing it to Git;
 * this helper only handles the display and tracking-name transformation.
 */
export function getLocalNameFromRemote(remoteBranchName: string): string {
    return remoteBranchName.split("/").slice(1).join("/");
}

/**
 * Resolves the current checked-out branch name with a cached-branch fallback.
 *
 * A detached HEAD, invalid ref name, or failed `rev-parse` returns `null` rather
 * than showing UI. Command handlers decide whether that means cancellation,
 * disabled actions, or a user-facing error.
 */
export async function getCheckedOutBranchName(
    executor: GitExecutor,
    currentBranches: Branch[],
): Promise<string | null> {
    try {
        const head = (await executor.run(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
        if (head && head !== "HEAD" && isValidBranchNameValue(head)) return head;
    } catch {
        // Fall back to cached branch metadata.
    }
    const fallback = currentBranches.find((b) => b.isCurrent)?.name;
    return fallback && isValidBranchNameValue(fallback) ? fallback : null;
}

/**
 * Determines the remote and remote-branch pair tracked by a local branch.
 *
 * Upstream metadata is preferred, then explicit branch metadata, then a single
 * unambiguous remote-branch suffix match. Invalid or ambiguous refs return
 * `null` so callers do not push, delete, or restore the wrong remote branch.
 */
export function resolveTrackedRemoteBranch(
    branch: Branch,
    currentBranches: Branch[],
): { remote: string; remoteBranch: string } | null {
    if (branch.upstream && branch.upstream.includes("/")) {
        const [remote, ...rest] = branch.upstream.split("/");
        const remoteBranch = rest.join("/");
        if (isValidRemoteName(remote) && isValidBranchNameValue(remoteBranch)) {
            return { remote, remoteBranch };
        }
    }

    if (branch.remote && isValidRemoteName(branch.remote) && isValidBranchNameValue(branch.name)) {
        const expected = `${branch.remote}/${branch.name}`;
        if (currentBranches.some((b) => b.isRemote && b.name === expected)) {
            return { remote: branch.remote, remoteBranch: branch.name };
        }
    }

    // Fallback: match remote branches whose name ends with the local branch name.
    // Only used when there is exactly one match to avoid ambiguity.
    const suffixMatches = currentBranches.filter(
        (b) => b.isRemote && b.name.endsWith(`/${branch.name}`),
    );
    if (suffixMatches.length === 1) {
        const [remote, ...rest] = suffixMatches[0].name.split("/");
        const remoteBranch = rest.join("/");
        if (isValidRemoteName(remote) && isValidBranchNameValue(remoteBranch)) {
            return { remote, remoteBranch };
        }
    }

    return null;
}

/**
 * Parses a remote branch tree item into the target used by `git push --delete`.
 *
 * Only remote branches with a valid remote name and branch path are accepted;
 * local branches and malformed remote refs return `null` for safe UI handling.
 */
export function resolveRemoteDeleteTarget(
    branch: Branch,
): { remote: string; remoteBranch: string } | null {
    if (!branch.isRemote) return null;
    const parts = branch.name.split("/");
    if (parts.length < 2) return null;

    const remote = branch.remote ?? parts[0];
    const remoteBranch = parts.slice(1).join("/");
    if (!isValidRemoteName(remote) || !isValidBranchNameValue(remoteBranch)) return null;

    return { remote, remoteBranch };
}

/**
 * Finds the remote that should receive a branch push or fallback operation.
 *
 * Branch metadata wins when valid; otherwise the first configured Git remote is
 * used. Git failures are swallowed and reported as `null` because callers show
 * workflow-specific messages or prompt for alternate actions.
 */
export async function resolveRemoteName(
    branch: Branch,
    executor: GitExecutor,
): Promise<string | null> {
    if (branch.remote && isValidRemoteName(branch.remote)) return branch.remote;
    try {
        const raw = await executor.run(["remote"]);
        const remotes = raw
            .split("\n")
            .map((r) => r.trim())
            .filter(isValidRemoteName);
        return remotes[0] ?? null;
    } catch {
        return null;
    }
}

/**
 * Reads the parent commit hashes for a commit using `git rev-list --parents`.
 *
 * The returned array excludes the commit itself and preserves Git's parent
 * ordering for merge mainline prompts. Callers must validate untrusted hashes
 * before invoking this helper.
 */
export async function getCommitParentHashes(
    hash: string,
    executor: GitExecutor,
): Promise<string[]> {
    const raw = (await executor.run(["rev-list", "--parents", "-n", "1", hash])).trim();
    const parts = raw.split(/\s+/).filter(Boolean);
    return parts.slice(1);
}

/**
 * Reports whether a commit has multiple parents in the active repository.
 *
 * This propagates Git failures so history commands can block unsafe rebase or
 * edit workflows before they mutate commits.
 */
export async function isMergeCommitHash(hash: string, executor: GitExecutor): Promise<boolean> {
    return (await getCommitParentHashes(hash, executor)).length > 1;
}

/**
 * Checks whether a commit appears in IntelliGit's unpushed commit list.
 *
 * Hash comparisons allow abbreviated UI hashes while protecting exact full-hash
 * comparisons from prefix collisions.
 */
export async function isCommitUnpushed(hash: string, gitOps: GitOps): Promise<boolean> {
    const unpushed = await gitOps.getUnpushedCommitHashes();
    return unpushed.some((h) => isHashMatch(h, hash));
}

const REBASE_PUSH_REJECTION_PATTERNS = [
    "fetch first",
    "non-fast-forward",
    "remote contains work",
    "tip of your current branch is behind",
    "updates were rejected because",
];

/**
 * Detects push rejections that are safe to offer as a pull-rebase-then-push retry.
 *
 * This is a conservative string classifier for common Git non-fast-forward
 * messages, not a general transport error parser.
 */
export function isRebaseablePushRejection(error: unknown): boolean {
    const message = getErrorMessage(error).toLowerCase();
    const isRejectedPush =
        message.includes("failed to push some refs") || message.includes("updates were rejected");

    return (
        isRejectedPush &&
        message.includes("rejected") &&
        REBASE_PUSH_REJECTION_PATTERNS.some((pattern) => message.includes(pattern))
    );
}

/**
 * Prompts the user to rebase after a non-fast-forward push rejection and retries the push.
 *
 * The workflow mutates repository state by running `pull --rebase` and then the
 * caller-provided push retry inside a progress notification. Rebase and retry
 * failures are shown to the user and return `false` instead of propagating.
 */
export async function promptRebaseAfterPushRejection(
    error: unknown,
    gitOps: GitOps,
    retryPush: () => Promise<void>,
): Promise<boolean> {
    if (!isRebaseablePushRejection(error)) return false;

    const rebaseLabel = vscode.l10n.t("Rebase and Push");
    const selection = await vscode.window.showWarningMessage(
        vscode.l10n.t(
            "Push rejected because the remote branch contains commits that are not in your local branch. Rebase and push now?",
        ),
        { modal: true },
        rebaseLabel,
    );
    if (selection !== rebaseLabel) return false;

    try {
        await runWithNotificationProgress(
            vscode.l10n.t("Rebasing and pushing current branch..."),
            async () => {
                await gitOps.pullRebase();
                await retryPush();
            },
        );
        showTimedInformationMessage(vscode.l10n.t("Rebased and pushed current branch."));
    } catch (rebaseError) {
        const message = getErrorMessage(rebaseError);
        vscode.window.showErrorMessage(
            vscode.l10n.t("Rebase and push failed: {message}", { message }),
        );
        return false;
    }

    return true;
}

/**
 * Counts how many commits would be affected by undoing from the selected commit to `HEAD`.
 *
 * A non-positive or unparsable Git result falls back to `1` so confirmation
 * prompts remain conservative instead of silently showing zero affected commits.
 */
export async function getUndoCommitCount(hash: string, executor: GitExecutor): Promise<number> {
    const raw = (await executor.run(["rev-list", "--count", `${hash}^..HEAD`])).trim();
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

/**
 * Prompts for the one-based mainline parent Git expects for merge-commit operations.
 *
 * Non-merge commits return `notMerge` without UI, and prompt cancellation returns
 * `cancelled`. Callers should not mutate history or file patches after a
 * cancelled result.
 */
export async function pickMainlineParent(
    hash: string,
    actionLabel: string,
    executor: GitExecutor,
    knownParents?: string[],
): Promise<MainlineParentPickResult> {
    const parents = knownParents ?? (await getCommitParentHashes(hash, executor));
    if (parents.length <= 1) return { kind: "notMerge" };

    const pick = await vscode.window.showQuickPick(
        parents.map((parent, idx) => ({
            label: vscode.l10n.t("Parent {number} ({short})", {
                number: idx + 1,
                short: parent.slice(0, 8),
            }),
            detail:
                idx === 0
                    ? vscode.l10n.t("Usually the target branch side of the merge.")
                    : vscode.l10n.t("Alternate merge parent."),
            parentNumber: idx + 1,
        })),
        {
            title: vscode.l10n.t("{action}: select mainline parent", {
                action: actionLabel,
            }),
            placeHolder: vscode.l10n.t("Pick the parent number to use with -m"),
        },
    );

    if (!pick) return { kind: "cancelled" };
    return { kind: "selected", parentNumber: pick.parentNumber };
}

/** Result of resolving a branch checkout request against current worktree state. */
export type CheckoutBranchResult =
    | { kind: "checkedOut"; branch: string }
    | { kind: "openWorktree"; branch: string; path: string };

/** Returns an open-folder checkout result when Git would reject checking out a branch already in a worktree. */
function getOpenWorktreeCheckoutResult(branch: Branch): CheckoutBranchResult | undefined {
    if (!branch.isCheckedOutInWorktree || branch.isCurrentWorktree || !branch.worktreePath) {
        return undefined;
    }
    return { kind: "openWorktree", branch: branch.name, path: branch.worktreePath };
}

/**
 * Checks out a local branch or creates a tracking local branch for a remote branch selection.
 *
 * Branch names are validated before Git receives them. This mutates the working
 * tree and index through `git checkout`, and Git failures propagate for command
 * handlers to display with their own action context.
 */
export async function checkoutBranch(
    branch: Branch,
    currentBranches: Branch[],
    executor: GitExecutor,
): Promise<CheckoutBranchResult> {
    if (!branch.isRemote) {
        assertValidBranchName(branch.name);
        const openWorktreeResult = getOpenWorktreeCheckoutResult(branch);
        if (openWorktreeResult) return openWorktreeResult;
        await executor.run(["checkout", branch.name]);
        return { kind: "checkedOut", branch: branch.name };
    }

    const localName = getLocalNameFromRemote(branch.name);
    assertValidBranchName(branch.name, "remote branch name");
    assertValidBranchName(localName, "local branch name");
    const existingLocal = currentBranches.find((b) => !b.isRemote && b.name === localName);
    if (existingLocal) {
        assertValidBranchName(existingLocal.name);
        const openWorktreeResult = getOpenWorktreeCheckoutResult(existingLocal);
        if (openWorktreeResult) return openWorktreeResult;
        await executor.run(["checkout", existingLocal.name]);
        return { kind: "checkedOut", branch: existingLocal.name };
    }

    await executor.run(["checkout", "--track", branch.name]);
    return { kind: "checkedOut", branch: localName };
}

/**
 * Builds the binary patch for a single file as changed by a commit.
 *
 * The commit hash and repository-relative file path are validated before Git is
 * invoked. Merge commits prompt for the mainline parent and return `null` when
 * cancelled; successful calls use `--literal-pathspecs` and `--` so file names
 * are treated as data rather than Git pathspec expressions.
 */
export async function buildCommitFilePatch(
    commitHash: string,
    filePath: string,
    actionLabel: string,
    executor: GitExecutor,
): Promise<string | null> {
    const validatedHash = commitHash.trim();
    if (!isValidGitHash(validatedHash)) {
        throw new Error("Invalid commit hash received for file change action.");
    }
    const safePath = assertRepoRelativePath(filePath);
    const parents = await getCommitParentHashes(validatedHash, executor);

    let baseRef: string;
    if (parents.length > 1) {
        const result = await pickMainlineParent(validatedHash, actionLabel, executor, parents);
        if (result.kind === "cancelled") return null;
        baseRef = `${validatedHash}^${result.parentNumber}`;
    } else {
        baseRef = parents.length === 0 ? EMPTY_TREE_HASH : parents[0];
    }

    return executor.run([
        "--literal-pathspecs",
        "diff",
        "--binary",
        "--full-index",
        "--no-color",
        baseRef,
        validatedHash,
        "--",
        safePath,
    ]);
}

/**
 * Checks whether a local branch has already been merged into the current delete target.
 *
 * The target is the current branch when known or `HEAD` otherwise. Invalid names
 * throw before Git runs, while a failed ancestor check returns `merged: false`
 * so delete prompts can warn instead of assuming safety.
 */
export async function getLocalBranchMergeStatusForDelete(
    branchName: string,
    currentBranchName: string | null,
    executor: GitExecutor,
): Promise<{ merged: boolean; target: string }> {
    const target = currentBranchName?.trim() || "HEAD";
    assertValidBranchName(branchName);
    if (target !== "HEAD") {
        assertValidBranchName(target, "current branch name");
    }
    try {
        await executor.run(["merge-base", "--is-ancestor", branchName, target]);
        return { merged: true, target };
    } catch {
        return { merged: false, target };
    }
}

/**
 * Shows restore and tracked-branch cleanup actions for a branch marked as deleted.
 *
 * Restore creates a local branch at the recorded commit hash. Deleting a tracked
 * branch prompts modally and runs `git push --delete`. All Git failures are
 * displayed to the user, and successful mutations request an IntelliGit refresh.
 */
export async function showDeletedBranchActions(
    branch: Branch,
    currentBranches: Branch[],
    executor: GitExecutor,
): Promise<void> {
    const restoreLabel = vscode.l10n.t("Restore");
    const deleteTrackedLabel = vscode.l10n.t("Delete Tracked Branch");
    const tracked = resolveTrackedRemoteBranch(branch, currentBranches);
    const buttons = tracked ? [restoreLabel, deleteTrackedLabel] : [restoreLabel];
    const action = await vscode.window.showInformationMessage(
        vscode.l10n.t("Deleted: {branch}", { branch: branch.name }),
        ...buttons,
    );

    if (action === restoreLabel) {
        if (!isValidBranchNameValue(branch.name)) {
            vscode.window.showErrorMessage(
                vscode.l10n.t("Cannot restore '{branch}': invalid branch name.", {
                    branch: branch.name,
                }),
            );
            return;
        }
        if (!isValidGitHash(branch.hash)) {
            vscode.window.showErrorMessage(
                vscode.l10n.t("Cannot restore '{branch}': missing or invalid commit hash.", {
                    branch: branch.name,
                }),
            );
            return;
        }
        try {
            await executor.run(["branch", branch.name, branch.hash]);
            showTimedInformationMessage(
                vscode.l10n.t("Restored {branch}", { branch: branch.name }),
            );
            await vscode.commands.executeCommand("intelligit.refresh");
        } catch (error) {
            const msg = getErrorMessage(error);
            vscode.window.showErrorMessage(
                vscode.l10n.t("Restore failed: {message}", { message: msg }),
            );
        }
        return;
    }

    if (action === deleteTrackedLabel && tracked) {
        assertValidRemoteName(tracked.remote);
        assertValidBranchName(tracked.remoteBranch, "remote branch name");
        const confirm = await vscode.window.showWarningMessage(
            vscode.l10n.t("Delete tracked branch '{remote}/{remoteBranch}'?", {
                remote: tracked.remote,
                remoteBranch: tracked.remoteBranch,
            }),
            { modal: true },
            deleteTrackedLabel,
        );
        if (confirm !== deleteTrackedLabel) return;

        try {
            await runWithNotificationProgress(
                vscode.l10n.t("Deleting tracked branch {remote}/{remoteBranch}...", {
                    remote: tracked.remote,
                    remoteBranch: tracked.remoteBranch,
                }),
                async () => {
                    await executor.run(["push", tracked.remote, "--delete", tracked.remoteBranch]);
                },
            );
            showTimedInformationMessage(
                vscode.l10n.t("Deleted tracked branch {remote}/{remoteBranch}", {
                    remote: tracked.remote,
                    remoteBranch: tracked.remoteBranch,
                }),
            );
            await vscode.commands.executeCommand("intelligit.refresh");
        } catch (error) {
            const msg = getErrorMessage(error);
            vscode.window.showErrorMessage(
                vscode.l10n.t("Delete tracked branch failed: {message}", { message: msg }),
            );
        }
    }
}
