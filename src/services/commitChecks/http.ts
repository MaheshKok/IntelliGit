// Provider-agnostic HTTPS GET helper for commit-check providers. Generalizes the
// former GitHub-only `githubGetJson`: callers pass a full URL and request headers,
// and the helper resolves parsed JSON or rejects on non-2xx / timeout / bad body.
// Injecting this `FetchJson` boundary keeps provider mapping logic unit-testable
// without module mocking.

import { createHash } from "crypto";
import * as https from "https";
import type { EtagStore } from "./etagStore";

/** Network boundary used by providers; the only thing tests mock. */
export type FetchJson = (url: string, headers: Record<string, string>) => Promise<unknown>;

/**
 * Token-free response facts exposed to rate-limit observers.
 *
 * Request headers are intentionally excluded because they can contain credentials. Consumers must
 * treat these server-supplied values as advisory scheduling data, never as trusted authorization.
 */
export interface HttpResponseMetadata {
    /** Full request URL, used only to scope provider rate-limit state by API origin. */
    readonly url: string;
    statusCode: number;
    headers: Record<string, string | string[] | undefined>;
}

/** HTTP failure that keeps response metadata needed for provider backoff. */
export class HttpError extends Error {
    /**
     * Builds an HTTP failure with response headers preserved for callers.
     *
     * @param statusCode - Numeric HTTP status code from the response.
     * @param message - Token-free display/error message.
     * @param headers - Lower-cased Node response headers.
     */
    constructor(
        readonly statusCode: number,
        message: string,
        readonly headers: Record<string, string | string[] | undefined>,
    ) {
        super(message);
        this.name = "HttpError";
    }
}

/** A parsed 2xx response with its headers, for callers that page by `Link` or similar headers. */
export interface FetchResponse {
    statusCode: number;
    headers: Record<string, string | string[] | undefined>;
    body: unknown;
}

/**
 * Network boundary for callers that need response headers; same rejection rules as `FetchJson`.
 * With `conditional`, the request names the stored `ETag` and a 304 resolves to the stored body.
 */
export type FetchJsonWithMeta = (
    url: string,
    headers: Record<string, string>,
    conditional?: EtagStore,
) => Promise<FetchResponse>;

/** Headers that carry the next page; a 304 may omit them, so they are stored with the body. */
const PAGINATION_HEADERS = ["link", "x-next-page"] as const;

interface RawResponse {
    statusCode: number;
    headers: Record<string, string | string[] | undefined>;
    data: string;
}

/**
 * Creates an HTTPS JSON getter with an optional response observer.
 *
 * The observer receives only response metadata after the response ends and before status/JSON
 * handling. Observer failures are ignored so quota telemetry cannot interrupt provider IO.
 */
export function createHttpGetJson(
    onResponse?: (metadata: HttpResponseMetadata) => void,
): FetchJson {
    const request = createHttpGetJsonWithMeta(onResponse);
    return async (url, headers) => (await request(url, headers)).body;
}

/**
 * Creates an HTTPS JSON getter that also returns the status and response headers.
 *
 * Shares the request core, observer, timeout and rejection rules of `createHttpGetJson`. The
 * observer sees every response, a 304 included, so the request gate reads its quota headers.
 */
export function createHttpGetJsonWithMeta(
    onResponse?: (metadata: HttpResponseMetadata) => void,
): FetchJsonWithMeta {
    return recoverBodylessNotModified(createConditionalRequest(onResponse));
}

/**
 * One metadata request. With `revalidate` false it names no etag at all, and a 304 rejects as
 * `HttpError`; with `revalidate` true a 304 no stored body stands for rejects as
 * `BodylessNotModifiedError`, for `recoverBodylessNotModified` to ask again.
 */
type ConditionalRequest = (
    url: string,
    headers: Record<string, string>,
    conditional?: EtagStore,
    revalidate?: boolean,
) => Promise<FetchResponse>;

/** A 304 to a request no stored body stands for; it is asked again without `If-None-Match`. */
class BodylessNotModifiedError extends Error {}

/**
 * Turns a body-less 304 into one more request without `If-None-Match`, made through `request`
 * as a request of its own, so a gate admits and counts it like any other.
 */
export function recoverBodylessNotModified(request: ConditionalRequest): FetchJsonWithMeta {
    return async (url, headers, conditional) => {
        try {
            return await request(url, headers, conditional, true);
        } catch (error) {
            if (!(error instanceof BodylessNotModifiedError)) throw error;
            return request(url, headers, conditional, false);
        }
    };
}

