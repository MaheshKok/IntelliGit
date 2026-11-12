import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import * as https from "https";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock specifier must match the source import ("https", not "node:https").
vi.mock("https");

import {
    CiLogMemoryStore,
    ciLogKey,
    MAX_CI_LOGS_IN_MEMORY,
    type CiLogSource,
} from "../../../../src/services/commitChecks/ciLogMemoryStore";
import {
    CI_LOG_MAX_BYTES,
    downloadToString,
    HttpError,
    type DownloadedText,
} from "../../../../src/services/commitChecks/http";
import { CI_EXCERPT_MAX_BYTES, CI_EXCERPT_MAX_LINES } from "../../../../src/shared/ci/excerpt";

const MB = 1024 * 1024;
const MARKER = "[IntelliGit: log truncated at 50 MB — open the run in the browser for the rest]";

function sourceFor(jobId: string): CiLogSource {
    return { repoKey: "repo", provider: "github", runId: "run-1", jobId, attempt: 1 };
}

function keyFor(jobId: string): string {
    return ciLogKey("github:o/r", "run-1", jobId, 1);
}

interface Deferred {
    resolve(value: DownloadedText): void;
    reject(error: unknown): void;
    signal: AbortSignal;
}

/** A fake transport: each call waits until the test settles it. */
function manualTransport() {
    const calls: { source: CiLogSource; deferred: Deferred }[] = [];
    const download = vi.fn(
        (source: CiLogSource, signal: AbortSignal) =>
            new Promise<DownloadedText>((resolvePromise, rejectPromise) => {
                calls.push({
                    source,
                    deferred: { resolve: resolvePromise, reject: rejectPromise, signal },
                });
            }),
    );
    return { calls, download };
}

/** A fake transport that answers at once with `<jobId> log #<n>`. */
function instantTransport() {
    let count = 0;
    return vi.fn(async (source: CiLogSource) => ({
        text: `${source.jobId} log #${++count}`,
        truncated: false,
    }));
}

describe("ciLogKey", () => {
    it("is 64 hex characters and differs per attempt", () => {
        const first = ciLogKey("github:o/r", "run-1", "job-1", 1);
        expect(first).toMatch(/^[0-9a-f]{64}$/);
        expect(ciLogKey("github:o/r", "run-1", "job-1", 2)).not.toBe(first);
        expect(ciLogKey("github:o/r", "run-1", "job-1", 1)).toBe(first);
    });

    it("differs when any one part differs, and the separator tells shifted parts apart", () => {
        const base = ciLogKey("github:o/r", "run-1", "job-1", 1);
        expect(ciLogKey("gitlab:o/r", "run-1", "job-1", 1), "providerKey").not.toBe(base);
        expect(ciLogKey("github:o/r", "run-2", "job-1", 1), "runId").not.toBe(base);
        expect(ciLogKey("github:o/r", "run-1", "job-2", 1), "jobId").not.toBe(base);
        expect(ciLogKey("github:o/r", "run-1", "job-1", undefined), "attempt").not.toBe(base);
        expect(ciLogKey("a", "bc", "j", 1), "providerKey|runId shift").not.toBe(
            ciLogKey("ab", "c", "j", 1),
        );
        expect(ciLogKey("p", "a", "bc", 1), "runId|jobId shift").not.toBe(
            ciLogKey("p", "ab", "c", 1),
        );
        expect(ciLogKey("p", "r", "j1", undefined), "jobId|attempt shift").not.toBe(
            ciLogKey("p", "r", "j", 1),
        );
    });
});

