import React from "react";
import type { CiBisectJob } from "../../../../shared/ci/history";
import type { CiState } from "../../../../types";
import type { CiBisectResultMessage } from "../../../protocol/commitCiMessages";
import { t } from "../../shared/i18n";
import { JETBRAINS_UI } from "../../shared/tokens";
import { closeCiBisect, retryCiBisect, useCiBisect, type CiBisectView } from "./ciBisect";
import { stateLabel } from "./ciFormat";
import { checksStyles } from "./checksStyles";

// Sizes from Figma frame 4:2 (PLAN.md Phase 16); design constants.
const HELP_HEIGHT = 19;
const ROW_HEIGHT = 25;
const FIRST_ROW_HEIGHT = 31;
const NAME_WIDTH = 160;
const COLUMN_GAP = 6;
const SPARKLINE_WIDTH = 72;
const SPARK_LEAD = 8;
const SQUARE = 9;
const SQUARE_GAP = 2;
const RESULT_INSET = 10;
const TAG_HEIGHT = 18;
const NOTE_HEIGHT = 16;

type Tone = "green" | "red" | "amber" | "none";

const TONE_COLOR: Record<Tone, string> = {
    green: "var(--vscode-charts-green, #62c370)",
    red: "var(--vscode-errorForeground, #f14c4c)",
    amber: "var(--vscode-charts-yellow, #e5c07b)",
    none: "transparent",
};

/** A square's colour; in a flaky job a red with green on both sides is amber. */
function toneOf(states: readonly (CiState | null)[], index: number, flaky: boolean): Tone {
    const state = states[index];
    if (state === "success") return "green";
    if (state === "queued" || state === "running") return "amber";
    if (state !== "failure") return "none";
    const isolated = states[index - 1] === "success" && states[index + 1] === "success";
    return flaky && isolated ? "amber" : "red";
}

function resultText(job: CiBisectJob, result: CiBisectResultMessage): string {
    if (!result.linear) return t("commit.checks.bisect.notLinear");
    if (job.brokeAt) {
        const hash = job.brokeAt.slice(0, 7);
        const ago = Math.max(0, result.commits.length - 1 - result.commits.indexOf(job.brokeAt));
        return ago === 0
            ? t("commit.checks.bisect.brokeAtThis", { hash })
            : t("commit.checks.bisect.brokeAtAgo", { hash, count: ago });
    }
    if (job.flaky) {
        return t("commit.checks.bisect.flakyNote", {
            n: String(job.flaky.n),
            m: String(job.flaky.m),
        });
    }
    return t("commit.checks.bisect.noBreak");
}

function Sparkline({
    job,
    commits,
}: {
    job: CiBisectJob;
    commits: readonly string[];
}): React.ReactElement {
    // `states` run oldest to newest; the sparkline shows the newest on the left.
    const indexes = job.states.map((_, index) => index).reverse();
    // Frame 4:2 fixes the width at 72 px, which holds six 9 px squares. A longer range keeps every
    // square and narrows them instead; past the point where the 2 px gaps alone would not fit,
    // the gaps go first so no square shrinks below a pixel.
    const count = indexes.length;
    const gap = Math.max(
        0,
        Math.min(
            SQUARE_GAP,
            Math.floor((SPARKLINE_WIDTH - SPARK_LEAD - count) / Math.max(1, count - 1)),
        ),
    );
    return (
        <span style={{ ...sparklineStyle, gap }}>
            {indexes.map((index) => {
                const state = job.states[index] ?? null;
                const hash = commits[index] ?? "";
                const tone = toneOf(job.states, index, job.flaky !== null);
                const label = t("commit.checks.bisect.square", {
                    hash: hash.slice(0, 7),
                    state: state ? stateLabel(state) : t("commit.checks.bisect.notRead"),
                });
                return (
                    <span
                        key={hash || index}
                        role="img"
                        aria-label={label}
                        title={label}
                        data-testid="ci-bisect-square"
                        data-hash={hash}
                        data-state={state ?? "unread"}
                        data-tone={tone}
                        style={{
                            ...squareStyle,
                            background: TONE_COLOR[tone],
                            ...(tone === "none" && {
                                border: `1px solid ${JETBRAINS_UI.color.muted}`,
                            }),
                        }}
                    />
                );
            })}
        </span>
    );
}

function FlakyTag({ job }: { job: CiBisectJob }): React.ReactElement | null {
    if (!job.flaky) return null;
    const { n, m, attemptsCounted } = job.flaky;
    return (
        <span
            data-testid="ci-bisect-flaky"
            title={
                attemptsCounted ? undefined : t("commit.checks.tab.history.flakyEstimatedTooltip")
            }
            style={flakyTagStyle}
        >
            {t(
                attemptsCounted
                    ? "commit.checks.tab.history.flaky"
                    : "commit.checks.tab.history.flakyEstimated",
                { n: String(n), m: String(m) },
            )}
        </span>
    );
}

function HelpLine(): React.ReactElement {
    const [before, after = ""] = t("commit.checks.bisect.help").split("{action}");
    return (
        <div style={helpStyle}>
            {before}
            <strong>{t("commit.menu.findCiBreak")}</strong>
            {after}
        </div>
    );
}

