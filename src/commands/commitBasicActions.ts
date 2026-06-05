import * as path from "path";
import * as vscode from "vscode";
import { getErrorMessage } from "../utils/errors";
import { runWithNotificationProgress } from "../utils/notifications";
import {
    getCheckedOutBranchName,
    pickMainlineParent,
    resolveRemoteName,
    resolveTrackedRemoteBranch,
    isCommitUnpushed,
    isValidBranchName,
    isValidTagName,
} from "../services/gitHelpers";
import type { CommitActionContext } from "./commitActionContext";

export async function copyRevision(ctx: CommitActionContext): Promise<void> {
    await vscode.env.clipboard.writeText(ctx.validatedHash);
    vscode.window.showInformationMessage(
        vscode.l10n.t("Copied revision {short}.", { short: ctx.short }),
    );
}

export async function createPatch(ctx: CommitActionContext): Promise<void> {
    const defaultUri = vscode.Uri.file(path.join(ctx.repoRoot, `${ctx.short}.patch`));
    const targetUri = await vscode.window.showSaveDialog({
        defaultUri,
        filters: { [vscode.l10n.t("Patch")]: ["patch", "diff"] },
    });
    if (!targetUri) return;
    try {
        const patchText = await ctx.executor.run([
            "format-patch",
            "-1",
            "--stdout",
            ctx.validatedHash,
        ]);
        await vscode.workspace.fs.writeFile(targetUri, Buffer.from(patchText, "utf8"));
        vscode.window.showInformationMessage(
            vscode.l10n.t("Patch created: {fileName}", {
                fileName: path.basename(targetUri.fsPath),
            }),
        );
    } catch (err) {
        const message = getErrorMessage(err);
        vscode.window.showErrorMessage(
            vscode.l10n.t("Failed to create patch: {message}", { message }),
        );
    }
}

export async function cherryPick(ctx: CommitActionContext): Promise<void> {
    const cherryPickLabel = vscode.l10n.t("Cherry-pick");
    const confirm = await vscode.window.showWarningMessage(
        vscode.l10n.t("Cherry-pick commit {short}?", { short: ctx.short }),
        { modal: true },
        cherryPickLabel,
    );
    if (confirm !== cherryPickLabel) return;

    const mainlineParent = await pickMainlineParent(
        ctx.validatedHash,
        cherryPickLabel,
        ctx.executor,
    );
    if (mainlineParent.kind === "cancelled") return;
    const args =
        mainlineParent.kind === "notMerge"
            ? ["cherry-pick", ctx.validatedHash]
            : ["cherry-pick", "-m", String(mainlineParent.parentNumber), ctx.validatedHash];
    try {
        await ctx.executor.run(args);
        vscode.window.showInformationMessage(
            vscode.l10n.t("Cherry-picked {short}.", { short: ctx.short }),
        );
    } catch (err) {
        const message = getErrorMessage(err);
        vscode.window.showErrorMessage(vscode.l10n.t("Cherry-pick failed: {message}", { message }));
    } finally {
        await ctx.refreshAll();
    }
}

export async function checkoutRevision(ctx: CommitActionContext): Promise<void> {
    const checkoutLabel = vscode.l10n.t("Checkout");
    const confirm = await vscode.window.showWarningMessage(
        vscode.l10n.t("Checkout commit {short}? This creates a detached HEAD state.", {
            short: ctx.short,
        }),
        { modal: true },
        checkoutLabel,
    );
    if (confirm !== checkoutLabel) return;
    try {
        await ctx.executor.run(["checkout", ctx.validatedHash]);
        vscode.window.showInformationMessage(
            vscode.l10n.t("Checked out revision {short}.", { short: ctx.short }),
        );
    } catch (err) {
        const message = getErrorMessage(err);
        vscode.window.showErrorMessage(vscode.l10n.t("Checkout failed: {message}", { message }));
    } finally {
        await ctx.refreshAll();
    }
}

