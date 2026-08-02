import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
const failingRemovals = vi.hoisted(() => new Set<string>());

vi.mock("node:fs/promises", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    return {
        ...actual,
        // Only an armed path fails. Storage's own temp-file cleanup keeps working, so the
        // failure lands exactly on the removal whose restore path is under test.
        rm: async (target: unknown, options?: unknown) => {
            if (typeof target === "string" && failingRemovals.has(target)) {
                throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
            }
            return actual.rm(target as never, options as never);
        },
    };
});

import {
    dismissRebasePushOffer,
    forcePushRebasedHead,
} from "../../../../src/git/interactiveRebase/push";
import {
    getRebaseStoragePaths,
    readRebaseManifest,
    writeRebaseManifest,
} from "../../../../src/git/interactiveRebase/storage";
import type { RebaseSessionManifest } from "../../../../src/git/interactiveRebase/types";

const BRANCH = "refs/heads/main";
const HEAD = "b".repeat(40);
const UPSTREAM = "a".repeat(40);
const roots: string[] = [];

afterEach(async () => {
    failingRemovals.clear();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(
    options: {
        branch?: string;
        head?: string;
        pushFails?: boolean;
        breakCleanupAfterPush?: boolean;
        truncatedProbe?: boolean;
    } = {},
) {
    const storageRoot = await mkdtemp(path.join(os.tmpdir(), "intelligit-rebase-push-"));
    roots.push(storageRoot);
    const manifest: RebaseSessionManifest = {
        version: 1,
        sessionId: "session-1",
        repoRoot: "/fixture-repository",
        branch: BRANCH,
        hasPushedCommit: true,
        baseHash: "c".repeat(40),
        expectedHead: "d".repeat(40),
        createdAt: "2026-08-02T00:00:00.000Z",
        lifecycle: "completed-pending-push",
        rebasedHeadOid: HEAD,
        pushTarget: {
            remoteName: "origin",
            remoteHeadRef: "refs/heads/main",
            upstreamOid: UPSTREAM,
        },
    };
    await writeRebaseManifest(storageRoot, manifest);
    const manifestPath = getRebaseStoragePaths(storageRoot, manifest.repoRoot).manifestPath(
        manifest.sessionId,
    );
    const executor = {
        runBinary: vi.fn(async (args: string[]) => {
            // Real Git terminates both probes with a newline, so the fixture does too.
            if (args.join(" ") === "symbolic-ref --quiet HEAD")
                return {
                    ...binary(`${options.branch ?? BRANCH}\n`),
                    truncated: options.truncatedProbe === true,
                };
            if (args.join(" ") === "rev-parse HEAD") return binary(`${options.head ?? HEAD}\n`);
            if (args[0] === "push") {
                if (options.pushFails) throw new Error("remote rejected the lease");
                // Breaking storage from inside the push is the only seam that puts the failure
                // strictly after the remote ref moved. Swapping the manifest for a non-empty
                // directory makes every write and unlink against that path fail on any platform
                // without depending on file modes, which a root test runner would ignore.
                if (options.breakCleanupAfterPush) {
                    await rm(manifestPath);
                    await mkdir(manifestPath);
                    await writeFile(path.join(manifestPath, "occupied"), "");
                }
                return binary("");
            }
            throw new Error(`Unexpected Git command: ${args.join(" ")}`);
        }),
    };
    const mutationGate = {
        run: vi.fn(async (_root: string, _common: string, task: () => Promise<unknown>) => task()),
    };
    return { storageRoot, manifest, manifestPath, executor, mutationGate };
}

function dependencies(test: Awaited<ReturnType<typeof fixture>>) {
    return {
        executor: test.executor as never,
        mutationGate: test.mutationGate as never,
        storageRoot: test.storageRoot,
        commonDir: "/fixture-common",
    };
}

function binary(stdout: string) {
    return { stdout: Buffer.from(stdout), stderr: Buffer.alloc(0), exitCode: 0, truncated: false };
}

async function expectMissing(target: string): Promise<void> {
    await expect(access(target)).rejects.toMatchObject({ code: "ENOENT" });
}

describe("post-rebase force push", () => {
    it("pushes exactly the captured source and destination with an explicit lease then removes the offer", async () => {
        const test = await fixture();

        await expect(forcePushRebasedHead(dependencies(test), test.manifest)).resolves.toEqual({
            status: "pushed",
            offerRetained: false,
        });

        expect(test.executor.runBinary).toHaveBeenCalledWith([
            "push",
            "origin",
            `${HEAD}:refs/heads/main`,
            `--force-with-lease=refs/heads/main:${UPSTREAM}`,
        ]);
        await expectMissing(test.manifestPath);
    });

    it("reports a push that landed as pushed even when clearing its offer fails", async () => {
        const test = await fixture({ breakCleanupAfterPush: true });

        // The remote ref has already moved by the time cleanup runs, so a bookkeeping failure
        // must never be reported as a failed push — a user told the push failed would force-push
        // a second time against a lease that no longer matches.
        await expect(forcePushRebasedHead(dependencies(test), test.manifest)).resolves.toEqual({
            status: "pushed",
            offerRetained: true,
        });

        expect(test.executor.runBinary).toHaveBeenCalledWith(
            expect.arrayContaining(["push", "origin"]),
        );
        // The offer survives, so reload reconciliation resurfaces it instead of losing the outcome.
        await expect(access(test.manifestPath)).resolves.toBeUndefined();
    });

    it.each([
        ["branch", { branch: "refs/heads/other" }, "branch-moved"],
        ["HEAD", { head: "e".repeat(40) }, "head-moved"],
    ] as const)(
        "does not push when the %s moved since the rebase",
        async (_name, options, status) => {
            const test = await fixture(options);

            await expect(forcePushRebasedHead(dependencies(test), test.manifest)).resolves.toEqual({
                status,
            });

            expect(test.executor.runBinary).not.toHaveBeenCalledWith(
                expect.arrayContaining(["push"]),
            );
            await expect(access(test.manifestPath)).resolves.toBeUndefined();
        },
    );

    it("retains the offer when the push fails", async () => {
        const test = await fixture({ pushFails: true });

        await expect(forcePushRebasedHead(dependencies(test), test.manifest)).resolves.toEqual({
            status: "failed",
            message: "remote rejected the lease",
        });

        await expect(access(test.manifestPath)).resolves.toBeUndefined();
    });

    it("restores the pending offer when its manifest cannot be removed", async () => {
        const test = await fixture();
        failingRemovals.add(test.manifestPath);

        await expect(forcePushRebasedHead(dependencies(test), test.manifest)).resolves.toEqual({
            status: "pushed",
            offerRetained: true,
        });

        // Cleanup commits `done` before unlinking. Without a restore the surviving record would
        // read `done`, and reconciliation would treat an uncleared offer as already handled.
        failingRemovals.clear();
        await expect(
            readRebaseManifest(test.storageRoot, test.manifest.repoRoot, test.manifest.sessionId),
        ).resolves.toEqual({ status: "valid", manifest: test.manifest });
    });

    it("never pushes when a probe's output was truncated", async () => {
        const test = await fixture({ truncatedProbe: true });

        await expect(forcePushRebasedHead(dependencies(test), test.manifest)).resolves.toEqual({
            status: "failed",
            message: "Git output exceeded 4194304 bytes.",
        });

        expect(test.executor.runBinary).not.toHaveBeenCalledWith(expect.arrayContaining(["push"]));
    });

    it.each(["pushTarget", "rebasedHeadOid"] as const)(
        "refuses to touch the remote when the manifest has no %s",
        async (field) => {
            const test = await fixture();
            const { [field]: _omitted, ...incomplete } = test.manifest;

            await expect(
                forcePushRebasedHead(dependencies(test), incomplete as RebaseSessionManifest),
            ).resolves.toEqual({
                status: "failed",
                message: "The rebase push target is incomplete.",
            });

            expect(test.mutationGate.run).not.toHaveBeenCalled();
            expect(test.executor.runBinary).not.toHaveBeenCalled();
        },
    );

    it("dismisses a pending offer by removing its manifest", async () => {
        const test = await fixture();

        await dismissRebasePushOffer(test.storageRoot, test.manifest);

        await expectMissing(test.manifestPath);
    });
});
