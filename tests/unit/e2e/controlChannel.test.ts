// Spec-derived tests for the E2E control channel orchestrator. The single most important
// case here is PLAN.md Phase 1 step 10's mandated negative test verbatim: "A unit test
// asserts the watcher does not start under ExtensionMode.Production even with the variable
// set and the directory present." This drives the REAL `activateE2eControlChannel` (which
// calls the real `evaluateE2eGate` and the real `watchChannelDir`) end to end against a real
// temp directory -- only `vscode` itself is mocked, because it has no runtime module outside
// the Extension Development Host. Nothing about the gate or the watcher is mocked.

import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as vscode from "vscode";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
    ExtensionMode: { Production: 1, Development: 2, Test: 3 },
}));

import * as vscodeMock from "vscode";
import { activateE2eControlChannel } from "../../../src/e2e/controlChannel";
import { isE2eControlChannelActive } from "../../../src/e2e/activationState";
import { E2E_CHANNEL_READY_MARKER } from "../../../src/e2e/transportFs";

const ALLOWED_WORKSPACE_KEY = "intelligit.selectedRepositoryRoot";

/** Builds a minimal fake `vscode.ExtensionContext` sufficient for `activateE2eControlChannel`. */
function makeContext(extensionMode: vscode.ExtensionMode): {
    context: vscode.ExtensionContext;
    workspaceMap: Map<string, unknown>;
    secretsMap: Map<string, string>;
    workspaceUpdate: ReturnType<typeof vi.fn>;
} {
    const workspaceMap = new Map<string, unknown>();
    const secretsMap = new Map<string, string>();

    const workspaceUpdate = vi.fn(async (key: string, value: unknown) => {
        if (value === undefined) workspaceMap.delete(key);
        else workspaceMap.set(key, value);
    });
    const workspaceState = {
        get: (key: string, defaultValue?: unknown) =>
            workspaceMap.has(key) ? workspaceMap.get(key) : defaultValue,
        update: workspaceUpdate,
    };
    const globalState = {
        get: (key: string, defaultValue?: unknown) => defaultValue,
        update: async () => undefined,
    };
    const secrets = {
        get: async (key: string) => secretsMap.get(key),
        store: async (key: string, value: string) => {
            secretsMap.set(key, value);
        },
        delete: async (key: string) => {
            secretsMap.delete(key);
        },
    };

    const context = {
        extensionMode,
        workspaceState,
        globalState,
        secrets,
    } as unknown as vscode.ExtensionContext;

    return { context, workspaceMap, secretsMap, workspaceUpdate };
}

/**
 * Polls for a file to appear, failing the test (via timeout) rather than hanging forever.
 *
 * These are real `fs.watch` integration tests, not mocks. Verified via an isolated
 * single-threaded rerun (`--poolOptions.threads.maxThreads=1`, 3/3 clean, ~1s each) that the
 * production watcher itself delivers events in well under a second: the only observed slowness
 * is OS-level FSEvents contention when several *other* test files' real watchers are also
 * active concurrently across vitest's worker threads. The three real-transport tests below
 * carry `{ retry: 2 }` to absorb exactly that scheduling variance -- a genuine regression in
 * the watcher or `dispatchRequest` still fails every attempt.
 */
