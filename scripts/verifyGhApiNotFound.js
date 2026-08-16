#!/usr/bin/env node
"use strict";

const fs = require("node:fs");

const EXACT_NOT_FOUND = "gh: Not Found (HTTP 404)";

/**
 * Recognizes only GitHub CLI's unambiguous missing-resource diagnostic.
 *
 * @param {string} diagnostic Captured standard error from `gh api`.
 * @returns {boolean} Whether the diagnostic is exactly one HTTP 404 line.
 */
function isExactGhApiNotFound(diagnostic) {
    return diagnostic === EXACT_NOT_FOUND || diagnostic === `${EXACT_NOT_FOUND}\n`;
}

/** Fails closed unless the supplied file contains exactly one GitHub 404 diagnostic. */
function main() {
    const [diagnosticPath] = process.argv.slice(2);
    if (diagnosticPath === undefined) {
        throw new Error("Usage: node scripts/verifyGhApiNotFound.js <stderr-file>");
    }
    const diagnostic = fs.readFileSync(diagnosticPath, "utf8");
    if (!isExactGhApiNotFound(diagnostic)) {
        process.stderr.write(diagnostic);
        throw new Error("GitHub API failure was not an unambiguous HTTP 404");
    }
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(`verifyGhApiNotFound: ${error.message}`);
        process.exitCode = 1;
    }
}

module.exports = { isExactGhApiNotFound };
