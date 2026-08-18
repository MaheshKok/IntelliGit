// Spec-derived tests for the E2E control channel's packaging gate: "Nothing added to
// package.json contributes ... a packaging test asserts the produced .vsix manifest contains
// no control command" (PLAN.md Phase 1 step 10). `vsce package` copies `contributes`
// verbatim into the produced manifest, so checking the checked-in package.json is a direct,
// sufficient proxy. The primary case is the real repository file: this suite fails loudly if
// a control command is ever actually added to it, not just against synthetic fixtures.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    diffCommandInventory,
    findE2eCommands,
    verifyNoE2eManifestCommand,
} from "../../../scripts/verifyNoE2eManifestCommand.js";

const SCRIPT_PATH = resolve(__dirname, "../../../scripts/verifyNoE2eManifestCommand.js");

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

    it("enforces the guard when invoked as a subprocess", () => {
        const forbiddenPackageJsonPath = seedPackageJson({
            commands: [{ command: "intelligit.e2eControlChannel.seed", title: "Seed" }],
        });
        const forbiddenRun = spawnSync(process.execPath, [SCRIPT_PATH, forbiddenPackageJsonPath], {
            encoding: "utf8",
        });

        expect(forbiddenRun.status).not.toBe(0);
        expect(forbiddenRun.stderr).toContain("packaging check failed");

        const repositoryRun = spawnSync(process.execPath, [SCRIPT_PATH], { encoding: "utf8" });
        expect(repositoryRun.status).toBe(0);
        expect(repositoryRun.stdout).toContain("no E2E control-channel command is contributed");
    });

    it("passes when contributes.commands is absent entirely", () => {
        const packageJsonPath = seedPackageJson(undefined);
        expect(verifyNoE2eManifestCommand({ packageJsonPath, knownCommands: [] })).toEqual({
            ok: true,
            errors: [],
        });
    });

    it("passes when contributes.commands is empty", () => {
        const packageJsonPath = seedPackageJson({ commands: [] });
        expect(verifyNoE2eManifestCommand({ packageJsonPath, knownCommands: [] })).toEqual({
            ok: true,
            errors: [],
        });
    });

    it("passes for ordinary, unrelated commands that are pinned", () => {
        const packageJsonPath = seedPackageJson({
            commands: [{ command: "intelligit.refresh", title: "Refresh" }],
        });
        expect(
            verifyNoE2eManifestCommand({ packageJsonPath, knownCommands: ["intelligit.refresh"] }),
        ).toEqual({ ok: true, errors: [] });
    });

    it("fails when a command id names the E2E control channel", () => {
        const packageJsonPath = seedPackageJson({
            commands: [{ command: "intelligit.e2eControlChannel.seed", title: "Seed" }],
        });
        // Pinned on purpose, so only the name pattern can be what fails here.
        const result = verifyNoE2eManifestCommand({
            packageJsonPath,
            knownCommands: ["intelligit.e2eControlChannel.seed"],
        });
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
        const result = verifyNoE2eManifestCommand({
            packageJsonPath,
            knownCommands: ["intelligit.controlChannel.snapshot"],
        });
        expect(result.ok).toBe(false);
        expect(result.errors[0]).toContain("intelligit.controlChannel.snapshot");
    });

    it("fails when only the title (not the command id) mentions E2E", () => {
        // A command author could pick an innocuous-looking id while the palette label still
        // gives the control surface away -- both must be checked.
        const packageJsonPath = seedPackageJson({
            commands: [
                { command: "intelligit.internalDebug", title: "IntelliGit: E2E Seed State" },
            ],
        });
        const result = verifyNoE2eManifestCommand({
            packageJsonPath,
            knownCommands: ["intelligit.internalDebug"],
        });
        expect(result.ok).toBe(false);
    });

    it("fails when only the category mentions E2E", () => {
        const packageJsonPath = seedPackageJson({
            commands: [{ command: "intelligit.internalDebug", title: "Seed", category: "E2E" }],
        });
        expect(
            verifyNoE2eManifestCommand({
                packageJsonPath,
                knownCommands: ["intelligit.internalDebug"],
            }).ok,
        ).toBe(false);
    });

    it("is case-insensitive", () => {
        const packageJsonPath = seedPackageJson({
            commands: [{ command: "intelligit.E2E.reset", title: "Reset" }],
        });
        expect(
            verifyNoE2eManifestCommand({ packageJsonPath, knownCommands: ["intelligit.E2E.reset"] })
                .ok,
        ).toBe(false);
    });

    it("reports every offending command, not just the first", () => {
        const packageJsonPath = seedPackageJson({
            commands: [
                { command: "intelligit.e2e.seed", title: "Seed" },
                { command: "intelligit.ok", title: "Fine" },
                { command: "intelligit.e2e.reset", title: "Reset" },
            ],
        });
        const result = verifyNoE2eManifestCommand({
            packageJsonPath,
            knownCommands: ["intelligit.e2e.seed", "intelligit.ok", "intelligit.e2e.reset"],
        });
        expect(result.errors).toHaveLength(2);
    });
});

