import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as vscode from "vscode";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
    ExtensionMode: { Production: 1, Development: 2, Test: 3 },
}));

const duplicateNonce = "duplicate";
const duplicatePayload = {
    nonce: duplicateNonce,
    store: "memento",
    operation: "seed",
    scope: "workspace",
    key: "intelligit.selectedRepositoryRoot",
    value: "/repo/drained-once",
};

const transportMocks = vi.hoisted(() => ({
    watcherCallback: undefined as ((nonce: string, payload: unknown) => void) | undefined,
    writeResponseFileAtomic: vi.fn(),
}));

vi.mock("../../../src/e2e/transportFs", async () => {
    const actual = await vi.importActual<typeof import("../../../src/e2e/transportFs")>(
        "../../../src/e2e/transportFs",
    );
    return {
        ...actual,
        listRequestNonces: vi.fn(() => [duplicateNonce]),
        readRequestFile: vi.fn(() => duplicatePayload),
        removeRequestFile: vi.fn(),
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
import { removeScratchDirectoriesSync } from "../../helpers/scratchDirectories";

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

describe("activateE2eControlChannel drain/watcher overlap", () => {
    let channelDir: string;

    beforeEach(() => {
        channelDir = mkdtempSync(join(tmpdir(), "intelligit-e2e-drain-overlap-"));
        process.env.INTELLIGIT_E2E = "1";
        process.env.INTELLIGIT_E2E_CHANNEL_DIR = channelDir;
        transportMocks.watcherCallback = undefined;
        transportMocks.writeResponseFileAtomic.mockClear();
    });

    afterEach(() => {
        delete process.env.INTELLIGIT_E2E;
        delete process.env.INTELLIGIT_E2E_CHANNEL_DIR;
        removeScratchDirectoriesSync(channelDir);
    });

    it("dispatches once when the drain and live watcher both observe one nonce", async () => {
        const workspaceUpdate = vi.fn(async () => undefined);
        const handle = activateE2eControlChannel(makeContext(workspaceUpdate));

        try {
            await vi.waitFor(() =>
                expect(transportMocks.writeResponseFileAtomic).toHaveBeenCalledTimes(1),
            );
            expect(workspaceUpdate).toHaveBeenCalledTimes(1);

            transportMocks.watcherCallback?.(duplicateNonce, duplicatePayload);
            await new Promise((resolve) => setTimeout(resolve, 20));

            expect(workspaceUpdate).toHaveBeenCalledTimes(1);
            expect(transportMocks.writeResponseFileAtomic).toHaveBeenCalledTimes(1);
        } finally {
            handle.dispose();
        }
    });
});
