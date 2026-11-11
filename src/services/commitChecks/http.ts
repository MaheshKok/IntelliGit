// Provider-agnostic HTTPS GET helper for commit-check providers. Generalizes the
// former GitHub-only `githubGetJson`: callers pass a full URL and request headers,
// and the helper resolves parsed JSON or rejects on non-2xx / timeout / bad body.
// Injecting this `FetchJson` boundary keeps provider mapping logic unit-testable
// without module mocking.

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
    return async (url, headers, conditional) => {
        // Taken when the request is sent: a 304 answers the etag sent, and a 200 is stored
        // under the auth generation whose token read it.
        const key = conditional?.keyFor(url);
        const stored = key === undefined ? undefined : conditional?.get(key);
        const sentHeaders = stored ? { ...headers, "If-None-Match": stored.etag } : headers;
        const response = await send(url, sentHeaders, onResponse);
        if (response.statusCode === 304 && conditional && key !== undefined) {
            if (stored) {
                return {
                    statusCode: 304,
                    headers: withPagination(response.headers, stored.pagination),
                    body: parseJson(stored.body),
                };
            }
            // A 304 to a request that named no etag has no body to stand for: ask once more.
            return toFetchResponse(await send(url, headers, onResponse), conditional, key);
        }
        return toFetchResponse(response, conditional, key);
    };
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
    conditional?: EtagStore,
    key?: string,
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
        conditional.set(key, { etag, body: data, pagination });
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
