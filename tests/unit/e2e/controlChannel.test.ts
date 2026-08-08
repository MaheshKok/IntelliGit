// Spec-derived tests for the E2E control channel orchestrator. The single most important
// case here is PLAN.md Phase 1 step 10's mandated negative test verbatim: "A unit test
// asserts the watcher does not start under ExtensionMode.Production even with the variable
// set and the directory present." This drives the REAL `activateE2eControlChannel` (which
// calls the real `evaluateE2eGate` and the real `watchChannelDir`) end to end against a real
// temp directory -- only `vscode` itself is mocked, because it has no runtime module outside
// the Extension Development Host. Nothing about the gate or the watcher is mocked.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const ALLOWED_WORKSPACE_KEY = "intelligit.selectedRepositoryRoot";

/** Builds a minimal fake `vscode.ExtensionContext` sufficient for `activateE2eControlChannel`. */
function makeContext(
    extensionMode: vscode.ExtensionMode,
): { context: vscode.ExtensionContext; workspaceMap: Map<string, unknown>; secretsMap: Map<string, string> } {
    const workspaceMap = new Map<string, unknown>();
    const secretsMap = new Map<string, string>();

    const workspaceState = {
        get: (key: string, defaultValue?: unknown) =>
            workspaceMap.has(key) ? workspaceMap.get(key) : defaultValue,
        update: async (key: string, value: unknown) => {
            if (value === undefined) workspaceMap.delete(key);
            else workspaceMap.set(key, value);
        },
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

    return { context, workspaceMap, secretsMap };
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
        } finally {
            handle.dispose();
            expect(isE2eControlChannelActive()).toBe(false);
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

    it("seed -> snapshot -> reset -> snapshot round-trips a memento key through real request/response files", { retry: 2 }, async () => {
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
    });

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
            expect(response).toMatchObject({ ok: false, error: expect.stringContaining("not allowlisted") });
        } finally {
            handle.dispose();
        }
    });

    it("rejects a structurally malformed request file rather than crashing the watcher", { retry: 2 }, async () => {
        const { context } = makeContext(vscodeMock.ExtensionMode.Development);
        const handle = activateE2eControlChannel(context);

        try {
            writeFileSync(join(channelDir, "malformed.request.json"), JSON.stringify({ nope: true }), "utf8");
            await waitFor(() => existsSync(join(channelDir, "malformed.response.json")));
            const response = JSON.parse(readFileSync(join(channelDir, "malformed.response.json"), "utf8"));
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
    });

    /** Writes a request file and waits for the correlated response file, returning its parsed body. */
    async function sendAndAwait(
        dir: string,
        nonce: string,
        body: Record<string, unknown>,
    ): Promise<{ nonce: string; ok: boolean; [key: string]: unknown }> {
        writeFileSync(join(dir, `${nonce}.request.json`), JSON.stringify({ nonce, ...body }), "utf8");
        const responsePath = join(dir, `${nonce}.response.json`);
        await waitFor(() => existsSync(responsePath));
        return JSON.parse(readFileSync(responsePath, "utf8"));
    }
});
