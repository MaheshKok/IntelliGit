#!/usr/bin/env node
// Build-provenance gate: proves every declared build output is not merely
// present, but actually came from the invocation recorded in
// dist/.build-manifest.json. Presence alone is not enough -- a stale bundle
// left over from an earlier build satisfies an existence check while
// silently testing old code. See PLAN.md Phase 0 step 2.

const fs = require("fs");
const path = require("path");
const { MANIFEST_FILENAME, hashFileContents, readManifest } = require("./buildManifest");

const DEFAULT_DIST_DIR = path.resolve(__dirname, "../dist");

/**
 * Verifies that every output recorded in the build manifest still exists at
 * its manifest-recorded path, with a current content hash matching the
 * recorded hash -- i.e. it really is an output of the build that wrote the
 * manifest, not a stale artifact from an earlier or different build.
 *
 * @param {object} [input] Verification inputs.
 * @param {string} [input.distDir] Absolute path to the build output directory.
 *   Defaults to the repository's real dist/ directory.
 * @returns {{ok: boolean, errors: string[], manifest: {schemaVersion: number, builtAt: string, files: {path: string, hash: string}[]} | null}}
 *   `ok` is true only when a manifest was found and every declared output
 *   exists with a matching hash. `errors` explains every failure found, not
 *   just the first.
 */
function verifyBuildProvenance({ distDir = DEFAULT_DIST_DIR } = {}) {
    let manifest;
    try {
        manifest = readManifest(distDir);
    } catch (error) {
        return { ok: false, errors: [error.message], manifest: null };
    }

    if (manifest === null) {
        return {
            ok: false,
            errors: [
                `No build manifest found at ${path.join(distDir, MANIFEST_FILENAME)}. Run the build first.`,
            ],
            manifest: null,
        };
    }

    if (manifest.files.length === 0) {
        return {
            ok: false,
            errors: ["Build manifest declares zero output files -- refusing to pass vacuously."],
            manifest,
        };
    }

    const errors = [];
    for (const { path: relativePath, hash: expectedHash } of manifest.files) {
        const absolutePath = path.join(distDir, ...relativePath.split("/"));
        if (!fs.existsSync(absolutePath)) {
            errors.push(`Missing declared output: ${relativePath}`);
            continue;
        }
        const actualHash = hashFileContents(absolutePath);
        if (actualHash !== expectedHash) {
            errors.push(
                `Stale declared output: ${relativePath} -- content hash does not match the ` +
                    "build manifest, so this file did not come from that build",
            );
        }
    }

    return { ok: errors.length === 0, errors, manifest };
}

/**
 * CLI entry point: verifies dist/ against dist/.build-manifest.json and exits
 * non-zero, with every failure reason printed, if anything is missing or stale.
 *
 * @returns {void}
 */
function main() {
    const { ok, errors } = verifyBuildProvenance();
    if (!ok) {
        console.error("verifyBuildProvenance: build provenance check failed:");
        for (const error of errors) {
            console.error(`  - ${error}`);
        }
        process.exit(1);
    }
    console.log("verifyBuildProvenance: every declared output matches the build manifest.");
}

if (require.main === module) {
    main();
}

module.exports = { verifyBuildProvenance };
