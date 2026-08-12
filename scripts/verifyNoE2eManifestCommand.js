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
const DEFAULT_KNOWN_COMMANDS_PATH = path.resolve(__dirname, "knownManifestCommands.json");

// Broad and case-insensitive on purpose: a narrower pattern risks missing a
// differently-worded but still-forbidden control command. "e2e" alone is not enough --
// the channel's own vocabulary (PLAN.md Phase 1 step 10) is "control channel" with
// seed/snapshot/reset operations, so a contribution named for the operation rather than
// for E2E would have slipped through.
//
// This pattern is the SECOND net, never the only one. It classifies a command from the words
// its author chose, so it catches only an author who named the surface honestly:
// `intelligit.internalDebug` titled "Seed", with no category, dispatches the control channel
// and reads as ordinary here. Deliberate classification of every new command is what the
// inventory below enforces; this pattern just labels the obvious cases with a better message.
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
 * Lists every contributed command id absent from `knownCommands`, and every pinned id no
 * longer contributed. Both directions matter: without the second, a command could be renamed
 * and the pin would keep vouching for the id it replaced.
 *
 * @param {object} packageJson Parsed package.json contents.
 * @param {readonly string[]} knownCommands The pinned inventory.
 * @returns {{unpinned: string[], stale: string[]}}
 */
function diffCommandInventory(packageJson, knownCommands) {
    const commands = packageJson?.contributes?.commands;
    const contributed = new Set(
        (Array.isArray(commands) ? commands : [])
            .map((entry) => entry?.command)
            .filter((command) => typeof command === "string"),
    );
    const pinned = new Set(knownCommands);
    return {
        unpinned: [...contributed].filter((command) => !pinned.has(command)).sort(),
        stale: [...pinned].filter((command) => !contributed.has(command)).sort(),
    };
}

/**
 * Reads the pinned inventory file, returning its `commands` array.
 *
 * @param {string} knownCommandsPath Absolute path to the inventory JSON.
 * @returns {string[]}
 */
function readKnownCommands(knownCommandsPath) {
    const parsed = JSON.parse(fs.readFileSync(knownCommandsPath, "utf8"));
    if (!Array.isArray(parsed?.commands)) {
        throw new Error(`${knownCommandsPath} must contain a "commands" array`);
    }
    return parsed.commands;
}

/**
 * Verifies the checked-in package.json declares no E2E control-channel command.
 *
 * Two independent rules, because neither is sufficient alone:
 *
 *   1. The inventory pin. Every contributed command id must already be listed in
 *      `knownManifestCommands.json`. This is the rule that actually holds, because it does not
 *      care what a command is called: a control entry point with deliberately neutral metadata
 *      still turns this gate red, and turning it green again means editing the inventory in the
 *      same commit, where a reviewer sees a new command being admitted and can ask what it
 *      dispatches. That is the "deliberate classification" this gate is for.
 *   2. The name pattern. Purely a better error message for a command that names the surface
 *      openly, and a second net if the inventory is ever regenerated blindly.
 *
 * @param {object} [input] Verification inputs.
 * @param {string} [input.packageJsonPath] Absolute path to package.json.
 * @param {string} [input.knownCommandsPath] Absolute path to the pinned inventory JSON.
 * @param {readonly string[]} [input.knownCommands] The inventory itself, overriding the file.
 * @returns {{ok: boolean, errors: string[]}}
 */
function verifyNoE2eManifestCommand({
    packageJsonPath = DEFAULT_PACKAGE_JSON_PATH,
    knownCommandsPath = DEFAULT_KNOWN_COMMANDS_PATH,
    knownCommands,
} = {}) {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    const inventory = knownCommands ?? readKnownCommands(knownCommandsPath);

    const errors = findE2eCommands(packageJson).map(
        (command) => `contributes.commands declares an E2E control-channel command: ${command}`,
    );

    const { unpinned, stale } = diffCommandInventory(packageJson, inventory);
    for (const command of unpinned) {
        errors.push(
            `contributes.commands declares an unclassified command: ${command}. Confirm it does ` +
                `not dispatch the E2E control channel, then add it to ${path.basename(knownCommandsPath)}.`,
        );
    }
    for (const command of stale) {
        errors.push(
            `${path.basename(knownCommandsPath)} pins a command package.json no longer ` +
                `contributes: ${command}. Remove it, or the pin keeps vouching for an id that is gone.`,
        );
    }

    return errors.length === 0 ? { ok: true, errors: [] } : { ok: false, errors };
}

/**
 * CLI entry point: verifies package.json and exits non-zero, with every failure reason
 * printed, if an E2E control-channel command is contributed. An optional first argument
 * selects a package.json path for fixture and subprocess testing; without it, the checked-in
 * repository manifest is used.
 *
 * @returns {void}
 */
function main() {
    const packageJsonPath = process.argv[2];
    const { ok, errors } = verifyNoE2eManifestCommand(
        packageJsonPath === undefined ? {} : { packageJsonPath },
    );
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

module.exports = { diffCommandInventory, findE2eCommands, verifyNoE2eManifestCommand };
