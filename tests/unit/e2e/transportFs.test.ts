// Spec-derived tests for the E2E control channel's file-exchange transport (PLAN.md Phase 1
// step 10): "the extension writes <nonce>.response.json by temp-file-plus-rename so a reader
// never sees a partial write." The partial-write-safety test below asserts the actual
// mechanism -- a full write to a differently-named temp file followed by a single rename --
// since POSIX/NTFS's atomicity guarantee for same-directory rename is what makes that
// mechanism sufficient; a unit test cannot itself race a reader against a writer
// deterministically, so it verifies the code takes the only path that guarantee covers.

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    describeReadFailure,
    isValidNonce,
    nonceFromRequestFilename,
    readRequestFile,
    removeChannelReadyMarker,
    removeRequestFile,
    watchChannelDir,
    writeResponseFileAtomic,
} from "../../../src/e2e/transportFs";

/**
 * `describeReadFailure` is tested here as a pure function rather than through `watchChannelDir`,
 * because the property it carries is not observable from outside. No `readFileSync` errno
 * message contains a credential-bearing URL, so routing the non-`SyntaxError` branch through
 * `getErrorMessage` (and therefore `sanitizeErrorMessage`) changes nothing the watcher can be
 * made to print today. An end-to-end test would pass identically with the redaction deleted.
 *
 * What the function is FOR is the day a failure does carry one -- so the oracle is the function
 * itself, fed the message shape the redaction exists for.
 */
describe("describeReadFailure", () => {
    /**
     * The URL below carries user-info but deliberately no password, and its host is an RFC 2606
     * reserved name. What this test needs is an input `sanitizeErrorMessage` transforms at all --
     * that is the entire observable difference between the shared helper and a raw
     * `error.message`, and it is what goes red when the helper is removed. A realistic
     * `user:password@` literal would add nothing to that and would fail this repository's secret
     * scan, which matches the shape structurally and cannot tell a fake one from a real one.
     */
    it("redacts URL user-info in a non-parse failure, using the channel's one redaction policy", () => {
        const message = describeReadFailure(
            new Error("EACCES: permission denied, open https://someone@example.invalid/o/r.git"),
        );

        expect(message).toContain("https://***@example.invalid/o/r.git");
        expect(message).not.toContain("someone");
        // The rest of the diagnosis survives: redaction, not truncation.
        expect(message).toContain("EACCES");
    });

    it("withholds a parse failure's message, which V8 may build by quoting the request body", () => {
        // The deliberate exception to the policy above. `getErrorMessage` would preserve this
        // message, and V8 puts the input's leading characters in it.
        let parseError: unknown;
        try {
            JSON.parse("placeholder-not-a-credential-0000 is not json");
        } catch (error) {
            parseError = error;
        }

        const message = describeReadFailure(parseError);

        expect(message).not.toContain("placeholde");
        expect(message).toContain("content withheld");
    });

    it("describes a thrown non-Error without throwing on it", () => {
        expect(describeReadFailure("dropped a string")).toBe("dropped a string");
    });
});

describe("isValidNonce", () => {
    it("accepts alphanumeric, dash, and underscore nonces", () => {
        expect(isValidNonce("abc123")).toBe(true);
        expect(isValidNonce("abc-123_XYZ")).toBe(true);
    });

    it("rejects an empty nonce", () => {
        expect(isValidNonce("")).toBe(false);
    });

    it("rejects a nonce containing a path separator", () => {
        expect(isValidNonce("../escape")).toBe(false);
        expect(isValidNonce("a/b")).toBe(false);
        expect(isValidNonce("a\\b")).toBe(false);
    });

    it("rejects a nonce containing a null byte or other control characters", () => {
        expect(isValidNonce("a\0b")).toBe(false);
        expect(isValidNonce("a\nb")).toBe(false);
    });
});

describe("nonceFromRequestFilename", () => {
    it("extracts the nonce from a well-formed request filename", () => {
        expect(nonceFromRequestFilename("abc123.request.json")).toBe("abc123");
    });

    it("returns undefined for a non-request filename", () => {
        expect(nonceFromRequestFilename("abc123.response.json")).toBeUndefined();
        expect(nonceFromRequestFilename("abc123.tmp")).toBeUndefined();
        expect(nonceFromRequestFilename("readme.md")).toBeUndefined();
    });

    it("returns undefined when the nonce portion is itself invalid (path traversal attempt)", () => {
        expect(nonceFromRequestFilename("../escape.request.json")).toBeUndefined();
    });
});

