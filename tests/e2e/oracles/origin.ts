import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { FixtureWorkspace } from "../../fixtures/repo/harness";

const execFileAsync = promisify(execFile);
type OriginWorkspace = Pick<FixtureWorkspace, "originRoot" | "env">;

async function runOriginGit(workspace: OriginWorkspace, args: readonly string[]): Promise<string> {
    const result = await execFileAsync("git", ["-C", workspace.originRoot, ...args], {
        env: { ...process.env, ...workspace.env },
        maxBuffer: 1024 * 1024,
    });
    return result.stdout;
}

/** Reads a bare-origin ref object ID without using the extension or a working-tree checkout. */
export async function refOid(workspace: OriginWorkspace, ref: string): Promise<string> {
    return (await runOriginGit(workspace, ["rev-parse", "--verify", ref])).trim();
}

/** Compares two captured ref IDs for the negative “commit did not push” assertion. */
export function didRefMove(before: string, after: string): boolean {
    return before !== after;
}
