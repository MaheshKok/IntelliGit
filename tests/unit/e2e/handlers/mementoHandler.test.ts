// Spec-derived tests for the E2E control channel's memento handler. Runs against a real
// Map-backed `vscode.Memento` double (get/update), exercising the actual seed/snapshot/reset
// contract end to end: "a seed that no-ops must be caught by the following snapshot, and a
// reset that no-ops must be caught by the snapshot after it" (PLAN.md Phase 6 negative
// matrix) -- so every test round-trips through real seed/snapshot/reset calls rather than
// asserting on internals.

import type * as vscode from "vscode";
import { describe, expect, it } from "vitest";
import { handleMementoRequest } from "../../../../src/e2e/handlers/mementoHandler";
import type { E2eMementoRequest } from "../../../../src/e2e/protocol";

const ALLOWED_WORKSPACE_KEY = "intelligit.selectedRepositoryRoot";
const ALLOWED_GLOBAL_KEY = "intelligit.reviewPrompt.status";

/** Builds a Map-backed double for one Memento scope. Carries `setKeysForSync` so the double is
 * also assignable to `ExtensionContext["globalState"]`, which intersects `Memento` with it. */
function makeMemento(
    seed: Record<string, unknown> = {},
): vscode.Memento & { setKeysForSync(keys: readonly string[]): void } {
    const map = new Map<string, unknown>(Object.entries(seed));
    return {
        get: (key: string, defaultValue?: unknown) => (map.has(key) ? map.get(key) : defaultValue),
        update: async (key: string, value: unknown) => {
            if (value === undefined) {
                map.delete(key);
            } else {
                map.set(key, value);
            }
        },
        keys: () => Array.from(map.keys()),
        setKeysForSync: () => undefined,
    } as unknown as vscode.Memento & { setKeysForSync(keys: readonly string[]): void };
}

function makeContext(): { context: Pick<vscode.ExtensionContext, "globalState" | "workspaceState"> } {
    return {
        context: {
            globalState: makeMemento(),
            workspaceState: makeMemento(),
        },
    };
}

describe("handleMementoRequest: allowlist rejection", () => {
    it("rejects an unlisted workspace key without touching the memento", async () => {
        const { context } = makeContext();
        const request: E2eMementoRequest = {
            nonce: "n1",
            store: "memento",
            operation: "seed",
            scope: "workspace",
            key: "intelligit.notAllowlisted",
            value: "x",
        };
        const response = await handleMementoRequest(context, request);
        expect(response).toEqual({
            nonce: "n1",
            ok: false,
            error: expect.stringContaining("not allowlisted"),
        });
        expect(context.workspaceState.get("intelligit.notAllowlisted")).toBeUndefined();
    });

    it("rejects an unlisted global key", async () => {
        const { context } = makeContext();
        const response = await handleMementoRequest(context, {
            nonce: "n1",
            store: "memento",
            operation: "snapshot",
            scope: "global",
            key: "intelligit.notAllowlisted",
        });
        expect(response.ok).toBe(false);
    });
});

describe("handleMementoRequest: seed -> snapshot -> reset -> snapshot", () => {
    it("round-trips a workspace-scoped key through the real memento", async () => {
        const { context } = makeContext();

        const seedResponse = await handleMementoRequest(context, {
            nonce: "n1",
            store: "memento",
            operation: "seed",
            scope: "workspace",
            key: ALLOWED_WORKSPACE_KEY,
            value: "/repo/root",
        });
        expect(seedResponse).toEqual({ nonce: "n1", ok: true });

        const snapshotAfterSeed = await handleMementoRequest(context, {
            nonce: "n2",
            store: "memento",
            operation: "snapshot",
            scope: "workspace",
            key: ALLOWED_WORKSPACE_KEY,
        });
        expect(snapshotAfterSeed).toEqual({
            nonce: "n2",
            ok: true,
            result: { kind: "value", value: "/repo/root" },
        });

        const resetResponse = await handleMementoRequest(context, {
            nonce: "n3",
            store: "memento",
            operation: "reset",
            scope: "workspace",
            key: ALLOWED_WORKSPACE_KEY,
        });
        expect(resetResponse).toEqual({ nonce: "n3", ok: true });

        const snapshotAfterReset = await handleMementoRequest(context, {
            nonce: "n4",
            store: "memento",
            operation: "snapshot",
            scope: "workspace",
            key: ALLOWED_WORKSPACE_KEY,
        });
        expect(snapshotAfterReset).toEqual({
            nonce: "n4",
            ok: true,
            result: { kind: "value", value: null },
        });
    });

    it("round-trips a global-scoped key independently of workspace state", async () => {
        const { context } = makeContext();

        await handleMementoRequest(context, {
            nonce: "n1",
            store: "memento",
            operation: "seed",
            scope: "global",
            key: ALLOWED_GLOBAL_KEY,
            value: "dismissed",
        });

        const globalSnapshot = await handleMementoRequest(context, {
            nonce: "n2",
            store: "memento",
            operation: "snapshot",
            scope: "global",
            key: ALLOWED_GLOBAL_KEY,
        });
        expect(globalSnapshot).toMatchObject({ result: { value: "dismissed" } });

        const workspaceSnapshot = await handleMementoRequest(context, {
            nonce: "n3",
            store: "memento",
            operation: "snapshot",
            scope: "workspace",
            key: ALLOWED_WORKSPACE_KEY,
        });
        expect(workspaceSnapshot).toMatchObject({ result: { value: null } });
    });

    it("snapshot reflects state seeded directly (not only through the handler)", async () => {
        // Guards against a handler that returns a constant instead of reading the real store.
        const { context } = makeContext();
        await context.workspaceState.update(ALLOWED_WORKSPACE_KEY, "/pre-seeded/root");

        const response = await handleMementoRequest(context, {
            nonce: "n1",
            store: "memento",
            operation: "snapshot",
            scope: "workspace",
            key: ALLOWED_WORKSPACE_KEY,
        });
        expect(response).toEqual({
            nonce: "n1",
            ok: true,
            result: { kind: "value", value: "/pre-seeded/root" },
        });
    });
});
