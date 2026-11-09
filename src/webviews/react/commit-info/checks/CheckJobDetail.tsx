import React from "react";
import type { CiJob } from "../../../../types";
import { StateIcon } from "../../commit-list/CommitChecksPopover";
import { t } from "../../shared/i18n";
import { badgeStateOf, formatCiDuration, formatCiStart, stateLabel } from "./ciFormat";
import { checksStyles } from "./checksStyles";

/** The selected job: name, state, duration, start, its steps and its link. */
export function CheckJobDetail({
    job,
    showSteps,
    onOpenUrl,
}: {
    job: CiJob | undefined;
    showSteps: boolean;
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
                <span style={{ fontWeight: 600, overflowWrap: "anywhere" }}>{job.name}</span>
            </div>
            <dl style={factsStyle}>
                <dt style={checksStyles.muted}>{t("commit.checks.tab.state")}</dt>
                <dd style={ddStyle}>{stateLabel(job.state)}</dd>
                <dt style={checksStyles.muted}>{t("commit.checks.tab.duration")}</dt>
                <dd style={ddStyle}>{formatCiDuration(job.startedAt, job.completedAt)}</dd>
                <dt style={checksStyles.muted}>{t("commit.checks.tab.started")}</dt>
                <dd style={ddStyle}>{formatCiStart(job.startedAt)}</dd>
            </dl>
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

const stepStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 6,
};
