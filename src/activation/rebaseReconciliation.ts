import * as vscode from "vscode";
import type { GitExecutor } from "../git/executor";
import { resolveGitDir } from "../git/gitDirectory";
import {
    gatherRebaseReconciliationEvidence,
    reconcileRebaseSessions,
} from "../git/interactiveRebase/reconcile";
import {
    discardRebaseSession,
    sweepOrphanedRebaseReservation,
} from "../git/interactiveRebase/storage";

/** Dependencies required to reconcile one repository's retained rebase state during activation. */
export interface RebaseReconciliationActivationDependencies {
    /** Extension-managed storage root that contains repository-scoped rebase session state. */
    storageRoot: string;
    /** Repository-bound Git runner used only by the sealed reconciliation evidence collector. */
    executor: Pick<GitExecutor, "runBinary">;
    /** Refreshes rendered repository state after the user explicitly discards retained state. */
    refresh: () => Promise<void>;
}

/**
 * Reconciles retained rebase state for one repository without allowing recovery failures to reject activation.
 *
 * The sealed classifier determines every disposition. This VS Code surface only performs its authorized
 * cleanup and prompts once for ambiguous state; it never arms or presents a force-push offer.
 */
export async function reconcileRebaseSessionsOnActivation(
    repositoryRoot: string,
    dependencies: RebaseReconciliationActivationDependencies,
): Promise<void> {
    try {
        const gitDir = resolveGitDir(repositoryRoot);
        const evidence = await gatherRebaseReconciliationEvidence(
            {
                storageRoot: dependencies.storageRoot,
                gitDir,
                executor: dependencies.executor,
            },
            repositoryRoot,
        );
        const reconciliation = reconcileRebaseSessions(evidence);
        const discardedSessionIds = reconciliation.dispositions.flatMap((disposition) =>
            disposition.status === "discard" ? [disposition.sessionId] : [],
        );

        await Promise.all(
            discardedSessionIds.map((sessionId) =>
                discardRebaseSession(dependencies.storageRoot, repositoryRoot, sessionId),
            ),
        );

        // Sweep after deleting proven-dead manifests: otherwise it retains their reservation pointer
        // until the next reload because the stale manifest still appears live to the sweep.
        await sweepOrphanedRebaseReservation({
            storageRoot: dependencies.storageRoot,
            repoRoot: repositoryRoot,
            gitDir,
        });

        const ambiguousSessionIds = reconciliation.dispositions.flatMap((disposition) =>
            disposition.status === "ambiguous" ? [disposition.sessionId] : [],
        );
        if (ambiguousSessionIds.length === 0) return;

        // The dialog answers with the exact label it was handed, which is the translated one.
        // Comparing that answer against the English source would make the action dead in every
        // non-English locale, and the notice returns every reload until the state is discarded.
        const discardAction = vscode.l10n.t("Discard rebase session state");
        const selectedAction = await vscode.window.showWarningMessage(
            vscode.l10n.t(
                "A rebase session did not finish cleanly — verify your branch, then push manually if intended",
            ),
            discardAction,
        );
        if (selectedAction !== discardAction) return;

        await Promise.all(
            ambiguousSessionIds.map((sessionId) =>
                discardRebaseSession(dependencies.storageRoot, repositoryRoot, sessionId),
            ),
        );
        await dependencies.refresh();
    } catch (error) {
        console.error(
            `[IntelliGit] Could not check rebase session state for ${repositoryRoot}:`,
            error,
        );
    }
}