export async function resetCurrentToHere(ctx: CommitActionContext): Promise<void> {
    const resetLabel = vscode.l10n.t("Reset");
    const confirm = await vscode.window.showWarningMessage(
        vscode.l10n.t(
            "Hard reset current branch to {short}? This will reset the index and working tree and permanently discard any uncommitted changes.",
            { short: ctx.short },
        ),
        { modal: true },
        resetLabel,
    );
    if (confirm !== resetLabel) return;
    try {
        await ctx.executor.run(["reset", "--hard", ctx.validatedHash]);
        vscode.window.showInformationMessage(
            vscode.l10n.t("Reset current branch to {short}.", { short: ctx.short }),
        );
    } catch (err) {
        const message = getErrorMessage(err);
        vscode.window.showErrorMessage(vscode.l10n.t("Reset failed: {message}", { message }));
    } finally {
        await ctx.refreshAll();
    }
}

export async function revertCommit(ctx: CommitActionContext): Promise<void> {
    const revertLabel = vscode.l10n.t("Revert");
    const confirm = await vscode.window.showWarningMessage(
        vscode.l10n.t("Revert commit {short}?", { short: ctx.short }),
        { modal: true },
        revertLabel,
    );
    if (confirm !== revertLabel) return;
    const mainlineParent = await pickMainlineParent(ctx.validatedHash, revertLabel, ctx.executor);
    if (mainlineParent.kind === "cancelled") return;
    const args =
        mainlineParent.kind === "notMerge"
            ? ["revert", "--no-edit", ctx.validatedHash]
            : ["revert", "-m", String(mainlineParent.parentNumber), "--no-edit", ctx.validatedHash];
    try {
        await ctx.executor.run(args);
        vscode.window.showInformationMessage(
            vscode.l10n.t("Reverted {short}.", { short: ctx.short }),
        );
    } catch (err) {
        const message = getErrorMessage(err);
        vscode.window.showErrorMessage(vscode.l10n.t("Revert failed: {message}", { message }));
    } finally {
        await ctx.refreshAll();
    }
}

export async function pushAllUpToHere(ctx: CommitActionContext): Promise<void> {
    if (!(await isCommitUnpushed(ctx.validatedHash, ctx.gitOps))) {
        vscode.window.showErrorMessage(
            vscode.l10n.t("Push All up to Here is available only for unpushed commits."),
        );
        return;
    }

    const checkedOutBranchName = await getCheckedOutBranchName(ctx.executor, ctx.currentBranches);
    if (!checkedOutBranchName) {
        vscode.window.showErrorMessage(
            vscode.l10n.t(
                "Push All up to Here is only available when a local branch is checked out.",
            ),
        );
        return;
    }

    try {
        await ctx.executor.run(["merge-base", "--is-ancestor", ctx.validatedHash, "HEAD"]);
    } catch {
        vscode.window.showErrorMessage(
            vscode.l10n.t("Commit {short} is not in the current branch history.", {
                short: ctx.short,
            }),
        );
        return;
    }

    let currentBranch = ctx.currentBranches.find(
        (branch) => !branch.isRemote && branch.name === checkedOutBranchName,
    );
    let branchesSnapshot = ctx.currentBranches;
    if (!currentBranch) {
        // Stale cache — refresh branch metadata and retry
        const freshBranches = await ctx.gitOps.getBranches();
        currentBranch = freshBranches.find(
            (branch) => !branch.isRemote && branch.name === checkedOutBranchName,
        );
        branchesSnapshot = freshBranches;
    }
    if (!currentBranch) {
        vscode.window.showErrorMessage(
            vscode.l10n.t("Could not resolve branch metadata for '{branch}'.", {
                branch: checkedOutBranchName,
            }),
        );
        return;
    }

    let target = resolveTrackedRemoteBranch(currentBranch, branchesSnapshot);
    let setUpstream = false;
    if (!target) {
        const remote = await resolveRemoteName(currentBranch, ctx.executor);
        if (!remote) {
            vscode.window.showErrorMessage(
                vscode.l10n.t("No remote configured for branch {branch}.", {
                    branch: currentBranch.name,
                }),
            );
            return;
        }

        const setUpstreamLabel = vscode.l10n.t("Set Upstream and Push");
        const setUpstreamConfirm = await vscode.window.showWarningMessage(
            vscode.l10n.t(
                "Branch '{branch}' has no upstream. Set upstream to '{remote}/{remoteBranch}' and push commits up to {short}?",
                {
                    branch: currentBranch.name,
                    remote,
                    remoteBranch: currentBranch.name,
                    short: ctx.short,
                },
            ),
            { modal: true },
            setUpstreamLabel,
        );
        if (setUpstreamConfirm !== setUpstreamLabel) return;

        target = { remote, remoteBranch: currentBranch.name };
        setUpstream = true;
    }

    const pushLabel = vscode.l10n.t("Push");
    const confirm = await vscode.window.showWarningMessage(
        vscode.l10n.t("Push all commits up to {short} to {remote}/{remoteBranch}?", {
            short: ctx.short,
            remote: target.remote,
            remoteBranch: target.remoteBranch,
        }),
        { modal: true },
        pushLabel,
    );
    if (confirm !== pushLabel) return;

    try {
        await runWithNotificationProgress(
            vscode.l10n.t("Pushing commits up to {short}...", { short: ctx.short }),
            async () => {
                const destinationRef = `refs/heads/${target.remoteBranch}`;
                const refspec = `${ctx.validatedHash}:${destinationRef}`;
                await ctx.executor.run([
                    "push",
                    ...(setUpstream ? ["-u"] : []),
                    target.remote,
                    refspec,
                ]);
            },
        );

        vscode.window.showInformationMessage(
            vscode.l10n.t("Pushed commits up to {short}.", { short: ctx.short }),
        );
    } finally {
        await ctx.refreshAll();
    }
}