/**
 * The Checks tab's "Find where CI broke" section: progress with Cancel while the host reads the
 * selected commits, then one row per job with its sparkline, where it broke (or why there is no
 * break point), its flaky tag, and the cap note.
 */
export function BisectView({ view }: { view: CiBisectView }): React.ReactElement {
    const result = view.status === "done" ? view.result : undefined;
    return (
        <section
            data-testid="ci-bisect"
            aria-label={t("commit.checks.bisect.title")}
            style={{ display: "flex", flexDirection: "column", padding: "4px 0" }}
        >
            <HelpLine />
            {result ? (
                <>
                    {result.failedReads ? (
                        <div role="alert" style={noteStyle}>
                            <span style={{ color: TONE_COLOR.red }}>
                                {t("commit.checks.bisect.failed", {
                                    count: String(result.failedReads),
                                })}
                            </span>
                            <button
                                type="button"
                                data-testid="ci-bisect-retry"
                                style={checksStyles.linkButton}
                                onClick={retryCiBisect}
                            >
                                {t("commit.checks.bisect.retry")}
                            </button>
                        </div>
                    ) : result.jobs.length === 0 ? (
                        <div role="status" style={noteStyle}>
                            {t("commit.checks.bisect.none")}
                        </div>
                    ) : null}
                    {result.jobs.map((job, index) => (
                        <div
                            key={`${job.checkName}\0${index}`}
                            data-testid="ci-bisect-job"
                            data-job={job.checkName}
                            style={{
                                ...rowStyle,
                                height: index === 0 ? FIRST_ROW_HEIGHT : ROW_HEIGHT,
                            }}
                        >
                            <span title={job.checkName} style={nameStyle}>
                                {job.checkName}
                            </span>
                            <Sparkline job={job} commits={result.commits} />
                            <span style={resultStyle}>{resultText(job, result)}</span>
                            <FlakyTag job={job} />
                        </div>
                    ))}
                    <div style={noteStyle}>
                        {result.limitedTo !== undefined ? (
                            <span>
                                {t("commit.checks.bisect.limited", {
                                    count: String(result.limitedTo),
                                })}
                            </span>
                        ) : null}
                        <button
                            type="button"
                            data-testid="ci-bisect-close"
                            style={checksStyles.linkButton}
                            onClick={closeCiBisect}
                        >
                            {t("commit.checks.bisect.close")}
                        </button>
                    </div>
                </>
            ) : (
                <div role="status" style={noteStyle}>
                    <span style={checksStyles.muted}>
                        {t("commit.checks.bisect.progress", {
                            done: String(view.status === "running" ? view.done : 0),
                            total: String(view.status === "running" ? view.total : 0),
                        })}
                    </span>
                    <button
                        type="button"
                        data-testid="ci-bisect-cancel"
                        style={checksStyles.linkButton}
                        onClick={closeCiBisect}
                    >
                        {t("commit.checks.bisect.cancel")}
                    </button>
                </div>
            )}
        </section>
    );
}

/** Shows the pane repository's bisect in place of the Checks tab's body while there is one. */
export function BisectInPlace({
    repoKey,
    children,
}: {
    repoKey: string;
    children: React.ReactNode;
}): React.ReactElement {
    const view = useCiBisect(repoKey);
    return view ? <BisectView view={view} /> : <>{children}</>;
}

const helpStyle: React.CSSProperties = {
    minHeight: HELP_HEIGHT,
    lineHeight: `${HELP_HEIGHT}px`,
    padding: "0 12px",
    color: JETBRAINS_UI.color.muted,
    fontSize: 12,
};

const rowStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: COLUMN_GAP,
    padding: "0 12px",
    boxSizing: "border-box",
    fontSize: 12,
};

const nameStyle: React.CSSProperties = {
    width: NAME_WIDTH,
    flexShrink: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
};

const sparklineStyle: React.CSSProperties = {
    display: "inline-flex",
    width: SPARKLINE_WIDTH,
    paddingLeft: SPARK_LEAD,
    boxSizing: "border-box",
    flexShrink: 0,
};

const squareStyle: React.CSSProperties = {
    flexBasis: SQUARE,
    flexGrow: 0,
    flexShrink: 1,
    minWidth: 0,
    height: SQUARE,
    boxSizing: "border-box",
};

const resultStyle: React.CSSProperties = {
    paddingLeft: RESULT_INSET,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    minWidth: 0,
};

const flakyTagStyle: React.CSSProperties = {
    ...checksStyles.tag,
    color: TONE_COLOR.amber,
    height: TAG_HEIGHT,
    lineHeight: `${TAG_HEIGHT - 2}px`,
    // The row's gap is the tag's 6 px left margin.
    boxSizing: "border-box",
};

const noteStyle: React.CSSProperties = {
    ...checksStyles.note,
    // Frame 4:2's note line is 16 px high: no vertical padding on top of it.
    padding: "0 12px",
    minHeight: NOTE_HEIGHT,
    lineHeight: `${NOTE_HEIGHT}px`,
};
