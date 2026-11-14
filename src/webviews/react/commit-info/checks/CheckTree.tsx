import React from "react";
import { VscChevronDown, VscChevronRight } from "react-icons/vsc";
import type { CiCoverage, CiJob, CiRun, CommitCiDetail } from "../../../../types";
import { StateIcon } from "../../commit-list/CommitChecksPopover";
import { t } from "../../shared/i18n";
import { JETBRAINS_UI } from "../../shared/tokens";
import {
    badgeStateOf,
    blocksMerge,
    formatCiDuration,
    formatCiDurationMs,
    formatCiStart,
    stateLabel,
} from "./ciFormat";
import { checksStyles } from "./checksStyles";

interface CheckTreeProps {
    detail: CommitCiDetail;
    selectedJobId: string | null;
    onSelectJob: (job: CiJob) => void;
    onOpenUrl: (url: string) => void;
    onRefresh: () => void;
}

/**
 * The run, job and step tree. Failed jobs start expanded down to their failing step;
 * flat checks sit under "Other checks", or alone with no header when there are no runs.
 */
export function CheckTree({
    detail,
    selectedJobId,
    onSelectJob,
    onOpenUrl,
    onRefresh,
}: CheckTreeProps): React.ReactElement {
    // Keyed by job id; a job not in the map follows its default (expanded when it failed).
    const [expanded, setExpanded] = React.useState<ReadonlyMap<string, boolean>>(new Map());
    const isExpanded = (job: CiJob): boolean => expanded.get(job.id) ?? job.state === "failure";
    const toggle = (job: CiJob): void =>
        setExpanded((prev) => new Map(prev).set(job.id, !isExpanded(job)));

    return (
        <div
            role="list"
            data-testid="ci-tree"
            aria-label={t("commit.checks.title")}
            style={treeStyle}
        >
            <CoverageNote
                coverage={detail.runsCoverage}
                pageBoundKey="commit.checks.tab.runsPageBound"
                rejectedKey="commit.checks.tab.runsRejectedNext"
            />
            {detail.runs.map((run) => (
                <RunGroup
                    key={run.id}
                    run={run}
                    showSteps={detail.capabilities.steps}
                    selectedJobId={selectedJobId}
                    isExpanded={isExpanded}
                    onToggle={toggle}
                    onSelectJob={onSelectJob}
                    onOpenUrl={onOpenUrl}
                    onRefresh={onRefresh}
                />
            ))}
            {detail.otherChecks.length > 0 && detail.runs.length > 0 ? (
                <div style={groupHeaderStyle}>{t("commit.checks.tab.otherChecks")}</div>
            ) : null}
            {detail.otherChecks.map((check, index) => (
                <div
                    // Flat checks may carry no id and may repeat a name; position breaks the tie.
                    // react-doctor-disable-next-line react-doctor/no-array-index-as-key -- Provider rows can be identical.
                    key={`${check.id ?? check.name}:${index}`}
                    role="listitem"
                    data-testid="ci-check-row"
                    style={{ ...rowStyle, paddingLeft: 12 }}
                >
                    <StateIcon state={check.state} />
                    <span style={checksStyles.visuallyHidden}>{stateLabel(check.state)}</span>
                    {check.url ? (
                        <button
                            type="button"
                            style={{ ...checksStyles.linkButton, ...nameStyle }}
                            onClick={() => onOpenUrl(check.url!)}
                        >
                            {check.name}
                        </button>
                    ) : (
                        <span style={nameStyle}>{check.name}</span>
                    )}
                    {blocksMerge(check.required, check.state) ? <BlocksMergeTag /> : null}
                    {check.durationMs !== undefined ? (
                        <span data-testid="ci-check-duration" style={checksStyles.muted}>
                            {formatCiDurationMs(check.durationMs)}
                        </span>
                    ) : null}
                    {check.description ? (
                        <span style={{ ...checksStyles.muted, ...ellipsisStyle }}>
                            {check.description}
                        </span>
                    ) : null}
                </div>
            ))}
            <CoverageNote
                coverage={detail.otherChecksCoverage}
                pageBoundKey="commit.checks.tab.checksPageBound"
                rejectedKey="commit.checks.tab.checksRejectedNext"
            />
        </div>
    );
}

