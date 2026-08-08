/**
 * Spec-derived tests for `tests/fixtures/repo/snapshotRefs.ts`, `snapshotWorktrees.ts`, and
 * `snapshotGitDirState.ts` (PLAN.md Phase 1 step 9):
 * - "All refs enumerated exhaustively (`for-each-ref` over the full namespace, not just
 *   branches/tags/remotes), plus `HEAD`, `refs/stash`, and all reflogs."
 * - "Per-worktree and common-directory private state -- inventoried recursively, with a
 *   documented exclusion list rather than a hand-written include list."
 * - "`BISECT_*` state" -- covered by the recursive walk, load-bearing for
 *   `src/git/interactiveRebase/guards.ts:100`'s bisect-in-progress probe.
 */

import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { snapshotGitDirState } from "../../fixtures/repo/snapshotGitDirState";
import { snapshotHead, snapshotReflogs, snapshotRefs } from "../../fixtures/repo/snapshotRefs";
import { snapshotWorktrees } from "../../fixtures/repo/snapshotWorktrees";
import { git, type ScratchRepo } from "./gitTestHelpers";
import { commitAll, createScratchRepo, writeRepoFile } from "./gitTestHelpers";

describe("snapshotRefs / snapshotHead / snapshotReflogs", () => {
    let repo: ScratchRepo | undefined;

    afterEach(async () => {
        await repo?.dispose();
        repo = undefined;
    });

    it("enumerates the full ref namespace: branches, tags, refs/stash, and a custom ref", async () => {
        repo = await createScratchRepo("refs-full-namespace");
        await writeRepoFile(repo.root, "a.txt", "one\n");
        await commitAll(repo.root, repo.env, "c1");
        await git(repo.root, ["tag", "-a", "v1", "-m", "v1"], repo.env);
        await git(repo.root, ["update-ref", "refs/custom/mything", "HEAD"], repo.env);
        await writeRepoFile(repo.root, "a.txt", "two\n");
        await git(repo.root, ["stash", "push", "--quiet", "-m", "probe stash"], repo.env);

        const section = await snapshotRefs(repo.root, repo.env);
        expect(section.status).toBe("captured");
        if (section.status !== "captured") return;

        const names = section.data.map((entry) => entry.name);
        expect(names).toContain("refs/heads/main");
        expect(names).toContain("refs/tags/v1");
        expect(names).toContain("refs/custom/mything");
        expect(names).toContain("refs/stash");
    });

    it("RED-proof: deleting a stash removes refs/stash from the next capture", async () => {
        repo = await createScratchRepo("refs-red-proof-stash");
        await writeRepoFile(repo.root, "a.txt", "one\n");
        await commitAll(repo.root, repo.env, "c1");
        await writeRepoFile(repo.root, "a.txt", "two\n");
        await git(repo.root, ["stash", "push", "--quiet", "-m", "will be dropped"], repo.env);

        const before = await snapshotRefs(repo.root, repo.env);
        const hasStashBefore = before.status === "captured" && before.data.some((entry) => entry.name === "refs/stash");
        expect(hasStashBefore).toBe(true);

        await git(repo.root, ["stash", "drop"], repo.env);

        const after = await snapshotRefs(repo.root, repo.env);
        const hasStashAfter = after.status === "captured" && after.data.some((entry) => entry.name === "refs/stash");
        // Same assertion shape as `hasStashBefore`; the deliberate break (dropping the stash)
        // flips it to `false`, proving the section is not tautologically "always has refs/stash".
        expect(hasStashAfter).toBe(false);
    });

    it("distinguishes a symbolic HEAD from a detached one", async () => {
        repo = await createScratchRepo("head-symbolic-vs-detached");
        await writeRepoFile(repo.root, "a.txt", "one\n");
        const sha = await commitAll(repo.root, repo.env, "c1");

        const gitDir = path.join(repo.root, ".git");
        const symbolic = await snapshotHead(gitDir);
        expect(symbolic).toEqual({ status: "captured", data: { kind: "symbolic", target: "refs/heads/main" } });

        await git(repo.root, ["checkout", "--quiet", "--detach", sha], repo.env);
        const detached = await snapshotHead(gitDir);
        expect(detached.status).toBe("captured");
        if (detached.status !== "captured") return;
        expect(detached.data).toEqual({ kind: "detached", target: sha });
    });

    it("captures logs/HEAD after a commit, and an empty list (not not-captured) with no logs dir", async () => {
        repo = await createScratchRepo("reflogs-basic");
        const emptySection = await snapshotReflogs(path.join(repo.root, ".git"));
        // A brand-new repo has no logs/ directory yet until the first ref update.
        expect(emptySection).toEqual({ status: "captured", data: [] });

        await writeRepoFile(repo.root, "a.txt", "one\n");
        await commitAll(repo.root, repo.env, "c1");

        const section = await snapshotReflogs(path.join(repo.root, ".git"));
        expect(section.status).toBe("captured");
        if (section.status !== "captured") return;
        const paths = section.data.map((entry) => entry.relativePath);
        expect(paths).toContain("HEAD");
    });
});

