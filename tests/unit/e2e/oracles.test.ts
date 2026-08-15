import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import * as origin from "../../e2e/oracles/origin";
import { headOid, parseStatusPorcelain, refOid } from "../../e2e/oracles/localGit";
import { readDurableState } from "../../e2e/oracles/durableState";
import { getRebaseStoragePaths } from "../../../src/git/interactiveRebase/storage";
import { resolveShelfPaths } from "../../../src/shelf/paths";

const execFileAsync = promisify(execFile);

describe("localGit oracle parsing", () => {
    it("parses ordinary, untracked, and rename porcelain entries", () => {
        expect(
            parseStatusPorcelain("MM mutable.txt\0?? untracked.txt\0R  renamed.txt\0old.txt\0"),
        ).toEqual([
            { indexStatus: "M", worktreeStatus: "M", path: "mutable.txt" },
            { indexStatus: "?", worktreeStatus: "?", path: "untracked.txt" },
            { indexStatus: "R", worktreeStatus: " ", path: "renamed.txt", originalPath: "old.txt" },
        ]);
    });

    it("reads HEAD and ref object IDs directly from a working tree", async () => {
        const root = await mkdtemp(path.join(tmpdir(), "intelligit-local-git-oracle-"));
        try {
            await execFileAsync("git", ["init", "--quiet", root]);
            await writeFile(path.join(root, "tracked.txt"), "tracked\n", "utf8");
            await execFileAsync("git", ["-C", root, "add", "tracked.txt"]);
            await execFileAsync("git", [
                "-C",
                root,
                "-c",
                "user.name=oracle",
                "-c",
                "user.email=oracle@example.invalid",
                "commit",
                "--quiet",
                "-m",
                "initial",
            ]);

            const workspace = { root, env: process.env };
            const currentHead = await headOid(workspace);
            expect(currentHead).toMatch(/^[0-9a-f]{40}$/);
            expect(await refOid(workspace, "HEAD")).toBe(currentHead);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});

describe("origin oracle", () => {
    it("detects a changed ref without knowing why it changed", () => {
        expect(origin.didRefMove("before", "before")).toBe(false);
        expect(origin.didRefMove("before", "after")).toBe(true);
    });

    it("reads a pushed ref from a bare origin and rejects missing refs", async () => {
        const root = await mkdtemp(path.join(tmpdir(), "intelligit-origin-oracle-"));
        const originRoot = path.join(root, "origin.git");
        const workingRoot = path.join(root, "working");
        const branchRef = "refs/heads/main";
        try {
            await execFileAsync("git", ["init", "--bare", "--quiet", originRoot]);
            await execFileAsync("git", ["clone", "--quiet", originRoot, workingRoot]);
            await writeFile(path.join(workingRoot, "tracked.txt"), "initial\n", "utf8");
            await execFileAsync("git", ["-C", workingRoot, "add", "tracked.txt"]);
            await execFileAsync("git", [
                "-C",
                workingRoot,
                "-c",
                "user.name=oracle",
                "-c",
                "user.email=oracle@example.invalid",
                "commit",
                "--quiet",
                "-m",
                "initial",
            ]);
            await execFileAsync("git", ["-C", workingRoot, "branch", "-M", "main"]);
            await execFileAsync("git", [
                "-C",
                workingRoot,
                "push",
                "--quiet",
                "--set-upstream",
                "origin",
                "main",
            ]);

            const workspace = { originRoot, env: process.env };
            const before = await origin.refOid(workspace, branchRef);
            await writeFile(path.join(workingRoot, "tracked.txt"), "second\n", "utf8");
            await execFileAsync("git", ["-C", workingRoot, "add", "tracked.txt"]);
            await execFileAsync("git", [
                "-C",
                workingRoot,
                "-c",
                "user.name=oracle",
                "-c",
                "user.email=oracle@example.invalid",
                "commit",
                "--quiet",
                "-m",
                "second",
            ]);
            await execFileAsync("git", ["-C", workingRoot, "push", "--quiet", "origin", "main"]);
            const after = await origin.refOid(workspace, branchRef);

            expect(before).toMatch(/^[0-9a-f]{40}$/);
            expect(after).toMatch(/^[0-9a-f]{40}$/);
            expect(after).not.toBe(before);
            expect(origin.didRefMove(before, after)).toBe(true);
            await expect(origin.refOid(workspace, "refs/heads/missing")).rejects.toThrow();
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});

describe("durable state oracle", () => {
    it("locates the real shelf, rebase, and repository-lock paths in an empty repository", async () => {
        const root = await mkdtemp(path.join(tmpdir(), "intelligit-durable-oracle-"));
        const profileDir = path.join(root, "profile");
        try {
            await execFileAsync("git", ["init", "--quiet", root]);
            const snapshot = await readDurableState({ root, profileDir, env: process.env });

            expect(snapshot.shelfRoot).toContain(
                path.join("globalStorage", "maheshkok.intelligit", "shelves"),
            );
            expect(snapshot.rebaseRepositoryDirectory).toContain(
                path.join("globalStorage", "maheshkok.intelligit", "interactive-rebase"),
            );
            expect(snapshot.repoLockPath).toContain(path.join("intelligit", "repo.lock"));
            expect(snapshot.shelfStoreFiles).toEqual([]);
            expect(snapshot.rebaseManifestFiles).toEqual([]);
            expect(snapshot.repoLockPresent).toBe(false);
            expect(snapshot.takeoverPaths).toEqual([]);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it("discovers nested durable files and sorted takeover paths from resolved locations", async () => {
        const root = await mkdtemp(path.join(tmpdir(), "intelligit-durable-oracle-nested-"));
        const profileDir = path.join(root, "profile");
        try {
            await execFileAsync("git", ["init", "--quiet", root]);
            const emptySnapshot = await readDurableState({ root, profileDir, env: process.env });
            const shelfPaths = await resolveShelfPaths({
                repositoryRoot: root,
                globalStoragePath: emptySnapshot.globalStoragePath,
            });
            const rebasePaths = getRebaseStoragePaths(
                emptySnapshot.globalStoragePath,
                await realpath(root),
            );
            const shelfFiles = [
                path.join(shelfPaths.root, "first", "entry.patch"),
                path.join(shelfPaths.root, "second", "deeper", "entry.patch"),
            ];
            const rebaseManifestFiles = [
                path.join(rebasePaths.manifestDirectory, "first", "manifest.json"),
                path.join(rebasePaths.manifestDirectory, "second", "deeper", "manifest.json"),
            ];
            const takeoverDirectory = path.dirname(emptySnapshot.repoLockPath);
            const takeoverPaths = [
                path.join(takeoverDirectory, "takeover-a"),
                path.join(takeoverDirectory, "takeover-z"),
            ];

            for (const filePath of [...shelfFiles, ...rebaseManifestFiles, ...takeoverPaths]) {
                await mkdir(path.dirname(filePath), { recursive: true });
                await writeFile(filePath, `${path.basename(filePath)}\n`, "utf8");
            }
            await writeFile(emptySnapshot.repoLockPath, "repo lock\n", "utf8");

            const snapshot = await readDurableState({ root, profileDir, env: process.env });
            expect(snapshot.shelfRoot).toBe(shelfPaths.root);
            expect(snapshot.shelfStoreFiles).toEqual(shelfFiles);
            expect(snapshot.rebaseRepositoryDirectory).toBe(rebasePaths.repositoryDirectory);
            expect(snapshot.rebaseManifestFiles).toEqual(rebaseManifestFiles);
            expect(snapshot.repoLockPath).toBe(emptySnapshot.repoLockPath);
            expect(snapshot.repoLockPresent).toBe(true);
            expect(snapshot.takeoverPaths).toEqual(takeoverPaths);
            expect(snapshot.takeoverPaths.every((filePath) => path.isAbsolute(filePath))).toBe(
                true,
            );
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