function RunGroup({
    run,
    showSteps,
    selectedJobId,
    isExpanded,
    onToggle,
    onSelectJob,
    onOpenUrl,
    onRefresh,
}: {
    run: CiRun;
    showSteps: boolean;
    selectedJobId: string | null;
    isExpanded: (job: CiJob) => boolean;
    onToggle: (job: CiJob) => void;
    onSelectJob: (job: CiJob) => void;
    onOpenUrl: (url: string) => void;
    onRefresh: () => void;
}): React.ReactElement {
    return (
        <div>
            <div role="listitem" data-testid="ci-run-row" style={{ ...rowStyle, paddingLeft: 12 }}>
                <StateIcon state={badgeStateOf(run.state)} />
                <span style={checksStyles.visuallyHidden}>{stateLabel(run.state)}</span>
                <span style={{ ...nameStyle, fontWeight: 600 }}>{run.name}</span>
                <span style={checksStyles.muted}>
                    {formatCiDuration(run.startedAt, run.completedAt)}
                </span>
                <span style={{ ...checksStyles.muted, ...ellipsisStyle }}>
                    {formatCiStart(run.startedAt)}
                </span>
            </div>
            {run.jobs.map((job) => {
                const expandable = showSteps && job.steps.length > 0;
                const open = expandable && isExpanded(job);
                return (
                    <React.Fragment key={job.id}>
                        <div
                            role="listitem"
                            tabIndex={0}
                            data-testid="ci-job-row"
                            data-name={job.name}
                            aria-current={selectedJobId === job.id ? "true" : undefined}
                            onClick={() => onSelectJob(job)}
                            onKeyDown={(event) => {
                                // A key pressed on a control inside the row belongs to that control.
                                if (event.target !== event.currentTarget) return;
                                if (event.key === "Enter" || event.key === " ") {
                                    event.preventDefault();
                                    onSelectJob(job);
                                } else if (
                                    expandable &&
                                    event.key === (open ? "ArrowLeft" : "ArrowRight")
                                ) {
                                    event.preventDefault();
                                    onToggle(job);
                                }
                            }}
                            style={{
                                ...rowStyle,
                                paddingLeft: 24,
                                cursor: "pointer",
                                background:
                                    selectedJobId === job.id
                                        ? JETBRAINS_UI.color.selected
                                        : undefined,
                            }}
                        >
                            {expandable ? (
                                <button
                                    type="button"
                                    style={checksStyles.iconButton}
                                    aria-label={job.name}
                                    aria-expanded={open}
                                    tabIndex={-1}
                                    onClick={(event) => {
                                        event.stopPropagation();
                                        onToggle(job);
                                    }}
                                >
                                    {open ? (
                                        <VscChevronDown size={12} aria-hidden="true" />
                                    ) : (
                                        <VscChevronRight size={12} aria-hidden="true" />
                                    )}
                                </button>
                            ) : null}
                            <StateIcon state={badgeStateOf(job.state)} />
                            <span style={checksStyles.visuallyHidden}>{stateLabel(job.state)}</span>
                            <span style={nameStyle}>{job.name}</span>
                            {blocksMerge(job.required, job.state) ? <BlocksMergeTag /> : null}
                            {job.optional ? (
                                <span
                                    data-testid="ci-tag-optional"
                                    style={{ ...checksStyles.tag, color: JETBRAINS_UI.color.muted }}
                                >
                                    {t("commit.checks.tab.optional")}
                                </span>
                            ) : null}
                            <span style={checksStyles.muted}>
                                {formatCiDuration(job.startedAt, job.completedAt)}
                            </span>
                            <span style={{ ...checksStyles.muted, ...ellipsisStyle }}>
                                {formatCiStart(job.startedAt)}
                            </span>
                        </div>
                        {open
                            ? job.steps.map((step) => (
                                  <div
                                      key={step.number}
                                      role="listitem"
                                      data-testid="ci-step-row"
                                      data-failed={step.state === "failure" ? "true" : undefined}
                                      style={{ ...rowStyle, paddingLeft: 56 }}
                                  >
                                      <StateIcon state={badgeStateOf(step.state)} />
                                      <span style={checksStyles.visuallyHidden}>
                                          {stateLabel(step.state)}
                                      </span>
                                      <span style={nameStyle}>{step.name}</span>
                                      <span style={checksStyles.muted}>
                                          {formatCiDuration(step.startedAt, step.completedAt)}
                                      </span>
                                      <span style={{ ...checksStyles.muted, ...ellipsisStyle }}>
                                          {formatCiStart(step.startedAt)}
                                      </span>
                                  </div>
                              ))
                            : null}
                    </React.Fragment>
                );
            })}
            <CoverageNote
                coverage={run.jobsCoverage}
                pageBoundKey="commit.checks.tab.jobsPageBound"
                rejectedKey="commit.checks.tab.jobsRejectedNext"
                url={run.url}
                onOpenUrl={onOpenUrl}
            />
            <FailedScanNote run={run} onRefresh={onRefresh} />
        </div>
    );
}

