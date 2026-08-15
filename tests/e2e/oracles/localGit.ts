import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { FixtureWorkspace } from "../../fixtures/repo/harness";
import { sanitizedGitEnv } from "./gitEnv";

const execFileAsync = promisify(execFile);

/** One parsed entry from `git status --porcelain`. */
export interface GitStatusEntry {
    readonly indexStatus: string;
    readonly worktreeStatus: string;
    readonly path: string;
    readonly originalPath?: string;
}

type LocalGitWorkspace = Pick<FixtureWorkspace, "root" | "env">;

/** Parses porcelain-v1 NUL-delimited entries without exposing raw command output to a flow. */
export function parseStatusPorcelain(output: string): readonly GitStatusEntry[] {
    const tokens = output.split("\0").filter((token) => token.length > 0);
    const entries: GitStatusEntry[] = [];
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        const status = token.slice(0, 2);
        const path = token.slice(3);
        if (status.length !== 2 || token[2] !== " ") {
            continue;
        }
        if (status.includes("R") || status.includes("C")) {
            const originalPath = tokens[index + 1];
            if (originalPath !== undefined) {
                entries.push({
                    indexStatus: status[0],
                    worktreeStatus: status[1],
                    path,
                    originalPath,
                });
                index += 1;
                continue;
            }
        }
        entries.push({ indexStatus: status[0], worktreeStatus: status[1], path });
    }
    return entries;
}

async function runGit(workspace: LocalGitWorkspace, args: readonly string[]): Promise<string> {
    const result = await execFileAsync("git", [...args], {
        cwd: workspace.root,
        env: sanitizedGitEnv(workspace.env),
        maxBuffer: 1024 * 1024,
    });
    return result.stdout;
}

/** Reads the current HEAD subject directly from the fixture's working tree. */
export async function headSubject(workspace: LocalGitWorkspace): Promise<string> {
    return (await runGit(workspace, ["log", "-1", "--format=%s"])).trimEnd();
}

/** Reads the current HEAD object ID directly from the fixture's working tree. */
export async function headOid(workspace: LocalGitWorkspace): Promise<string> {
    return (await runGit(workspace, ["rev-parse", "HEAD"])).trim();
}

/** Reads every parent object ID of HEAD directly from the fixture's working tree. */
export async function headParentOids(workspace: LocalGitWorkspace): Promise<readonly string[]> {
    const parents = (await runGit(workspace, ["show", "-s", "--format=%P", "HEAD"])).trim();
    return parents.length === 0 ? [] : parents.split(/\s+/);
}

/** Reads the number of commits local `main` is ahead of and behind its configured upstream. */
export async function aheadBehindCounts(
    workspace: LocalGitWorkspace,
): Promise<{ readonly ahead: number; readonly behind: number }> {
    const output = (
        await runGit(workspace, [
            "rev-list",
            "--left-right",
            "--count",
            "main...@{upstream}",
        ])
    ).trim();
    const [ahead, behind] = output.split(/\s+/).map(Number);
    if (!Number.isInteger(ahead) || !Number.isInteger(behind)) {
        throw new Error(`Expected ahead/behind counts, got "${output}".`);
    }
    return { ahead, behind };
}

/** Checks ancestry through Git's commit graph without exposing subprocess failures to an oracle. */
export async function isAncestor(
    workspace: LocalGitWorkspace,
    ancestor: string,
    descendant: string,
): Promise<boolean> {
    try {
        await runGit(workspace, ["merge-base", "--is-ancestor", ancestor, descendant]);
        return true;
    } catch {
        return false;
    }
}

/** Lists every tracked path in HEAD so a flow can prove that a rebase preserved file content. */
export async function headTreePaths(workspace: LocalGitWorkspace): Promise<readonly string[]> {
    const output = (await runGit(workspace, ["ls-tree", "--name-only", "-r", "HEAD"])).trim();
    return output.length === 0 ? [] : output.split(/\r?\n/);
}

/** Reads one repository-relative path from HEAD for a side-specific resolution oracle. */
export async function headPathContent(
    workspace: LocalGitWorkspace,
    repositoryPath: string,
): Promise<string> {
    return runGit(workspace, ["show", `HEAD:${repositoryPath}`]);
}

/** Reads all tracked and untracked changes as parsed porcelain entries. */
export async function statusPorcelain(
    workspace: LocalGitWorkspace,
): Promise<readonly GitStatusEntry[]> {
    const output = await runGit(workspace, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
    ]);
    return parseStatusPorcelain(output);
}

/** Reads the current branch name, or an empty string for a detached HEAD. */
export async function currentBranch(workspace: LocalGitWorkspace): Promise<string> {
    return (await runGit(workspace, ["branch", "--show-current"])).trim();
}

/** Reads a local ref object ID directly from the fixture's working tree. */
export async function refOid(workspace: LocalGitWorkspace, ref: string): Promise<string> {
    return (await runGit(workspace, ["rev-parse", "--verify", ref])).trim();
}
