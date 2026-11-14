import React from "react";
import { VscLoading } from "react-icons/vsc";
import type { CiJob, CiRun, CommitCiDetail } from "../../../../types";
import { SPIN_KEYFRAMES } from "../../shared/components/iconStyles";
import { t } from "../../shared/i18n";
import { getVsCodeApi } from "../../shared/vscodeApi";
import { CheckJobDetail } from "./CheckJobDetail";
import { CheckTree } from "./CheckTree";
import { ChecksHeader } from "./ChecksHeader";
import { checksStyles } from "./checksStyles";
import { useCiAction, type CiActionTarget, type CiActionView } from "./useCiAction";
import { useCommitCiDetail } from "./useCommitCiDetail";

type ChecksTabMessage =
    | { type: "openCommitCheckUrl"; url: string }
    | { type: "signInForCommitChecks"; host: string }
    | { type: "openCommitChecksSettings" };

type ChecksTabState = "loading" | "none" | "disabled" | "signedOut" | "unavailable" | "detail";

// Two columns (tree 340 px, job detail beside it) once the pane is wide enough; one below 760 px.
const LAYOUT_CSS = `${SPIN_KEYFRAMES}
.intelligit-checks-body { display: grid; grid-template-columns: 1fr; container-type: inline-size; }
@container (min-width: 760px) {
  .intelligit-checks-columns { display: grid; grid-template-columns: 340px 1fr; }
}
@media (prefers-reduced-motion: reduce) {
  [data-testid="ci-loading-spinner"] { animation: none !important; }
}
`;

function post(message: ChecksTabMessage): void {
    getVsCodeApi<ChecksTabMessage>().postMessage(message);
}

function stateOf(detail: CommitCiDetail | null | undefined, enabled: boolean): ChecksTabState {
    if (!enabled) return "disabled";
    if (detail === undefined) return "loading";
    if (detail === null) return "none";
    if (detail.outcome === "unavailable") return detail.signInHost ? "signedOut" : "unavailable";
    if (detail.runs.length === 0 && detail.otherChecks.length === 0) return "none";
    return "detail";
}

function firstFailedJob(detail: CommitCiDetail): CiJob | undefined {
    for (const run of detail.runs) {
        const failed = run.jobs.find((job) => job.state === "failure");
        if (failed) return failed;
    }
    return undefined;
}

/** "Re-run job" for the selected finished job, unless the provider cannot or an action is pending. */
function rerunJobTarget(
    detail: CommitCiDetail | undefined,
    run: CiRun | undefined,
    job: CiJob | undefined,
): CiActionTarget | null {
    if (!detail?.capabilities.rerunJob || detail.actionFence || !run || !job) return null;
    if (job.state === "queued" || job.state === "running") return null;
    return { action: "rerunJob", runId: run.id, jobId: job.id };
}

/**
 * The Checks tab body: requests the selected commit's CI detail while shown and renders
 * the header, the run, job and step tree and the selected job, or the state that
 * replaces them (loading, none, turned off, signed out, unavailable).
 */
export function ChecksTab({
    repoKey,
    hash,
    enabled,
}: {
    repoKey: string;
    hash: string;
    enabled: boolean;
}): React.ReactElement {
    const { detail, refresh, reload } = useCommitCiDetail(repoKey, enabled ? hash : null, true);
    const action = useCiAction(repoKey, hash, reload);
    // A job id is unique only inside one commit, so a pick counts only for the commit it was made on.
    const commitKey = `${repoKey}\0${hash}`;
    const [picked, setPicked] = React.useState<{ commitKey: string; jobId: string } | null>(null);
    const selectedJobId = picked?.commitKey === commitKey ? picked.jobId : null;
    const state = stateOf(detail, enabled);
    const openUrl = React.useCallback(
        (url: string) => post({ type: "openCommitCheckUrl", url }),
        [],
    );
    const loaded = state === "detail" ? detail! : undefined;
    const selectedJob =
        loaded &&
        (loaded.runs.flatMap((run) => run.jobs).find((job) => job.id === selectedJobId) ??
            firstFailedJob(loaded));
    const selectedRun = selectedJob && loaded?.runs.find((run) => run.jobs.includes(selectedJob));
    const logJob =
        selectedJob && selectedRun && loaded?.capabilities.logs
            ? {
                  repoKey,
                  hash,
                  runId: selectedRun.id,
                  jobId: selectedJob.id,
                  attempt: selectedJob.attempt ?? selectedRun.attempt,
              }
            : null;
    const actionRun = selectedRun ?? loaded?.runs[0];
    const rerunJob = rerunJobTarget(loaded, selectedRun, selectedJob);

    return (
        <div
            data-testid="checks-tab"
            data-state={state}
            style={{ display: "flex", flexDirection: "column", flex: "1 1 auto", minHeight: 40 }}
        >
            <style>{LAYOUT_CSS}</style>
            {state === "disabled" ? null : (
                <ChecksHeader
                    // The cancel confirmation belongs to one repository and commit.
                    key={commitKey}
                    detail={loaded}
                    actionRun={actionRun}
                    busy={action.busy}
                    onAction={action.run}
                    onRefresh={refresh}
                    onOpenUrl={openUrl}
                />
            )}
            {loaded ? (
                <ActionAlert
                    view={action.view}
                    writeScopeHelp={loaded.capabilities.writeScopeHelp}
                    onOpenUrl={openUrl}
                />
            ) : null}
            {detail?.refreshError !== undefined ? (
                <div role="alert" style={checksStyles.note}>
                    {t("commit.checks.tab.refreshFailed", { error: detail.refreshError })}
                </div>
            ) : null}
            <div className="intelligit-checks-body" style={{ flex: "1 1 auto", overflowY: "auto" }}>
                {loaded ? (
                    <div className="intelligit-checks-columns">
                        <CheckTree
                            detail={loaded}
                            selectedJobId={selectedJob?.id ?? null}
                            onSelectJob={(job) => setPicked({ commitKey, jobId: job.id })}
                            onOpenUrl={openUrl}
                            onRefresh={refresh}
                        />
                        {loaded.runs.length > 0 ? (
                            <CheckJobDetail
                                job={selectedJob}
                                showSteps={loaded.capabilities.steps}
                                showFailureSummary={loaded.capabilities.failureSummary}
                                logJob={logJob}
                                rerunJob={
                                    rerunJob
                                        ? {
                                              target: rerunJob,
                                              busy: action.busy,
                                              onAction: action.run,
                                          }
                                        : null
                                }
                                onOpenUrl={openUrl}
                            />
                        ) : null}
                    </div>
                ) : (
                    <StateMessage state={state} detail={detail} onRefresh={refresh} />
                )}
            </div>
        </div>
    );
}

