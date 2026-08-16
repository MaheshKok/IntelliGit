#!/usr/bin/env node
"use strict";

const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/**
 * Parses the stable SemVer form used by IntelliGit releases.
 *
 * Prerelease and build metadata are rejected deliberately: the release workflow
 * has no channel semantics for them, so treating them as ordinary production
 * versions would make ordering ambiguous.
 *
 * @param {string} version Candidate stable version.
 * @returns {readonly [bigint, bigint, bigint]} Exact major, minor, and patch components.
 * @throws {Error} If the value is not a canonical stable SemVer.
 */
function parseStableVersion(version) {
    const match = STABLE_SEMVER.exec(version);
    if (!match) {
        throw new Error(`Release version "${version}" must be a canonical stable SemVer (X.Y.Z).`);
    }
    return [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])];
}

/**
 * Compares two canonical stable SemVer values.
 *
 * @param {string} left First version.
 * @param {string} right Second version.
 * @returns {-1|0|1} Ordering of left relative to right.
 */
function compareStableVersions(left, right) {
    const leftParts = parseStableVersion(left);
    const rightParts = parseStableVersion(right);
    for (let index = 0; index < leftParts.length; index += 1) {
        if (leftParts[index] < rightParts[index]) return -1;
        if (leftParts[index] > rightParts[index]) return 1;
    }
    return 0;
}

/**
 * Fails unless a normal release moves strictly forward.
 *
 * The explicit force-publish recovery path is checked separately by the
 * workflow and is allowed only while every registry still reports unpublished.
 *
 * @param {string} previousVersion Version at the previous main commit.
 * @param {string} currentVersion Version being considered for release.
 * @returns {void}
 * @throws {Error} If the transition is equal, backward, or unsupported.
 */
function assertForwardStableRelease(previousVersion, currentVersion) {
    if (compareStableVersions(previousVersion, currentVersion) >= 0) {
        throw new Error(
            `Current version ${currentVersion} must be greater than previous version ${previousVersion}.`,
        );
    }
}

/**
 * Fails unless an explicit recovery republishes the same stable version.
 *
 * @param {string} previousVersion Version at the comparison commit.
 * @param {string} currentVersion Version requested for recovery.
 * @returns {void}
 * @throws {Error} If either value is unsupported or the versions differ.
 */
function assertSameStableRelease(previousVersion, currentVersion) {
    if (compareStableVersions(previousVersion, currentVersion) !== 0) {
        throw new Error(
            `Force-publish version ${currentVersion} must equal previous version ${previousVersion}.`,
        );
    }
}

/** Runs the release-transition check for the workflow shell step. */
function main() {
    const args = process.argv.slice(2);
    const requireEqual = args[0] === "--require-equal";
    const [previousVersion, currentVersion] = requireEqual ? args.slice(1) : args;
    if (previousVersion === undefined || currentVersion === undefined) {
        throw new Error(
            "Usage: node scripts/verifyReleaseVersion.js [--require-equal] <previous> <current>",
        );
    }
    if (requireEqual) {
        assertSameStableRelease(previousVersion, currentVersion);
    } else {
        assertForwardStableRelease(previousVersion, currentVersion);
    }
    console.log(`Release version transition verified: ${previousVersion} -> ${currentVersion}`);
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(`verifyReleaseVersion: ${error.message}`);
        process.exitCode = 1;
    }
}

module.exports = {
    assertForwardStableRelease,
    assertSameStableRelease,
    compareStableVersions,
    parseStableVersion,
};
