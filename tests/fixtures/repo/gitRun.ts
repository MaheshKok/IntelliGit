/**
 * The one seam every snapshot module runs Git through (PLAN.md step 9's "every git subprocess
 * must use the sanitized environment" constraint). Mirrors `seed.ts`'s private `git()` helper --
 * read stdout as a buffer, decode explicitly -- but is exported, since every module in this
 * package needs it and `seed.ts` is not to be modified to export its own copy.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Runs one git process against `cwd` with the caller's sanitized `env`, returning trimmed UTF-8 stdout. */
export async function runGit(
    cwd: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
): Promise<string> {
    const result = await execFileAsync("git", [...args], { cwd, env, encoding: "buffer" });
    return result.stdout.toString("utf8").trim();
}

/** Runs one git process and returns raw, untrimmed UTF-8 stdout -- for NUL- or newline-delimited output. */
export async function runGitRaw(
    cwd: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
): Promise<string> {
    const result = await execFileAsync("git", [...args], { cwd, env, encoding: "buffer" });
    return result.stdout.toString("utf8");
}

/** Splits NUL-delimited git output (`-z`) into records, dropping the trailing empty record. */
export function splitNulRecords(raw: string): readonly string[] {
    const records = raw.split("\0");
    if (records.length > 0 && records[records.length - 1] === "") records.pop();
    return records;
}