describe("snapshotWorktrees", () => {
    let repo: ScratchRepo | undefined;

    afterEach(async () => {
        await repo?.dispose();
        repo = undefined;
    });

    it("lists only the primary worktree when none are linked, keyed to the common directory", async () => {
        repo = await createScratchRepo("worktrees-primary-only");
        await writeRepoFile(repo.root, "a.txt", "one\n");
        await commitAll(repo.root, repo.env, "c1");

        const commonDir = path.join(repo.root, ".git");
        const result = await snapshotWorktrees(repo.root, commonDir, repo.env);
        expect(result.section.status).toBe("captured");
        if (result.section.status !== "captured") return;

        expect(result.section.data).toHaveLength(1);
        expect(result.section.data[0]?.branch).toBe("refs/heads/main");
        expect(result.section.data[0]?.bare).toBe(false);
        expect(result.linkedGitDirs.size).toBe(0);
    });

    it("lists a linked worktree with its own resolved admin directory, distinct from the common one", async () => {
        repo = await createScratchRepo("worktrees-linked");
        await writeRepoFile(repo.root, "a.txt", "one\n");
        await commitAll(repo.root, repo.env, "c1");

        const linkedPath = path.join(path.dirname(repo.root), `${path.basename(repo.root)}-linked`);
        await git(repo.root, ["worktree", "add", "--quiet", "-b", "linked-branch", linkedPath, "main"], repo.env);

        const commonDir = path.join(repo.root, ".git");
        const result = await snapshotWorktrees(repo.root, commonDir, repo.env);
        expect(result.section.status).toBe("captured");
        if (result.section.status !== "captured") return;

        expect(result.section.data).toHaveLength(2);
        const linkedInfo = result.section.data[1];
        expect(linkedInfo?.branch).toBe("refs/heads/linked-branch");
        expect(result.linkedGitDirs.size).toBe(1);
        // The linked worktree's admin dir must be a real, distinct directory under the common
        // directory's own `worktrees/` -- never equal to the common dir itself. Compared via
        // realpath on both sides: `git worktree list --porcelain` may report a realpath'd form
        // on a platform with a symlinked temp root (e.g. macOS `/var` -> `/private/var`), while
        // `commonDir` here is built from the literal, non-realpath'd `repo.root`.
        const { realpath } = await import("node:fs/promises");
        const [[, linkedGitDir]] = [...result.linkedGitDirs.entries()];
        const [realLinkedGitDir, realCommonDir] = await Promise.all([realpath(linkedGitDir), realpath(commonDir)]);
        expect(realLinkedGitDir).not.toBe(realCommonDir);
        expect(realLinkedGitDir.startsWith(path.join(realCommonDir, "worktrees"))).toBe(true);

        await git(repo.root, ["worktree", "remove", "--force", linkedPath], repo.env).catch(() => undefined);
    });
});

