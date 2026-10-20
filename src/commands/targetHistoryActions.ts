import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { ChangelistPersistence } from "../changes/changelistPersistence";
import {
    preflightUndoCommit,
    type TargetHistoryRequest,
    type TargetHistoryResult,
    type UndoCommitPreflight,
} from "../git/targetHistoryOperation";
import { pickMainlineParent } from "../services/gitHelpers";
import { getErrorMessage } from "../utils/errors";
import { showTimedInformationMessage } from "../utils/notifications";
import { pickChangelistTarget, type CapturedSourceList } from "./changelistTarget";
import type { CommitActionContext } from "./commitActionContext";

/**
 * Asks for the destination after the caller's own prompts, then runs one captured intent at the
 * captured root. Returns undefined when the user cancels the destination; nothing changed then.
 */
export async function applyHistoryToChangelist(
    ctx: CommitActionContext,
    intent: Pick<TargetHistoryRequest, "kind" | "commit" | "head" | "mainline">,
    sourceLists: readonly CapturedSourceList[] = [],
): Promise<TargetHistoryResult | undefined> {
    const outcome = await ctx.gitOps.applyTargetHistory(
        ctx.repoRoot,
        ctx.changelists,
        async (state) => {
            const picked = await pickChangelistTarget({ state, sourceLists });
            if (!picked) return undefined;
            const choice = picked.draftChoice;
            const sourceDraft =
                choice?.kind === "copySource"
                    ? sourceLists.find((list) => list.id === choice.sourceListId)?.draft
                    : undefined;
            return {
                ...intent,
                id: randomUUID(),
                target: picked.target,
                ...(choice ? { draftChoice: choice } : {}),
                ...(sourceDraft !== undefined ? { sourceDraft } : {}),
            };
        },
    );
    if (outcome.status === "cancelled") return undefined;
    await ctx.refreshAll();
    return outcome.result;
}

/**
 * Decides Undo Commit's route at the captured root before any destination prompt. `plainReset`
 * means the previous release's soft reset has already run, so no destination is offered.
 */
export async function undoCommitRoute(
    ctx: CommitActionContext,
    intent: Pick<TargetHistoryRequest, "commit" | "head">,
): Promise<UndoCommitPreflight> {
    const { root, gitDir } = await ctx.gitOps.deriveFor(ctx.repoRoot).getGitDirectories();
    await ctx.changelists.connect(root, gitDir);
    const persistence = await ChangelistPersistence.open(root, gitDir);
    return preflightUndoCommit(ctx.executor, persistence, ctx.changelists, intent);
}

/** Cherry-picks the selected commit into a chosen changelist and leaves the result uncommitted. */
export async function cherryPickToChangelist(ctx: CommitActionContext): Promise<void> {
    await historyToChangelist(ctx, "cherryPick");
}

/** Reverts the selected commit into a chosen changelist and leaves the result uncommitted. */
export async function revertToChangelist(ctx: CommitActionContext): Promise<void> {
    await historyToChangelist(ctx, "revert");
}

async function historyToChangelist(
    ctx: CommitActionContext,
    kind: "cherryPick" | "revert",
): Promise<void> {
    const label =
        kind === "cherryPick"
            ? vscode.l10n.t("Cherry-pick Without Committing")
            : vscode.l10n.t("Revert Without Committing");
    try {
        // HEAD is captured before any prompt; the adapter refuses if it moved meanwhile.
        const head = (await ctx.executor.run(["rev-parse", "--verify", "HEAD"])).trim();
        const confirm = await vscode.window.showWarningMessage(
            kind === "cherryPick"
                ? vscode.l10n.t(
                      "Cherry-pick commit {short} into a changelist? The result stays uncommitted.",
                      { short: ctx.short },
                  )
                : vscode.l10n.t(
                      "Revert commit {short} into a changelist? The result stays uncommitted.",
                      { short: ctx.short },
                  ),
            { modal: true },
            label,
        );
        if (confirm !== label) return;
        const parent = await pickMainlineParent(ctx.validatedHash, label, ctx.executor);
        if (parent.kind === "cancelled") return;
        const result = await applyHistoryToChangelist(ctx, {
            kind,
            commit: ctx.validatedHash,
            head,
            ...(parent.kind === "notMerge" ? {} : { mainline: parent.parentNumber }),
        });
        if (result) showTargetHistoryResult(ctx.short, kind, result);
    } catch (err) {
        const message = getErrorMessage(err);
        vscode.window.showErrorMessage(
            kind === "cherryPick"
                ? vscode.l10n.t("Cherry-pick failed: {message}", { message })
                : vscode.l10n.t("Revert failed: {message}", { message }),
        );
    }
}

/** Reports one targeted outcome; only `applied` is a plain success. */
export function showTargetHistoryResult(
    short: string,
    kind: TargetHistoryRequest["kind"],
    result: Pick<TargetHistoryResult, "outcome" | "reason">,
): void {
    const reason = result.reason ?? vscode.l10n.t("No changes were made.");
    switch (result.outcome) {
        case "applied":
            showTimedInformationMessage(
                kind === "cherryPick"
                    ? vscode.l10n.t(
                          "Cherry-picked {short} into the changelist without committing.",
                          {
                              short,
                          },
                      )
                    : kind === "revert"
                      ? vscode.l10n.t("Reverted {short} into the changelist without committing.", {
                            short,
                        })
                      : vscode.l10n.t("Undid commits up to {short} into the changelist.", {
                            short,
                        }),
            );
            return;
        case "conflicted":
            vscode.window.showWarningMessage(
                vscode.l10n.t(
                    "Applying {short} stopped with conflicts. Resolve them, then continue or abort. Nothing will be committed.",
                    { short },
                ),
            );
            return;
        case "appliedNeedsReview":
            vscode.window.showWarningMessage(
                vscode.l10n.t(
                    "Git changed files for {short}, but the changelist update needs review: {reason}",
                    { short, reason },
                ),
            );
            return;
        case "stale":
            vscode.window.showWarningMessage(
                vscode.l10n.t(
                    "The repository or changelists changed. Nothing was applied for {short}; try again.",
                    { short },
                ),
            );
            return;
        case "busy":
            vscode.window.showWarningMessage(
                vscode.l10n.t(
                    "Another changelist or Git operation is running. Nothing was applied for {short}.",
                    { short },
                ),
            );
            return;
        case "notApplied":
            vscode.window.showErrorMessage(
                vscode.l10n.t("Nothing was applied for {short}: {reason}", { short, reason }),
            );
            return;
    }
}
