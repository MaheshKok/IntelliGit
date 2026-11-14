// Display helpers for the Checks tab: durations, times and state words.

import type { CiState, CommitCheckState } from "../../../../types";
import { formatDateTime } from "../../shared/date";
import { t } from "../../shared/i18n";

/** Shown wherever a time or duration is unknown; never computed from a guess. */
const UNKNOWN_TIME = "—";

/**
 * Formats the time between two provider timestamps as `45s`, `1m 05s` or `1h 02m`.
 *
 * @param startedAt - ISO start time, if the provider gave one.
 * @param completedAt - ISO end time, if the provider gave one.
 */
export function formatCiDuration(startedAt?: string, completedAt?: string): string {
    if (!startedAt || !completedAt) return UNKNOWN_TIME;
    return formatCiDurationMs(Date.parse(completedAt) - Date.parse(startedAt));
}

/**
 * Formats a provider-reported duration as `45s`, `1m 05s` or `1h 02m`.
 *
 * @param ms - Duration in milliseconds; null when the provider reports it as unknown.
 */
export function formatCiDurationMs(ms: number | null): string {
    if (ms === null || !Number.isFinite(ms) || ms < 0) return UNKNOWN_TIME;
    const totalSeconds = Math.round(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
    if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
    return `${seconds}s`;
}

/**
 * Formats a provider start time for a tree row.
 *
 * @param startedAt - ISO start time, if the provider gave one.
 */
export function formatCiStart(startedAt?: string): string {
    return startedAt ? formatDateTime(startedAt) : UNKNOWN_TIME;
}

/**
 * Maps an execution state onto the badge state set, so the tab and the row badge share icons.
 *
 * @param state - Run, job or step state.
 */
export function badgeStateOf(state: CiState): CommitCheckState {
    return state === "queued" || state === "running" ? "pending" : state;
}

const STATE_KEYS: Partial<Record<CiState | CommitCheckState, string>> = {
    queued: "commit.checks.state.queued",
    running: "commit.checks.state.running",
    pending: "commit.checks.state.pending",
    success: "commit.checks.state.success",
    failure: "commit.checks.state.failure",
    timed_out: "commit.checks.state.failure",
    action_required: "commit.checks.state.actionRequired",
    cancelled: "commit.checks.state.cancelled",
    skipped: "commit.checks.state.skipped",
    neutral: "commit.checks.state.neutral",
};

/**
 * The localized word for a state, read by screen readers next to each icon.
 *
 * @param state - Execution or badge state.
 */
export function stateLabel(state: CiState | CommitCheckState): string {
    return t(STATE_KEYS[state] ?? "commit.checks.state.unknown");
}

/** States in which a required check keeps a merge blocked: failed, or not finished yet. */
const BLOCKING_STATES: ReadonlySet<CiState | CommitCheckState> = new Set([
    "failure",
    "cancelled",
    "timed_out",
    "action_required",
    "queued",
    "running",
    "pending",
]);

/**
 * Whether a job or check gets the "blocks merge" tag: required, and failed or unfinished.
 *
 * @param required - The job's or check's required mark; only "yes" can block.
 * @param state - Its execution or badge state.
 */
export function blocksMerge(
    required: "yes" | "no" | "unknown" | undefined,
    state: CiState | CommitCheckState,
): boolean {
    return required === "yes" && BLOCKING_STATES.has(state);
}

/**
 * Earliest start and latest end over a set of runs, for the header's overall duration.
 *
 * @param runs - Runs with optional provider times.
 */
export function spanOf(runs: readonly { startedAt?: string; completedAt?: string }[]): {
    startedAt?: string;
    completedAt?: string;
} {
    if (runs.length === 0 || runs.some((run) => !run.startedAt || !run.completedAt)) return {};
    // By instant: a text sort misorders times written with different timezone offsets.
    const byInstant = (a: string, b: string): number => Date.parse(a) - Date.parse(b);
    const starts = runs.map((run) => run.startedAt!).sort(byInstant);
    const ends = runs.map((run) => run.completedAt!).sort(byInstant);
    return { startedAt: starts[0], completedAt: ends[ends.length - 1] };
}
