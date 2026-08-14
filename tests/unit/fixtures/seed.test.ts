/**
 * Spec-derived tests for tests/fixtures/repo/seed.ts (PLAN.md Phase 1 step 7). Every seeded
 * property below is checked with a real `git` command run against the seeded repository -- never
 * by trusting the seed script's own return values alone -- because a harness bug here would
 * produce silent false-green results across every later visual and E2E test that restores from
 * this template (PLAN.md's stated governing risk for this whole effort).
 *
 * Determinism is the load-bearing property the entire fixture strategy depends on: two independent
 * `seedFixtureTemplate` calls, into two different destinations, must produce byte-identical
 * ref/SHA lists. If that ever stops holding, every committed visual baseline and every
 * SHA-sensitive E2E assertion becomes flaky per machine, so it gets first billing below.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FIXTURE_REFS, seedFixtureTemplate, type FixtureTemplate } from "../../fixtures/repo/seed";

const execFileAsync = promisify(execFile);

/** Runs one git process and returns trimmed UTF-8 stdout, exactly like `seed.ts`'s own internal
 * helper -- the test verifies the fixture from the outside, through the same kind of plain git
 * subprocess a real consumer (the extension, a future harness) would use. */
async function git(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<string> {
    const result = await execFileAsync("git", [...args], { cwd, env, encoding: "buffer" });
    return result.stdout.toString("utf8").trim();
}

describe("seedFixtureTemplate", () => {
    let workDir: string;
    let destinationA: string;
    let destinationB: string;
    let templateA: FixtureTemplate;
    let templateB: FixtureTemplate;

    beforeAll(async () => {
        workDir = await mkdtemp(join(tmpdir(), "intelligit-seed-test-"));
        destinationA = join(workDir, "a");
        destinationB = join(workDir, "b");
        // Sequential, not concurrent: this proves determinism across two independently seeded
        // destinations, which is the property PLAN.md step 7 requires. Whether two seeds can also
        // safely run concurrently is a separate question this suite does not need to answer.
        templateA = await seedFixtureTemplate(destinationA);
        templateB = await seedFixtureTemplate(destinationB);
    }, 60_000);

    afterAll(async () => {
        await Promise.all([
            rm(workDir, { recursive: true, force: true }),
            rm(templateA.home, { recursive: true, force: true }),
            rm(templateB.home, { recursive: true, force: true }),
        ]);
    });

    describe("determinism", () => {
        it("produces a byte-identical full commit-SHA list across two independent destinations", async () => {
            const logA = await git(templateA.root, ["log", "--all", "--format=%H"], templateA.env);
            const logB = await git(templateB.root, ["log", "--all", "--format=%H"], templateB.env);

            expect(logA.split("\n").length).toBeGreaterThan(0);
            expect(logB.split("\n").sort()).toEqual(logA.split("\n").sort());
        });

        it("produces a byte-identical ref-name-to-SHA mapping (branches, tags, remote-tracking refs)", async () => {
            const showRefA = await git(templateA.root, ["show-ref"], templateA.env);
            const showRefB = await git(templateB.root, ["show-ref"], templateB.env);

            expect(showRefA.length).toBeGreaterThan(0);
            expect(showRefB).toEqual(showRefA);
        });

        it("produces an identical bare-origin main SHA across two independent destinations", async () => {
            const originMainA = await git(
                templateA.originRoot,
                ["rev-parse", "refs/heads/main"],
                templateA.env,
            );
            const originMainB = await git(
                templateB.originRoot,
                ["rev-parse", "refs/heads/main"],
                templateB.env,
            );

            expect(originMainB).toEqual(originMainA);
        });

        it("rejects seeding into a destination that is not empty", async () => {
            await expect(seedFixtureTemplate(destinationA)).rejects.toThrow(/not empty/);
        });
    });

    describe("sanitized git environment", () => {
        it("nulls global and system config and pins a scratch HOME", () => {
            expect(templateA.env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
            expect(templateA.env.GIT_CONFIG_SYSTEM).toBe("/dev/null");
            expect(templateA.env.HOME).toBe(templateA.home);
            expect(templateA.home).not.toBe(process.env.HOME);
        });

        it("pins a fixed author/committer identity and fixed dates", () => {
            expect(templateA.env.GIT_AUTHOR_NAME).toBe("IntelliGit Fixture Repo");
            expect(templateA.env.GIT_AUTHOR_EMAIL).toBe("intelligit-fixture@example.invalid");
            expect(templateA.env.GIT_COMMITTER_NAME).toBe("IntelliGit Fixture Repo");
            expect(templateA.env.GIT_COMMITTER_EMAIL).toBe("intelligit-fixture@example.invalid");
            expect(templateA.env.GIT_AUTHOR_DATE).toBe("2000-01-01T00:00:00 +0000");
            expect(templateA.env.GIT_COMMITTER_DATE).toBe("2000-01-01T00:00:00 +0000");
        });
    });

    describe("repo config", () => {
        it("pins every config value PLAN.md step 7 requires", async () => {
            const configGet = async (key: string) =>
                git(templateA.root, ["config", "--get", key], templateA.env);

            expect(await configGet("core.autocrlf")).toBe("false");
            expect(await configGet("core.ignorecase")).toBe("false");
            expect(await configGet("init.defaultBranch")).toBe("main");
            expect(await configGet("gc.auto")).toBe("0");
            expect(await configGet("commit.gpgsign")).toBe("false");
            expect(await configGet("core.abbrev")).toBe("40");
        });
    });

    describe("history", () => {
        it("puts feature/awesome exactly 3 ahead and 2 behind main", async () => {
            const ahead = await git(
                templateA.root,
                ["rev-list", "--count", `${FIXTURE_REFS.main}..${FIXTURE_REFS.feature}`],
                templateA.env,
            );
            const behind = await git(
                templateA.root,
                ["rev-list", "--count", `${FIXTURE_REFS.feature}..${FIXTURE_REFS.main}`],
                templateA.env,
            );

            expect(ahead).toBe("3");
            expect(behind).toBe("2");
        });

        it("shares featureBase as the merge-base of feature/awesome and topic/mergeable (the multi-lane region)", async () => {
            const mergeBase = await git(
                templateA.root,
                ["merge-base", FIXTURE_REFS.feature, FIXTURE_REFS.topic],
                templateA.env,
            );
            expect(mergeBase).toBe(templateA.commits.featureBase);
        });

        it("really merges topic/mergeable into main with a 2-parent merge commit", async () => {
            const mergeCommits = await git(
                templateA.root,
                ["log", "--merges", "--format=%H", FIXTURE_REFS.main],
                templateA.env,
            );
            expect(mergeCommits.split("\n")).toContain(templateA.commits.mergeCommit);

            const parents = await git(
                templateA.root,
                ["rev-list", "--parents", "-n", "1", templateA.commits.mergeCommit],
                templateA.env,
            );
            // "<self> <parent1> <parent2>" -- three tokens confirms exactly two parents.
            expect(parents.split(" ")).toHaveLength(3);
        });

        it("makes conflict/with-main really conflict against main", async () => {
            await expect(
                git(
                    templateA.root,
                    ["merge-tree", "--write-tree", FIXTURE_REFS.main, FIXTURE_REFS.conflicting],
                    templateA.env,
                ),
            ).rejects.toMatchObject({ code: 1 });

            const mergeTreeOutput = await execFileAsync(
                "git",
                ["merge-tree", "--write-tree", FIXTURE_REFS.main, FIXTURE_REFS.conflicting],
                { cwd: templateA.root, env: templateA.env, encoding: "utf8" },
            ).catch((error: { stdout?: string }) => error);
            expect(mergeTreeOutput.stdout).toContain("CONFLICT");
        });

        it("keeps feature/awesome and conflict/with-main unmerged into main, and topic/mergeable merged", async () => {
            const unmerged = await git(
                templateA.root,
                ["branch", "--no-merged", FIXTURE_REFS.main],
                templateA.env,
            );

            expect(unmerged).toContain(FIXTURE_REFS.feature);
            expect(unmerged).toContain(FIXTURE_REFS.conflicting);
            expect(unmerged).not.toContain(FIXTURE_REFS.topic);
        });

        it("tags main's tip as an annotated tag", async () => {
            const tagType = await git(
                templateA.root,
                ["cat-file", "-t", FIXTURE_REFS.tag],
                templateA.env,
            );
            const taggedCommit = await git(
                templateA.root,
                ["rev-parse", `${FIXTURE_REFS.tag}^{commit}`],
                templateA.env,
            );

            expect(tagType).toBe("tag");
            expect(taggedCommit).toBe(templateA.commits.mergeCommit);
        });
    });

    describe("dirty working tree", () => {
        it("has an ignored file that git actually ignores", async () => {
            const checkIgnore = await git(
                templateA.root,
                ["check-ignore", "ignored/build.log"],
                templateA.env,
            );
            expect(checkIgnore).toBe("ignored/build.log");
        });

        it("has an untracked file", async () => {
            const status = await git(templateA.root, ["status", "--porcelain"], templateA.env);
            expect(status.split("\n")).toContain("?? untracked.txt");
        });

        it("has a file with both staged and unstaged changes", async () => {
            const status = await git(templateA.root, ["status", "--porcelain"], templateA.env);
            expect(status.split("\n")).toContain("MM mutable.txt");
        });

        it("has a staged binary file that git recognizes as binary", async () => {
            const status = await git(templateA.root, ["status", "--porcelain"], templateA.env);
            expect(status.split("\n")).toContain("A  binary.bin");

            const numstat = await git(
                templateA.root,
                ["diff", "--cached", "--numstat", "--", "binary.bin"],
                templateA.env,
            );
            // Binary files report "-" for both added/removed line counts instead of numbers.
            expect(numstat).toMatch(/^-\t-\tbinary\.bin$/);
        });

        it("has a CRLF file with literal CRLF bytes on disk", async () => {
            const raw = await readFile(join(templateA.root, "crlf.txt"));
            expect(raw.toString("utf8")).toBe("first line\r\nsecond line\r\nthird line\r\n");
            expect(raw.includes(Buffer.from("\r\n"))).toBe(true);
        });

        it("has a staged rename", async () => {
            const status = await git(templateA.root, ["status", "--porcelain"], templateA.env);
            expect(status.split("\n")).toContain("R  topic.txt -> topic-renamed.txt");
        });

        it("has two pre-seeded stash entries in refs/stash", async () => {
            const stashRef = await git(
                templateA.root,
                ["rev-parse", "--verify", "refs/stash"],
                templateA.env,
            );
            expect(stashRef).toHaveLength(40);

            const stashList = await git(templateA.root, ["stash", "list"], templateA.env);
            const entries = stashList.split("\n");
            expect(entries).toHaveLength(2);
            expect(entries[0]).toBe("stash@{0}: On main: stash entry two");
            expect(entries[1]).toBe("stash@{1}: On main: stash entry one");
        });
    });

    describe("bare origin", () => {
        it("is a real bare repository", async () => {
            const isBare = await git(
                templateA.originRoot,
                ["rev-parse", "--is-bare-repository"],
                templateA.env,
            );
            expect(isBare).toBe("true");
        });

        it("is wired as origin over a file:// URL with upstream tracking configured", async () => {
            const remoteUrl = await git(
                templateA.root,
                ["remote", "get-url", FIXTURE_REFS.remote],
                templateA.env,
            );
            expect(remoteUrl.startsWith("file://")).toBe(true);

            const upstream = await git(
                templateA.root,
                ["rev-parse", "--abbrev-ref", `${FIXTURE_REFS.main}@{upstream}`],
                templateA.env,
            );
            expect(upstream).toBe(`${FIXTURE_REFS.remote}/${FIXTURE_REFS.main}`);
        });

        it("holds main at the same SHA main was pushed at, and holds the tag", async () => {
            const originMain = await git(
                templateA.originRoot,
                ["rev-parse", "refs/heads/main"],
                templateA.env,
            );
            expect(originMain).toBe(templateA.commits.mergeCommit);

            const originTag = await git(
                templateA.originRoot,
                ["rev-parse", `refs/tags/${FIXTURE_REFS.tag}^{commit}`],
                templateA.env,
            );
            expect(originTag).toBe(templateA.commits.mergeCommit);
        });
    });
});