/** Creates the single-request core of `createHttpGetJsonWithMeta`. */
export function createConditionalRequest(
    onResponse?: (metadata: HttpResponseMetadata) => void,
): ConditionalRequest {
    return async (url, headers, conditional, revalidate = true) => {
        // The entry also records which request headers (the token among them) read its body, so
        // a body is only ever reused for the same credentials, whichever window changed them.
        const unconditional = withoutIfNoneMatch(headers);
        const requestHash = headersHash(unconditional);
        const key = conditional?.keyFor(url);
        const entry = revalidate && key !== undefined ? conditional?.get(key) : undefined;
        const stored = entry?.requestHash === requestHash ? entry : undefined;
        const sentHeaders = stored
            ? { ...unconditional, "If-None-Match": stored.etag }
            : revalidate
              ? headers
              : unconditional;
        const response = await send(url, sentHeaders, onResponse);
        if (response.statusCode === 304 && conditional && key !== undefined) {
            if (stored) {
                return {
                    statusCode: 304,
                    headers: withPagination(response.headers, stored.pagination),
                    body: parseJson(stored.body),
                };
            }
            if (revalidate) throw new BodylessNotModifiedError("HTTP 304 without a stored body");
        }
        return toFetchResponse(response, conditional, key, requestHash);
    };
}

/** `headers` without any `If-None-Match`, whatever its case. */
function withoutIfNoneMatch(headers: Record<string, string>): Record<string, string> {
    return Object.fromEntries(
        Object.entries(headers).filter(([name]) => name.toLowerCase() !== "if-none-match"),
    );
}

/** A digest of the request headers, so the store keeps no token. */
function headersHash(headers: Record<string, string>): string {
    const entries = Object.entries(headers)
        .map(([name, value]) => [name.toLowerCase(), value])
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

/** One HTTPS GET; the observer sees the response before its status is judged. */
function send(
    url: string,
    headers: Record<string, string>,
    onResponse?: (metadata: HttpResponseMetadata) => void,
): Promise<RawResponse> {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers }, (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer | string) => {
                chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
            });
            res.on("end", () => {
                req.setTimeout(0);
                const statusCode = res.statusCode ?? 0;
                try {
                    onResponse?.({ url, statusCode, headers: res.headers });
                } catch {
                    // Observers are non-critical quota telemetry.
                }
                resolve({
                    statusCode,
                    headers: res.headers,
                    data: Buffer.concat(chunks).toString("utf8"),
                });
            });
        });
        req.on("error", reject);
        req.setTimeout(15000, () => {
            req.destroy(new Error("HTTP request timed out"));
        });
    });
}

/**
 * Rejects a non-2xx response as `HttpError` and parses a 2xx body; with `conditional`, a 2xx
 * carrying an `ETag` is stored under `key` with its pagination headers.
 */
function toFetchResponse(
    response: RawResponse,
    conditional: EtagStore | undefined,
    key: string | undefined,
    requestHash: string,
): FetchResponse {
    const { statusCode, headers, data } = response;
    if (statusCode < 200 || statusCode >= 300) {
        throw new HttpError(statusCode, `HTTP ${statusCode}: ${data.slice(0, 200)}`, headers);
    }
    const body = parseJson(data);
    const etag = headers.etag;
    if (conditional && key !== undefined && typeof etag === "string" && etag) {
        const pagination: Record<string, string | string[]> = {};
        for (const name of PAGINATION_HEADERS) {
            const value = headers[name];
            if (value !== undefined) pagination[name] = value;
        }
        conditional.set(key, { etag, body: data, pagination, requestHash });
    }
    return { statusCode, headers, body };
}

function parseJson(data: string): unknown {
    try {
        return data ? JSON.parse(data) : {};
    } catch {
        throw new Error("Invalid JSON response");
    }
}

/** A 304's own headers with its pagination headers replaced by the stored ones. */
function withPagination(
    headers: Record<string, string | string[] | undefined>,
    pagination: Readonly<Record<string, string | string[]>>,
): Record<string, string | string[] | undefined> {
    const merged = { ...headers };
    for (const name of PAGINATION_HEADERS) delete merged[name];
    return { ...merged, ...pagination };
}

/** Default provider-agnostic HTTPS JSON getter. */
export const httpGetJson = createHttpGetJson();

/** Default provider-agnostic HTTPS JSON getter that keeps response headers. */
export const httpGetJsonWithMeta = createHttpGetJsonWithMeta();