/** Red tag on a required job or check that failed or has not finished. */
function BlocksMergeTag(): React.ReactElement {
    return (
        <span
            data-testid="ci-tag-blocks-merge"
            style={{ ...checksStyles.tag, color: JETBRAINS_UI.color.deleted }}
        >
            {t("commit.checks.tab.blocksMerge")}
        </span>
    );
}

function CoverageNote({
    coverage,
    pageBoundKey,
    rejectedKey,
    url,
    onOpenUrl,
}: {
    coverage: CiCoverage;
    pageBoundKey: string;
    rejectedKey: string;
    url?: string;
    onOpenUrl?: (url: string) => void;
}): React.ReactElement | null {
    if (coverage === "full") return null;
    const key = coverage.reason === "pageBound" ? pageBoundKey : rejectedKey;
    return (
        <div data-testid="ci-coverage-note" style={checksStyles.note}>
            <span>{t(key, { count: String(coverage.shown) })}</span>
            {url && onOpenUrl ? (
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

function FailedScanNote({
    run,
    onRefresh,
}: {
    run: CiRun;
    onRefresh: () => void;
}): React.ReactElement | null {
    const scan = run.failedScan;
    if (!scan || scan.state === "done") return null;
    const key =
        scan.state === "running"
            ? "commit.checks.tab.scanRunning"
            : scan.state === "paused"
              ? "commit.checks.tab.scanPaused"
              : "commit.checks.tab.scanStopped";
    return (
        <div data-testid="ci-scan-note" role="status" style={checksStyles.note}>
            <span>{t(key)}</span>
            {scan.state === "stopped" ? (
                <button type="button" style={checksStyles.linkButton} onClick={onRefresh}>
                    {t("common.refresh")}
                </button>
            ) : null}
        </div>
    );
}

const treeStyle: React.CSSProperties = {
    display: "flex",
    flexDirection: "column",
    padding: "4px 0",
    minWidth: 0,
};

const rowStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 6,
    minHeight: 24,
    paddingRight: 8,
    fontSize: 12,
    whiteSpace: "nowrap",
};

const nameStyle: React.CSSProperties = {
    overflow: "hidden",
    textOverflow: "ellipsis",
    minWidth: 0,
};

const ellipsisStyle: React.CSSProperties = {
    overflow: "hidden",
    textOverflow: "ellipsis",
    minWidth: 0,
};

const groupHeaderStyle: React.CSSProperties = {
    padding: "8px 12px 2px",
    fontSize: 11,
    fontWeight: 600,
    color: JETBRAINS_UI.color.muted,
};
