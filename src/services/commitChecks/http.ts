// Provider-agnostic HTTPS GET helper for commit-check providers. Generalizes the
// former GitHub-only `githubGetJson`: callers pass a full URL and request headers,
// and the helper resolves parsed JSON or rejects on non-2xx / timeout / bad body.
// Injecting this `FetchJson` boundary keeps provider mapping logic unit-testable
// without module mocking.

import { createHash } from "crypto";
import type * as http from "http";
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
     * @param url - The URL that answered, when a redirect may have moved it off the requested one.
     */
    constructor(
        readonly statusCode: number,
        message: string,
        readonly headers: Record<string, string | string[] | undefined>,
        readonly url?: string,
    ) {
        super(message);
        this.name = "HttpError";
    }
}

/**
 * A parsed 2xx response with its headers, for callers that page by `Link` or similar headers.
 * A conditional request answered 304 resolves with `statusCode` 304 and the stored body.
 */
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

/** Per-log download bound (owner decision O2): a longer log keeps its first 50 MB. */
export const CI_LOG_MAX_BYTES = 50 * 1024 * 1024;

/** Inactivity timeout of every request: `setTimeout` on a request measures socket idle time. */
const REQUEST_IDLE_TIMEOUT_MS = 15000;

/** Statuses `followRedirects` follows; any other 3xx is a final response. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Headers that carry credentials for every provider; stripped when a redirect changes origin. */
const CREDENTIAL_HEADERS = ["authorization", "cookie", "private-token", "job-token"];

/** Options of `followRedirects`. */
export interface RedirectOptions {
    /** Most redirects followed; one more is an error. */
    maxHops: number;
    /** Extra credential headers of the provider, stripped with the shared ones. */
    credentialHeaders?: readonly string[];
    /** Aborts the request in flight and rejects with an `AbortError`. */
    signal?: AbortSignal;
}

/** The final, non-redirect response of a redirect chain, with its body not yet read. */
export interface RedirectedResponse {
    response: http.IncomingMessage;
    request: http.ClientRequest;
    /** URL that answered with `response`. */
    url: string;
}

/** A downloaded text body and whether it was cut at the byte bound. */
export interface DownloadedText {
    text: string;
    truncated: boolean;
}

/**
 * GETs `url`, following 301/302/303/307/308 redirects to `https:` targets only.
 *
 * On any change of origin (scheme, host or port) the credential headers are removed and never
 * restored on a later hop, even when the chain returns to the first origin. More than `maxHops`
 * redirects, a non-HTTPS target or a redirect with no `Location` rejects.
 *
 * @param url - First URL; must be `https:`.
 * @param headers - Request headers, credentials included.
 * @param options - Hop limit, extra credential headers and abort signal.
 * @returns The final response, unread, with the request that carries it.
 */
export async function followRedirects(
    url: string,
    headers: Record<string, string>,
    options: RedirectOptions,
): Promise<RedirectedResponse> {
    let current = parseHttpsUrl(url);
    let sentHeaders = headers;
    for (let hops = 0; ; hops++) {
        const opened = await openResponse(current.href, sentHeaders, options.signal);
        const status = opened.response.statusCode ?? 0;
        if (!REDIRECT_STATUSES.has(status)) return { ...opened, url: current.href };
        opened.response.destroy();
        if (hops >= options.maxHops) throw new Error("Too many redirects");
        const location = opened.response.headers.location;
        if (!location) throw new Error("Redirect without a Location header");
        const next = parseHttpsUrl(new URL(location, current).href);
        if (next.origin !== current.origin) {
            sentHeaders = withoutCredentials(sentHeaders, options.credentialHeaders ?? []);
        }
        current = next;
    }
}

/**
 * Downloads a text body through `followRedirects` (at most 5 hops), keeping at most `maxBytes`.
 *
 * Bytes are counted as chunks arrive; at the bound the response is destroyed, the kept bytes are
 * cut back to a UTF-8 boundary and the truncation line is appended once. A larger announced
 * `Content-Length` is not refused. A non-2xx final status rejects as `HttpError` carrying the URL
 * that answered; a stream error,
 * a response that closes before it ends and an idle timeout reject; an abort rejects with an
 * `AbortError`.
 *
 * @param url - Download URL; must be `https:`.
 * @param headers - Request headers, credentials included.
 * @param maxBytes - Byte bound of the kept body.
 * @param signal - Aborts the download.
 * @param credentialHeaders - Extra credential headers of the provider for redirects.
 */
export async function downloadToString(
    url: string,
    headers: Record<string, string>,
    maxBytes: number,
    signal: AbortSignal,
    credentialHeaders?: readonly string[],
): Promise<DownloadedText> {
    const {
        response,
        request,
        url: answeredBy,
    } = await followRedirects(url, headers, {
        maxHops: 5,
        credentialHeaders,
        signal,
    });
    const status = response.statusCode ?? 0;
    if (status < 200 || status >= 300) {
        response.destroy();
        throw new HttpError(status, `HTTP ${status}`, response.headers, answeredBy);
    }
    return readBounded(response, request, maxBytes, signal);
}

/** Downloads one CI job log: a URL and its request headers in, the bounded text out. */
export type DownloadCiLog = (
    url: string,
    headers: Record<string, string>,
    signal: AbortSignal,
) => Promise<DownloadedText>;

