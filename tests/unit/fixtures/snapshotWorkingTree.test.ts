/**
 * Spec-derived tests for `tests/fixtures/repo/snapshotWorkingTree.ts` (PLAN.md Phase 1 step 9:
 * "Working tree: tracked + untracked + ignored files, with type/mode/symlink-target/digest per
 * entry").
 */

import { chmod, symlink } from "node:fs/promises";
import path from "node:path";
import { platform } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { snapshotWorkingTree } from "../../fixtures/repo/snapshotWorkingTree";
import type { ScratchRepo } from "./gitTestHelpers";
import { commitAll, createScratchRepo, writeRepoFile } from "./gitTestHelpers";

describe("snapshotWorkingTree", () => {
    let repo: ScratchRepo | undefined;

    afterEach(async () => {
        await repo?.dispose();
        repo = undefined;
    });

    it("captures tracked, untracked, and ignored files, excluding only .git itself", async () => {
        repo = await createScratchRepo("workingtree-basic");
        await writeRepoFile(repo.root, ".gitignore", "ignored/\n");
        await writeRepoFile(repo.root, "tracked.txt", "tracked content\n");
        await commitAll(repo.root, repo.env, "seed");
        await writeRepoFile(repo.root, "untracked.txt", "untracked content\n");
        await writeRepoFile(repo.root, "ignored/build.log", "throwaway\n");

        const section = await snapshotWorkingTree(repo.root, false);
        expect(section.status).toBe("captured");
        if (section.status !== "captured") return;

        const byPath = new Map(section.data.map((entry) => [entry.relativePath, entry]));
        expect(byPath.has(".git")).toBe(false);
        expect(byPath.get("tracked.txt")?.type).toBe("file");
        expect(byPath.get("untracked.txt")?.type).toBe("file");
        expect(byPath.get("ignored")?.type).toBe("directory");
        expect(byPath.get("ignored/build.log")?.type).toBe("file");
    });

    it("records the sha256 digest and decoded text of a small text file", async () => {
        repo = await createScratchRepo("workingtree-digest");
        await writeRepoFile(repo.root, "a.txt", "hello world\n");

        const section = await snapshotWorkingTree(repo.root, false);
        expect(section.status).toBe("captured");
        if (section.status !== "captured") return;

        const entry = section.data.find((candidate) => candidate.relativePath === "a.txt");
        expect(entry).toBeDefined();
        expect(entry?.digest).toHaveLength(64);
        expect(entry?.text).toBe("hello world\n");
    });

    it("records the literal symlink target text, not its resolved path", async () => {
        repo = await createScratchRepo("workingtree-symlink");
        await writeRepoFile(repo.root, "target.txt", "target content\n");
        await symlink("target.txt", path.join(repo.root, "link.txt"));

        const section = await snapshotWorkingTree(repo.root, false);
        expect(section.status).toBe("captured");
        if (section.status !== "captured") return;

        const link = section.data.find((candidate) => candidate.relativePath === "link.txt");
        expect(link?.type).toBe("symlink");
        expect(link?.symlinkTarget).toBe("target.txt");
        expect(link?.digest).toBeNull();
    });

    it("reports not-captured, with a reason, for a bare repository", async () => {
        repo = await createScratchRepo("workingtree-bare-not-captured");
        const section = await snapshotWorkingTree(repo.root, true);
        expect(section.status).toBe("not-captured");
        if (section.status !== "not-captured") return;
        expect(section.reason.length).toBeGreaterThan(0);
    });

    it("keeps permission-bit mode distinct between an executable and a plain file", async () => {
        // Skipped on Windows-hosted CI images, where chmod bits are not meaningful -- but this
        // suite's own gate always runs on macOS/Linux, so no skip needed here in practice; the
        // guard just documents the assumption rather than silently mis-asserting elsewhere.
        if (platform() === "win32") return;
        repo = await createScratchRepo("workingtree-mode");
        await writeRepoFile(repo.root, "plain.txt", "plain\n");
        await writeRepoFile(repo.root, "exec.sh", "#!/bin/sh\necho hi\n");
        await chmod(path.join(repo.root, "exec.sh"), 0o755);
        await chmod(path.join(repo.root, "plain.txt"), 0o644);

        const section = await snapshotWorkingTree(repo.root, false);
        expect(section.status).toBe("captured");
        if (section.status !== "captured") return;
        const byPath = new Map(section.data.map((entry) => [entry.relativePath, entry]));
        expect(byPath.get("exec.sh")?.mode).toBe(0o755);
        expect(byPath.get("plain.txt")?.mode).toBe(0o644);
    });

    describe("RED-proof: the same presence assertion diverges between two real states", () => {
        it("detects a file's disappearance between two captures of the same directory", async () => {
            repo = await createScratchRepo("workingtree-red-proof");
            await writeRepoFile(repo.root, "will-be-deleted.txt", "here for now\n");

            const before = await snapshotWorkingTree(repo.root, false);
            expect(before.status).toBe("captured");
            const presentBefore =
                before.status === "captured" &&
                before.data.some((entry) => entry.relativePath === "will-be-deleted.txt");
            expect(presentBefore).toBe(true);

            const { rm } = await import("node:fs/promises");
            await rm(path.join(repo.root, "will-be-deleted.txt"));

            const after = await snapshotWorkingTree(repo.root, false);
            expect(after.status).toBe("captured");
            const presentAfter =
                after.status === "captured" &&
                after.data.some((entry) => entry.relativePath === "will-be-deleted.txt");
            // Same assertion shape as `presentBefore`; it now evaluates to `false`, which is what
            // proves the oracle can actually fail -- a broken implementation that silently
            // returned yesterday's list would leave this `true` and this test would catch it.
            expect(presentAfter).toBe(false);
        });

        it("detects a content change via a differing digest for the same path", async () => {
            repo = await createScratchRepo("workingtree-red-proof-digest");
            await writeRepoFile(repo.root, "mutable.txt", "version one\n");
            const before = await snapshotWorkingTree(repo.root, false);
            const digestBefore =
                before.status === "captured"
                    ? before.data.find((entry) => entry.relativePath === "mutable.txt")?.digest
                    : undefined;
            expect(digestBefore).toHaveLength(64);

            await writeRepoFile(repo.root, "mutable.txt", "version two, deliberately different\n");
            const after = await snapshotWorkingTree(repo.root, false);
            const digestAfter =
                after.status === "captured"
                    ? after.data.find((entry) => entry.relativePath === "mutable.txt")?.digest
                    : undefined;
            expect(digestAfter).toHaveLength(64);
            expect(digestAfter).not.toBe(digestBefore);
        });
    });
});
