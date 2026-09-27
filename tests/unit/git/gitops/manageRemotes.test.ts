import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { GitExecutor } from "../../../../src/git/executor";
import { GitOps } from "../../../../src/git/operations";
import { removeScratchDirectories } from "../../../helpers/scratchDirectories";

const execGit = promisify(execFile);
const repositories: string[] = [];

async function git(repo: string, ...args: string[]): Promise<string> {
    return (await execGit("git", args, { cwd: repo })).stdout;
}

async function repository(): Promise<{ root: string; ops: GitOps }> {
    const root = await mkdtemp(path.join(tmpdir(), "intelligit-manage-remotes-"));
    repositories.push(root);
    await git(root, "init");
    await git(root, "config", "user.name", "Test");
    await git(root, "config", "user.email", "test@example.com");
    await writeFile(path.join(root, "a"), "a");
    await git(root, "add", "a");
    await git(root, "commit", "-m", "initial");
    return { root, ops: new GitOps(new GitExecutor(root)) };
}

async function values(root: string, key: string): Promise<string[]> {
    try {
        return (await git(root, "config", "--null", "--get-all", key)).split("\0").filter(Boolean);
    } catch (error) {
        if ((error as { code?: number }).code === 1) return [];
        throw error;
    }
}

afterEach(async () => {
    await Promise.all(repositories.splice(0).map((root) => removeScratchDirectories(root)));
});

describe("managed remote configuration", () => {
    it("propagates Git remote inventory errors instead of claiming an empty list", async () => {
        const root = await mkdtemp(path.join(tmpdir(), "intelligit-nonrepo-"));
        repositories.push(root);
        const ops = new GitOps(new GitExecutor(root));
        await expect(ops.getRemoteNames()).rejects.toThrow();
        expect(await ops.getRemotes()).toEqual([]);
    });

    it("reads configured alias text and strictly distinguishes a missing URL", async () => {
        const { root, ops } = await repository();
        await git(root, "config", "url.https://actual.example/.insteadOf", "alias:");
        await ops.addRemote("origin", "alias:project.git");
        expect(await ops.getRemoteNames()).toEqual(["origin"]);
        expect(await ops.getConfiguredRemoteUrls("origin")).toEqual(["alias:project.git"]);
        expect(await ops.getRemoteUrl("origin")).toBe("https://actual.example/project.git");
        await git(root, "config", "--unset-all", "remote.origin.url");
        expect(await ops.getRemoteNames()).toEqual(["origin"]);
        expect(await ops.getConfiguredRemoteUrls("origin")).toEqual([]);
        await ops.setRemoteUrl("origin", undefined, "../first.git");
        expect(await ops.getConfiguredRemoteUrls("origin")).toEqual(["../first.git"]);
    });

    it("changes only the selected URL and retains push, fetch and custom config", async () => {
        const { root, ops } = await repository();
        await ops.addRemote("origin", "ssh://host/repo.git?x=1");
        await git(root, "config", "--add", "remote.origin.url", "ssh://host/repoXgit?x=1");
        await git(root, "config", "--add", "remote.origin.pushurl", "ssh://push/one");
        await git(root, "config", "--add", "remote.origin.pushurl", "ssh://push/two");
        await git(
            root,
            "config",
            "--add",
            "remote.origin.fetch",
            "+refs/pull/*:refs/remotes/origin/pr/*",
        );
        await git(root, "config", "remote.origin.custom", "keep");
        const fetch = await values(root, "remote.origin.fetch");
        await expect(
            ops.setRemoteUrl("origin", "ssh://host/repo.git?x=1", "../new repo.git"),
        ).resolves.toBeUndefined();
        expect(await ops.getConfiguredRemoteUrls("origin")).toEqual([
            "../new repo.git",
            "ssh://host/repoXgit?x=1",
        ]);
        expect(await values(root, "remote.origin.pushurl")).toEqual([
            "ssh://push/one",
            "ssh://push/two",
        ]);
        expect(await values(root, "remote.origin.fetch")).toEqual(fetch);
        expect(await values(root, "remote.origin.custom")).toEqual(["keep"]);
    });

    it("treats a leading option-like new URL as a literal and keeps a sibling", async () => {
        const { root, ops } = await repository();
        await ops.addRemote("origin", "../old.git");
        await git(root, "config", "--add", "remote.origin.url", "../sibling.git");
        await ops.setRemoteUrl("origin", "../old.git", "--delete");
        expect(await ops.getConfiguredRemoteUrls("origin")).toEqual(["--delete", "../sibling.git"]);
    });

    it("preserves an empty configured first URL and displays slash names", async () => {
        const { root, ops } = await repository();
        await git(root, "config", "--add", "remote.team/upstream.url", "");
        await git(root, "config", "--add", "remote.team/upstream.url", "../sibling.git");
        expect(await ops.getRemoteNames()).toEqual(["team/upstream"]);
        expect(await ops.getConfiguredRemoteUrls("team/upstream")).toEqual(["", "../sibling.git"]);
    });

    it("keeps duplicate old URLs after Git rejects ambiguous replacement", async () => {
        const { root, ops } = await repository();
        await ops.addRemote("origin", "../same.git");
        await git(root, "config", "--add", "remote.origin.url", "../same.git");
        await expect(ops.setRemoteUrl("origin", "../same.git", "../new.git")).rejects.toThrow();
        expect(await ops.getConfiguredRemoteUrls("origin")).toEqual(["../same.git", "../same.git"]);
    });

    it("renames config, tracking refs and branch association", async () => {
        const { root, ops } = await repository();
        await ops.addRemote("origin", "../one.git");
        await git(root, "config", "remote.origin.pushurl", "../push.git");
        await git(root, "config", "branch.work.remote", "origin");
        await git(root, "config", "branch.work.merge", "refs/heads/main");
        await git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
        await ops.renameRemote("origin", "upstream");
        expect(await ops.getRemoteNames()).toEqual(["upstream"]);
        expect(await values(root, "remote.upstream.pushurl")).toEqual(["../push.git"]);
        expect(await values(root, "branch.work.remote")).toEqual(["upstream"]);
        expect((await git(root, "rev-parse", "refs/remotes/upstream/main")).trim()).toMatch(
            /^[a-f0-9]{40,64}$/,
        );
        await expect(
            git(root, "rev-parse", "--verify", "refs/remotes/origin/main"),
        ).rejects.toThrow();
    });
});