/**
 * `downloadToString` at the per-log bound (O2), with the shared credential headers.
 *
 * @param url - Log URL; must be `https:`.
 * @param headers - Request headers, credentials included.
 * @param signal - Aborts the download.
 */
export const downloadCiLog: DownloadCiLog = (url, headers, signal) =>
    downloadToString(url, headers, CI_LOG_MAX_BYTES, signal);

/** One HTTPS GET resolved at its response head; the idle timeout stays armed for the body. */
function openResponse(
    url: string,
    headers: Record<string, string>,
    signal: AbortSignal | undefined,
): Promise<{ response: http.IncomingMessage; request: http.ClientRequest }> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(abortError());
            return;
        }
        const onAbort = () => request.destroy(abortError());
        const request = https.get(url, { headers }, (response) => {
            signal?.removeEventListener("abort", onAbort);
            resolve({ response, request });
        });
        request.on("error", (error) => {
            signal?.removeEventListener("abort", onAbort);
            reject(error);
        });
        // A 101 skips the response callback: with no `upgrade` listener Node destroys the socket
        // and emits only `close`, no error. Rejecting after a resolve is a no-op.
        request.on("close", () => {
            signal?.removeEventListener("abort", onAbort);
            reject(new Error("The log request closed before a response arrived"));
        });
        request.setTimeout(REQUEST_IDLE_TIMEOUT_MS, () => {
            request.destroy(new Error("HTTP request timed out"));
        });
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

/** Reads `response` into a string of at most `maxBytes` bytes plus the truncation line. */
function readBounded(
    response: http.IncomingMessage,
    request: http.ClientRequest,
    maxBytes: number,
    signal: AbortSignal,
): Promise<DownloadedText> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let settled = false;
        const settle = (outcome: () => void) => {
            if (settled) return;
            settled = true;
            signal.removeEventListener("abort", onAbort);
            request.setTimeout(0);
            outcome();
        };
        const fail = (error: Error) => settle(() => reject(error));
        const finish = (truncated: boolean) =>
            settle(() => {
                const kept = Buffer.concat(chunks);
                if (!truncated) {
                    resolve({ text: kept.toString("utf8"), truncated });
                    return;
                }
                const body = cutToUtf8Boundary(kept).toString("utf8");
                const separator = body.endsWith("\n") ? "" : "\n";
                resolve({ text: `${body}${separator}${truncationLine(maxBytes)}`, truncated });
            });
        function onAbort() {
            fail(abortError());
            response.destroy();
            request.destroy();
        }
        if (signal.aborted) {
            onAbort();
            return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
        // Reaching `maxBytes` always stops and marks the log (O2), whatever `Content-Length` says,
        // so a server that stalls after the bound cannot lose the kept bytes.
        response.on("data", (chunk: Buffer | string) => {
            if (settled) return;
            const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
            const room = maxBytes - size;
            if (bytes.length < room) {
                chunks.push(bytes);
                size += bytes.length;
                return;
            }
            chunks.push(bytes.subarray(0, room));
            size = maxBytes;
            finish(true);
            response.destroy();
        });
        response.on("end", () => finish(false));
        response.on("error", fail);
        request.on("error", fail);
        response.on("close", () => fail(new Error("The log download closed before it ended")));
    });
}

/**
 * The last line of a cut log. English on purpose: the transport has no `vscode` import, and the
 * line is part of the log text the user reads next to other English log output.
 */
function truncationLine(maxBytes: number): string {
    const megabytes = Math.round(maxBytes / (1024 * 1024));
    return `[IntelliGit: log truncated at ${megabytes} MB — open the run in the browser for the rest]`;
}

/** `bytes` without a trailing incomplete UTF-8 sequence. */
function cutToUtf8Boundary(bytes: Buffer): Buffer {
    // The last lead byte sits at most 3 bytes back; continuation bytes look like 10xxxxxx.
    for (let index = bytes.length - 1; index >= Math.max(0, bytes.length - 4); index--) {
        const byte = bytes[index];
        if ((byte & 0xc0) === 0x80) continue;
        const length = byte < 0x80 ? 1 : byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
        return index + length > bytes.length ? bytes.subarray(0, index) : bytes;
    }
    return bytes;
}

/** `url` parsed, or an error when it is not `https:`. */
function parseHttpsUrl(url: string): URL {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") throw new Error("Refusing a non-HTTPS URL");
    return parsed;
}

/** `headers` without the shared and the provider's credential headers, in any letter case. */
function withoutCredentials(
    headers: Record<string, string>,
    extra: readonly string[],
): Record<string, string> {
    const names = new Set([...CREDENTIAL_HEADERS, ...extra.map((name) => name.toLowerCase())]);
    return Object.fromEntries(
        Object.entries(headers).filter(([name]) => !names.has(name.toLowerCase())),
    );
}

function abortError(): Error {
    const error = new Error("The log download was aborted");
    error.name = "AbortError";
    return error;
}

/** Default provider-agnostic HTTPS JSON getter. */
export const httpGetJson = createHttpGetJson();

/** Default provider-agnostic HTTPS JSON getter that keeps response headers. */
export const httpGetJsonWithMeta = createHttpGetJsonWithMeta();
