import React from "react";
import { VscLinkExternal, VscLoading, VscRefresh } from "react-icons/vsc";
import type { CiRun, CommitCiDetail } from "../../../../types";
import { StateIcon } from "../../commit-list/CommitChecksPopover";
import { t } from "../../shared/i18n";
import { JETBRAINS_UI } from "../../shared/tokens";
import { formatCiDuration, spanOf, stateLabel } from "./ciFormat";
import { checksStyles } from "./checksStyles";
import type { CiActionTarget } from "./useCiAction";

/**
 * The Checks tab header: overall state and duration, the run line where the provider
 * declares it, the re-run and cancel actions the provider declares (cancel asks for an inline
 * confirm), the waiting label while an action is not seen yet, Refresh, and Open in browser
 * when the run has a link.
 */
export function ChecksHeader({
    detail,
    actionRun,
    busy = null,
    onAction,
    onRefresh,
    onOpenUrl,
}: {
    detail: CommitCiDetail | null | undefined;
    /** The run the header's actions target. */
    actionRun?: CiRun;
    /** The action in flight; every action button waits for it. */
    busy?: CiActionTarget | null;
    onAction?: (target: CiActionTarget) => void;
    onRefresh: () => void;
    onOpenUrl: (url: string) => void;
}): React.ReactElement {
    // The run line and link name the run the actions target, so Cancel never acts on a run the header does not show.
    const shownRun = actionRun ?? detail?.runs[0];
    const span = spanOf(detail?.runs ?? []);
    const runLine =
        detail?.capabilities.runHeader && shownRun
            ? t("commit.checks.tab.runLine", {
                  event: shownRun.event ?? "—",
                  actor: shownRun.actor ?? "—",
                  ref: shownRun.ref ?? "—",
                  runNumber: String(shownRun.runNumber ?? "—"),
              })
            : undefined;
    const url = shownRun?.url;
    return (
        <div data-testid="ci-header" style={headerStyle}>
            {detail ? (
                <>
                    <StateIcon state={detail.outcome} />
                    <span style={checksStyles.visuallyHidden}>{stateLabel(detail.outcome)}</span>
                    <span style={durationStyle}>
                        {formatCiDuration(span.startedAt, span.completedAt)}
                    </span>
                    {runLine ? (
                        <span data-testid="ci-header-run-line" style={runLineStyle}>
                            {runLine}
                        </span>
                    ) : null}
                </>
            ) : null}
            <span style={{ flex: 1 }} />
            <HeaderActions
                detail={detail}
                actionRun={actionRun}
                busy={busy}
                onAction={onAction}
                onRefresh={onRefresh}
            />
            {url ? (
                <button
                    type="button"
                    style={checksStyles.iconButton}
                    aria-label={t("commit.checks.tab.openInBrowser")}
                    title={t("commit.checks.tab.openInBrowser")}
                    onClick={() => onOpenUrl(url)}
                >
                    <VscLinkExternal size={14} aria-hidden="true" />
                </button>
            ) : null}
            <button
                type="button"
                style={checksStyles.iconButton}
                aria-label={t("common.refresh")}
                title={t("common.refresh")}
                onClick={onRefresh}
            >
                <VscRefresh size={14} aria-hidden="true" />
            </button>
        </div>
    );
}

/**
 * The header's write actions: the waiting label while an action is not seen yet, else
 * Re-run failed for a failed run and Cancel run (with its inline confirm) for a running one.
 */
