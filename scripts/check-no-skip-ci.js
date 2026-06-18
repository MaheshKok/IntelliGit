/**
 * Guard that blocks CI-skip directives from entering main through a PR merge.
 *
 * GitHub silently creates zero workflow runs for a push whose resulting commit
 * message contains a skip token, and a squash merge concatenates every branch
 * commit subject into the merge commit body -- so a token in ANY PR commit (or in
 * the PR title, which becomes the default squash subject) can suppress the
 * push-to-main deploy. This script runs as a required pull_request status check:
 * it scans every PR commit message plus the PR title and body and exits non-zero
 * if a skip token is present, which blocks the merge.
 */

const { execFileSync } = require("node:child_process");

// GitHub's recognized skip tokens, matched case-insensitively in their exact
// bracketed form. GitHub matches these as exact case-insensitive substrings of
// the resulting commit message; it does NOT normalize inner whitespace, so
// `[ skip ci ]` or `[skip  ci]` do not suppress a run and are deliberately not
// flagged here. Mirroring GitHub's exact tokens keeps the guard aligned with the
// real trigger and avoids blocking PRs whose prose merely mentions the phrase.
// Source: GitHub Actions docs, "Skipping workflow runs".
const SKIP_TOKEN_PATTERN = /\[(?:skip ci|ci skip|no ci|skip actions|actions skip)\]/i;

// GitHub populates pull_request base.sha / head.sha with full 40-char SHA-1
// commit hashes (64 chars under SHA-256). Validating the format before handing
// the value to git rejects any non-hash string -- in particular one beginning
// with `-`, which git would otherwise treat as an option rather than a revision.
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;

// `%x00` tells git to emit a NUL byte after each commit body; NUL is used to
// split the output because it cannot occur inside a commit message (spaces and
// newlines can, so they would split a single message into many fragments).
const COMMIT_RECORD_SEPARATOR = String.fromCharCode(0);

/**
 * Reports whether the given text contains a GitHub CI-skip directive.
 *
 * @param {unknown} text Arbitrary text (commit message, PR title, or PR body).
 * @returns {boolean} True if a bracketed skip token is present, otherwise false.
 */
function containsSkipDirective(text) {
    if (typeof text !== "string" || text.length === 0) {
        return false;
    }
    return SKIP_TOKEN_PATTERN.test(text);
}

/**
 * Returns the full message of every commit in the exclusive range base..head.
 *
 * @param {string} baseSha The base branch tip SHA (excluded from the range).
 * @param {string} headSha The PR head SHA (included in the range).
 * @param {string} [cwd] Directory to run git in (defaults to the current dir).
 * @returns {string[]} One entry per commit, each the full `%B` message body.
 */
function getCommitMessages(baseSha, headSha, cwd = process.cwd()) {
    const output = execFileSync("git", ["log", "--format=%B%x00", `${baseSha}..${headSha}`], {
        cwd,
        encoding: "utf8",
    });
    return output
        .split(COMMIT_RECORD_SEPARATOR)
        .map((message) => message.trim())
        .filter((message) => message.length > 0);
}

/**
 * Finds every PR text source that would land in the squash merge commit and
 * contains a skip token.
 *
 * @param {object} input Scan inputs.
 * @param {string} input.prTitle The PR title (default squash commit subject).
 * @param {string} input.prBody The PR body.
 * @param {string[]} input.commitMessages Full messages of the PR's commits.
 * @returns {string[]} Human-readable descriptions of each offending source.
 */
function findOffenders({ prTitle, prBody, commitMessages }) {
    const offenders = [];
    if (containsSkipDirective(prTitle)) {
        offenders.push(`PR title: ${prTitle}`);
    }
    if (containsSkipDirective(prBody)) {
        offenders.push("PR body");
    }
    for (const message of commitMessages) {
        if (containsSkipDirective(message)) {
            offenders.push(`commit: ${message.split("\n")[0]}`);
        }
    }
    return offenders;
}

/**
 * Entry point: reads PR context from the environment, scans it, and exits
 * non-zero (failing the required check) if any skip token is found. Fails closed
 * on any error so an unscanned change can never be merged.
 *
 * @returns {void}
 */
function main() {
    const baseSha = process.env.BASE_SHA;
    const headSha = process.env.HEAD_SHA;
    if (!baseSha || !headSha) {
        console.error(
            "check-no-skip-ci: BASE_SHA and HEAD_SHA must be set (expected on a pull_request event).",
        );
        process.exit(1);
    }

    if (!COMMIT_SHA_PATTERN.test(baseSha) || !COMMIT_SHA_PATTERN.test(headSha)) {
        console.error(
            "check-no-skip-ci: BASE_SHA and HEAD_SHA must be commit SHA hashes. " +
                "Failing closed to avoid passing an unexpected value to git.",
        );
        process.exit(1);
    }

    let commitMessages;
    try {
        commitMessages = getCommitMessages(baseSha, headSha);
    } catch (error) {
        console.error(
            `check-no-skip-ci: failed to read PR commits (${error.message}). ` +
                "Failing closed to avoid merging an unscanned change.",
        );
        process.exit(1);
    }

    const offenders = findOffenders({
        prTitle: process.env.PR_TITLE || "",
        prBody: process.env.PR_BODY || "",
        commitMessages,
    });

    if (offenders.length > 0) {
        console.error(
            "check-no-skip-ci: CI-skip directive found. A squash merge would inline this " +
                "into main's commit message and suppress the deploy:",
        );
        for (const offender of offenders) {
            console.error(`  - ${offender}`);
        }
        console.error(
            "\nRemove the bracketed skip token from the listed source(s) before merging.",
        );
        process.exit(1);
    }

    console.log("check-no-skip-ci: no CI-skip directives found in PR commits, title, or body.");
}

if (require.main === module) {
    main();
}

module.exports = {
    SKIP_TOKEN_PATTERN,
    containsSkipDirective,
    getCommitMessages,
    findOffenders,
};
