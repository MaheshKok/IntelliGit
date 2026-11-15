import React from "react";
import type { CiChangedFile, CiJob } from "../../../../types";
import { StateIcon } from "../../commit-list/CommitChecksPopover";
import { t } from "../../shared/i18n";
import { JETBRAINS_UI } from "../../shared/tokens";
import { badgeStateOf, formatCiDuration, formatCiStart, stateLabel } from "./ciFormat";
import { ActionButton } from "./ChecksHeader";
import { checksStyles } from "./checksStyles";
import type { CiActionTarget } from "./useCiAction";
import { useChangedSinceGreen, type ChangedSinceGreenJob } from "./useChangedSinceGreen";
import { useCiLog, type CiLogJobRef, type CiLogView } from "./useCiLog";

/**
 * The selected job: name, state, duration, start, its failure summary, its steps, the files
 * changed since it last passed, its log excerpt with the button that opens the full log, and
 * its link.
 */
export function CheckJobDetail({
    job,
    showSteps,
    showFailureSummary = false,
    logJob = null,
    rerunJob = null,
    changedSinceGreen = null,
    onOpenUrl,
}: {
    job: CiJob | undefined;
    showSteps: boolean;
    /** The provider declares failure summaries. */
    showFailureSummary?: boolean;
    /** The selected job's log identity; null when the provider has no logs. */
    logJob?: CiLogJobRef | null;
    /** "Re-run job" for this finished job; null when the provider cannot or an action is pending. */
    rerunJob?: {
        target: CiActionTarget;
        busy: CiActionTarget | null;
        onAction: (target: CiActionTarget) => void;
    } | null;
    /** The selected job when it failed, for "Changed since last green"; null otherwise. */
    changedSinceGreen?: ChangedSinceGreenJob | null;
    onOpenUrl: (url: string) => void;
}): React.ReactElement {
    if (!job) {
        return (
            <div data-testid="ci-job-detail" style={{ ...checksStyles.note, padding: 12 }}>
                {t("commit.checks.tab.selectJob")}
            </div>
        );
    }
    const url = job.url;
    return (
        <div data-testid="ci-job-detail" style={detailStyle}>
            <div style={titleStyle}>
                <StateIcon state={badgeStateOf(job.state)} />
                <span style={{ fontWeight: 600, overflowWrap: "anywhere", flex: 1 }}>
                    {job.name}
                </span>
                {rerunJob ? (
                    <ActionButton
                        label={t("commit.checks.tab.rerunJob")}
                        target={rerunJob.target}
                        busy={rerunJob.busy}
                        onClick={rerunJob.onAction}
                    />
                ) : null}
            </div>
            <dl style={factsStyle}>
                <dt style={checksStyles.muted}>{t("commit.checks.tab.state")}</dt>
                <dd style={ddStyle}>{stateLabel(job.state)}</dd>
                <dt style={checksStyles.muted}>{t("commit.checks.tab.duration")}</dt>
                <dd style={ddStyle}>{formatCiDuration(job.startedAt, job.completedAt)}</dd>
                <dt style={checksStyles.muted}>{t("commit.checks.tab.started")}</dt>
                <dd style={ddStyle}>{formatCiStart(job.startedAt)}</dd>
            </dl>
            {showFailureSummary && job.failureSummary ? (
                <p
                    data-testid="ci-failure-summary"
                    aria-label={t("commit.checks.tab.failureSummary")}
                    style={summaryStyle}
                >
                    {job.failureSummary}
                </p>
            ) : null}
            {showSteps && job.steps.length > 0 ? (
                <ol style={stepsStyle} aria-label={t("commit.checks.tab.steps")}>
                    {job.steps.map((step) => (
                        <li key={step.number} style={stepStyle}>
                            <StateIcon state={badgeStateOf(step.state)} />
                            <span style={checksStyles.visuallyHidden}>
                                {stateLabel(step.state)}
                            </span>
                            <span style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>
                                {step.name}
                            </span>
                            <span style={checksStyles.muted}>
                                {formatCiDuration(step.startedAt, step.completedAt)}
                            </span>
                        </li>
                    ))}
                </ol>
            ) : null}
            {changedSinceGreen ? (
                <ChangedSinceGreen
                    // Another job or commit starts a new answer, so nothing of the last one shows.
                    key={`${changedSinceGreen.repoKey}\0${changedSinceGreen.hash}\0${changedSinceGreen.logicalCheckId}`}
                    job={changedSinceGreen}
                />
            ) : null}
            {logJob ? (
                <JobLog
                    // A new selection starts a new log view, so nothing of the last one shows.
                    key={`${logJob.repoKey}\0${logJob.hash}\0${logJob.runId}\0${logJob.jobId}\0${logJob.attempt ?? ""}`}
                    job={job}
                    logJob={logJob}
                    onOpenUrl={onOpenUrl}
                />
            ) : null}
            {url ? (
                <button
                    type="button"
                    style={checksStyles.linkButton}
                    onClick={() => onOpenUrl(url)}
                >
                    {t("commit.checks.tab.openInBrowser")}
                </button>
            ) : null}
        </div>
    );
}