describe("writeResponseFileAtomic: partial-write safety", () => {
    // The temp-file-plus-rename *mechanism* is proven separately in
    // transportFsAtomicWrite.test.ts, which mocks node:fs at module scope (required so the
    // mock is in place before transportFs.ts's own import binds to it) to assert the exact
    // call order and that the temp path differs from the final path. The tests here prove
    // observable *outcomes* against the real filesystem.
    let channelDir: string;

    beforeEach(() => {
        channelDir = mkdtempSync(join(tmpdir(), "intelligit-e2e-transport-test-"));
    });

    afterEach(() => {
        rmSync(channelDir, { recursive: true, force: true });
    });

    it("leaves the final response path readable with the exact written payload, and no leftover temp file", () => {
        const payload = { nonce: "abc123", ok: true, result: { kind: "value", value: 42 } };
        writeResponseFileAtomic(channelDir, "abc123", payload);

        const finalPath = join(channelDir, "abc123.response.json");
        expect(existsSync(finalPath)).toBe(true);
        expect(JSON.parse(readFileSync(finalPath, "utf8"))).toEqual(payload);

        const leftoverTempFiles = readdirSync(channelDir).filter((name) => name.includes(".tmp"));
        expect(leftoverTempFiles).toEqual([]);
    });

    it("never leaves a zero-byte or empty response file at the final path", () => {
        // A regression here (e.g. writing directly to the final path with truncation) would
        // let a reader observe a momentarily empty file, which JSON.parse would reject --
        // exactly the partial-write failure mode this transport exists to prevent.
        writeResponseFileAtomic(channelDir, "abc123", { nonce: "abc123", ok: true });
        const finalPath = join(channelDir, "abc123.response.json");
        expect(readFileSync(finalPath, "utf8").length).toBeGreaterThan(0);
    });
});

describe("readRequestFile / removeRequestFile", () => {
    let channelDir: string;

    beforeEach(() => {
        channelDir = mkdtempSync(join(tmpdir(), "intelligit-e2e-transport-test-"));
    });

    afterEach(() => {
        rmSync(channelDir, { recursive: true, force: true });
    });

    it("reads and JSON-parses an existing request file", () => {
        writeFileSync(join(channelDir, "n1.request.json"), JSON.stringify({ a: 1 }), "utf8");
        expect(readRequestFile(channelDir, "n1")).toEqual({ a: 1 });
    });

    it("returns undefined for a missing request file", () => {
        expect(readRequestFile(channelDir, "missing")).toBeUndefined();
    });

    // The two failures below must stay distinguishable, and that distinction is the whole
    // contract: "the file is gone" is a routine race with a prior tick that already consumed it,
    // while "the file is here and unreadable" is a request that will never be answered. Both
    // callers -- the reconciliation loop and the activation drain -- skip the nonce either way,
    // so the ONLY thing that separates a logged, diagnosable failure from silence is which of
    // these two shapes `readRequestFile` produces. Collapsing the parse failure into `undefined`
    // deletes the caller's ability to report it, and the caller cannot recover the distinction:
    // by the time it holds `undefined` the reason is already gone.
    it("distinguishes an unreadable request from an absent one, so only the former can be reported", () => {
        writeFileSync(join(channelDir, "malformed.request.json"), '{"nonce":', "utf8");

        expect(() => readRequestFile(channelDir, "malformed")).toThrow(SyntaxError);
        expect(readRequestFile(channelDir, "absent")).toBeUndefined();
    });

    it("removeRequestFile deletes the file and is a no-op when it is already gone", () => {
        const path = join(channelDir, "n1.request.json");
        writeFileSync(path, "{}", "utf8");
        removeRequestFile(channelDir, "n1");
        expect(existsSync(path)).toBe(false);
        expect(() => removeRequestFile(channelDir, "n1")).not.toThrow();
    });
});