describe("CiLogMemoryStore", () => {
    it("holds at most three logs", () => {
        expect(MAX_CI_LOGS_IN_MEMORY).toBe(3);
    });

    it("LRU evicts the least-recent of 4", async () => {
        const store = new CiLogMemoryStore({ download: instantTransport() });
        for (const job of ["a", "b", "c"]) await store.load(keyFor(job), sourceFor(job));
        // Reading "a" makes "b" the least recent.
        expect(store.get(keyFor("a"))?.text).toBe("a log #1");
        await store.load(keyFor("d"), sourceFor("d"));
        expect(store.get(keyFor("b"))).toBeUndefined();
        expect(store.get(keyFor("a"))?.text).toBe("a log #1");
        expect(store.get(keyFor("c"))?.text).toBe("c log #3");
        expect(store.get(keyFor("d"))?.text).toBe("d log #4");
    });

    it("two concurrent opens make one request", async () => {
        const { calls, download } = manualTransport();
        const store = new CiLogMemoryStore({ download });
        const first = store.load(keyFor("a"), sourceFor("a"));
        const second = store.load(keyFor("a"), sourceFor("a"));
        expect(download).toHaveBeenCalledTimes(1);
        calls[0].deferred.resolve({ text: "the log", truncated: false });
        const [one, two] = await Promise.all([first, second]);
        expect(one).toBe(two);
        expect(one.text).toBe("the log");
        // A third open after the download is a hit.
        await store.load(keyFor("a"), sourceFor("a"));
        expect(download).toHaveBeenCalledTimes(1);
    });

    it("a reopened evicted log triggers a new download", async () => {
        const download = instantTransport();
        const store = new CiLogMemoryStore({ download });
        for (const job of ["a", "b", "c", "d"]) await store.load(keyFor(job), sourceFor(job));
        expect(store.get(keyFor("a"))).toBeUndefined();
        const reopened = await store.load(keyFor("a"), sourceFor("a"));
        expect(reopened.text).toBe("a log #5");
        expect(download.mock.calls.filter(([source]) => source.jobId === "a")).toHaveLength(2);
    });

    it("keeps the source of an evicted log so it can be downloaded again", async () => {
        const store = new CiLogMemoryStore({ download: instantTransport() });
        for (const job of ["a", "b", "c", "d"]) await store.load(keyFor(job), sourceFor(job));
        expect(store.get(keyFor("a"))).toBeUndefined();
        expect(store.sourceOf(keyFor("a"))).toEqual(sourceFor("a"));
        expect(store.sourceOf(keyFor("never"))).toBeUndefined();
    });

    it("30 MB log is stored and only the excerpt is returned", async () => {
        const lines = Array.from(
            { length: (30 * MB) / 64 },
            (_, index) => `${String(index).padStart(10, "0")} ${"x".repeat(52)}`,
        );
        lines[200_000] = "##[error]the build broke here";
        const text = lines.join("\n");
        expect(text.length).toBeGreaterThan(30 * MB - 100);
        const store = new CiLogMemoryStore({
            download: async () => ({ text, truncated: false }),
            errorRules: () => ({ patterns: [/##\[error\]/] }),
        });
        const preview = await store.preview(keyFor("a"), sourceFor("a"));
        expect(store.get(keyFor("a"))?.text.length).toBe(text.length);
        expect(store.get(keyFor("a"))?.firstErrorLine).toBe(200_000);
        expect(preview.firstErrorLine).toBe(200_000);
        expect(preview.truncated).toBe(false);
        expect(preview.excerpt).toContain("##[error]the build broke here");
        expect(Buffer.byteLength(preview.excerpt, "utf8")).toBeLessThanOrEqual(
            CI_EXCERPT_MAX_BYTES,
        );
        expect(preview.excerpt.split("\n").length).toBeLessThanOrEqual(CI_EXCERPT_MAX_LINES);
        expect(Object.keys(preview).sort()).toEqual(["excerpt", "firstErrorLine", "truncated"]);
    });

    it("stream error stores nothing and rejects every waiter", async () => {
        const { calls, download } = manualTransport();
        const store = new CiLogMemoryStore({ download });
        const first = store.load(keyFor("a"), sourceFor("a"));
        const second = store.load(keyFor("a"), sourceFor("a"));
        const failure = new Error("socket hang up");
        calls[0].deferred.reject(failure);
        await expect(first).rejects.toBe(failure);
        await expect(second).rejects.toBe(failure);
        expect(store.get(keyFor("a"))).toBeUndefined();
        // The next click retries.
        const retry = store.load(keyFor("a"), sourceFor("a"));
        expect(download).toHaveBeenCalledTimes(2);
        calls[1].deferred.resolve({ text: "ok", truncated: false });
        await expect(retry).resolves.toMatchObject({ text: "ok" });
    });

    it("clear() empties the store and aborts in-flight downloads", async () => {
        const { calls, download } = manualTransport();
        const store = new CiLogMemoryStore({ download });
        const done = store.load(keyFor("a"), sourceFor("a"));
        calls[0].deferred.resolve({ text: "kept until clear", truncated: false });
        await done;
        const pending = store.load(keyFor("b"), sourceFor("b"));
        const loaded = vi.fn();
        store.onDidLoad(loaded);
        store.clear();
        expect(calls[1].deferred.signal.aborted).toBe(true);
        expect(store.get(keyFor("a"))).toBeUndefined();
        // A transport that ignores the abort and answers anyway is dropped by the generation.
        calls[1].deferred.resolve({ text: "late", truncated: false });
        await expect(pending).rejects.toThrow(/abort/i);
        expect(store.get(keyFor("b"))).toBeUndefined();
        expect(loaded).not.toHaveBeenCalled();
        // After clear() the same key downloads fresh.
        const again = store.load(keyFor("b"), sourceFor("b"));
        expect(download).toHaveBeenCalledTimes(3);
        calls[2].deferred.resolve({ text: "fresh", truncated: false });
        await expect(again).resolves.toMatchObject({ text: "fresh" });
    });

    it.each([
        ["rejects with an abort error", "reject"],
        ["resolves anyway", "resolve"],
    ] as const)(
        "stale download settling after clear() does not drop the new in-flight download (stale %s)",
        async (_label, settle) => {
            const { calls, download } = manualTransport();
            const store = new CiLogMemoryStore({ download });
            const stale = store.load(keyFor("b"), sourceFor("b"));
            store.clear();
            const second = store.load(keyFor("b"), sourceFor("b"));
            expect(download).toHaveBeenCalledTimes(2);
            if (settle === "reject") {
                const abort = new Error("aborted");
                abort.name = "AbortError";
                calls[0].deferred.reject(abort);
            } else {
                calls[0].deferred.resolve({ text: "late", truncated: false });
            }
            await expect(stale).rejects.toThrow(/abort/i);
            const third = store.load(keyFor("b"), sourceFor("b"));
            expect(
                download,
                "the third request must join the second download",
            ).toHaveBeenCalledTimes(2);
            calls[1].deferred.resolve({ text: "fresh", truncated: false });
            const [two, three] = await Promise.all([second, third]);
            expect(two.text).toBe("fresh");
            expect(three).toBe(two);
        },
    );

    it("a waiter whose signal is already aborted rejects while the others still get the log", async () => {
        const { calls, download } = manualTransport();
        const store = new CiLogMemoryStore({ download });
        const kept = store.load(keyFor("a"), sourceFor("a"));
        const controller = new AbortController();
        controller.abort();
        const cancelled = store.load(keyFor("a"), sourceFor("a"), controller.signal);
        expect(download).toHaveBeenCalledTimes(1);
        // Settle first, so a waiter that wrongly joins resolves instead of hanging.
        calls[0].deferred.resolve({ text: "landed", truncated: false });
        await expect(cancelled, "a pre-aborted waiter must reject").rejects.toThrow(/abort/i);
        await expect(kept).resolves.toMatchObject({ text: "landed" });
    });

    it("cancelling one waiter keeps the shared download for the others", async () => {
        const { calls, download } = manualTransport();
        const store = new CiLogMemoryStore({ download });
        const controller = new AbortController();
        const cancelled = store.load(keyFor("a"), sourceFor("a"), controller.signal);
        const kept = store.load(keyFor("a"), sourceFor("a"));
        controller.abort();
        await expect(cancelled).rejects.toThrow(/abort/i);
        expect(calls[0].deferred.signal.aborted).toBe(false);
        calls[0].deferred.resolve({ text: "landed", truncated: false });
        await expect(kept).resolves.toMatchObject({ text: "landed" });
        expect(store.get(keyFor("a"))?.text).toBe("landed");
    });

    it("tells listeners which key loaded", async () => {
        const store = new CiLogMemoryStore({ download: instantTransport() });
        const loaded = vi.fn();
        const subscription = store.onDidLoad(loaded);
        await store.load(keyFor("a"), sourceFor("a"));
        expect(loaded).toHaveBeenCalledWith(keyFor("a"));
        subscription.dispose();
        await store.load(keyFor("b"), sourceFor("b"));
        expect(loaded).toHaveBeenCalledTimes(1);
    });

    it("a load listener that calls clear() never hands the cleared log back to the waiter", async () => {
        const { calls, download } = manualTransport();
        const store = new CiLogMemoryStore({ download });
        store.onDidLoad(() => store.clear());
        const pending = store.load(keyFor("a"), sourceFor("a"));
        calls[0].deferred.resolve({ text: "cleared by the listener", truncated: false });
        await expect(
            pending,
            "the pending load must reject once a listener cleared the store",
        ).rejects.toThrow(/abort/i);
        expect(store.get(keyFor("a"))).toBeUndefined();
    });

    it("store module imports no fs", () => {
        const source = readFileSync(
            resolve(__dirname, "../../../../src/services/commitChecks/ciLogMemoryStore.ts"),
            "utf8",
        );
        const specifiers = [
            ...source.matchAll(/\bfrom\s+["']([^"']+)["']/g),
            ...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g),
            ...source.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g),
            ...source.matchAll(/^\s*import\s+["']([^"']+)["']/gm),
        ].map((match) => match[1]);
        expect(specifiers.length).toBeGreaterThan(0);
        const fsLike = specifiers.filter((specifier) =>
            /^(node:)?(fs|fs\/promises|original-fs)$/.test(specifier),
        );
        expect(fsLike).toEqual([]);
    });
});

// --- downloadToString over a fake HTTPS response -----------------------------------------

interface StreamPlan {
    status?: number;
    headers?: Record<string, string>;
    chunks: (index: number) => Buffer | undefined;
    errorAfter?: number;
    /** Emits `close` with no `end` before chunk `closeAfter`, as a dropped connection does. */
    closeAfter?: number;
    /** Yields to timers between chunks, so a test can act mid-body. */
    slow?: boolean;
    /** Never answers, as a server that accepted the connection and hangs before the head. */
    noHead?: boolean;
    /** Sends nothing more from chunk `stallAfter` on, as a server that hangs mid-body. */
    stallAfter?: number;
}

/** Streams `plan.chunks(i)` until it returns undefined, the response is destroyed, or an error. */
function stubStream(plan: StreamPlan) {
    const state = {
        destroyed: false,
        emitted: 0,
        requestDestroyed: false,
        timeouts: [] as [number, (() => void) | undefined][],
    };
    vi.mocked(https.get).mockImplementation(((
        _url: string,
        _options: unknown,
        cb: (r: unknown) => void,
    ) => {
        const req = Object.assign(new EventEmitter(), {
            setTimeout: vi.fn((ms: number, callback?: () => void) => {
                state.timeouts.push([ms, callback]);
                return req;
            }),
            destroy: vi.fn((error?: Error) => {
                state.requestDestroyed = true;
                if (error) queueMicrotask(() => req.emit("error", error));
                return req;
            }),
        });
        const res = Object.assign(new EventEmitter(), {
            statusCode: plan.status ?? 200,
            headers: plan.headers ?? {},
            resume: vi.fn(),
            destroy: vi.fn(() => {
                state.destroyed = true;
                queueMicrotask(() => res.emit("close"));
            }),
        });
        if (plan.noHead) return req;
        queueMicrotask(() => {
            cb(res);
            void (async () => {
                // A real response is paused until a `data` listener attaches; start after that.
                await new Promise((r) => setTimeout(r, 0));
                for (let index = 0; ; index++) {
                    await (plan.slow ? new Promise((r) => setTimeout(r, 0)) : Promise.resolve());
                    if (state.destroyed || state.requestDestroyed) return;
                    if (plan.errorAfter !== undefined && index === plan.errorAfter) {
                        res.emit("error", new Error("ECONNRESET"));
                        return;
                    }
                    if (plan.closeAfter !== undefined && index === plan.closeAfter) {
                        res.emit("close");
                        return;
                    }
                    if (plan.stallAfter !== undefined && index === plan.stallAfter) return;
                    const chunk = plan.chunks(index);
                    if (!chunk) {
                        res.emit("end");
                        res.emit("close");
                        return;
                    }
                    state.emitted++;
                    res.emit("data", chunk);
                }
            })();
        });
        return req;
    }) as unknown as typeof https.get);
    return state;
}

function countMarkers(text: string): number {
    return text.split(MARKER).length - 1;
}

describe("downloadToString", () => {
    beforeEach(() => {
        vi.mocked(https.get).mockReset();
    });

    it("bounds a CI log at 50 MB", () => {
        expect(CI_LOG_MAX_BYTES).toBe(50 * MB);
    });

    it("known-length 300 MB response truncates at 50 MB with one marker", async () => {
        const chunk = Buffer.alloc(MB, "a");
        const state = stubStream({
            headers: { "content-length": "314572800" },
            chunks: (index) => (index < 300 ? chunk : undefined),
        });
        const result = await downloadToString(
            "https://logs.example.com/job",
            {},
            CI_LOG_MAX_BYTES,
            new AbortController().signal,
        );
        expect(result.truncated).toBe(true);
        expect(countMarkers(result.text)).toBe(1);
        expect(result.text.length).toBe(CI_LOG_MAX_BYTES + 1 + MARKER.length);
        expect(result.text.endsWith(`a\n${MARKER}`)).toBe(true);
        expect(state.destroyed).toBe(true);
        expect(state.emitted).toBeLessThan(300);
    });

    it("unknown-length stream truncates at 50 MB with one marker", async () => {
        const chunk = Buffer.alloc(700_001, "b");
        const state = stubStream({ chunks: (index) => (index < 200 ? chunk : undefined) });
        const result = await downloadToString(
            "https://logs.example.com/job",
            {},
            CI_LOG_MAX_BYTES,
            new AbortController().signal,
        );
        expect(result.truncated).toBe(true);
        expect(countMarkers(result.text)).toBe(1);
        expect(result.text.length).toBe(CI_LOG_MAX_BYTES + 1 + MARKER.length);
        expect(state.destroyed).toBe(true);
    });

    it("a log under the bound is returned whole with no marker", async () => {
        const parts = [Buffer.from("line 1\nli"), Buffer.from("ne 2\n")];
        stubStream({ chunks: (index) => parts[index] });
        const result = await downloadToString(
            "https://logs.example.com/job",
            {},
            CI_LOG_MAX_BYTES,
            new AbortController().signal,
        );
        expect(result).toEqual({ text: "line 1\nline 2\n", truncated: false });
    });

    // A 10-byte bound against an ASCII prefix plus one multi-byte character: é is 2 bytes,
    // € is 3 (E2 82 AC), 😀 is 4 (F0 9F 98 80).
    it.each([
        ["a 2-byte character cut after 1 byte", "abcdefghi", "é", "abcdefghi"],
        ["a 3-byte character cut after 1 byte", "abcdefghi", "€", "abcdefghi"],
        ["a 3-byte character cut after 2 bytes", "abcdefgh", "€", "abcdefgh"],
        ["a 4-byte character cut after 1 byte", "abcdefghi", "😀", "abcdefghi"],
        ["a 4-byte character cut after 2 bytes", "abcdefgh", "😀", "abcdefgh"],
        ["a 4-byte character cut after 3 bytes", "abcdefg", "😀", "abcdefg"],
        ["a 3-byte character ending exactly at the bound (kept)", "abcdefg", "€", "abcdefg€"],
        ["a 4-byte character ending exactly at the bound (kept)", "abcdef", "😀", "abcdef😀"],
    ])("UTF-8 boundary: %s", async (_label, prefix, character, kept) => {
        stubStream({
            chunks: (index) =>
                index === 0 ? Buffer.from(`${prefix}${character} tail`) : undefined,
        });
        const result = await downloadToString(
            "https://logs.example.com/job",
            {},
            10,
            new AbortController().signal,
        );
        expect(result.truncated).toBe(true);
        const beforeMarker = result.text.slice(
            0,
            result.text.indexOf("[IntelliGit: log truncated"),
        );
        expect(beforeMarker).toBe(`${kept}\n`);
        expect(result.text).not.toContain("�");
    });

    it("rejects a stream error and never returns partial text", async () => {
        stubStream({ chunks: () => Buffer.from("partial "), errorAfter: 3 });
        await expect(
            downloadToString(
                "https://logs.example.com/job",
                {},
                CI_LOG_MAX_BYTES,
                new AbortController().signal,
            ),
        ).rejects.toThrow("ECONNRESET");
    });

    it("rejects a response that closes before it ends", async () => {
        stubStream({ chunks: () => Buffer.from("partial "), closeAfter: 3 });
        await expect(
            downloadToString(
                "https://logs.example.com/job",
                {},
                CI_LOG_MAX_BYTES,
                new AbortController().signal,
            ),
        ).rejects.toThrow(/before it ended/i);
    });

    it("a non-2xx status rejects as HttpError with its status", async () => {
        stubStream({ status: 403, chunks: () => undefined });
        const error = await downloadToString(
            "https://logs.example.com/job",
            { Authorization: "Bearer s" },
            CI_LOG_MAX_BYTES,
            new AbortController().signal,
        ).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(HttpError);
        expect((error as HttpError).statusCode).toBe(403);
    });

    it("an abort mid-body rejects with an abort error and destroys the response", async () => {
        const controller = new AbortController();
        const state = stubStream({ chunks: () => Buffer.from("more "), slow: true });
        const pending = downloadToString(
            "https://logs.example.com/job",
            {},
            CI_LOG_MAX_BYTES,
            controller.signal,
        );
        // Wait for body bytes, not a fixed delay: a loaded machine may emit nothing within 5 ms.
        await vi.waitFor(() => expect(state.emitted).toBeGreaterThan(0));
        controller.abort();
        await expect(pending).rejects.toMatchObject({ name: "AbortError" });
        expect(state.destroyed).toBe(true);
    });

    it("an abort before the response head rejects and destroys the request", async () => {
        const controller = new AbortController();
        const state = stubStream({ chunks: () => undefined, noHead: true });
        const pending = downloadToString(
            "https://logs.example.com/job",
            {},
            CI_LOG_MAX_BYTES,
            controller.signal,
        );
        await vi.waitFor(() => expect(https.get).toHaveBeenCalledTimes(1));
        controller.abort();
        await expect(pending).rejects.toMatchObject({ name: "AbortError" });
        expect(state.requestDestroyed).toBe(true);
    });

    it.each([
        ["an announced larger length", { "content-length": "300" }],
        ["no announced length", {}],
        ["an announced length of exactly the bound", { "content-length": "10" }],
    ])(
        "reaching the bound with %s stops at once even if the server then stalls",
        async (_label, headers: Record<string, string>) => {
            const state = stubStream({
                headers,
                chunks: (index) => (index === 0 ? Buffer.from("abcdefghij") : undefined),
                stallAfter: 1,
            });
            const pending = downloadToString(
                "https://logs.example.com/job",
                {},
                10,
                new AbortController().signal,
            );
            await vi.waitFor(() =>
                expect(state.destroyed, "reaching maxBytes must destroy the response").toBe(true),
            );
            const result = await pending;
            expect(result.truncated).toBe(true);
            expect(result.text.startsWith("abcdefghij\n")).toBe(true);
            expect(result.text.split("[IntelliGit: log truncated").length - 1).toBe(1);
        },
    );

    it("a body of exactly the bound, announced at that length, still gets the marker once (O2)", async () => {
        const state = stubStream({
            headers: { "content-length": "10" },
            chunks: (index) => (index === 0 ? Buffer.from("abcdefghij") : undefined),
        });
        const result = await downloadToString(
            "https://logs.example.com/job",
            {},
            10,
            new AbortController().signal,
        );
        expect(result.truncated, "reaching maxBytes always marks the log truncated").toBe(true);
        expect(result.text.startsWith("abcdefghij\n[IntelliGit: log truncated")).toBe(true);
        expect(result.text.split("[IntelliGit: log truncated").length - 1).toBe(1);
        expect(state.destroyed).toBe(true);
    });

    it.each([
        ["before the response head", { chunks: () => undefined, noHead: true }],
        [
            "mid body",
            {
                chunks: (index: number) => (index === 0 ? Buffer.from("partial ") : undefined),
                stallAfter: 1,
            },
        ],
    ])("15 s inactivity callback rejects %s", async (_label, plan: StreamPlan) => {
        const state = stubStream(plan);
        const pending = downloadToString(
            "https://logs.example.com/job",
            {},
            CI_LOG_MAX_BYTES,
            new AbortController().signal,
        );
        await vi.waitFor(() => expect(state.timeouts.length).toBeGreaterThan(0));
        if (!plan.noHead) await vi.waitFor(() => expect(state.emitted).toBeGreaterThan(0));
        const [ms, onIdle] = state.timeouts[0];
        expect(ms, "log requests keep the existing 15 s idle timeout").toBe(15000);
        onIdle?.();
        await expect(pending).rejects.toThrow("HTTP request timed out");
        expect(state.requestDestroyed).toBe(true);
    });

    it("follows at most 5 redirects", async () => {
        stubStream({ status: 302, headers: { location: "/next" }, chunks: () => undefined });
        await expect(
            downloadToString(
                "https://logs.example.com/job",
                {},
                CI_LOG_MAX_BYTES,
                new AbortController().signal,
            ),
        ).rejects.toThrow(/too many redirects/i);
        expect(https.get).toHaveBeenCalledTimes(6);
    });

    it("an already-aborted signal sends no request", async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(
            downloadToString("https://logs.example.com/job", {}, 10, controller.signal),
        ).rejects.toMatchObject({ name: "AbortError" });
        expect(https.get).not.toHaveBeenCalled();
    });
});
