import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as vscode from "vscode";

import { resolveGitBinary } from "../git/executor";
import { logGitOpsWarning } from "../git/operationSupport";

/**
 * Git 2.31 added `rev-parse --path-format=absolute`, which merge resolution, partial commits
 * and shelf restore rely on.
 */
const MINIMUM_GIT = { major: 2, minor: 31 };

/**
 * Returns the version `git --version` reported when it is older than the minimum.
 *
 * Returns `undefined` when Git is new enough, and also when the output names no version: an
 * unreadable answer is not evidence of an old Git, so it never triggers the warning.
 */
export function outdatedGitVersion(versionOutput: string): string | undefined {
    const match = /git version ((\d+)\.(\d+)\S*)/.exec(versionOutput);
    if (!match) return undefined;
    const major = Number(match[2]);
    const minor = Number(match[3]);
    const outdated =
        major < MINIMUM_GIT.major || (major === MINIMUM_GIT.major && minor < MINIMUM_GIT.minor);
    return outdated ? match[1] : undefined;
}

/** Asks the Git binary every executor spawns for its `git --version` line. */
export async function readGitVersion(): Promise<string> {
    const { stdout } = await promisify(execFile)(await resolveGitBinary(), ["--version"]);
    return stdout;
}

/**
 * Warns once per activation when the Git the extension spawns is older than the minimum.
 *
 * Activation fires this without awaiting it and never blocks on it, because everything except
 * the features that need the newer Git keeps working. It absorbs its own failures: when Git
 * cannot run at all, the features that spawn it report that themselves.
 */
export async function warnIfGitTooOld(
    readVersion: () => Promise<string> = readGitVersion,
): Promise<void> {
    try {
        const version = outdatedGitVersion(await readVersion());
        if (!version) return;
        void vscode.window.showWarningMessage(
            vscode.l10n.t(
                "IntelliGit needs Git {0} or later for merge resolution, partial commits and shelf restore, but found Git {1}. Update Git to use these features.",
                `${MINIMUM_GIT.major}.${MINIMUM_GIT.minor}`,
                version,
            ),
        );
    } catch (err) {
        logGitOpsWarning("Git version check", err);
    }
}