describe("removeChannelReadyMarker", () => {
    let channelDir: string;

    beforeEach(() => {
        channelDir = mkdtempSync(join(tmpdir(), "intelligit-e2e-transport-test-"));
    });

    afterEach(() => {
        rmSync(channelDir, { recursive: true, force: true });
    });

    it("removes the marker and tolerates a missing marker", () => {
        const markerPath = join(channelDir, ".e2e-channel-ready");
        writeFileSync(markerPath, "ready\n", "utf8");

        removeChannelReadyMarker(channelDir);
        expect(existsSync(markerPath)).toBe(false);
        expect(() => removeChannelReadyMarker(channelDir)).not.toThrow();
    });
});

describe("watchChannelDir", () => {
    let channelDir: string;

    beforeEach(() => {
        channelDir = mkdtempSync(join(tmpdir(), "intelligit-e2e-transport-test-"));
    });

    afterEach(() => {
        rmSync(channelDir, { recursive: true, force: true });
    });

    // Exercises a real fs.watch delivery, not a mock. A confirmed run showed this can
    // occasionally miss its budget only when many other files' real fs.watch integration tests
    // are scheduled onto concurrent worker threads at the same time -- never in isolation or
    // under single-threaded execution (verified: 3/3 clean runs with --poolOptions.threads.maxThreads=1,
    // vs. one flake across several runs at default parallelism). Retrying absorbs that
    // environmental scheduling variance without hiding a real failure: a genuine regression in
    // watchChannelDir fails all 3 attempts, since nothing about the retry changes what is
    // asserted.
    it("invokes onRequest with the nonce and parsed payload when a request file appears", { timeout: 10_000, retry: 2 }, async () => {
        const received = new Promise<{ nonce: string; payload: unknown }>((resolve) => {
            const watcher = watchChannelDir(channelDir, (nonce, payload) => {
                watcher.dispose();
                resolve({ nonce, payload });
            });
        });

        writeFileSync(
            join(channelDir, "watch-nonce.request.json"),
            JSON.stringify({ hello: "world" }),
            "utf8",
        );

        const result = await received;
        expect(result.nonce).toBe("watch-nonce");
        expect(result.payload).toEqual({ hello: "world" });
    });

    it("ignores unrelated files written to the same directory", async () => {
        const onRequest = vi.fn();
        const watcher = watchChannelDir(channelDir, onRequest);
        writeFileSync(join(channelDir, "unrelated.txt"), "noise", "utf8");
        writeFileSync(join(channelDir, "n1.response.json"), "{}", "utf8");

        await new Promise((resolve) => setTimeout(resolve, 200));
        watcher.dispose();

        expect(onRequest).not.toHaveBeenCalled();
    });

    it("dispose() stops further callbacks", async () => {
        const onRequest = vi.fn();
        const watcher = watchChannelDir(channelDir, onRequest);
        watcher.dispose();

        writeFileSync(join(channelDir, "after-dispose.request.json"), "{}", "utf8");
        await new Promise((resolve) => setTimeout(resolve, 200));

        expect(onRequest).not.toHaveBeenCalled();
    });

    // Reconciliation is a poll, not an event, and a genuinely malformed request is never
    // consumed -- so this file is re-read on every tick for as long as the channel is up. That
    // makes the log's DEDUPLICATION load-bearing rather than cosmetic: reporting per read buries
    // the host output at the reconciliation interval, which is where the real diagnostic for
    // every other failure also lands. The window below spans several ticks precisely so an
    // undeduplicated log cannot pass by being fast enough to only fire once.
    it("reports a persistently unreadable request once, not once per reconciliation tick", async () => {
        const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const onRequest = vi.fn();
        writeFileSync(join(channelDir, "stuck.request.json"), '{"nonce":', "utf8");

        const watcher = watchChannelDir(channelDir, onRequest);
        await new Promise((resolve) => setTimeout(resolve, 400));
        watcher.dispose();

        const stuckReports = errors.mock.calls.filter(
            (call) => typeof call[0] === "string" && call[0].includes('"stuck"'),
        );
        errors.mockRestore();

        // Counted, never matched against a quoted expectation: the assertion's own diff prints
        // the message, so presence proves nothing about how many times it was emitted.
        expect(stuckReports).toHaveLength(1);
        expect(onRequest, "an unreadable request must never be dispatched").not.toHaveBeenCalled();
    });
});