/**
 * The log part of the job detail: nothing to show until the job finishes; for a failed job
 * the excerpt around its first error line, always as text. The excerpt stays in this
 * component's state and is never saved with the webview's state.
 */
function JobLog({
    job,
    logJob,
    onOpenUrl,
}: {
    job: CiJob;
    logJob: CiLogJobRef;
    onOpenUrl: (url: string) => void;
}): React.ReactElement {
    const unfinished = job.state === "queued" || job.state === "running";
    const { log, openFullLog, openError } = useCiLog(
        logJob,
        !unfinished && job.state === "failure",
    );
    if (unfinished) {
        return <div style={checksStyles.note}>{t("commit.checks.tab.logWhenFinished")}</div>;
    }
    const url = job.url;
    return (
        <div style={logStyle}>
            {log.status === "loading" ? (
                <div role="status" style={checksStyles.note}>
                    {t("commit.checks.tab.loadingExcerpt")}
                </div>
            ) : null}
            {log.status === "ready" ? (
                <>
                    <pre
                        data-testid="ci-log-excerpt"
                        aria-label={t("commit.checks.tab.logExcerpt")}
                        style={excerptStyle}
                    >
                        {log.excerpt}
                    </pre>
                    {log.truncated ? (
                        <div data-testid="ci-log-truncated" style={checksStyles.note}>
                            <span>{t("commit.checks.tab.logTruncated")}</span>
                            {url ? (
                                <button
                                    type="button"
                                    style={checksStyles.linkButton}
                                    onClick={() => onOpenUrl(url)}
                                >
                                    {t("commit.checks.tab.openInBrowser")}
                                </button>
                            ) : null}
                        </div>
                    ) : null}
                </>
            ) : null}
            <LogProblem view={log} />
            <button type="button" style={openLogStyle} onClick={openFullLog}>
                {t("commit.checks.tab.openFullLog")}
            </button>
            <LogProblem view={openError} />
        </div>
    );
}

const FILE_STATUS_COLOR: Record<CiChangedFile["status"], string> = {
    A: JETBRAINS_UI.color.added,
    D: JETBRAINS_UI.color.deleted,
    M: JETBRAINS_UI.color.modified,
    R: JETBRAINS_UI.color.modified,
    C: JETBRAINS_UI.color.added,
    T: JETBRAINS_UI.color.modified,
};

/**
 * "Changed since last green (a1b2c3d)": the files changed between the newest loaded
 * first-parent ancestor where this job passed and the selected commit, each opening a diff of
 * the two versions. Says so when no ancestor passed, when the job cannot be matched in older
 * commits, or when Git could not compare.
 */
