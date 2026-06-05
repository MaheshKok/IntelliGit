// Commit context menu action dispatcher extracted from extension.ts.
// Each action handles a right-click operation on a commit in the
// commit graph: cherry-pick, revert, reset, rebase, tag, etc.

import * as vscode from "vscode";
import { GitExecutor } from "../git/executor";
import { GitOps } from "../git/operations";
import type { CommitAction } from "../webviews/protocol/commitGraphTypes";
import { isValidGitHash } from "../services/gitHelpers";
import type { Branch } from "../types";
import type { CommitActionContext } from "./commitActionContext";
import {
    checkoutRevision,
    cherryPick,
    copyRevision,
    createPatch,
    newBranch,
    newTag,
    pushAllUpToHere,
    resetCurrentToHere,
    revertCommit,
} from "./commitBasicActions";
import {
    dropCommit,
    editCommitMessage,
    interactiveRebaseFromHere,
    squashCommits,
    undoCommit,
} from "./commitHistoryActions";

function assertNever(value: never): never {
    throw new Error(`Unhandled commit action: ${String(value)}`);
}

export async function handleCommitContextAction(params: {
    action: CommitAction;
    hash: string;
    executor: GitExecutor;
    gitOps: GitOps;
    repoRoot: string;
    currentBranches: Branch[];
    refreshAll: () => Promise<void>;
}): Promise<void> {
    const { action, hash, executor, gitOps, repoRoot, currentBranches, refreshAll } = params;
    const validatedHash = hash.trim();
    if (!isValidGitHash(validatedHash)) {
        console.error("Blocked commit action due to invalid hash:", { action, hash });
        vscode.window.showErrorMessage(
            vscode.l10n.t("Invalid commit hash received for commit action."),
        );
        return;
    }

    const ctx: CommitActionContext = {
        validatedHash,
        short: validatedHash.slice(0, 8),
        executor,
        gitOps,
        repoRoot,
        currentBranches,
        refreshAll,
    };
    await dispatchCommitContextAction(action, ctx);
}

async function dispatchCommitContextAction(
    action: CommitAction,
    ctx: CommitActionContext,
): Promise<void> {
    switch (action) {
        case "copyRevision":
            await copyRevision(ctx);
            return;
        case "createPatch":
            await createPatch(ctx);
            return;
        case "cherryPick":
            await cherryPick(ctx);
            return;
        case "checkoutRevision":
            await checkoutRevision(ctx);
            return;
        case "resetCurrentToHere":
            await resetCurrentToHere(ctx);
            return;
        case "revertCommit":
            await revertCommit(ctx);
            return;
        case "pushAllUpToHere":
            await pushAllUpToHere(ctx);
            return;
        case "newBranch":
            await newBranch(ctx);
            return;
        case "newTag":
            await newTag(ctx);
            return;
        case "undoCommit":
            await undoCommit(ctx);
            return;
        case "editCommitMessage":
            await editCommitMessage(ctx);
            return;
        case "squashCommits":
            await squashCommits(ctx);
            return;
        case "dropCommit":
            await dropCommit(ctx);
            return;
        case "interactiveRebaseFromHere":
            await interactiveRebaseFromHere(ctx);
            return;
        default:
            return assertNever(action);
    }
}
