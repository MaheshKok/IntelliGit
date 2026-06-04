import { execFile } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { getErrorMessage } from "../utils/errors";

export interface GitAskpassAuth {
    username: string;
    token: string;
}

type GitAskpassEnv = Record<string, string> & { askpassDir: string };

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