/** The last write action's problem: no permission (with the help link), a failure, or unsure. */
function ActionAlert({
    view,
    writeScopeHelp,
    onOpenUrl,
}: {
    view: CiActionView;
    writeScopeHelp: string | undefined;
    onOpenUrl: (url: string) => void;
}): React.ReactElement | null {
    if (view.status === "idle") return null;
    const helpUrl = view.status === "forbidden" ? view.helpUrl : undefined;
    let text: string;
    if (view.status === "uncertain") text = t("commit.checks.tab.actionUncertain");
    else if (view.status === "failed")
        text = t("commit.checks.tab.actionFailed", { error: view.message });
    else
        text = writeScopeHelp
            ? t(writeScopeHelp)
            : t("commit.checks.tab.actionFailed", { error: "403" });
    return (
        <div role="alert" data-testid="ci-action-alert" style={checksStyles.note}>
            <span>{text}</span>
            {helpUrl ? (
                <button
                    type="button"
                    style={checksStyles.linkButton}
                    onClick={() => onOpenUrl(helpUrl)}
                >
                    {t("commit.checks.tab.writeActionsHelp")}
                </button>
            ) : null}
        </div>
    );
}

function StateMessage({
    state,
    detail,
    onRefresh,
}: {
    state: ChecksTabState;
    detail: CommitCiDetail | null | undefined;
    onRefresh: () => void;
}): React.ReactElement {
    const signInHost = detail?.signInHost;
    if (state === "loading") {
        return (
            <div role="status" data-testid="ci-loading-row" style={loadingRowStyle}>
                <VscLoading
                    size={14}
                    aria-hidden="true"
                    data-testid="ci-loading-spinner"
                    style={{ animation: "intelligit-spin 0.8s linear infinite", flexShrink: 0 }}
                />
                <span>{t("commit.checks.loading")}</span>
            </div>
        );
    }
    return (
        <div
            role="status"
            style={{
                ...checksStyles.note,
                padding: "10px 12px",
                flexDirection: "column",
                alignItems: "flex-start",
            }}
        >
            {state === "none" ? <span>{t("commit.checks.tab.none")}</span> : null}
            {state === "disabled" ? (
                <>
                    <span>{t("commit.checks.tab.disabled")}</span>
                    <button
                        type="button"
                        style={checksStyles.linkButton}
                        onClick={() => post({ type: "openCommitChecksSettings" })}
                    >
                        {t("commit.checks.tab.openSettings")}
                    </button>
                </>
            ) : null}
            {state === "signedOut" && signInHost ? (
                <>
                    <span>{detail?.error}</span>
                    <button
                        type="button"
                        style={signInButtonStyle}
                        onClick={() => post({ type: "signInForCommitChecks", host: signInHost })}
                    >
                        {t("commit.checks.signIn")}
                    </button>
                </>
            ) : null}
            {state === "unavailable" ? (
                <>
                    <span>{detail?.error ?? t("commit.checks.none")}</span>
                    <button type="button" style={checksStyles.linkButton} onClick={onRefresh}>
                        {t("common.refresh")}
                    </button>
                </>
            ) : null}
        </div>
    );
}

const loadingRowStyle: React.CSSProperties = {
    ...checksStyles.note,
    alignItems: "center",
    gap: 6,
    padding: "10px 12px",
};

const signInButtonStyle: React.CSSProperties = {
    border: "none",
    borderRadius: 4,
    background: "var(--vscode-button-background)",
    color: "var(--vscode-button-foreground)",
    padding: "4px 12px",
    fontSize: 12,
    cursor: "pointer",
};