async function waitFor(predicate: () => boolean, timeoutMs = 6_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) {
            throw new Error("waitFor: condition never became true within the timeout");
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

describe("activateE2eControlChannel: the watcher does not start outside Development", () => {
    let channelDir: string;

    beforeEach(() => {
        channelDir = mkdtempSync(join(tmpdir(), "intelligit-e2e-controlchannel-test-"));
        process.env.INTELLIGIT_E2E = "1";
        process.env.INTELLIGIT_E2E_CHANNEL_DIR = channelDir;
    });

    afterEach(() => {
        delete process.env.INTELLIGIT_E2E;
        delete process.env.INTELLIGIT_E2E_CHANNEL_DIR;
        rmSync(channelDir, { recursive: true, force: true });
    });

    it("does not activate, and never answers a request, under Production even with INTELLIGIT_E2E=1 and the directory present and writable", async () => {
        const { context } = makeContext(vscodeMock.ExtensionMode.Production);

        const handle = activateE2eControlChannel(context);
        try {
            expect(handle.active).toBe(false);
            expect(isE2eControlChannelActive()).toBe(false);

            // Prove the watcher itself never started, not merely that the handle reports
            // inactive: write a real request file and confirm nothing ever answers it.
            const requestPath = join(channelDir, "prod-nonce.request.json");
            writeFileSync(
                requestPath,
                JSON.stringify({
                    nonce: "prod-nonce",
                    store: "memento",
                    operation: "snapshot",
                    scope: "workspace",
                    key: ALLOWED_WORKSPACE_KEY,
                }),
                "utf8",
            );

            await new Promise((resolve) => setTimeout(resolve, 300));

            const responsePath = join(channelDir, "prod-nonce.response.json");
            expect(existsSync(responsePath)).toBe(false);
        } finally {
            handle.dispose();
        }
    });

    it("activates under Development with the same env and directory", async () => {
        const { context } = makeContext(vscodeMock.ExtensionMode.Development);

        const handle = activateE2eControlChannel(context);
        try {
            expect(handle.active).toBe(true);
            expect(isE2eControlChannelActive()).toBe(true);
            expect(existsSync(join(channelDir, E2E_CHANNEL_READY_MARKER))).toBe(true);
        } finally {
            handle.dispose();
            expect(isE2eControlChannelActive()).toBe(false);
            expect(existsSync(join(channelDir, E2E_CHANNEL_READY_MARKER))).toBe(false);
        }
    });

    it.each([
        ["Development + INTELLIGIT_E2E=1", vscodeMock.ExtensionMode.Development, "1", true],
        [
            "Development + INTELLIGIT_E2E unset",
            vscodeMock.ExtensionMode.Development,
            undefined,
            false,
        ],
        ["Production + INTELLIGIT_E2E=1", vscodeMock.ExtensionMode.Production, "1", false],
        [
            "Production + INTELLIGIT_E2E unset",
            vscodeMock.ExtensionMode.Production,
            undefined,
            false,
        ],
    ])("publishes readiness only for %s", (_label, extensionMode, e2eValue, expectedReady) => {
        const matrixChannelDir = mkdtempSync(
            join(tmpdir(), "intelligit-e2e-controlchannel-matrix-"),
        );
        if (e2eValue === undefined) delete process.env.INTELLIGIT_E2E;
        else process.env.INTELLIGIT_E2E = e2eValue;
        process.env.INTELLIGIT_E2E_CHANNEL_DIR = matrixChannelDir;
        const { context } = makeContext(extensionMode);
        const handle = activateE2eControlChannel(context);

        try {
            expect(existsSync(join(matrixChannelDir, E2E_CHANNEL_READY_MARKER))).toBe(
                expectedReady,
            );
        } finally {
            handle.dispose();
            delete process.env.INTELLIGIT_E2E;
            delete process.env.INTELLIGIT_E2E_CHANNEL_DIR;
            rmSync(matrixChannelDir, { recursive: true, force: true });
        }
    });
});

describe("activateE2eControlChannel: end-to-end request/response over the real transport", () => {
    let channelDir: string;

    beforeEach(() => {
        channelDir = mkdtempSync(join(tmpdir(), "intelligit-e2e-controlchannel-test-"));
        process.env.INTELLIGIT_E2E = "1";
        process.env.INTELLIGIT_E2E_CHANNEL_DIR = channelDir;
    });

    afterEach(() => {
        delete process.env.INTELLIGIT_E2E;
        delete process.env.INTELLIGIT_E2E_CHANNEL_DIR;
        rmSync(channelDir, { recursive: true, force: true });
    });

    it(
        "seed -> snapshot -> reset -> snapshot round-trips a memento key through real request/response files",
        { retry: 2 },
        async () => {
            const { context, workspaceMap } = makeContext(vscodeMock.ExtensionMode.Development);
            const handle = activateE2eControlChannel(context);

            try {
                await sendAndAwait(channelDir, "seed-1", {
                    store: "memento",
                    operation: "seed",
                    scope: "workspace",
                    key: ALLOWED_WORKSPACE_KEY,
                    value: "/repo/from/e2e",
                });
                expect(workspaceMap.get(ALLOWED_WORKSPACE_KEY)).toBe("/repo/from/e2e");

                const snapshotAfterSeed = await sendAndAwait(channelDir, "snap-1", {
                    store: "memento",
                    operation: "snapshot",
                    scope: "workspace",
                    key: ALLOWED_WORKSPACE_KEY,
                });
                expect(snapshotAfterSeed).toEqual({
                    nonce: "snap-1",
                    ok: true,
                    result: { kind: "value", value: "/repo/from/e2e" },
                });

                await sendAndAwait(channelDir, "reset-1", {
                    store: "memento",
                    operation: "reset",
                    scope: "workspace",
                    key: ALLOWED_WORKSPACE_KEY,
                });
                expect(workspaceMap.has(ALLOWED_WORKSPACE_KEY)).toBe(false);

                const snapshotAfterReset = await sendAndAwait(channelDir, "snap-2", {
                    store: "memento",
                    operation: "snapshot",
                    scope: "workspace",
                    key: ALLOWED_WORKSPACE_KEY,
                });
                expect(snapshotAfterReset).toEqual({
                    nonce: "snap-2",
                    ok: true,
                    result: { kind: "value", value: null },
                });
            } finally {
                handle.dispose();
            }
        },
    );

    it(
        "drains a request written before activation and dispatches a nonce only once",
        { retry: 2 },
        async () => {
            const request = {
                nonce: "preactivation",
                store: "memento",
                operation: "seed",
                scope: "workspace",
                key: ALLOWED_WORKSPACE_KEY,
                value: "/repo/preactivated",
            };
            writeFileSync(
                join(channelDir, "preactivation.request.json"),
                JSON.stringify(request),
                "utf8",
            );
            // Let the preactivation filesystem event settle before the watcher exists; otherwise an
            // OS may deliver the old event to a watcher registered moments later and mask the drain.
            await new Promise((resolve) => setTimeout(resolve, 100));
            const { context, workspaceUpdate } = makeContext(vscodeMock.ExtensionMode.Development);
            const handle = activateE2eControlChannel(context);

            try {
                await waitFor(() => existsSync(join(channelDir, "preactivation.response.json")));
                expect(workspaceUpdate).toHaveBeenCalledTimes(1);

                // Reusing the nonce forces the same file through the live watcher after the drain;
                // the per-activation nonce set must prevent a second handler invocation.
                unlinkSync(join(channelDir, "preactivation.response.json"));
                writeFileSync(
                    join(channelDir, "preactivation.request.json"),
                    JSON.stringify(request),
                    "utf8",
                );
                await new Promise((resolve) => setTimeout(resolve, 250));
                expect(workspaceUpdate).toHaveBeenCalledTimes(1);
            } finally {
                handle.dispose();
            }
        },
    );

    it("rejects an unlisted memento key over the real transport", { retry: 2 }, async () => {
        const { context } = makeContext(vscodeMock.ExtensionMode.Development);
        const handle = activateE2eControlChannel(context);

        try {
            const response = await sendAndAwait(channelDir, "bad-key", {
                store: "memento",
                operation: "snapshot",
                scope: "workspace",
                key: "intelligit.notAllowlisted",
            });
            expect(response).toMatchObject({
                ok: false,
                error: expect.stringContaining("not allowlisted"),
            });
        } finally {
            handle.dispose();
        }
    });

    it(
        "rejects a structurally malformed request file rather than crashing the watcher",
        { retry: 2 },
        async () => {
            const { context } = makeContext(vscodeMock.ExtensionMode.Development);
            const handle = activateE2eControlChannel(context);

            try {
                writeFileSync(
                    join(channelDir, "malformed.request.json"),
                    JSON.stringify({ nope: true }),
                    "utf8",
                );
                await waitFor(() => existsSync(join(channelDir, "malformed.response.json")));
                const response = JSON.parse(
                    readFileSync(join(channelDir, "malformed.response.json"), "utf8"),
                );
                expect(response.ok).toBe(false);

                // The watcher must still be alive for the next request after a malformed one.
                const response2 = await sendAndAwait(channelDir, "after-malformed", {
                    store: "memento",
                    operation: "snapshot",
                    scope: "workspace",
                    key: ALLOWED_WORKSPACE_KEY,
                });
                expect(response2.ok).toBe(true);
            } finally {
                handle.dispose();
            }
        },
    );

    it(
        "continues serving valid requests after a truncated request file",
        { retry: 2 },
        async () => {
            const { context } = makeContext(vscodeMock.ExtensionMode.Development);
            const handle = activateE2eControlChannel(context);

            try {
                writeFileSync(join(channelDir, "truncated.request.json"), '{"nonce":', "utf8");
                const response = await sendAndAwait(channelDir, "after-truncated", {
                    store: "memento",
                    operation: "snapshot",
                    scope: "workspace",
                    key: ALLOWED_WORKSPACE_KEY,
                });
                expect(response.ok).toBe(true);
            } finally {
                handle.dispose();
            }
        },
    );

    it(
        "retries a request whose response write failed, stranding no temp file and no unhandled rejection",
        { retry: 2 },
        async () => {
            const { context, workspaceMap } = makeContext(vscodeMock.ExtensionMode.Development);
            const nonce = "blocked-response";
            const requestPath = join(channelDir, `${nonce}.request.json`);
            const responsePath = join(channelDir, `${nonce}.response.json`);

            // Block the write at the filesystem layer rather than by mocking the transport:
            // renaming onto an existing directory fails exactly the way a channel torn down
            // mid-flight fails an in-flight response, so the real error path runs end to end.
            mkdirSync(responsePath);

            const rejections: unknown[] = [];
            const recordRejection = (reason: unknown): void => {
                rejections.push(reason);
            };
            process.on("unhandledRejection", recordRejection);
            const handle = activateE2eControlChannel(context);

            try {
                writeFileSync(
                    requestPath,
                    JSON.stringify({
                        nonce,
                        store: "memento",
                        operation: "seed",
                        scope: "workspace",
                        key: ALLOWED_WORKSPACE_KEY,
                        value: "/repo/after/retry",
                    }),
                    "utf8",
                );

                // The handler runs, then delivery fails. A failed delivery must leave the request
                // in place: that surviving file is both what reconciliation retries from, and what
                // makes the client's timeout diagnostic name the true failure instead of blaming
                // a watcher that did observe the request.
                await waitFor(() => workspaceMap.has(ALLOWED_WORKSPACE_KEY));
                await new Promise((resolve) => setTimeout(resolve, 200));
                expect(existsSync(requestPath)).toBe(true);
                expect(rejections).toEqual([]);

                // Unblocking alone must be enough -- no new request file is written here, so only
                // reconciliation retrying the surviving one can produce a response.
                rmSync(responsePath, { recursive: true, force: true });
                await waitFor(() => existsSync(responsePath));
                expect(JSON.parse(readFileSync(responsePath, "utf8")).ok).toBe(true);
                expect(existsSync(requestPath)).toBe(false);
                expect(readdirSync(channelDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
            } finally {
                process.off("unhandledRejection", recordRejection);
                handle.dispose();
            }
        },
    );

    /**
     * A request file whose CONTENT is not JSON at all. The existing malformed-request test above
     * writes `{"nope": true}` -- valid JSON with the wrong schema, which exercises
     * `parseE2eRequest` and never reaches `JSON.parse`. This one reaches `JSON.parse`, which
     * throws a `SyntaxError` synchronously inside the reconciliation loop, upstream of every
     * `try`/`catch` in `dispatchRequest`. Nothing there catches it, so it escapes as an
     * uncaught exception in the extension host.
     *
     * The assertion is the log line naming the nonce, not merely "the next request still works":
     * a watcher can survive an uncaught listener throw and still leave the failure attributed to
     * nothing at all, and a test that only checks the next request would pass in that state.
     */
    it(
        "logs and skips a non-JSON request body instead of throwing inside the watcher listener",
        { retry: 2 },
        async () => {
            const { context } = makeContext(vscodeMock.ExtensionMode.Development);
            const handle = activateE2eControlChannel(context);
            const logged: string[] = [];
            const consoleSpy = vi
                .spyOn(console, "error")
                .mockImplementation((...args: unknown[]) => {
                    logged.push(args.map((arg) => String(arg)).join(" "));
                });

            try {
                writeFileSync(join(channelDir, "not-json.request.json"), "{ not json", "utf8");

                await waitFor(() =>
                    logged.some((line) => line.includes("not-json") && line.includes("unreadable")),
                );

                // Skipped, not answered: with a non-atomic writer this same failure is also how a
                // half-written file looks, and answering it would race a spurious error response
                // against the real one.
                expect(existsSync(join(channelDir, "not-json.response.json"))).toBe(false);

                // The watcher must still answer the next request.
                const next = await sendAndAwait(channelDir, "after-not-json", {
                    store: "memento",
                    operation: "snapshot",
                    scope: "workspace",
                    key: ALLOWED_WORKSPACE_KEY,
                });
                expect(next.ok).toBe(true);
            } finally {
                consoleSpy.mockRestore();
                handle.dispose();
            }
        },
    );

    /**
     * The log line added for the case above must not become a way out for the thing this
     * channel is most careful about. A request file is not opaque bytes -- a `secret` `seed`
     * request carries the secret VALUE -- and a `JSON.parse` failure message can quote the
     * input: measured against this Node's V8, a parse that fails at position 0 reports
     * `Unexpected token 'p', "placeholde"... is not valid JSON`, echoing the first ten
     * characters. (A parse that fails later reports only a position and echoes nothing, which
     * is why the body below is arranged to fail at the very start -- a body that fails late
     * cannot detect this defect at all, and a test using one would pass either way.)
     *
     * The stand-in below is deliberately NOT credential-shaped. This repository is scanned by
     * a secret detector on every push, and a literal wearing a real token's prefix fails that
     * scan whether or not it is real -- correctly, since a scanner cannot tell. Nothing the
     * test measures depends on the shape: it needs a value distinctive enough that finding it
     * in the log is unambiguous, and one that makes the parse fail at position 0.
     *
     * The assertion is on the leading characters V8 actually emits, so it fails when the guard
     * is removed, and it does not depend on the wording of the replacement message.
     */
    it(
        "never echoes the request body when reporting an unreadable request, because a body can carry a secret",
        { retry: 2 },
        async () => {
            const { context } = makeContext(vscodeMock.ExtensionMode.Development);
            const handle = activateE2eControlChannel(context);
            const logged: string[] = [];
            const consoleSpy = vi
                .spyOn(console, "error")
                .mockImplementation((...args: unknown[]) => {
                    logged.push(args.map((arg) => String(arg)).join(" "));
                });
            const secretValue = "placeholder-not-a-credential-0000";

            try {
                writeFileSync(join(channelDir, "leaky.request.json"), secretValue, "utf8");

                await waitFor(() => logged.some((line) => line.includes("leaky")));

                expect(
                    logged.join("\n"),
                    "the parse failure was reported with its own message, and V8 builds that message " +
                        "by quoting the input's leading characters -- so part of a request body, which " +
                        "for a secret seed is the secret itself, reached a log this suite writes in CI",
                ).not.toContain(secretValue.slice(0, 10));
            } finally {
                consoleSpy.mockRestore();
                handle.dispose();
            }
        },
    );

    /**
     * The failure that happens AFTER `dispatchRequest` has already resolved. `dispatchRequest`
     * turns every parse and handler failure into an error response, so it never rejects -- but
     * the `.then` callback that finalizes the exchange calls two synchronous filesystem
     * functions that can. A directory sitting where the response file must go makes
     * `renameSync` throw deterministically, with no timing to lose: without a rejection handler
     * that throw is an unhandled promise rejection in the extension host, attributed to no
     * request at all.
     */
    it(
        "reports a finalize failure against its own nonce instead of raising an unhandled rejection",
        { retry: 2 },
        async () => {
            const { context } = makeContext(vscodeMock.ExtensionMode.Development);
            const handle = activateE2eControlChannel(context);
            const logged: string[] = [];
            const consoleSpy = vi
                .spyOn(console, "error")
                .mockImplementation((...args: unknown[]) => {
                    logged.push(args.map((arg) => String(arg)).join(" "));
                });

            try {
                mkdirSync(join(channelDir, "collide.response.json"));
                writeFileSync(
                    join(channelDir, "collide.request.json"),
                    JSON.stringify({
                        nonce: "collide",
                        store: "memento",
                        operation: "snapshot",
                        scope: "workspace",
                        key: ALLOWED_WORKSPACE_KEY,
                    }),
                    "utf8",
                );

                await waitFor(() =>
                    logged.some((line) => line.includes("collide") && line.includes("deliver")),
                );
            } finally {
                consoleSpy.mockRestore();
                handle.dispose();
            }
        },
    );

    /** Writes a request file and waits for the correlated response file, returning its parsed body. */
    async function sendAndAwait(
        dir: string,
        nonce: string,
        body: Record<string, unknown>,
    ): Promise<{ nonce: string; ok: boolean; [key: string]: unknown }> {
        writeFileSync(
            join(dir, `${nonce}.request.json`),
            JSON.stringify({ nonce, ...body }),
            "utf8",
        );
        const responsePath = join(dir, `${nonce}.response.json`);
        await waitFor(() => existsSync(responsePath));
        return JSON.parse(readFileSync(responsePath, "utf8"));
    }
});