function ChangedSinceGreen({ job }: { job: ChangedSinceGreenJob }): React.ReactElement {
    const { view, openDiff } = useChangedSinceGreen(job);
    if (view.status === "loading") {
        return (
            <div role="status" style={checksStyles.note}>
                {t("commit.checks.tab.changedSinceGreenLoading")}
            </div>
        );
    }
    if (view.error !== undefined) {
        return (
            <div role="alert" data-testid="ci-changed-since-green" style={checksStyles.note}>
                {t("commit.checks.tab.changedSinceGreenFailed", { error: view.error })}
            </div>
        );
    }
    const lastGreen = view.lastGreen;
    if (!lastGreen) {
        return (
            <div data-testid="ci-changed-since-green" style={checksStyles.note}>
                {view.unknownReason === "ambiguous"
                    ? t("commit.checks.tab.changedSinceGreenAmbiguous")
                    : t("commit.checks.tab.changedSinceGreenNone")}
            </div>
        );
    }
    const title = t("commit.checks.tab.changedSinceGreen", { hash: lastGreen.slice(0, 7) });
    return (
        <section data-testid="ci-changed-since-green" aria-label={title} style={logStyle}>
            <div style={{ fontWeight: 600 }}>{title}</div>
            <ul style={stepsStyle}>
                {view.files.map((file) => (
                    <li key={file.path}>
                        <button
                            type="button"
                            data-testid="ci-changed-file"
                            title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
                            style={fileButtonStyle}
                            onClick={() => openDiff(file)}
                        >
                            <span style={{ color: FILE_STATUS_COLOR[file.status], minWidth: 10 }}>
                                {file.status}
                            </span>
                            <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
                                {file.path}
                            </span>
                        </button>
                    </li>
                ))}
            </ul>
        </section>
    );
}

function LogProblem({ view }: { view: CiLogView }): React.ReactElement | null {
    let text: string;
    if (view.status === "running") text = t("commit.checks.tab.logWhenFinished");
    else if (view.status === "forbidden") text = t("commit.checks.tab.logForbidden");
    else if (view.status === "failed")
        text = t("commit.checks.tab.logFailed", { error: view.message });
    else return null;
    return (
        <div role="alert" style={checksStyles.note}>
            {text}
        </div>
    );
}

const logStyle: React.CSSProperties = {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: 6,
    minWidth: 0,
};

const summaryStyle: React.CSSProperties = {
    margin: 0,
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
};

const excerptStyle: React.CSSProperties = {
    margin: 0,
    alignSelf: "stretch",
    maxHeight: 320,
    overflow: "auto",
    padding: 8,
    borderRadius: 4,
    background: "var(--vscode-textCodeBlock-background)",
    fontFamily: "var(--vscode-editor-font-family)",
    fontSize: "var(--vscode-editor-font-size)",
    whiteSpace: "pre",
};

const openLogStyle: React.CSSProperties = {
    border: "none",
    borderRadius: 4,
    background: "var(--vscode-button-secondaryBackground)",
    color: "var(--vscode-button-secondaryForeground)",
    padding: "4px 12px",
    fontSize: 12,
    cursor: "pointer",
};

const detailStyle: React.CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: 10,
    padding: 12,
    fontSize: 12,
    minWidth: 0,
};

const titleStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 13,
};

const factsStyle: React.CSSProperties = {
    display: "grid",
    gridTemplateColumns: "max-content 1fr",
    columnGap: 12,
    rowGap: 4,
    margin: 0,
};

const ddStyle: React.CSSProperties = { margin: 0, fontVariantNumeric: "tabular-nums" };

const stepsStyle: React.CSSProperties = {
    listStyle: "none",
    margin: 0,
    padding: 0,
    display: "flex",
    flexDirection: "column",
    gap: 4,
};

const fileButtonStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 6,
    width: "100%",
    padding: "2px 0",
    border: "none",
    background: "transparent",
    color: "var(--vscode-foreground)",
    font: "inherit",
    textAlign: "left",
    cursor: "pointer",
};

const stepStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 6,
};
