/**
 * Phase 6 step 33: reset a mutated fixture workspace and compare it item by item with the
 * canonical snapshot captured from that same workspace before mutation. The harness's documented
 * reset primitive is `dispose()` followed by a fresh copy, so the tests exercise that public path.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { assertWorkspaceEquivalentToTemplate } from "../../fixtures/repo/assertWorkspaceEquivalence";
import {
    createFixtureWorkspace,
    type CreateFixtureWorkspaceOptions,
    type FixtureWorkspace,
} from "../../fixtures/repo/harness";
import { MANIFEST_SCHEMA_VERSION, writeFixtureManifest } from "../../fixtures/repo/manifest";
import { seedFixtureTemplate, type FixtureTemplate } from "../../fixtures/repo/seed";
import {
    captureFixtureSnapshot,
    normalizeFixtureSnapshot,
    type FixtureSnapshot,
} from "../../fixtures/repo/phase6Snapshot";
import { git } from "./gitTestHelpers";

const FIXTURE_TIMEOUT_MS = 60_000;

interface SeededManifestFixture {
    readonly template: FixtureTemplate;
    readonly manifestPath: string;
    readonly workspacesRoot: string;
}

describe("Phase 6 step 33 -- restore fidelity", () => {
    let workspaces: FixtureWorkspace[] = [];
    let cleanupDirs: string[] = [];

    afterEach(async () => {
        await Promise.all(workspaces.map((workspace) => workspace.dispose()));
        await Promise.all(
            cleanupDirs.map((directory) => rm(directory, { recursive: true, force: true })),
        );
        workspaces = [];
        cleanupDirs = [];
    }, FIXTURE_TIMEOUT_MS);

    it(
        "restores commit, branch, staged, untracked, and config mutations to the pre-mutation canonical snapshot",
        async () => {
            const workspacesRoot = await mkdtemp(
                path.join(tmpdir(), "intelligit-phase6-restore-pass-"),
            );
            cleanupDirs.push(workspacesRoot);
            const workspace = await createFixtureWorkspace({ scenario: "clean", workspacesRoot });
            workspaces.push(workspace);
            const initial = await captureFixtureSnapshot(workspace);

            await mutateWorkspace(workspace);
            const mutated = await captureFixtureSnapshot(workspace);
            expect(mutated.snapshot.workspace.refs).not.toEqual(initial.snapshot.workspace.refs);
            expect(mutated.snapshot.workspace.head).not.toEqual(initial.snapshot.workspace.head);
            expect(mutated.snapshot.workspace.index).not.toEqual(initial.snapshot.workspace.index);
            expect(mutated.snapshot.workspace.workingTree).not.toEqual(
                initial.snapshot.workspace.workingTree,
            );
            expect(mutated.snapshot.workspace.gitDirState).not.toEqual(
                initial.snapshot.workspace.gitDirState,
            );

            const restored = await restoreFixtureWorkspace(workspace, {
                scenario: "clean",
                workspacesRoot,
            });
            workspaces.push(restored);
            const restoredSnapshot = await captureFixtureSnapshot(restored);

            expect(normalizeFixtureSnapshot(restoredSnapshot)).toEqual(
                normalizeFixtureSnapshot(initial),
            );
        },
        FIXTURE_TIMEOUT_MS,
    );

    it(
        "RED-proof #5: refs restored without the working tree or index still fail the canonical comparison",
        async () => {
            const workspacesRoot = await mkdtemp(
                path.join(tmpdir(), "intelligit-phase6-restore-partial-"),
            );
            cleanupDirs.push(workspacesRoot);
            const workspace = await createFixtureWorkspace({ scenario: "clean", workspacesRoot });
            workspaces.push(workspace);
            const initial = await captureFixtureSnapshot(workspace);
            const initialHead = await git(workspace.root, ["rev-parse", "HEAD"], workspace.env);

            await mutateWorkspace(workspace);
            await git(workspace.root, ["checkout", "--quiet", "main"], workspace.env);
            await git(workspace.root, ["branch", "-D", "phase6-mutated"], workspace.env);
            await git(workspace.root, ["reset", "--hard", initialHead], workspace.env);
            await writeFile(
                path.join(workspace.root, "phase6-leftover-staged.txt"),
                "staged residue\n",
                "utf8",
            );
            await git(workspace.root, ["add", "phase6-leftover-staged.txt"], workspace.env);
            await writeFile(
                path.join(workspace.root, "phase6-leftover-untracked.txt"),
                "untracked residue\n",
                "utf8",
            );

            const partial = await captureFixtureSnapshot(workspace);
            expect(partial.snapshot.workspace.refs).toEqual(initial.snapshot.workspace.refs);
            expect(partial.snapshot.workspace.head).toEqual(initial.snapshot.workspace.head);
            expect(partial.snapshot.workspace.index).not.toEqual(initial.snapshot.workspace.index);
            expect(partial.snapshot.workspace.workingTree).not.toEqual(
                initial.snapshot.workspace.workingTree,
            );

            let thrown: unknown;
            try {
                assertWorkspaceEquivalentToTemplate(
                    initial.snapshot,
                    initial.roots,
                    partial.snapshot,
                    partial.roots,
                );
            } catch (error) {
                thrown = error;
            }
            expect(thrown).toBeInstanceOf(Error);
            const message = (thrown as Error).message;
            expect(message).toContain("snapshot.workspace.index");
            expect(message).toContain("snapshot.workspace.workingTree");
        },
        FIXTURE_TIMEOUT_MS,
    );

    it(
        "RED-proof #6: a fresh-copy baseline can pass while the pre-mutation snapshot catches a corrupted template",
        async () => {
            const fixture = await seedManifestFixture("restore-baseline-trap", cleanupDirs);
            const workspace = await createFixtureWorkspace({
                manifestPath: fixture.manifestPath,
                workspacesRoot: fixture.workspacesRoot,
            });
            workspaces.push(workspace);
            const initial = await captureFixtureSnapshot(workspace);
            const originalReadme = await readFile(
                path.join(fixture.template.root, "README.md"),
                "utf8",
            );

            await writeFile(
                path.join(workspace.root, "phase6-mutation.txt"),
                "mutated workspace\n",
                "utf8",
            );
            await git(workspace.root, ["config", "phase6.restore", "mutated"], workspace.env);
            await writeFile(
                path.join(fixture.template.root, "README.md"),
                "corrupted template baseline\n",
                "utf8",
            );

            try {
                const restored = await restoreFixtureWorkspace(workspace, {
                    manifestPath: fixture.manifestPath,
                    workspacesRoot: fixture.workspacesRoot,
                });
                workspaces.push(restored);
                const restoredSnapshot = await captureFixtureSnapshot(restored);

                const secondFreshCopy = await createFixtureWorkspace({
                    manifestPath: fixture.manifestPath,
                    workspacesRoot: fixture.workspacesRoot,
                });
                workspaces.push(secondFreshCopy);
                const freshSnapshot = await captureFixtureSnapshot(secondFreshCopy);

                // The named trap: both copies inherit the corrupted template, so comparing them
                // against one another stays green and says nothing about restore fidelity.
                expect(() =>
                    assertWorkspaceEquivalentToTemplate(
                        freshSnapshot.snapshot,
                        freshSnapshot.roots,
                        restoredSnapshot.snapshot,
                        restoredSnapshot.roots,
                    ),
                ).not.toThrow();

                let thrown: unknown;
                try {
                    assertWorkspaceEquivalentToTemplate(
                        initial.snapshot,
                        initial.roots,
                        restoredSnapshot.snapshot,
                        restoredSnapshot.roots,
                    );
                } catch (error) {
                    thrown = error;
                }
                expect(thrown).toBeInstanceOf(Error);
                const message = (thrown as Error).message;
                expect(message).toContain("snapshot.workspace.workingTree");
                expect(message).toContain("README.md");
            } finally {
                await writeFile(
                    path.join(fixture.template.root, "README.md"),
                    originalReadme,
                    "utf8",
                );
            }
        },
        FIXTURE_TIMEOUT_MS,
    );
});

/** Applies mutations across refs, HEAD, index, working tree, and repository configuration. */
async function mutateWorkspace(workspace: FixtureWorkspace): Promise<void> {
    await git(workspace.root, ["checkout", "--quiet", "-b", "phase6-mutated"], workspace.env);
    await git(
        workspace.root,
        ["commit", "--quiet", "--allow-empty", "-m", "Phase 6 restore mutation"],
        workspace.env,
    );
    await writeFile(path.join(workspace.root, "phase6-staged.txt"), "staged mutation\n", "utf8");
    await git(workspace.root, ["add", "phase6-staged.txt"], workspace.env);
    await writeFile(
        path.join(workspace.root, "phase6-untracked.txt"),
        "untracked mutation\n",
        "utf8",
    );
    await mkdir(path.join(workspace.root, "ignored"), { recursive: true });
    await writeFile(
        path.join(workspace.root, "ignored", "phase6-ignored.log"),
        "ignored mutation\n",
        "utf8",
    );
    await git(workspace.root, ["config", "phase6.restore", "mutated"], workspace.env);
}

/** Implements the harness contract's reset primitive: dispose the old copy, then allocate a new one. */
async function restoreFixtureWorkspace(
    workspace: FixtureWorkspace,
    options: CreateFixtureWorkspaceOptions,
): Promise<FixtureWorkspace> {
    await workspace.dispose();
    return createFixtureWorkspace(options);
}

async function seedManifestFixture(
    prefix: string,
    cleanupDirs: string[],
): Promise<SeededManifestFixture> {
    const workDir = await mkdtemp(path.join(tmpdir(), `intelligit-phase6-${prefix}-`));
    cleanupDirs.push(workDir);
    const templateRoot = path.join(workDir, "template");
    const manifestPath = path.join(workDir, "manifest.json");
    const workspacesRoot = path.join(workDir, "workspaces");
    const template = await seedFixtureTemplate(templateRoot);
    cleanupDirs.push(template.home);
    await writeFixtureManifest(manifestPath, {
        schemaVersion: MANIFEST_SCHEMA_VERSION,
        templateRoot,
    });
    return { template, manifestPath, workspacesRoot };
}
