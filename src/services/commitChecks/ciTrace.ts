// Token-free diagnostic trace for CI operations, written to the "IntelliGit CI" log
// channel. It is for troubleshooting caches and requests, never a place for CI logs:
// only the whitelisted fields below are written, URLs lose their query and fragment,
// and nothing that could hold a token, a header, log text or an excerpt is accepted.

import { randomUUID } from "node:crypto";

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
    repoKey?: string;
    provider?: string;
    /** Full or short commit hash; written as 7 characters. */
    hash?: string;
    /** Request URL; written as origin and path only. */
    url?: string;
    /** Display-safe reason; any URL inside it is written as origin and path only. */
    reason?: string;
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
        ["repoKey", event.repoKey],
        ["provider", event.provider],
        ["hash", event.hash?.slice(0, 7)],
        ["url", event.url === undefined ? undefined : originAndPath(event.url)],
        ["status", event.status],
        ["ms", event.ms],
        ["reason", event.reason?.replace(/https?:\/\/[^\s"'<>]+/g, originAndPath)],
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

/** Drops credentials, query and fragment; keeps origin and path. */
function originAndPath(url: string): string {
    try {
        const parsed = new URL(url);
        return `${parsed.origin}${parsed.pathname}`;
    } catch {
        return "[invalid url]";
    }
}
