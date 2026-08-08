// Spec-derived tests for the E2E control channel's packaging gate: "Nothing added to
// package.json contributes ... a packaging test asserts the produced .vsix manifest contains
// no control command" (PLAN.md Phase 1 step 10). `vsce package` copies `contributes`
// verbatim into the produced manifest, so checking the checked-in package.json is a direct,
// sufficient proxy. The primary case is the real repository file: this suite fails loudly if
// a control command is ever actually added to it, not just against synthetic fixtures.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    findE2eCommands,
    verifyNoE2eManifestCommand,
} from "../../../scripts/verifyNoE2eManifestCommand.js";

describe("verifyNoE2eManifestCommand: the real repository package.json", () => {
    it("passes against the actual checked-in package.json", () => {
        const result = verifyNoE2eManifestCommand();
        expect(result).toEqual({ ok: true, errors: [] });
    });
});

describe("verifyNoE2eManifestCommand: synthetic fixtures", () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "intelligit-e2e-packaging-test-"));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    function seedPackageJson(contributes: unknown): string {
        const path = join(dir, "package.json");
        writeFileSync(path, JSON.stringify({ name: "fixture", contributes }), "utf8");
        return path;
    }

    it("passes when contributes.commands is absent entirely", () => {
        const packageJsonPath = seedPackageJson(undefined);
        expect(verifyNoE2eManifestCommand({ packageJsonPath })).toEqual({ ok: true, errors: [] });
    });

    it("passes when contributes.commands is empty", () => {
        const packageJsonPath = seedPackageJson({ commands: [] });
        expect(verifyNoE2eManifestCommand({ packageJsonPath })).toEqual({ ok: true, errors: [] });
    });

    it("passes for ordinary, unrelated commands", () => {
        const packageJsonPath = seedPackageJson({
            commands: [{ command: "intelligit.refresh", title: "Refresh" }],
        });
        expect(verifyNoE2eManifestCommand({ packageJsonPath })).toEqual({ ok: true, errors: [] });
    });

    it("fails when a command id names the E2E control channel", () => {
        const packageJsonPath = seedPackageJson({
            commands: [{ command: "intelligit.e2eControlChannel.seed", title: "Seed" }],
        });
        const result = verifyNoE2eManifestCommand({ packageJsonPath });
        expect(result.ok).toBe(false);
        expect(result.errors[0]).toContain("intelligit.e2eControlChannel.seed");
    });

    it("fails when the command names the control channel without the string 'e2e'", () => {
        // The guard's whole purpose is blocking this surface, and PLAN.md step 10 calls it
        // the "control channel" with seed/snapshot/reset operations -- never "e2e". A
        // pattern matching only /e2e/ would let the plan's own vocabulary walk straight past.
        const packageJsonPath = seedPackageJson({
            commands: [{ command: "intelligit.controlChannel.snapshot", title: "Snapshot state" }],
        });
        const result = verifyNoE2eManifestCommand({ packageJsonPath });
        expect(result.ok).toBe(false);
        expect(result.errors[0]).toContain("intelligit.controlChannel.snapshot");
    });

    it("fails when only the title (not the command id) mentions E2E", () => {
        // A command author could pick an innocuous-looking id while the palette label still
        // gives the control surface away -- both must be checked.
        const packageJsonPath = seedPackageJson({
            commands: [{ command: "intelligit.internalDebug", title: "IntelliGit: E2E Seed State" }],
        });
        const result = verifyNoE2eManifestCommand({ packageJsonPath });
        expect(result.ok).toBe(false);
    });

    it("fails when only the category mentions E2E", () => {
        const packageJsonPath = seedPackageJson({
            commands: [{ command: "intelligit.internalDebug", title: "Seed", category: "E2E" }],
        });
        expect(verifyNoE2eManifestCommand({ packageJsonPath }).ok).toBe(false);
    });

    it("is case-insensitive", () => {
        const packageJsonPath = seedPackageJson({
            commands: [{ command: "intelligit.E2E.reset", title: "Reset" }],
        });
        expect(verifyNoE2eManifestCommand({ packageJsonPath }).ok).toBe(false);
    });

    it("reports every offending command, not just the first", () => {
        const packageJsonPath = seedPackageJson({
            commands: [
                { command: "intelligit.e2e.seed", title: "Seed" },
                { command: "intelligit.ok", title: "Fine" },
                { command: "intelligit.e2e.reset", title: "Reset" },
            ],
        });
        const result = verifyNoE2eManifestCommand({ packageJsonPath });
        expect(result.errors).toHaveLength(2);
    });
});

describe("findE2eCommands", () => {
    it("returns an empty array for a package.json with no contributes block at all", () => {
        expect(findE2eCommands({})).toEqual([]);
    });

    it("returns an empty array when contributes.commands is not an array", () => {
        expect(findE2eCommands({ contributes: { commands: "not-an-array" } })).toEqual([]);
    });
});