export async function newBranch(ctx: CommitActionContext): Promise<void> {
    const branchName = await vscode.window.showInputBox({
        prompt: vscode.l10n.t("New branch from {short}", { short: ctx.short }),
        placeHolder: "branch-name",
    });
    if (!branchName) return;
    if (!isValidBranchName(branchName)) {
        vscode.window.showErrorMessage(
            vscode.l10n.t(
                "Invalid branch name '{branch}'. Names must contain only alphanumeric characters, dots, dashes, underscores, or slashes, and must not start with a dash.",
                { branch: branchName },
            ),
        );
        return;
    }
    try {
        await ctx.executor.run(["branch", branchName, ctx.validatedHash]);
        vscode.window.showInformationMessage(
            vscode.l10n.t("Created branch {branch} at {short}.", {
                branch: branchName,
                short: ctx.short,
            }),
        );
    } catch (err) {
        const message = getErrorMessage(err);
        vscode.window.showErrorMessage(
            vscode.l10n.t("Failed to create branch: {message}", { message }),
        );
    } finally {
        await ctx.refreshAll();
    }
}

export async function newTag(ctx: CommitActionContext): Promise<void> {
    const tagName = await vscode.window.showInputBox({
        prompt: vscode.l10n.t("New tag at {short}", { short: ctx.short }),
        placeHolder: "v1.0.0",
    });
    if (!tagName) return;
    if (!isValidTagName(tagName)) {
        vscode.window.showErrorMessage(
            vscode.l10n.t("Invalid tag name '{tag}'. Tag names must be valid git ref names.", {
                tag: tagName,
            }),
        );
        return;
    }
    try {
        await ctx.executor.run(["tag", tagName, ctx.validatedHash]);
        vscode.window.showInformationMessage(vscode.l10n.t("Created tag {tag}.", { tag: tagName }));
    } catch (err) {
        const message = getErrorMessage(err);
        vscode.window.showErrorMessage(
            vscode.l10n.t("Failed to create tag: {message}", { message }),
        );
    } finally {
        await ctx.refreshAll();
    }
}
