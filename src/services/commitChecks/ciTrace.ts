// Token-free diagnostic trace for CI operations, written to the "IntelliGit CI" log
// channel. It is for troubleshooting caches and requests, never a place for CI logs:
// only the whitelisted fields below are written, the repository key is written as a
// short hash, URLs keep only their origin, and nothing that could hold a token, a
// header, log text or an excerpt is accepted.

import { createHash, randomUUID } from "node:crypto";

/**
 * Outcome of one traced CI operation.
 *
 * @public consumed by later CI tab phases.
 */
export type CiTraceOutcome =
    | "hit-l1"
    | "hit-l2"
    | "fetched"
    | "incomplete"
    | "discarded-generation"
    | "cooldown"
    | "paused"
    | "uncertain-write"
    | "next-rejected"
    | "claim-exists"
    | "fenced"
    | "failed";

const CI_TRACE_REASONS = [
    "auth",
    "forbidden",
    "not-found",
    "rate-limited",
    "http-error",
    "network",
    "timeout",
    "bad-response",
    "redirect-refused",
    "storage",
] as const;

/**
 * Why a traced operation failed. Only these codes are written; free text (an error
 * message that might echo a token) is written as `other`.
 *
 * @public consumed by later CI tab phases.
 */
export type CiTraceReason = (typeof CI_TRACE_REASONS)[number];

const KNOWN_REASONS: ReadonlySet<string> = new Set(CI_TRACE_REASONS);

/** One traced CI operation. */
export interface CiTraceEvent {
    kind:
        | "detail"
        | "snapshot"
        | "scan"
        | "log"
        | "preview"
        | "action"
        | "fence"
        | "annotations"
        | "monitor"
        | "claim"
        | "history"
        | "bisect";
    outcome: CiTraceOutcome;
    /** Repository key; written as the first 12 hex characters of its SHA-256. */
    repoKey?: string;
    provider?: string;
    /** Full or short commit hash; written as 7 characters. */
    hash?: string;
    /** Request URL; written as its origin only, since a path can carry a token. */
    url?: string;
    /** Failure reason code; any other value is written as `other`. */
    reason?: CiTraceReason;
    /** HTTP status code. */
    status?: number;
    ms?: number;
}

/** The part of a VS Code `LogOutputChannel` the trace writes to. */
export interface CiTraceChannel {
    trace(message: string): void;
    info(message: string): void;
    warn(message: string): void;
}

/** Writes one trace event; never throws. */
export type CiTrace = (event: CiTraceEvent) => void;

const WARN_OUTCOMES: ReadonlySet<CiTraceOutcome> = new Set([
    "discarded-generation",
    "next-rejected",
    "uncertain-write",
]);

/**
 * Formats one event as a single `key=value` line from whitelisted fields only.
 *
 * @param event - The operation to describe.
 * @param op - Short id of the operation.
 */
export function formatCiTraceLine(event: CiTraceEvent, op: string): string {
    const fields: [string, string | number | undefined][] = [
        ["op", op],
        ["kind", event.kind],
        ["outcome", event.outcome],
        ["repoKey", event.repoKey === undefined ? undefined : shortHash(event.repoKey)],
        ["provider", event.provider],
        ["hash", event.hash?.slice(0, 7)],
        ["url", event.url === undefined ? undefined : originOf(event.url)],
        ["status", event.status],
        ["ms", event.ms],
        [
            "reason",
            event.reason === undefined
                ? undefined
                : KNOWN_REASONS.has(event.reason)
                  ? event.reason
                  : "other",
        ],
    ];
    return fields
        .filter((field): field is [string, string | number] => field[1] !== undefined)
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(" ");
}

/**
 * Builds the trace writer. The channel is created on first use, so a window that never
 * runs a CI operation gets no extra output channel.
 *
 * @param getChannel - Creates or returns the log channel.
 */
export function createCiTrace(getChannel: () => CiTraceChannel): CiTrace {
    let channel: CiTraceChannel | undefined;
    return (event) => {
        try {
            channel ??= getChannel();
            const line = formatCiTraceLine(event, randomUUID().slice(0, 8));
            if (event.outcome === "hit-l1" || event.outcome === "hit-l2") channel.trace(line);
            else if (WARN_OUTCOMES.has(event.outcome)) channel.warn(line);
            else channel.info(line);
        } catch {
            // A trace must never break the feature it describes.
        }
    };
}

/** Drops credentials, path, query and fragment; keeps the origin. */
function originOf(url: string): string {
    try {
        return new URL(url).origin;
    } catch {
        return "[invalid url]";
    }
}

/** Stable, token-free id for a repository key, so trace lines still correlate. */
function shortHash(value: string): string {
    return createHash("sha256").update(value).digest("hex").slice(0, 12);
}
