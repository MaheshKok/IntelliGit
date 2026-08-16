/**
 * Spec-derived tests for `FixtureWorkspace.dispose()`. These assertions inspect the real filesystem
 * and a real child process so cleanup claims cannot pass by checking only in-memory handle state.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readdir, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createFixtureWorkspace, type FixtureWorkspace } from "../../fixtures/repo/harness";
import { git } from "./gitTestHelpers";

const FIXTURE_TIMEOUT_MS = 30_000;
const execFileAsync = promisify(execFile);

const { rmMock } = vi.hoisted(() => ({ rmMock: vi.fn() }));

vi.mock("node:fs/promises", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs/promises")>();
    rmMock.mockImplementation(actual.rm);
    return { ...actual, rm: rmMock };
});

describe("FixtureWorkspace resource cleanup", () => {
    let cleanupDirs: string[] = [];
    let workspacesToDispose: FixtureWorkspace[] = [];

    afterEach(async () => {
        const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
        rmMock.mockImplementation(actual.rm);
        await Promise.all(workspacesToDispose.map((workspace) => workspace.dispose()));
        workspacesToDispose = [];
        await Promise.all(
            cleanupDirs.map((directory) => actual.rm(directory, { recursive: true, force: true })),
        );
        cleanupDirs = [];
        rmMock.mockClear();
    }, FIXTURE_TIMEOUT_MS);

    async function createWorkspacesRoot(prefix: string): Promise<string> {
        const workspacesRoot = await mkdtemp(path.join(tmpdir(), `intelligit-${prefix}-`));
        cleanupDirs.push(workspacesRoot);
        return workspacesRoot;
    }

    async function exists(candidate: string): Promise<boolean> {
        try {
            await stat(candidate);
            return true;
        } catch {
            return false;
        }
    }

    function ownRootOf(workspace: FixtureWorkspace): string {
        // `root` is `<ownRoot>/copy/workspace`; walking back two levels reaches the disposer target.
        return path.dirname(path.dirname(workspace.root));
    }

    function isBelow(parent: string, candidate: string): boolean {
        const relative = path.relative(parent, candidate);
        return relative.length > 0 && relative !== ".." && !relative.startsWith(`..${path.sep}`);
    }

    it(
        "removes every fixture-owned resource and leaves no ig- workspace after successful dispose",
        async () => {
            const workspacesRoot = await createWorkspacesRoot("successful-cleanup");
            const workspace = await createFixtureWorkspace({
                scenario: "shelf-populated",
                workspacesRoot,
            });
            workspacesToDispose.push(workspace);
            const ownRoot = ownRootOf(workspace);

            expect(await exists(workspace.root), "root existed before cleanup").toBe(true);
            expect(await exists(workspace.originRoot), "originRoot existed before cleanup").toBe(
                true,
            );
            expect(await exists(workspace.profileDir), "profileDir existed before cleanup").toBe(
                true,
            );
            expect(workspace.env.TMPDIR, "env.TMPDIR was provided").toBeDefined();
            expect(await exists(workspace.env.TMPDIR!), "env.TMPDIR existed before cleanup").toBe(
                true,
            );
            expect(workspace.env.TMP, "env.TMP was provided").toBe(workspace.env.TMPDIR);
            expect(workspace.env.TEMP, "env.TEMP was provided").toBe(workspace.env.TMPDIR);
            expect(workspace.env.HOME, "env.HOME was provided").toBeDefined();
            expect(await exists(workspace.env.HOME!), "env.HOME existed before cleanup").toBe(true);
            if (workspace.shelfStorageRoot !== undefined) {
                expect(
                    await exists(workspace.shelfStorageRoot),
                    "shelfStorageRoot existed before cleanup",
                ).toBe(true);
            }
            expect(await exists(ownRoot), "fixture-owned root existed before cleanup").toBe(true);
            expect(
                (await readdir(workspacesRoot)).some((entry) => entry.startsWith("ig-")),
                "workspacesRoot contained the allocated ig- workspace before cleanup",
            ).toBe(true);

            await workspace.dispose();

            expect(await exists(workspace.root), "root was removed by cleanup").toBe(false);
            expect(await exists(workspace.originRoot), "originRoot was removed by cleanup").toBe(
                false,
            );
            expect(await exists(workspace.profileDir), "profileDir was removed by cleanup").toBe(
                false,
            );
            expect(await exists(workspace.env.TMPDIR!), "env.TMPDIR was removed by cleanup").toBe(
                false,
            );
            expect(await exists(workspace.env.TMP!), "env.TMP was removed by cleanup").toBe(false);
            expect(await exists(workspace.env.TEMP!), "env.TEMP was removed by cleanup").toBe(
                false,
            );
            expect(await exists(workspace.env.HOME!), "env.HOME was removed by cleanup").toBe(
                false,
            );
            if (workspace.shelfStorageRoot !== undefined) {
                expect(
                    await exists(workspace.shelfStorageRoot),
                    "shelfStorageRoot was removed by cleanup",
                ).toBe(false);
            }
            expect(await exists(ownRoot), "fixture-owned root was removed by cleanup").toBe(false);
            expect(
                (await readdir(workspacesRoot)).some((entry) => entry.startsWith("ig-")),
                "workspacesRoot had no ig- workspace left after cleanup",
            ).toBe(false);
        },
        FIXTURE_TIMEOUT_MS,
    );

    it(
        "retry after failed dispose removes the fixture-owned resources",
        async () => {
            const workspacesRoot = await createWorkspacesRoot("retry-cleanup");
            const workspace = await createFixtureWorkspace({ scenario: "clean", workspacesRoot });
            workspacesToDispose.push(workspace);
            const ownRoot = ownRootOf(workspace);
            const injectedError = new Error("injected ownRoot removal failure");
            const actual =
                await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
            const realRm = actual.rm.bind(actual);
            let shouldFailOwnRootRm = true;
            rmMock.mockImplementation(async (target, options) => {
                if (target === ownRoot && shouldFailOwnRootRm) {
                    throw injectedError;
                }
                return realRm(target, options);
            });

            const firstDispose = workspace.dispose();
            await expect(
                firstDispose,
                "first dispose must expose the injected failure",
            ).rejects.toThrow(injectedError.message);
            expect(await exists(ownRoot), "ownRoot remained after the failed first dispose").toBe(
                true,
            );
            expect(
                await exists(workspace.root),
                "root remained after the failed first dispose",
            ).toBe(true);
            expect(
                await exists(workspace.originRoot),
                "originRoot remained after the failed first dispose",
            ).toBe(true);
            expect(
                await exists(workspace.profileDir),
                "profileDir remained after the failed first dispose",
            ).toBe(true);
            expect(
                await exists(workspace.env.TMPDIR!),
                "TMPDIR remained after the failed first dispose",
            ).toBe(true);
            expect(
                await exists(workspace.env.HOME!),
                "HOME remained after the failed first dispose",
            ).toBe(true);
            expect(
                rmMock.mock.calls.filter(([target]) => target === ownRoot),
                "the injected failure affected exactly one ownRoot rm call",
            ).toHaveLength(1);

            shouldFailOwnRootRm = false;
            const retryDispose = workspace.dispose();
            expect(retryDispose, "failed disposal must clear its memo before a retry").not.toBe(
                firstDispose,
            );
            await expect(
                retryDispose,
                "second dispose must retry after the failure",
            ).resolves.toBeUndefined();

            expect(await exists(ownRoot), "ownRoot was removed by the retry").toBe(false);
            expect(await exists(workspace.root), "root was removed by the retry").toBe(false);
            expect(await exists(workspace.originRoot), "originRoot was removed by the retry").toBe(
                false,
            );
            expect(await exists(workspace.profileDir), "profileDir was removed by the retry").toBe(
                false,
            );
            expect(await exists(workspace.env.TMPDIR!), "TMPDIR was removed by the retry").toBe(
                false,
            );
            expect(await exists(workspace.env.HOME!), "HOME was removed by the retry").toBe(false);
            expect(
                rmMock.mock.calls.filter(([target]) => target === ownRoot),
                "the retry made the second real ownRoot rm call",
            ).toHaveLength(2);
        },
        FIXTURE_TIMEOUT_MS,
    );

    it(
        "joins overlapping dispose calls to one in-flight cleanup promise",
        async () => {
            const workspacesRoot = await createWorkspacesRoot("overlap-cleanup");
            const workspace = await createFixtureWorkspace({ scenario: "clean", workspacesRoot });
            workspacesToDispose.push(workspace);
            const ownRoot = ownRootOf(workspace);
            const injectedError = new Error("injected overlapping removal failure");
            const actual =
                await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
            const realRm = actual.rm.bind(actual);
            let releaseFailure!: () => void;
            const failureGate = new Promise<void>((resolve) => {
                releaseFailure = resolve;
            });
            let shouldFailOwnRootRm = true;
            rmMock.mockImplementation(async (target, options) => {
                if (target === ownRoot && shouldFailOwnRootRm) {
                    await failureGate;
                    throw injectedError;
                }
                return realRm(target, options);
            });

            const firstDispose = workspace.dispose();
            const overlappingDispose = workspace.dispose();
            expect(
                overlappingDispose,
                "overlapping dispose calls must join the same in-flight cleanup promise",
            ).toBe(firstDispose);
            releaseFailure();
            await expect(firstDispose).rejects.toThrow(injectedError.message);

            shouldFailOwnRootRm = false;
            await workspace.dispose();
        },
        FIXTURE_TIMEOUT_MS,
    );

    it(
        "removes ownRoot even when linked-worktree cleanup fails",
        async () => {
            const workspacesRoot = await createWorkspacesRoot("linked-failure");
            const workspace = await createFixtureWorkspace({ scenario: "clean", workspacesRoot });
            workspacesToDispose.push(workspace);
            const ownRoot = ownRootOf(workspace);
            const linkedWorktreePath = path.join(workspacesRoot, "linked-worktree-outside-root");
            const injectedError = new Error("injected linked-worktree removal failure");
            const actual =
                await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
            const realRm = actual.rm.bind(actual);

            await git(
                workspace.root,
                ["worktree", "add", linkedWorktreePath, "-b", "resource-cleanup-linked-failure"],
                workspace.env,
            );
            const linkedWorktreeRealPath = await realpath(linkedWorktreePath);
            expect(await exists(linkedWorktreePath), "linked worktree existed before cleanup").toBe(
                true,
            );
            expect(
                (
                    await git(workspace.root, ["worktree", "list", "--porcelain"], workspace.env)
                ).includes(linkedWorktreePath),
                "git reported the external linked worktree before cleanup",
            ).toBe(true);

            rmMock.mockImplementation(async (target, options) => {
                if (target === linkedWorktreePath || target === linkedWorktreeRealPath) {
                    throw injectedError;
                }
                return realRm(target, options);
            });

            try {
                await expect(
                    workspace.dispose(),
                    "dispose must expose the linked-worktree failure",
                ).rejects.toThrow(injectedError.message);
                expect(
                    await exists(ownRoot),
                    "ownRoot was removed despite linked-worktree failure",
                ).toBe(false);
            } finally {
                // The injected failure intentionally leaves the external directory for this explicit,
                // real cleanup; it is outside ownRoot and therefore cannot be covered by ownRoot rm.
                await realRm(linkedWorktreePath, { recursive: true, force: true });
            }
        },
        FIXTURE_TIMEOUT_MS,
    );

    it(
        "contains awaited spawned-child temp files inside ownRoot and removes them with dispose",
        async () => {
            const workspacesRoot = await createWorkspacesRoot("child-process");
            const workspace = await createFixtureWorkspace({ scenario: "clean", workspacesRoot });
            workspacesToDispose.push(workspace);
            const ownRoot = ownRootOf(workspace);
            const childScript = [
                'const os = require("node:os");',
                'const fs = require("node:fs");',
                'const path = require("node:path");',
                'const target = path.join(os.tmpdir(), "spawned-child-resource.txt");',
                'fs.writeFileSync(target, "child process resource");',
                "process.stdout.write(target);",
            ].join(" ");

            // This is the honest "spawned processes" claim for this short-lived awaited harness: the
            // child receives workspace.env, writes through its own os.tmpdir(), and exits before
            // dispose. A ps/lsof snapshot would be timing-sensitive and would not prove containment.
            const { stdout } = await execFileAsync(process.execPath, ["-e", childScript], {
                env: workspace.env,
                encoding: "utf8",
            });
            const childResourcePath = stdout.trim();

            expect(await exists(childResourcePath), "the real child wrote its temp file").toBe(
                true,
            );
            expect(
                isBelow(ownRoot, childResourcePath),
                "the child temp file was contained beneath the fixture-owned root",
            ).toBe(true);

            await workspace.dispose();

            expect(await exists(childResourcePath), "dispose removed the child temp file").toBe(
                false,
            );
        },
        FIXTURE_TIMEOUT_MS,
    );
});