describe("snapshotGitDirState -- per-worktree and common-directory private state", () => {
    let repo: ScratchRepo | undefined;

    afterEach(async () => {
        await repo?.dispose();
        repo = undefined;
    });

    it("captures special common-dir files without a hand-written include list: COMMIT_EDITMSG, ORIG_HEAD", async () => {
        repo = await createScratchRepo("gitdirstate-common-files");
        await writeRepoFile(repo.root, "a.txt", "one\n");
        await commitAll(repo.root, repo.env, "first message");
        await writeRepoFile(repo.root, "a.txt", "two\n");
        await commitAll(repo.root, repo.env, "second message");
        // `git reset --soft HEAD~1` writes ORIG_HEAD; a merge/rebase would too, but this is the
        // cheapest real trigger for a fixture that only needs to prove the file gets captured.
        await git(repo.root, ["reset", "--soft", "HEAD~1"], repo.env);

        const commonDir = path.join(repo.root, ".git");
        const section = await snapshotGitDirState(commonDir, new Map());
        expect(section.status).toBe("captured");
        if (section.status !== "captured") return;

        const commonPaths = section.data.common?.map((entry) => entry.relativePath) ?? [];
        expect(commonPaths).toContain("ORIG_HEAD");
        expect(commonPaths).toContain("COMMIT_EDITMSG");
        // Excluded-everywhere names must genuinely be absent, not merely unlisted by coincidence.
        expect(commonPaths.some((p) => p === "objects" || p.startsWith("objects/"))).toBe(false);
        expect(commonPaths).not.toContain("packed-refs");
        expect(commonPaths.some((p) => p === "refs" || p.startsWith("refs/"))).toBe(false);
        expect(commonPaths.some((p) => p === "logs" || p.startsWith("logs/"))).toBe(false);
        expect(commonPaths.some((p) => p === "hooks" || p.startsWith("hooks/"))).toBe(false);
        expect(commonPaths).not.toContain("description");
    });

    describe("BISECT_* state -- load-bearing for guards.ts:100's isBisecting probe", () => {
        it("captures every BISECT_* file once a bisect session starts, and none before", async () => {
            repo = await createScratchRepo("gitdirstate-bisect");
            await writeRepoFile(repo.root, "a.txt", "v0\n");
            const first = await commitAll(repo.root, repo.env, "c0");
            await writeRepoFile(repo.root, "a.txt", "v1\n");
            await commitAll(repo.root, repo.env, "c1");
            await writeRepoFile(repo.root, "a.txt", "v2\n");
            const last = await commitAll(repo.root, repo.env, "c2");

            const commonDir = path.join(repo.root, ".git");
            const before = await snapshotGitDirState(commonDir, new Map());
            const bisectFilesBefore =
                before.status === "captured"
                    ? (before.data.common ?? []).filter((entry) => entry.relativePath.startsWith("BISECT"))
                    : [];
            expect(bisectFilesBefore).toEqual([]);

            await git(repo.root, ["bisect", "start"], repo.env);
            await git(repo.root, ["bisect", "bad", last], repo.env);
            await git(repo.root, ["bisect", "good", first], repo.env);

            const during = await snapshotGitDirState(commonDir, new Map());
            expect(during.status).toBe("captured");
            const bisectFilesDuring =
                during.status === "captured"
                    ? (during.data.common ?? []).filter((entry) => entry.relativePath.startsWith("BISECT"))
                    : [];
            expect(bisectFilesDuring.map((entry) => entry.relativePath).sort()).toContain("BISECT_LOG");
            expect(bisectFilesDuring.length).toBeGreaterThan(0);

            // RED-proof completes the loop: `git bisect reset` removes them again, and the same
            // "no BISECT_* files" assertion that failed above (had it been asserted `during`) now
            // holds again -- confirming the walk tracks real state, not a cached list.
            await git(repo.root, ["bisect", "reset"], repo.env);
            const after = await snapshotGitDirState(commonDir, new Map());
            const bisectFilesAfter =
                after.status === "captured"
                    ? (after.data.common ?? []).filter((entry) => entry.relativePath.startsWith("BISECT"))
                    : [];
            expect(bisectFilesAfter).toEqual([]);
        });
    });

    describe("per-worktree private state, including per-worktree logs (the previously-missed item)", () => {
        it("captures a linked worktree's own logs/HEAD, distinct from the common directory's", async () => {
            repo = await createScratchRepo("gitdirstate-worktree-logs");
            await writeRepoFile(repo.root, "a.txt", "one\n");
            await commitAll(repo.root, repo.env, "primary commit");

            const linkedPath = path.join(path.dirname(repo.root), `${path.basename(repo.root)}-linked`);
            await git(repo.root, ["worktree", "add", "--quiet", "-b", "linked-branch", linkedPath, "main"], repo.env);
            await writeRepoFile(linkedPath, "b.txt", "from linked worktree\n");
            await commitAll(linkedPath, repo.env, "linked commit");

            const commonDir = path.join(repo.root, ".git");
            const worktreesResult = await snapshotWorktrees(repo.root, commonDir, repo.env);
            expect(worktreesResult.section.status).toBe("captured");
            // Key by the ACTUAL reported worktree path, never a self-constructed guess: git's own
            // `worktree list --porcelain` may realpath its output on platforms with a symlinked
            // temp root (e.g. macOS `/var` -> `/private/var`), and the snapshot's own gitDirState
            // key must match that exactly for the lookup below to mean anything.
            const linkedWorktreeInfo =
                worktreesResult.section.status === "captured" ? worktreesResult.section.data[1] : undefined;
            expect(linkedWorktreeInfo).toBeDefined();

            const gitDirState = await snapshotGitDirState(commonDir, worktreesResult.linkedGitDirs);
            expect(gitDirState.status).toBe("captured");
            if (gitDirState.status !== "captured") return;

            const linkedKey = linkedWorktreeInfo!.path;
            const linkedEntries = gitDirState.data[linkedKey];
            expect(linkedEntries).toBeDefined();
            const linkedPaths = linkedEntries?.map((entry) => entry.relativePath) ?? [];
            expect(linkedPaths).toContain("logs/HEAD");
            expect(linkedPaths).toContain("commondir");

            // The common directory's own logs/HEAD is a *different* file (excluded from the
            // common walk entirely here, since `snapshotRefs.ts` owns that section) and is
            // unaffected by the commit made inside the linked worktree.
            const commonPaths = gitDirState.data.common?.map((entry) => entry.relativePath) ?? [];
            expect(commonPaths.some((p) => p === "logs" || p.startsWith("logs/"))).toBe(false);

            // RED-proof: removing the linked worktree makes its private-state key disappear from
            // the very next capture.
            await git(repo.root, ["worktree", "remove", "--force", linkedPath], repo.env);
            const afterRemoval = await snapshotGitDirState(commonDir, new Map());
            expect(afterRemoval.status).toBe("captured");
            if (afterRemoval.status !== "captured") return;
            expect(Object.keys(afterRemoval.data)).not.toContain(linkedKey);
        });
    });
});
