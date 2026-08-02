import { describe, expect, it, vi } from "vitest";
import {
    forcePushRebasedHead,
    readRebasePushTarget,
    resolveRebasePushTarget,
    shouldOfferRebaseForcePush,
} from "../../../../src/git/interactiveRebase/push";

const TARGET = {
    remoteName: "origin",
    remoteHeadRef: "refs/heads/main",
    upstreamOid: "a".repeat(40),
};

describe("resolveRebasePushTarget", () => {
    it("returns a complete pinned target only when every upstream field is valid", () => {
        expect(resolveRebasePushTarget(TARGET)).toEqual(TARGET);
    });

    it.each([
        undefined,
        {},
        { remoteName: "origin" },
        { remoteName: "origin", remoteHeadRef: "refs/heads/main" },
        { ...TARGET, remoteName: "--upload-pack=unexpected" },
        { ...TARGET, remoteName: "origin:other" },
        { ...TARGET, remoteName: "origin/other" },
        { ...TARGET, remoteName: "r".repeat(256) },
        { ...TARGET, remoteHeadRef: "main" },
        // A ref carrying refspec punctuation would smuggle a second destination into the push.
        { ...TARGET, remoteHeadRef: "refs/heads/main:refs/heads/other" },
        { ...TARGET, remoteHeadRef: "refs/heads/ma in" },
        { ...TARGET, remoteHeadRef: "refs/heads/release..candidate" },
        { ...TARGET, remoteHeadRef: "refs/heads/release.lock" },
        { ...TARGET, remoteHeadRef: "refs/heads/release/" },
        { ...TARGET, upstreamOid: "abc1234" },
        { ...TARGET, upstreamOid: TARGET.upstreamOid.toUpperCase() },
        // An extra key means the value did not come from the reader this target is pinned to.
        { ...TARGET, extra: "unexpected" },
    ])("returns no target for absent, partial, or malformed upstream data: %#", (candidate) => {
        expect(resolveRebasePushTarget(candidate)).toBeUndefined();
    });
});

describe("readRebasePushTarget", () => {
    function executorReturning(stdout: string) {
        return {
            runBinary: vi.fn(async () => ({
                stdout: Buffer.from(stdout),
                stderr: Buffer.alloc(0),
                exitCode: 0,
                truncated: false,
            })),
        };
    }

    it("reads the upstream of a fully qualified branch as a pinned target", async () => {
        const executor = executorReturning(`origin\0refs/heads/main\0${TARGET.upstreamOid}\n`);

        await expect(readRebasePushTarget(executor as never, "refs/heads/main")).resolves.toEqual(
            TARGET,
        );
        expect(executor.runBinary).toHaveBeenCalledWith(
            [
                "for-each-ref",
                "--format=%(upstream:remotename)%00%(upstream:remoteref)%00%(upstream:objectname)",
                "refs/heads/main",
            ],
            expect.anything(),
        );
    });

    it("never asks Git about a branch name it has not validated", async () => {
        const executor = executorReturning(`origin\0refs/heads/main\0${TARGET.upstreamOid}`);

        await expect(
            readRebasePushTarget(executor as never, "--upload-pack=x"),
        ).resolves.toBeUndefined();
        expect(executor.runBinary).not.toHaveBeenCalled();
    });

    it.each([
        ["a detached or upstream-less branch", "\0\0"],
        [
            "more fields than the format defines",
            `origin\0refs/heads/main\0${TARGET.upstreamOid}\0x`,
        ],
        ["fewer fields than the format defines", "origin\0refs/heads/main"],
    ])("returns no target for %s", async (_name, stdout) => {
        await expect(
            readRebasePushTarget(executorReturning(stdout) as never, "refs/heads/main"),
        ).resolves.toBeUndefined();
    });
});

describe("shouldOfferRebaseForcePush", () => {
    it.each([
        [true, TARGET, true],
        [false, TARGET, false],
        [true, undefined, false],
        [false, undefined, false],
    ] as const)(
        "requires both pushed history and a submission-time push target",
        (hasPushedCommit, pushTarget, expected) => {
            expect(shouldOfferRebaseForcePush(hasPushedCommit, pushTarget)).toBe(expected);
        },
    );
});

describe("forcePushRebasedHead", () => {
    it("reads an exit-one symbolic ref as branch movement instead of a generic failure", async () => {
        const executor = {
            runBinary: vi.fn(async (args: string[], options?: { expectedExitCodes?: number[] }) => {
                if (args.join(" ") === "rev-parse HEAD") {
                    return {
                        stdout: Buffer.from(manifest.rebasedHeadOid + "\n"),
                        stderr: Buffer.alloc(0),
                        exitCode: 0,
                        truncated: false,
                    };
                }
                if (args.join(" ") !== "symbolic-ref --quiet HEAD") {
                    throw new Error(`Unexpected Git command: ${args.join(" ")}`);
                }
                if (!options?.expectedExitCodes?.includes(1)) throw new Error("Git exited with 1");
                return {
                    stdout: Buffer.alloc(0),
                    stderr: Buffer.alloc(0),
                    exitCode: 1,
                    truncated: false,
                };
            }),
        };
        const manifest = {
            version: 1 as const,
            sessionId: "session-1",
            repoRoot: "/fixture-repository",
            branch: "refs/heads/main",
            hasPushedCommit: true,
            pushTarget: TARGET,
            baseHash: "b".repeat(40),
            expectedHead: "c".repeat(40),
            rebasedHeadOid: "d".repeat(40),
            createdAt: "2026-08-02T00:00:00.000Z",
            lifecycle: "completed-pending-push" as const,
        };

        await expect(
            forcePushRebasedHead(
                {
                    executor: executor as never,
                    mutationGate: {
                        run: async (_repo, _common, operation) => operation(),
                    } as never,
                    storageRoot: "/storage",
                    commonDir: "/git",
                },
                manifest,
            ),
        ).resolves.toEqual({ status: "branch-moved" });
    });
});
