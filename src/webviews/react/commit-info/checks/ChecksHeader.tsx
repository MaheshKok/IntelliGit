import React from "react";
import { VscLinkExternal, VscRefresh } from "react-icons/vsc";
import type { CommitCiDetail } from "../../../../types";
import { StateIcon } from "../../commit-list/CommitChecksPopover";
import { t } from "../../shared/i18n";
import { JETBRAINS_UI } from "../../shared/tokens";
import { formatCiDuration, spanOf, stateLabel } from "./ciFormat";
import { checksStyles } from "./checksStyles";

/**
 * The Checks tab header: overall state and duration, the run line where the provider
 * declares it, Refresh, and Open in browser when the run has a link.
 */
export function ChecksHeader({
    detail,
    onRefresh,
    onOpenUrl,
}: {
    detail: CommitCiDetail | null | undefined;
    onRefresh: () => void;
    onOpenUrl: (url: string) => void;
}): React.ReactElement {
    const firstRun = detail?.runs[0];
    const span = spanOf(detail?.runs ?? []);
    const runLine =
        detail?.capabilities.runHeader && firstRun
            ? t("commit.checks.tab.runLine", {
                  event: firstRun.event ?? "—",
                  actor: firstRun.actor ?? "—",
                  ref: firstRun.ref ?? "—",
                  runNumber: String(firstRun.runNumber ?? "—"),
              })
            : undefined;
    const url = firstRun?.url;
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
