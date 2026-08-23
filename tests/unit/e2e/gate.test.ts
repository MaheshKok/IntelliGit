// Spec-derived tests for the E2E control channel's three-gate check (PLAN.md Phase 1 step
// 10): "Three independent gates, all required: ExtensionMode.Development, INTELLIGIT_E2E=1,
// and a channel directory that exists and is writable." This is the exact function the
// mandatory negative test targets: the gate itself, not a mock of it, must refuse to
// activate under ExtensionMode.Production even with the variable set and a real, writable
// directory present -- so this suite drives `evaluateE2eGate` directly with real temp
// directories rather than stubbing filesystem calls.

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POSIX_PERMISSIONS_ENFORCED } from "../../helpers/platformCapabilities";

// "vscode" has no runtime module outside the Extension Development Host; only the
// ExtensionMode enum's real numeric values are needed here.
vi.mock("vscode", () => ({
    ExtensionMode: { Production: 1, Development: 2, Test: 3 },
}));

import * as vscode from "vscode";
import { evaluateE2eGate } from "../../../src/e2e/gate";

describe("evaluateE2eGate: gating truth table", () => {
    let channelDir: string;

    beforeEach(() => {
        channelDir = mkdtempSync(join(tmpdir(), "intelligit-e2e-gate-test-"));
    });

    afterEach(() => {
        rmSync(channelDir, { recursive: true, force: true });
    });

    // All four cells of {Development, Production} x {INTELLIGIT_E2E=1, unset}. Exactly one
    // (Development + "1") may activate; the other three -- including the historically riskiest
    // one, Production with the variable set and the directory present -- must not.
    it("activates: Development + INTELLIGIT_E2E=1 + a real writable directory", () => {
        const result = evaluateE2eGate(vscode.ExtensionMode.Development, {
            INTELLIGIT_E2E: "1",
            INTELLIGIT_E2E_CHANNEL_DIR: channelDir,
        });
        expect(result.active).toBe(true);
        expect(result.channelDir).toBe(channelDir);
    });

    it("does NOT activate: Production + INTELLIGIT_E2E=1 + a real writable directory present", () => {
        // The mandated negative case: the two weaker gates both pass, and only the mode gate
        // stops it. If this ever activates, a marketplace install with the env var leaked into
        // its process would expose the control channel.
        const result = evaluateE2eGate(vscode.ExtensionMode.Production, {
            INTELLIGIT_E2E: "1",
            INTELLIGIT_E2E_CHANNEL_DIR: channelDir,
        });
        expect(result.active).toBe(false);
        expect(result.channelDir).toBeUndefined();
        expect(result.reason).toMatch(/ExtensionMode\.Development/);
    });

    it("does NOT activate: Production + INTELLIGIT_E2E unset", () => {
        const result = evaluateE2eGate(vscode.ExtensionMode.Production, {
            INTELLIGIT_E2E_CHANNEL_DIR: channelDir,
        });
        expect(result.active).toBe(false);
    });

    it("does NOT activate: Development + INTELLIGIT_E2E unset", () => {
        const result = evaluateE2eGate(vscode.ExtensionMode.Development, {
            INTELLIGIT_E2E_CHANNEL_DIR: channelDir,
        });
        expect(result.active).toBe(false);
        expect(result.reason).toMatch(/INTELLIGIT_E2E/);
    });
});

describe("evaluateE2eGate: channel directory gate", () => {
    it("does not activate when INTELLIGIT_E2E_CHANNEL_DIR is unset", () => {
        const result = evaluateE2eGate(vscode.ExtensionMode.Development, { INTELLIGIT_E2E: "1" });
        expect(result.active).toBe(false);
        expect(result.reason).toMatch(/INTELLIGIT_E2E_CHANNEL_DIR/);
    });

    it("does not activate when the directory does not exist", () => {
        const result = evaluateE2eGate(vscode.ExtensionMode.Development, {
            INTELLIGIT_E2E: "1",
            INTELLIGIT_E2E_CHANNEL_DIR: "/nonexistent/intelligit-e2e-channel-dir",
        });
        expect(result.active).toBe(false);
        expect(result.reason).toMatch(/not an existing directory/);
    });

    it("does not activate when the path exists but is a file, not a directory", () => {
        const dir = mkdtempSync(join(tmpdir(), "intelligit-e2e-gate-test-"));
        const filePath = join(dir, "not-a-directory");
        writeFileSync(filePath, "");
        try {
            const result = evaluateE2eGate(vscode.ExtensionMode.Development, {
                INTELLIGIT_E2E: "1",
                INTELLIGIT_E2E_CHANNEL_DIR: filePath,
            });
            expect(result.active).toBe(false);
            expect(result.reason).toMatch(/not an existing directory/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it.skipIf(!POSIX_PERMISSIONS_ENFORCED)(
        "does not activate when the directory exists but is not writable",
        () => {
            const dir = mkdtempSync(join(tmpdir(), "intelligit-e2e-gate-test-"));
            chmodSync(dir, 0o500);
            try {
                const result = evaluateE2eGate(vscode.ExtensionMode.Development, {
                    INTELLIGIT_E2E: "1",
                    INTELLIGIT_E2E_CHANNEL_DIR: dir,
                });
                expect(result.active).toBe(false);
                expect(result.reason).toMatch(/not writable/);
            } finally {
                chmodSync(dir, 0o700);
                rmSync(dir, { recursive: true, force: true });
            }
        },
    );

    it('rejects INTELLIGIT_E2E="true" -- only the literal string "1" satisfies the gate', () => {
        const dir = mkdtempSync(join(tmpdir(), "intelligit-e2e-gate-test-"));
        try {
            const result = evaluateE2eGate(vscode.ExtensionMode.Development, {
                INTELLIGIT_E2E: "true",
                INTELLIGIT_E2E_CHANNEL_DIR: dir,
            });
            expect(result.active).toBe(false);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
