import React from "react";
import type { CommitCheckState } from "../../../types";
import { t } from "../shared/i18n";
import { JETBRAINS_UI } from "../shared/tokens";
import { colorForState, type CommitChecksValue } from "./CommitChecksPopover";
import {
    CI_BAR_GAP,
    CI_BAR_HEIGHT,
    CI_BAR_WIDTH,
    CI_CELL_INSET,
    CI_COL_WIDTH,
    METADATA_COLUMN_MARGIN,
} from "./styles";

interface Props {
    hash: string;
    /** The same snapshot the check badge reads. */
    checks?: CommitChecksValue;
    /** Selects the row and opens the Checks tab; without it a click just selects the row. */
    onOpenInChecks?: (hash: string) => void;
}

const FAILED_STATES: ReadonlySet<CommitCheckState> = new Set([
    "failure",
    "timed_out",
    "action_required",
]);

/** The Git Log's CI cell: a bar of passed, failed and running checks and a `passed/total` count. */
export function CiColumnCell({ hash, checks, onOpenInChecks }: Props): React.ReactElement {
    const items = checks && checks !== "loading" ? checks.items : [];
    const total = items.length;
    const passed = items.filter((item) => item.state === "success").length;
    const failed = items.filter((item) => FAILED_STATES.has(item.state)).length;
    const pending = items.filter((item) => item.state === "pending").length;
    const summary = checks && checks !== "loading" ? checks.summary : t("commit.checks.title");
    const segments = [
        { state: "success" as const, count: passed },
        { state: "failure" as const, count: failed },
        { state: "pending" as const, count: pending },
    ];

    return (
        <button
            type="button"
            title={summary}
            aria-label={t("commit.list.ci.label", { summary })}
            data-testid={`commit-ci-cell-${hash}`}
            style={cellStyle}
            onClick={(event) => {
                if (!onOpenInChecks) return;
                event.stopPropagation();
                onOpenInChecks(hash);
            }}
        >
            <span aria-hidden="true" style={barStyle}>
                {total > 0
                    ? segments.map(({ state, count }) =>
                          count > 0 ? (
                              <span
                                  key={state}
                                  data-testid={`commit-ci-bar-${state}`}
                                  style={{
                                      width: `${(count / total) * 100}%`,
                                      background: colorForState(state),
                                  }}
                              />
                          ) : null,
                      )
                    : null}
            </span>
            <span style={countStyle}>{total > 0 ? `${passed}/${total}` : "—"}</span>
        </button>
    );
}

/** The CI column's header, over the cells; renders nothing while the column is not shown. */
export function CiColumnHeader({
    shown,
    beforeAuthor,
}: {
    shown: boolean;
    beforeAuthor: boolean;
}): React.ReactElement | null {
    if (!shown) return null;
    return (
        <span
            data-testid="commit-ci-header"
            style={{
                width: CI_COL_WIDTH,
                boxSizing: "border-box",
                paddingLeft: CI_CELL_INSET,
                marginLeft: METADATA_COLUMN_MARGIN,
                // The Author header has no left margin of its own.
                marginRight: beforeAuthor ? METADATA_COLUMN_MARGIN : 0,
            }}
        >
            {t("commit.list.header.ci")}
        </span>
    );
}

const cellStyle: React.CSSProperties = {
    width: CI_COL_WIDTH,
    boxSizing: "border-box",
    height: "100%",
    flexShrink: 0,
    marginLeft: METADATA_COLUMN_MARGIN,
    paddingLeft: CI_CELL_INSET,
    paddingRight: 0,
    display: "inline-flex",
    alignItems: "center",
    gap: CI_BAR_GAP,
    border: "none",
    background: "transparent",
    color: "inherit",
    font: "inherit",
    cursor: "pointer",
    textAlign: "left",
};

const barStyle: React.CSSProperties = {
    width: CI_BAR_WIDTH,
    height: CI_BAR_HEIGHT,
    flexShrink: 0,
    display: "flex",
    overflow: "hidden",
    borderRadius: CI_BAR_HEIGHT / 2,
    background: JETBRAINS_UI.color.border,
};

const countStyle: React.CSSProperties = {
    fontSize: 12,
    lineHeight: "12px",
    fontVariantNumeric: "tabular-nums",
    opacity: 0.8,
};
