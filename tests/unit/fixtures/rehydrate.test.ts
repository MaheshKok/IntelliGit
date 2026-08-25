/**
 * Spec-derived tests for `tests/fixtures/repo/rehydrate.ts` and
 * `tests/fixtures/repo/assertWorkspaceEquivalence.ts` (PLAN.md Phase 1 step 8, the rehydration
 * slice -- Codex R3 #5): live rehydration rewrites a `copyTemplate` output's metadata on disk to
 * the copy's own concrete, functional paths (never a placeholder -- that is normalization's job,
 * comparison-only, see `snapshotNormalize.test.ts`), and the equivalence assertion proves a
 * normalized diff against the template shows only the declared rewrite set and nothing else.
 *
 * Every functional claim here is checked with real `git` commands read back through
 * `gitTestHelpers.ts`'s own `git()` helper -- deliberately NOT through `rehydrate.ts`'s internal
 * `runGit` seam -- so a bug in that shared seam cannot hide from these tests (the same Gate-4
 * discipline `gitTestHelpers.ts`'s own doc comment states and `snapshotObjectStore.test.ts`
 * already follows).
 */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { assertWorkspaceEquivalentToTemplate } from "../../fixtures/repo/assertWorkspaceEquivalence";
import { copyTemplate } from "../../fixtures/repo/copyTemplate";
import {
    createSanitizedGitEnv,
    seedFixtureTemplate,
    type FixtureTemplate,
} from "../../fixtures/repo/seed";
import { DECLARED_REWRITES, rehydrateCopy } from "../../fixtures/repo/rehydrate";
import { snapshotWorkspace, type PlaceholderRoots } from "../../fixtures/repo/snapshot";
import { git } from "./gitTestHelpers";
import { removeScratchDirectories } from "../../helpers/scratchDirectories";

const execFileAsync = promisify(execFile);
const FIXTURE_TIMEOUT_MS = 30_000;

/** `grep -rIl` over `root` for the literal `needle`, tolerating grep's "no match" exit code (1)
 * as an empty result rather than a thrown error -- independent of any production code under test. */
async function grepLiteral(needle: string, root: string): Promise<string> {
    const { stdout } = await execFileAsync("grep", [
        "-rIl",
        "--fixed-strings",
        "--",
        needle,
        root,
    ]).catch((error: unknown) => ({ stdout: (error as { stdout?: string }).stdout ?? "" }));
    return stdout.trim();
}

