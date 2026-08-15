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
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
    createSanitizedGitEnv,
    FIXTURE_REFS,
    seedFixtureTemplate,
    type FixtureTemplate,
} from "../../fixtures/repo/seed";
import { createScratchWorkspaces } from "./scratchWorkspaces";

const execFileAsync = promisify(execFile);

/** Puts one `process.env` key back exactly as it was, including having been ABSENT -- assigning
 * `undefined` to a `process.env` key stores the string `"undefined"` in Node, which would leave the
 * process dirtier than the test found it. */
function restoreEnvVar(key: string, original: string | undefined): void {
    if (original === undefined) {
        delete process.env[key];
        return;
    }
    process.env[key] = original;
}

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

    // Paths are registered the moment they exist rather than read back off `templateA`/`templateB`
    // in `afterAll`. Seeding is a real `git` build and can fail: if the SECOND seed below throws,
    // the old `afterAll` dereferenced an unassigned `templateB`, so a `TypeError` replaced the real
    // seeding error in the report AND skipped `workDir`'s removal entirely.
    const scratch = createScratchWorkspaces();

    beforeAll(async () => {
        workDir = await mkdtemp(join(tmpdir(), "intelligit-seed-test-"));
        scratch.register(workDir);
        destinationA = join(workDir, "a");
        destinationB = join(workDir, "b");
        // Sequential, not concurrent: this proves determinism across two independently seeded
        // destinations, which is the property PLAN.md step 7 requires. Whether two seeds can also
        // safely run concurrently is a separate question this suite does not need to answer.
        templateA = await seedFixtureTemplate(destinationA);
        scratch.register(templateA.home);
        templateB = await seedFixtureTemplate(destinationB);
        scratch.register(templateB.home);
    }, 60_000);

    afterAll(async () => {
        await scratch.removeAll();
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

        /**
         * Locale is pinned because git's PORCELAIN output is translated, and
         * `scenarios.ts`'s `assertMidRebasePostcondition` matches `/rebas/i` against `git status`
         * run through this env. On a runner with a non-English locale installed, that scenario
         * would report a correctly-built mid-rebase workspace as un-built.
         *
         * Asserted against a HOSTILE ambient value rather than by reading `env.LC_ALL` on its own:
         * `createSanitizedGitEnv` spreads `process.env` first, so on a machine where `LC_ALL` is
         * already `C` (or unset) a bare equality check passes just as happily with the pin deleted.
         * Only a run whose ambient value DIFFERS can witness that the pin overrides rather than
         * inherits -- the two must not share an environment, or neither can prove anything.
         */
        it("overrides a hostile ambient locale rather than inheriting it", async () => {
            const ambient = { LC_ALL: process.env.LC_ALL, LANG: process.env.LANG };
            process.env.LC_ALL = "fr_FR.UTF-8";
            process.env.LANG = "fr_FR.UTF-8";
            try {
                const sanitized = await createSanitizedGitEnv();
                try {
                    expect(sanitized.env.LC_ALL).toBe("C");
                    expect(sanitized.env.LANG).toBe("C");
                } finally {
                    await rm(sanitized.home, { recursive: true, force: true });
                }
            } finally {
                restoreEnvVar("LC_ALL", ambient.LC_ALL);
                restoreEnvVar("LANG", ambient.LANG);
            }
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
            // Pinned so `%h` cannot drift with object count, but pinned SMALL so it stays a real
            // abbreviation. At 40 the "short" hash equals the full hash, which later phases would
            // bake into baseline screenshots as a chip no user ever sees. See seed.ts.
            expect(await configGet("core.abbrev")).toBe("8");
        });

        it("abbreviates %h to a real short hash, distinct from the full SHA", async () => {
            // The assertion above pins the config value; this one pins the OBSERVABLE consequence.
            // A future change that sets core.abbrev back to 40 -- or that lets git auto-scale --
            // has to fail here too, not just on a config string comparison.
            const [full, short] = await Promise.all([
                git(templateA.root, ["rev-parse", "HEAD"], templateA.env),
                git(templateA.root, ["log", "-1", "--format=%h"], templateA.env),
            ]);
            expect(full.trim()).toHaveLength(40);
            expect(short.trim()).toHaveLength(8);
            expect(full.trim().startsWith(short.trim())).toBe(true);
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

/**
 * The seed's own failure path -- a sibling `describe` so it does not pay for the 60s double seed
 * above, which it has no use for.
 *
 * Nothing in a green run reaches this path, and the directory it used to leak lives OUTSIDE the
 * `destination` a caller cleans up: `home` is `mkdtemp`'d in the OS temp root and the only
 * reference to it dies with the rejected frame. So the leak is invisible until a machine has
 * accumulated thousands of them.
 *
 * The failure is forced by emptying `PATH`, which every `git` spawn inherits through
 * `createSanitizedGitEnv`'s `process.env` spread -- `execFile` then cannot resolve the binary at
 * all (ENOENT). That lands on `initializeWorkingRepository`, the FIRST git call after the home is
 * allocated, which is exactly the window the cleanup exists to cover.
 *
 * `homeParent` is passed so the assertion can be "this directory the test owns is empty". Scanning
 * the shared OS temp root instead would race every sibling test file seeding its own home.
 */
describe("seedFixtureTemplate failure cleanup", () => {
    const allocated: string[] = [];

    afterAll(async () => {
        await Promise.all(
            allocated.map((scratchPath) => rm(scratchPath, { recursive: true, force: true })),
        );
    });

    it("removes the temporary home it allocated when seeding fails", async () => {
        const workDir = await mkdtemp(join(tmpdir(), "intelligit-seed-failure-test-"));
        allocated.push(workDir);
        const homeParent = join(workDir, "homes");
        await mkdir(homeParent);

        const originalPath = process.env.PATH;
        process.env.PATH = "";
        try {
            await expect(
                seedFixtureTemplate(join(workDir, "destination"), { homeParent }),
            ).rejects.toThrow(/ENOENT/);
        } finally {
            restoreEnvVar("PATH", originalPath);
        }

        expect(await readdir(homeParent)).toEqual([]);
    }, 30_000);
});
