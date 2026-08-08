#!/usr/bin/env node
// Packaging gate for the E2E control channel: package.json's `contributes.commands` must
// declare no control-channel command. `vsce package` copies `contributes` verbatim into the
// produced .vsix manifest, so palette visibility of a control command there would ship the
// exact surface the channel's runtime gating exists to hide (PLAN.md Phase 1 step 10). This
// checks the checked-in package.json directly rather than actually invoking `vsce package`,
// since that source is what the packaged manifest is a mechanical copy of.

const fs = require("fs");
const path = require("path");

const DEFAULT_PACKAGE_JSON_PATH = path.resolve(__dirname, "../package.json");

// Broad and case-insensitive on purpose: a narrower pattern risks missing a
// differently-worded but still-forbidden control command. "e2e" alone is not enough --
// the channel's own vocabulary (PLAN.md Phase 1 step 10) is "control channel" with
// seed/snapshot/reset operations, so a contribution named for the operation rather than
// for E2E would have slipped through.
const FORBIDDEN_PATTERN = /e2e|control.?channel/i;

/**
 * Scans `contributes.commands` for anything that looks like an E2E control-channel command.
 *
 * @param {object} packageJson Parsed package.json contents.
 * @returns {string[]} Every offending command id found, empty when none are.
 */
function findE2eCommands(packageJson) {
    const commands = packageJson?.contributes?.commands;
    if (!Array.isArray(commands)) {
        return [];
    }
    return commands
        .filter((entry) => {
            const haystack = [entry?.command, entry?.title, entry?.category]
                .filter((value) => typeof value === "string")
                .join(" ");
            return FORBIDDEN_PATTERN.test(haystack);
        })
        .map((entry) => String(entry?.command));
}

/**
 * Verifies the checked-in package.json declares no E2E control-channel command.
 *
 * @param {object} [input] Verification inputs.
 * @param {string} [input.packageJsonPath] Absolute path to package.json.
 * @returns {{ok: boolean, errors: string[]}}
 */
function verifyNoE2eManifestCommand({ packageJsonPath = DEFAULT_PACKAGE_JSON_PATH } = {}) {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    const offenders = findE2eCommands(packageJson);
    if (offenders.length === 0) {
        return { ok: true, errors: [] };
    }
    return {
        ok: false,
        errors: offenders.map(
            (command) => `contributes.commands declares an E2E control-channel command: ${command}`,
        ),
    };
}

/**
 * CLI entry point: verifies package.json and exits non-zero, with every failure reason
 * printed, if an E2E control-channel command is contributed.
 *
 * @returns {void}
 */
function main() {
    const { ok, errors } = verifyNoE2eManifestCommand();
    if (!ok) {
        console.error("verifyNoE2eManifestCommand: packaging check failed:");
        for (const error of errors) {
            console.error(`  - ${error}`);
        }
        process.exit(1);
    }
    console.log("verifyNoE2eManifestCommand: no E2E control-channel command is contributed.");
}

if (require.main === module) {
    main();
}

module.exports = { findE2eCommands, verifyNoE2eManifestCommand };
