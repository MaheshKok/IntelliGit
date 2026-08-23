/**
 * Phase 6 step 35: destructive changes in one allocated copy must not cross its private ownership
 * boundary into a second copy or the shared seed template.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { gitSpellingOf } from "../../helpers/gitPathSpelling";

import { createFixtureWorkspace, type FixtureWorkspace } from "../../fixtures/repo/harness";
import { MANIFEST_SCHEMA_VERSION, writeFixtureManifest } from "../../fixtures/repo/manifest";
import {
    captureFixtureSnapshot,
    normalizeFixtureSnapshot,
} from "../../fixtures/repo/phase6Snapshot";
import { seedFixtureTemplate, type FixtureTemplate } from "../../fixtures/repo/seed";
import { git } from "./gitTestHelpers";

const FIXTURE_TIMEOUT_MS = 60_000;

describe("Phase 6 step 35 -- workspace isolation", () => {
    let workspaces: FixtureWorkspace[] = [];
    let cleanupDirs: string[] = [];

    afterEach(async () => {
        await Promise.all(
            workspaces.map(async (workspace) => {
                try {
                    await workspace.dispose();
                } catch {
                    // The test's assertion owns any expected teardown error; cleanup still must run.
                }
            }),
        );
        await Promise.all(
            cleanupDirs.map((directory) => rm(directory, { recursive: true, force: true })),
        );
        workspaces = [];
        cleanupDirs = [];
    }, FIXTURE_TIMEOUT_MS);

    it(
        "keeps workspace B and the template byte-equivalent after destructive mutations in A",
        async () => {
            const fixture = await seedSharedFixture("destructive", cleanupDirs);
            const [workspaceA, workspaceB] = await Promise.all([
                createFixtureWorkspace({
                    manifestPath: fixture.manifestPath,
                    workspacesRoot: fixture.workspacesRoot,
                }),
                createFixtureWorkspace({
                    manifestPath: fixture.manifestPath,
                    workspacesRoot: fixture.workspacesRoot,
                }),
            ]);
            workspaces.push(workspaceA, workspaceB);

            const workspaceBBefore = normalizeFixtureSnapshot(
                await captureFixtureSnapshot(workspaceB),
            );
            const templateBefore = normalizeFixtureSnapshot(
                await captureFixtureSnapshot(asFixtureWorkspace(fixture.template)),
            );
            const ownRootA = path.dirname(path.dirname(workspaceA.root));
            const linkedWorktreePath = path.join(fixture.workDir, "isolation-linked-worktree");
            // Every assertion in this file puts its message on `expect(actual, message)`, never on
            // the matcher. Vitest's chai-derived types accept a trailing message on `.toBe(...)`
            // and friends, so it typechecks -- but the jest-compatible matcher silently drops it,
            // and the failure prints a bare diff. Measured against this very suite.
            expect(
                linkedWorktreePath.startsWith(ownRootA),
                "isolation probe worktree must live outside workspace A's fixture-owned root",
            ).toBe(false);

            // Mutation 1: prove Git registered a real linked worktree outside A before continuing.
            await git(
                workspaceA.root,
                ["worktree", "add", linkedWorktreePath, "-b", "isolation-probe"],
                workspaceA.env,
            );
            const worktreeList = await git(
                workspaceA.root,
                ["worktree", "list", "--porcelain"],
                workspaceA.env,
            );
            expect(
                worktreeList,
                "git worktree add must register the outside probe worktree",
            ).toContain(gitSpellingOf(linkedWorktreePath));

            // Mutation 2: push an older local commit to A's private origin and prove its main ref moved.
            const originMainBefore = await git(
                workspaceA.originRoot,
                ["rev-parse", "refs/heads/main"],
                workspaceA.env,
            );
            const mainHistory = (
                await git(workspaceA.root, ["rev-list", "--max-count=2", "main"], workspaceA.env)
            ).split("\n");
            const olderMain = mainHistory[1];
            expect(olderMain, "force-push probe requires a parent commit").toBeTruthy();
            await git(
                workspaceA.root,
                ["push", "--force", "origin", `${olderMain}:refs/heads/main`],
                workspaceA.env,
            );
            const originMainAfter = await git(
                workspaceA.originRoot,
                ["rev-parse", "refs/heads/main"],
                workspaceA.env,
            );
            expect(
                originMainAfter,
                "force-push must move A's private origin main ref to the older commit",
            ).toBe(olderMain);
            expect(
                originMainAfter,
                "force-push must move A's private origin main ref rather than replaying the same tip",
            ).not.toBe(originMainBefore);

            // Prepare one unreachable loose object so gc has a concrete object to prune, then prove
            // the object existed before the destructive gc and is absent afterward.
            const gcProbePath = path.join(ownRootA, "unreachable-gc-probe.txt");
            await writeFile(gcProbePath, "unreachable gc probe\n", "utf8");
            const probeObject = await git(
                workspaceA.root,
                ["hash-object", "-w", gcProbePath],
                workspaceA.env,
            );
            await git(workspaceA.root, ["cat-file", "-e", `${probeObject}^{blob}`], workspaceA.env);
            const looseObjectsBefore = parseCountObjects(
                await git(workspaceA.root, ["count-objects", "-v"], workspaceA.env),
            ).loose;
            expect(
                looseObjectsBefore,
                "gc probe must create at least one loose object before pruning",
            ).toBeGreaterThan(0);

            // Mutation 3: expire reflogs first so --prune=now has no retention window to hide behind.
            await git(
                workspaceA.root,
                ["reflog", "expire", "--expire=now", "--all"],
                workspaceA.env,
            );
            await git(workspaceA.root, ["gc", "--prune=now", "--aggressive"], workspaceA.env);
            const looseObjectsAfter = parseCountObjects(
                await git(workspaceA.root, ["count-objects", "-v"], workspaceA.env),
            ).loose;
            expect(
                looseObjectsAfter,
                "git gc must reduce the loose-object count after creating the unreachable probe",
            ).toBeLessThan(looseObjectsBefore);
            await expect(
                git(workspaceA.root, ["cat-file", "-e", `${probeObject}^{blob}`], workspaceA.env),
                "pruned gc probe object must no longer exist after git gc --prune=now",
            ).rejects.toThrow();

            expect(
                normalizeFixtureSnapshot(await captureFixtureSnapshot(workspaceB)),
                "destructive mutations in A must not change workspace B's canonical snapshot",
            ).toEqual(workspaceBBefore);
            expect(
                normalizeFixtureSnapshot(
                    await captureFixtureSnapshot(asFixtureWorkspace(fixture.template)),
                ),
                "destructive mutations in A must not change the template's canonical snapshot",
            ).toEqual(templateBefore);
        },
        FIXTURE_TIMEOUT_MS,
    );

    it(
        "proves the normalized snapshot comparison catches a mutation in workspace B",
        async () => {
            const fixture = await seedSharedFixture("comparison-proof", cleanupDirs);
            const workspaceB = await createFixtureWorkspace({
                manifestPath: fixture.manifestPath,
                workspacesRoot: fixture.workspacesRoot,
            });
            workspaces.push(workspaceB);

            const before = normalizeFixtureSnapshot(await captureFixtureSnapshot(workspaceB));
            await writeFile(
                path.join(workspaceB.root, "README.md"),
                "workspace B comparison probe\n",
                "utf8",
            );
            const after = normalizeFixtureSnapshot(await captureFixtureSnapshot(workspaceB));

            expect(
                after,
                "the canonical snapshot comparison must detect a direct workspace B mutation",
            ).not.toEqual(before);
        },
        FIXTURE_TIMEOUT_MS,
    );

    it(
        "proves the normalized snapshot comparison catches a mutation in the TEMPLATE",
        async () => {
            // The isolation test asserts the template is unchanged, and that assertion is only
            // worth anything if this capture actually reads the template. A capture that resolved
            // to nothing -- an unread path, an empty section -- would compare equal to itself
            // forever and certify isolation it never observed. The B-mutation proof above does not
            // cover this: it exercises a real `FixtureWorkspace`, while the template is captured
            // through `asFixtureWorkspace`, a different construction with a synthesized profileDir.
            const fixture = await seedSharedFixture("template-comparison-proof", cleanupDirs);
            const templateHandle = asFixtureWorkspace(fixture.template);

            const before = normalizeFixtureSnapshot(await captureFixtureSnapshot(templateHandle));
            await writeFile(
                path.join(fixture.template.root, "README.md"),
                "template comparison probe\n",
                "utf8",
            );
            const after = normalizeFixtureSnapshot(await captureFixtureSnapshot(templateHandle));

            expect(
                after,
                "the canonical snapshot comparison must detect a direct template mutation",
            ).not.toEqual(before);
        },
        FIXTURE_TIMEOUT_MS,
    );
});

interface SharedFixture {
    readonly template: FixtureTemplate;
    readonly workDir: string;
    readonly manifestPath: string;
    readonly workspacesRoot: string;
}

async function seedSharedFixture(prefix: string, cleanupDirs: string[]): Promise<SharedFixture> {
    const workDir = await mkdtemp(path.join(tmpdir(), `intelligit-phase6-isolation-${prefix}-`));
    cleanupDirs.push(workDir);
    const templateDir = path.join(workDir, "template");
    const manifestPath = path.join(workDir, "manifest.json");
    const workspacesRoot = path.join(workDir, "workspaces");
    const template = await seedFixtureTemplate(templateDir, { homeParent: workDir });
    await writeFixtureManifest(manifestPath, {
        schemaVersion: MANIFEST_SCHEMA_VERSION,
        templateRoot: templateDir,
    });
    return { template, workDir, manifestPath, workspacesRoot };
}

/**
 * Adapts the seed template to the handle shape `captureFixtureSnapshot` accepts. The template owns
 * no profile directory, and `profileDir` is only ever used as a placeholder-canonicalization root
 * (never read from disk -- see `phase6Snapshot.ts`), so a path that does not exist is safe here: no
 * captured string can contain it, so it simply never matches. The template-mutation proof above is
 * what shows this handle really reads the template rather than returning an empty capture.
 */
function asFixtureWorkspace(template: FixtureTemplate): FixtureWorkspace {
    return {
        root: template.root,
        originRoot: template.originRoot,
        profileDir: path.join(path.dirname(template.root), ".template-profile"),
        env: template.env,
        dispose: async () => undefined,
    };
}

function parseCountObjects(output: string): { readonly loose: number } {
    const loose = output.match(/^count: (\d+)$/m)?.[1];
    if (loose === undefined) {
        throw new Error(`git count-objects -v did not report a loose-object count:\n${output}`);
    }
    return { loose: Number(loose) };
}
