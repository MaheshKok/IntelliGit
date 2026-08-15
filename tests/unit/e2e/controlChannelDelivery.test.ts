import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as vscode from "vscode";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
    ExtensionMode: { Production: 1, Development: 2, Test: 3 },
}));

const nonce = "undelivered";
const payload = {
    nonce,
    store: "memento",
    operation: "seed",
    scope: "workspace",
    key: "intelligit.selectedRepositoryRoot",
    value: "/repo/answered-once",
};

const transportMocks = vi.hoisted(() => ({
    watcherCallback: undefined as ((nonce: string, payload: unknown) => void) | undefined,
    removeRequestFile: vi.fn(),
    writeResponseFileAtomic: vi.fn(),
}));

vi.mock("../../../src/e2e/transportFs", async () => {
    const actual = await vi.importActual<typeof import("../../../src/e2e/transportFs")>(
        "../../../src/e2e/transportFs",
    );
    return {
        ...actual,
        listRequestNonces: vi.fn(() => [nonce]),
        readRequestFile: vi.fn(() => payload),
        removeRequestFile: transportMocks.removeRequestFile,
        watchChannelDir: vi.fn(
            (_channelDir: string, onRequest: (nonce: string, payload: unknown) => void) => {
                transportMocks.watcherCallback = onRequest;
                return { dispose: vi.fn() };
            },
        ),
        writeChannelReadyMarker: vi.fn(),
        writeResponseFileAtomic: transportMocks.writeResponseFileAtomic,
    };
});

import * as vscodeMock from "vscode";
import { activateE2eControlChannel } from "../../../src/e2e/controlChannel";

/**
 * The handler's side effect, counted directly. A retry that re-runs the handler seeds the
 * memento a second time, which is exactly the damage a delivery retry must not cause.
 */
function makeContext(workspaceUpdate: ReturnType<typeof vi.fn>): vscode.ExtensionContext {
    const workspaceMap = new Map<string, unknown>();
    return {
        extensionMode: vscodeMock.ExtensionMode.Development,
        workspaceState: {
            get: (key: string, defaultValue?: unknown) => workspaceMap.get(key) ?? defaultValue,
            update: workspaceUpdate,
        },
        globalState: { get: () => undefined, update: async () => undefined },
        secrets: {
            get: async () => undefined,
            store: async () => undefined,
            delete: async () => undefined,
        },
    } as unknown as vscode.ExtensionContext;
}

/** Offers the same nonce back, the way the reconciliation loop does when a request survives. */
function reconcile(times: number): void {
    for (let index = 0; index < times; index += 1) {
        transportMocks.watcherCallback?.(nonce, payload);
    }
}

/** Lets every dispatch started by {@link reconcile} reach its write before anything is counted. */
async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 50));
}