function HeaderActions({
    detail,
    actionRun,
    busy,
    onAction,
    onRefresh,
}: {
    detail: CommitCiDetail | null | undefined;
    actionRun: CiRun | undefined;
    busy: CiActionTarget | null;
    onAction: ((target: CiActionTarget) => void) | undefined;
    onRefresh: () => void;
}): React.ReactElement | null {
    const [confirming, setConfirming] = React.useState<string | null>(null);
    const fence = detail?.actionFence;
    if (fence) return <FenceLabel fence={fence} onRefresh={onRefresh} />;
    const capabilities = detail?.capabilities;
    const run = onAction ? actionRun : undefined;
    if (!run || !capabilities) return null;
    const canRerun = run.state === "failure" && capabilities.rerunFailed;
    const canCancel = (run.state === "queued" || run.state === "running") && capabilities.cancel;
    const confirmingCancel = canCancel && confirming === run.id;
    const send = (target: CiActionTarget): void => {
        setConfirming(null);
        onAction?.(target);
    };
    return (
        <>
            {canRerun ? (
                <ActionButton
                    label={t(capabilities.rerunFailedLabel ?? "commit.checks.tab.rerunFailed")}
                    target={{ action: "rerunFailed", runId: run.id }}
                    busy={busy}
                    onClick={send}
                />
            ) : null}
            {canCancel && !confirmingCancel ? (
                <button
                    type="button"
                    style={actionButtonStyle}
                    disabled={busy !== null}
                    onClick={() => setConfirming(run.id)}
                >
                    {t("commit.checks.tab.cancelRun")}
                </button>
            ) : null}
            {confirmingCancel ? (
                <>
                    <ActionButton
                        label={t("commit.checks.tab.confirmCancel")}
                        target={{ action: "cancel", runId: run.id }}
                        busy={busy}
                        onClick={send}
                    />
                    <button
                        type="button"
                        style={actionButtonStyle}
                        onClick={() => setConfirming(null)}
                    >
                        {t("commit.checks.tab.keepRunning")}
                    </button>
                </>
            ) : null}
        </>
    );
}

/**
 * One write-action button. While any action is in flight it is disabled, and the clicked one
 * shows a spinner.
 */
export function ActionButton({
    label,
    target,
    busy,
    onClick,
}: {
    label: string;
    target: CiActionTarget;
    busy: CiActionTarget | null;
    onClick: (target: CiActionTarget) => void;
}): React.ReactElement {
    const spinning =
        busy?.action === target.action &&
        busy.runId === target.runId &&
        busy.jobId === target.jobId;
    return (
        <button
            type="button"
            style={actionButtonStyle}
            disabled={busy !== null}
            aria-busy={spinning || undefined}
            onClick={() => onClick(target)}
        >
            {spinning ? (
                <VscLoading
                    size={12}
                    aria-hidden="true"
                    style={{ animation: "intelligit-spin 0.8s linear infinite" }}
                />
            ) : null}
            {label}
        </button>
    );
}

/** "Waiting for …" while the provider has not shown the action; "… not seen yet — Refresh" after. */
function FenceLabel({
    fence,
    onRefresh,
}: {
    fence: NonNullable<CommitCiDetail["actionFence"]>;
    onRefresh: () => void;
}): React.ReactElement {
    const cancel = fence.action === "cancel";
    if (fence.notSeen) {
        return (
            <button
                type="button"
                data-testid="ci-action-fence"
                style={checksStyles.linkButton}
                onClick={onRefresh}
            >
                {t(cancel ? "commit.checks.tab.cancelNotSeen" : "commit.checks.tab.rerunNotSeen")}
            </button>
        );
    }
    return (
        <span role="status" data-testid="ci-action-fence" style={runLineStyle}>
            {t(cancel ? "commit.checks.tab.waitingCancel" : "commit.checks.tab.waitingRerun")}
        </span>
    );
}

const actionButtonStyle: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    border: `1px solid ${JETBRAINS_UI.color.divider}`,
    borderRadius: 4,
    background: "transparent",
    color: "inherit",
    padding: "2px 8px",
    font: "inherit",
    cursor: "pointer",
    flexShrink: 0,
};

const headerStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 8,
    minHeight: 32,
    padding: "4px 8px 4px 12px",
    borderBottom: `1px solid ${JETBRAINS_UI.color.divider}`,
    fontSize: 12,
    flexShrink: 0,
};

const durationStyle: React.CSSProperties = {
    fontVariantNumeric: "tabular-nums",
};

const runLineStyle: React.CSSProperties = {
    color: JETBRAINS_UI.color.muted,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    minWidth: 0,
};