/**
 * The case the name pattern cannot see. A control entry point does not have to announce
 * itself: `intelligit.internalDebug` titled "Seed", with no category, reads as an ordinary
 * command to any rule that classifies a command from the words its author chose, while
 * dispatching exactly the surface this gate exists to keep out of the manifest.
 *
 * These tests assert both halves -- that the pattern really is blind to it, and that the gate
 * still fails -- so the pattern's blindness is stated as a fact of the design rather than left
 * as an assumption. Deleting the inventory rule turns the second assertion red while the first
 * keeps passing.
 */
describe("verifyNoE2eManifestCommand: a control command with neutral metadata", () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "intelligit-e2e-packaging-bypass-"));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    const NEUTRAL_COMMAND = { command: "intelligit.internalDebug", title: "Seed" };

    function seedNeutralPackageJson(): string {
        const path = join(dir, "package.json");
        writeFileSync(
            path,
            JSON.stringify({ name: "fixture", contributes: { commands: [NEUTRAL_COMMAND] } }),
            "utf8",
        );
        return path;
    }

    it("is invisible to the name pattern", () => {
        expect(findE2eCommands({ contributes: { commands: [NEUTRAL_COMMAND] } })).toEqual([]);
    });

    it("still fails the gate, because it was never classified", () => {
        const result = verifyNoE2eManifestCommand({
            packageJsonPath: seedNeutralPackageJson(),
            knownCommands: [],
        });
        expect(result.ok).toBe(false);
        expect(result.errors[0]).toContain("intelligit.internalDebug");
        expect(result.errors[0]).toContain("unclassified");
    });

    it("passes once it is classified, so the gate is not simply always red", () => {
        const result = verifyNoE2eManifestCommand({
            packageJsonPath: seedNeutralPackageJson(),
            knownCommands: ["intelligit.internalDebug"],
        });
        expect(result).toEqual({ ok: true, errors: [] });
    });
});

describe("diffCommandInventory: both directions", () => {
    it("reports a contributed command missing from the pin", () => {
        const diff = diffCommandInventory(
            { contributes: { commands: [{ command: "a" }, { command: "b" }] } },
            ["a"],
        );
        expect(diff).toEqual({ unpinned: ["b"], stale: [] });
    });

    /**
     * Without this direction a rename passes silently: the old id stays pinned, vouching for a
     * command that no longer exists, and the pin drifts out of agreement with the manifest one
     * entry at a time until it is describing a different extension.
     */
    it("reports a pinned command the manifest no longer contributes", () => {
        const diff = diffCommandInventory({ contributes: { commands: [{ command: "a" }] } }, [
            "a",
            "removed",
        ]);
        expect(diff).toEqual({ unpinned: [], stale: ["removed"] });
    });

    it("treats a missing contributes block as contributing nothing", () => {
        expect(diffCommandInventory({}, [])).toEqual({ unpinned: [], stale: [] });
    });
});

/**
 * Where the gate actually runs. `vsce package` and `vsce publish` both execute
 * `vscode:prepublish` before building the .vsix and halt on a non-zero exit, so that hook is
 * the one place a packaging check is guaranteed to be reached -- including when someone runs
 * `vsce package` by hand, outside CI entirely.
 */
describe("verifyNoE2eManifestCommand: packaging lifecycle wiring", () => {
    it("runs from vscode:prepublish, which vsce executes before packaging or publishing", () => {
        const packageJson = JSON.parse(
            readFileSync(join(process.cwd(), "package.json"), "utf8"),
        ) as { scripts?: Record<string, string> };

        expect(
            packageJson.scripts?.["vscode:prepublish"] ?? "",
            "a packaging gate that no packaging command runs is not a gate; vsce runs " +
                "vscode:prepublish for both `vsce package` and `vsce publish` and halts on a " +
                "non-zero exit",
        ).toContain("verifyNoE2eManifestCommand");
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
