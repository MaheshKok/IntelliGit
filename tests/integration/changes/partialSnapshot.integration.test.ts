import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { GitExecutor } from "../../../src/git/executor";
import {
    PartialChangesUnsupportedError,
    readPartialSnapshot,
} from "../../../src/git/partialSnapshot";
import { removeScratchDirectories } from "../../helpers/scratchDirectories";

let root: string;

afterEach(async () => {
    await removeScratchDirectories(root);
});

async function repository(objectFormat: "sha1" | "sha256"): Promise<GitExecutor> {
    root = await realpath(await mkdtemp(path.join(tmpdir(), "intelligit-partial-snapshot-")));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root });
    git("init", "-q", `--object-format=${objectFormat}`);
    git("config", "user.name", "Snapshot Test");
    git("config", "user.email", "snapshot@example.invalid");
    git("config", "commit.gpgSign", "false");
    await writeFile(path.join(root, "text.txt"), "base\n");
    git("add", ".");
    git("commit", "-qm", "base");
    return new GitExecutor(root);
}

// The unfiltered hash is computed without Git, so it must follow the repository's object format.
it("reads a working change in a SHA-256 repository", async () => {
    const executor = await repository("sha256");
    await writeFile(path.join(root, "text.txt"), "base\nworking\n");
    const snapshot = await readPartialSnapshot(executor, root, "text.txt", "working");
    expect(snapshot.head).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.working).toBe("base\nworking\n");
    expect(snapshot.view.blocks).toHaveLength(1);
});

it("reads a staged blob that differs from HEAD", async () => {
    const executor = await repository("sha1");
    await writeFile(path.join(root, "text.txt"), "base\nstaged\n");
    execFileSync("git", ["add", "text.txt"], { cwd: root });
    await writeFile(path.join(root, "text.txt"), "base\nstaged\nworking\n");
    const snapshot = await readPartialSnapshot(executor, root, "text.txt", "index");
    expect(snapshot.indexed).toBe("base\nstaged\n");
    expect(snapshot.view.base).toBe("base\n");
});

it("refuses an assume-unchanged file", async () => {
    const executor = await repository("sha1");
    execFileSync("git", ["update-index", "--assume-unchanged", "text.txt"], { cwd: root });
    await expect(readPartialSnapshot(executor, root, "text.txt", "working")).rejects.toBeInstanceOf(
        PartialChangesUnsupportedError,
    );
});
