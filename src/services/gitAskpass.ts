import { execFile } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { getErrorMessage } from "../utils/errors";

/**
 * Credentials passed to Git through a temporary askpass script instead of command-line URLs.
 *
 * Callers must provide short-lived provider credentials where possible. The
 * values are exposed only to the spawned Git process environment and are never
 * interpolated into remote URLs or user-visible messages by this service.
 */
export interface GitAskpassAuth {
    /** Username Git should receive when it asks for HTTPS credentials. */
    username: string;
    /** Secret token or password returned only from the generated askpass script. */
    token: string;
}

type GitAskpassEnv = Record<string, string> & { askpassDir: string };

/**
 * Runs a Git command with non-interactive HTTPS credentials supplied by askpass.
 *
 * The temporary script directory is removed in a `finally` block after Git exits.
 * Git failures are propagated with stderr/stdout detail so UI services can show
 * provider-specific errors without this helper deciding how to notify users.
 *
 * @param cwd - Absolute or process-relative working directory for the Git process.
 * @param args - Argument vector passed to `git`; do not include credentials in these values.
 */
export async function runGitCommandWithAskpass(
    cwd: string,
    args: string[],
    auth: GitAskpassAuth,
): Promise<void> {
    const env = await createAskpassEnv(auth);
    try {
        await runGitCommand(cwd, args, env);
    } finally {
        await fs.rm(env.askpassDir, { recursive: true, force: true }).catch(() => undefined);
    }
}

/**
 * Creates the platform-specific askpass script and environment for a single Git invocation.
 *
 * On any write or permission failure the partially created directory is removed
 * before the original error is rethrown, preventing stale credential scripts in
 * the system temp directory.
 */
async function createAskpassEnv(auth: GitAskpassAuth): Promise<GitAskpassEnv> {
    const askpassDir = await fs.mkdtemp(path.join(os.tmpdir(), "intelligit-askpass-"));
    const isWindows = process.platform === "win32";
    const askpassPath = path.join(askpassDir, isWindows ? "askpass.cmd" : "askpass.sh");
    const script = isWindows
        ? [
              "@echo off",
              "echo %1 | findstr /i Username >nul",
              "if not errorlevel 1 (",
              "  <nul set /p=%INTELLIGIT_GIT_USERNAME%",
              ") else (",
              "  <nul set /p=%INTELLIGIT_GIT_TOKEN%",
              ")",
              "",
          ].join("\r\n")
        : [
              "#!/bin/sh",
              'case "$1" in',
              '*Username*) printf "%s" "$INTELLIGIT_GIT_USERNAME" ;;',
              '*) printf "%s" "$INTELLIGIT_GIT_TOKEN" ;;',
              "esac",
              "",
          ].join("\n");

    try {
        await fs.writeFile(askpassPath, script, { mode: 0o700 });
        if (!isWindows) {
            await fs.chmod(askpassPath, 0o700);
        }
    } catch (err) {
        await fs.rm(askpassDir, { recursive: true, force: true }).catch(() => undefined);
        throw err;
    }

    return {
        askpassDir,
        GIT_ASKPASS: askpassPath,
        GIT_TERMINAL_PROMPT: "0",
        INTELLIGIT_GIT_USERNAME: auth.username,
        INTELLIGIT_GIT_TOKEN: auth.token,
    };
}

/**
 * Spawns `git` with inherited process environment plus askpass overrides.
 *
 * Terminal prompting is disabled by the caller-provided environment, so rejected
 * credentials fail fast and return the concise Git error output to the caller.
 */
function runGitCommand(cwd: string, args: string[], env: Record<string, string>): Promise<void> {
    return new Promise((resolve, reject) => {
        execFile(
            "git",
            args,
            {
                cwd,
                env: { ...process.env, ...env },
                windowsHide: true,
            },
            (err, stdout, stderr) => {
                if (err) {
                    const detail =
                        stderr.trim() || stdout.trim() || err.message || getErrorMessage(err);
                    reject(new Error(detail.trim() || "Git command failed"));
                    return;
                }
                resolve();
            },
        );
    });
}