describe("activateE2eControlChannel response delivery", () => {
    let channelDir: string;
    let consoleError: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        channelDir = mkdtempSync(join(tmpdir(), "intelligit-e2e-delivery-"));
        process.env.INTELLIGIT_E2E = "1";
        process.env.INTELLIGIT_E2E_CHANNEL_DIR = channelDir;
        transportMocks.watcherCallback = undefined;
        transportMocks.removeRequestFile.mockClear();
        transportMocks.writeResponseFileAtomic.mockReset();
        consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    });

    afterEach(() => {
        delete process.env.INTELLIGIT_E2E;
        delete process.env.INTELLIGIT_E2E_CHANNEL_DIR;
        rmSync(channelDir, { recursive: true, force: true });
        vi.restoreAllMocks();
    });

    it("retries only the delivery, never the handler, when the response write fails", async () => {
        transportMocks.writeResponseFileAtomic.mockImplementation(() => {
            throw new Error("ENOSPC: no space left on device");
        });
        const workspaceUpdate = vi.fn(async () => undefined);
        const handle = activateE2eControlChannel(makeContext(workspaceUpdate));

        try {
            await vi.waitFor(() =>
                expect(transportMocks.writeResponseFileAtomic).toHaveBeenCalledTimes(1),
            );
            expect(workspaceUpdate).toHaveBeenCalledTimes(1);

            reconcile(1);
            await vi.waitFor(() =>
                expect(transportMocks.writeResponseFileAtomic).toHaveBeenCalledTimes(2),
            );

            expect(
                workspaceUpdate,
                "the handler ran again for a request it had already answered",
            ).toHaveBeenCalledTimes(1);
            // The request must survive an undelivered response, or the client is left waiting on
            // a request nothing will ever offer back.
            expect(transportMocks.removeRequestFile).not.toHaveBeenCalled();
        } finally {
            handle.dispose();
        }
    });

    it("keeps retrying a failing delivery while a client could still be waiting", async () => {
        transportMocks.writeResponseFileAtomic.mockImplementation(() => {
            throw new Error("EEXIST: file already exists");
        });
        const workspaceUpdate = vi.fn(async () => undefined);
        const handle = activateE2eControlChannel(makeContext(workspaceUpdate));

        try {
            await vi.waitFor(() =>
                expect(transportMocks.writeResponseFileAtomic).toHaveBeenCalledTimes(1),
            );

            // A response path blocked for a moment -- teardown recreating the directory, a lock
            // held briefly -- is the case retrying exists for, and giving up inside it strands a
            // request the client is still waiting on.
            reconcile(5);
            await settle();
            expect(
                transportMocks.writeResponseFileAtomic,
                "the retry window closed while the client was still waiting",
            ).toHaveBeenCalledTimes(6);
        } finally {
            handle.dispose();
        }
    });

    it("gives up on a delivery once no client could still be waiting for it", async () => {
        transportMocks.writeResponseFileAtomic.mockImplementation(() => {
            throw new Error("ENOSPC: no space left on device");
        });
        const workspaceUpdate = vi.fn(async () => undefined);
        const handle = activateE2eControlChannel(makeContext(workspaceUpdate));

        try {
            await vi.waitFor(() =>
                expect(transportMocks.writeResponseFileAtomic).toHaveBeenCalledTimes(1),
            );
            reconcile(2);
            await settle();
            const beforeExpiry = transportMocks.writeResponseFileAtomic.mock.calls.length;

            // Only the clock is faked. Real timers still drive `settle()`, and the reconciliation
            // offers below are made by hand, so nothing here depends on timer scheduling -- just
            // on the window the delivery deadline was measured against having elapsed.
            vi.useFakeTimers({ toFake: ["Date"] });
            vi.setSystemTime(Date.now() + 31_000);
            reconcile(20);
            vi.useRealTimers();
            await settle();

            expect(
                transportMocks.writeResponseFileAtomic.mock.calls.length,
                "the delivery is still being retried after every client gave up",
            ).toBe(beforeExpiry + 1);
            expect(workspaceUpdate).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
            handle.dispose();
        }
    });

    it("stops retrying once a later delivery attempt succeeds", async () => {
        transportMocks.writeResponseFileAtomic
            .mockImplementationOnce(() => {
                throw new Error("EEXIST: file already exists");
            })
            .mockImplementation(() => undefined);
        const workspaceUpdate = vi.fn(async () => undefined);
        const handle = activateE2eControlChannel(makeContext(workspaceUpdate));

        try {
            await vi.waitFor(() =>
                expect(transportMocks.writeResponseFileAtomic).toHaveBeenCalledTimes(1),
            );
            expect(transportMocks.removeRequestFile).not.toHaveBeenCalled();

            reconcile(1);
            await settle();
            expect(transportMocks.removeRequestFile).toHaveBeenCalledTimes(1);

            // The delivered response must leave nothing behind to retry, or the channel keeps
            // rewriting an answered request for every tick that offers the nonce again.
            reconcile(5);
            await settle();
            expect(
                transportMocks.writeResponseFileAtomic,
                "a delivered response is still being retried",
            ).toHaveBeenCalledTimes(2);
            expect(workspaceUpdate).toHaveBeenCalledTimes(1);
        } finally {
            handle.dispose();
        }
    });

    it("consumes the request and caches nothing once the response is written", async () => {
        const workspaceUpdate = vi.fn(async () => undefined);
        const handle = activateE2eControlChannel(makeContext(workspaceUpdate));

        try {
            await vi.waitFor(() =>
                expect(transportMocks.removeRequestFile).toHaveBeenCalledTimes(1),
            );
            expect(transportMocks.writeResponseFileAtomic).toHaveBeenCalledTimes(1);

            // A delivered response leaves nothing to retry: an offer of the same nonce is the
            // watcher and the drain overlapping, not a survivor needing another write.
            reconcile(5);
            await new Promise((resolve) => setTimeout(resolve, 20));

            expect(transportMocks.writeResponseFileAtomic).toHaveBeenCalledTimes(1);
            expect(workspaceUpdate).toHaveBeenCalledTimes(1);
            expect(consoleError).not.toHaveBeenCalled();
        } finally {
            handle.dispose();
        }
    });
});