describe("rehydrateCopy / assertWorkspaceEquivalentToTemplate", () => {
    let cleanupDirs: string[] = [];

    afterEach(async () => {
        await Promise.all(cleanupDirs.map((dir) => removeScratchDirectories(dir)));
        cleanupDirs = [];
    }, FIXTURE_TIMEOUT_MS);

    /** Seeds a real template and copies it wholesale (via the real `copyTemplate`), tracking both
     * for cleanup. Does NOT rehydrate -- callers do that explicitly, so a test can inspect the
     * pre-rehydration state when it needs to. */
    async function seedAndCopy(prefix: string): Promise<{
        readonly destination: string;
        readonly template: FixtureTemplate;
        readonly copyRoot: string;
        readonly copyOriginRoot: string;
    }> {
        const workDir = await mkdtemp(path.join(tmpdir(), `intelligit-rehydrate-${prefix}-`));
        cleanupDirs.push(workDir);
        const templateDir = path.join(workDir, "template");
        const destination = path.join(workDir, "destination");

        const template = await seedFixtureTemplate(templateDir);
        cleanupDirs.push(template.home);
        await copyTemplate(templateDir, destination);

        return {
            destination,
            template,
            copyRoot: path.join(destination, "workspace"),
            copyOriginRoot: path.join(destination, "origin.git"),
        };
    }

    describe("DECLARED_REWRITES", () => {
        it("documents exactly the rewrite this template empirically needs, each entry with a written rationale", () => {
            // Empirically determined (see rehydrate.ts's own module doc comment): `grep -rIl`'ing
            // an entire real copy for the literal template root found exactly one match. This
            // test pins that finding as a spec, not an implementation detail.
            expect(DECLARED_REWRITES).toHaveLength(1);
            const [rewrite] = DECLARED_REWRITES;
            expect(rewrite?.id).toBe("workspace-origin-remote-url");
            expect(rewrite?.rationale.length).toBeGreaterThan(20);
        });
    });

    describe("the origin-remote rewrite -- functional, proven with real git commands", () => {
        it(
            "before rehydration the copy's origin silently resolves into the TEMPLATE -- the hazard this step closes",
            async () => {
                const { copyRoot, template } = await seedAndCopy("before");
                const url = await git(
                    copyRoot,
                    ["config", "--get", "remote.origin.url"],
                    template.env,
                );
                expect(url).toBe(pathToFileURL(template.originRoot).href);
            },
            FIXTURE_TIMEOUT_MS,
        );

        it(
            "rewrites the copy's origin remote URL to its own origin.git, and the copy becomes independently functional",
            async () => {
                const { destination, template, copyRoot, copyOriginRoot } =
                    await seedAndCopy("functional");

                const result = await rehydrateCopy(destination, template.env);
                expect(result.rewrites).toEqual([
                    {
                        id: "workspace-origin-remote-url",
                        newValue: pathToFileURL(copyOriginRoot).href,
                    },
                ]);

                const urlAfter = await git(
                    copyRoot,
                    ["config", "--get", "remote.origin.url"],
                    template.env,
                );
                expect(urlAfter).toBe(pathToFileURL(copyOriginRoot).href);

                // Real functional proof: `git ls-remote` and `git fetch` against the copy succeed
                // and report the copy's own origin, not a stale/failed lookup.
                const lsRemoteUrl = await git(
                    copyRoot,
                    ["ls-remote", "--get-url", "origin"],
                    template.env,
                );
                expect(lsRemoteUrl).toBe(pathToFileURL(copyOriginRoot).href);
                await git(copyRoot, ["fetch", "--quiet", "origin"], template.env);
            },
            FIXTURE_TIMEOUT_MS,
        );

        it(
            "THE TEETH TEST: after rehydration, the copy never reaches the template's origin, even for state that only exists there",
            async () => {
                const { destination, template, copyRoot } = await seedAndCopy("teeth");
                await rehydrateCopy(destination, template.env);

                // Push state to the TEMPLATE's origin only, after the copy was already rehydrated.
                await git(template.root, ["tag", "template-only-tag"], template.env);
                await git(
                    template.root,
                    ["push", "--quiet", "origin", "template-only-tag"],
                    template.env,
                );

                const copyRemoteTags = await git(
                    copyRoot,
                    ["ls-remote", "--tags", "origin"],
                    template.env,
                );
                expect(copyRemoteTags).not.toContain("template-only-tag");
            },
            FIXTURE_TIMEOUT_MS,
        );

        it(
            "THROWS when the copy is not a real git repository -- fails loudly rather than leaving a broken copy",
            async () => {
                const workDir = await mkdtemp(
                    path.join(tmpdir(), "intelligit-rehydrate-malformed-"),
                );
                cleanupDirs.push(workDir);
                const destination = path.join(workDir, "destination");
                await mkdir(path.join(destination, "workspace"), { recursive: true });
                await mkdir(path.join(destination, "origin.git"), { recursive: true });
                const sanitized = await createSanitizedGitEnv({ homeParent: workDir });

                await expect(rehydrateCopy(destination, sanitized.env)).rejects.toThrow();
            },
            FIXTURE_TIMEOUT_MS,
        );
    });

    describe("objects/info/alternates -- defensive containment check", () => {
        it(
            "THROWS when an alternates file is planted pointing outside the copy -- the deliberate break",
            async () => {
                const { destination, template, copyRoot } = await seedAndCopy("alternates");
                await rehydrateCopy(destination, template.env); // succeeds the first time

                const outside = await mkdtemp(
                    path.join(tmpdir(), "intelligit-rehydrate-alternates-outside-"),
                );
                cleanupDirs.push(outside);
                const infoDir = path.join(copyRoot, ".git", "objects", "info");
                await mkdir(infoDir, { recursive: true });
                await writeFile(path.join(infoDir, "alternates"), `${outside}\n`, "utf8");

                await expect(rehydrateCopy(destination, template.env)).rejects.toThrow(
                    /points outside every allowed root/,
                );
            },
            FIXTURE_TIMEOUT_MS,
        );
    });

    describe("no residual template path -- the generic safety net beyond the one declared rewrite", () => {
        it(
            "leaves no file anywhere in the copy containing the literal template root path",
            async () => {
                const { destination, template } = await seedAndCopy("residual");
                const workDir = path.dirname(destination);
                const templateDir = path.join(workDir, "template");

                await rehydrateCopy(destination, template.env);

                const matches = await grepLiteral(templateDir, destination);
                expect(matches).toBe("");
            },
            FIXTURE_TIMEOUT_MS,
        );

        it(
            "never writes a <ROOT>, <ORIGIN>, or <PROFILE> placeholder string to disk -- rehydration is concrete paths only",
            async () => {
                const { destination, template } = await seedAndCopy("placeholder");
                await rehydrateCopy(destination, template.env);

                for (const placeholder of ["<ROOT>", "<ORIGIN>", "<PROFILE>"]) {
                    const matches = await grepLiteral(placeholder, destination);
                    expect(matches).toBe("");
                }
            },
            FIXTURE_TIMEOUT_MS,
        );
    });

    describe("assertWorkspaceEquivalentToTemplate", () => {
        function rootsFor(destination: string, root: string, originRoot: string): PlaceholderRoots {
            return { root, originRoot, profileDir: path.join(destination, "unused-profile") };
        }

        it(
            "passes for a correctly rehydrated copy -- the normalized diff is empty",
            async () => {
                const { destination, template, copyRoot, copyOriginRoot } =
                    await seedAndCopy("equivalence-pass");
                await rehydrateCopy(destination, template.env);

                const templateRoots = rootsFor(destination, template.root, template.originRoot);
                const copyRoots = rootsFor(destination, copyRoot, copyOriginRoot);
                const [templateSnapshot, copySnapshot] = await Promise.all([
                    snapshotWorkspace({ ...templateRoots, env: template.env }),
                    snapshotWorkspace({ ...copyRoots, env: template.env }),
                ]);

                expect(() =>
                    assertWorkspaceEquivalentToTemplate(
                        templateSnapshot,
                        templateRoots,
                        copySnapshot,
                        copyRoots,
                    ),
                ).not.toThrow();
            },
            FIXTURE_TIMEOUT_MS,
        );

        it(
            "THE TEETH TEST: THROWS naming the offending file when an undeclared mutation is planted in the copy",
            async () => {
                const { destination, template, copyRoot, copyOriginRoot } =
                    await seedAndCopy("equivalence-fail");
                await rehydrateCopy(destination, template.env);

                const templateRoots = rootsFor(destination, template.root, template.originRoot);
                const copyRoots = rootsFor(destination, copyRoot, copyOriginRoot);
                const templateSnapshot = await snapshotWorkspace({
                    ...templateRoots,
                    env: template.env,
                });

                // Undeclared mutation: nothing in DECLARED_REWRITES touches README.md.
                await writeFile(
                    path.join(copyRoot, "README.md"),
                    "mutated by a test, not a declared rewrite\n",
                    "utf8",
                );
                const mutatedCopySnapshot = await snapshotWorkspace({
                    ...copyRoots,
                    env: template.env,
                });

                let thrown: unknown;
                try {
                    assertWorkspaceEquivalentToTemplate(
                        templateSnapshot,
                        templateRoots,
                        mutatedCopySnapshot,
                        copyRoots,
                    );
                } catch (error) {
                    thrown = error;
                }

                expect(thrown).toBeInstanceOf(Error);
                const message = (thrown as Error).message;
                expect(message).toContain("workingTree");
                expect(message).toContain("README.md");
            },
            FIXTURE_TIMEOUT_MS,
        );

        it(
            "sanity: the exact same snapshot compared against itself never throws -- the failure above was the mutation, not a bug in the assertion",
            async () => {
                const { destination, template, copyRoot, copyOriginRoot } =
                    await seedAndCopy("equivalence-sanity");
                await rehydrateCopy(destination, template.env);

                const copyRoots = rootsFor(destination, copyRoot, copyOriginRoot);
                const snapshot = await snapshotWorkspace({ ...copyRoots, env: template.env });

                expect(() =>
                    assertWorkspaceEquivalentToTemplate(snapshot, copyRoots, snapshot, copyRoots),
                ).not.toThrow();
            },
            FIXTURE_TIMEOUT_MS,
        );
    });
});
