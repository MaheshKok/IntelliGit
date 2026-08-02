import { describe, expect, it, vi } from "vitest";
import type { GitExecutor } from "../../../../src/git/executor";
import { createPendingRebaseDialogRequests } from "../../../../src/git/interactiveRebase/pendingRequests";
import { createInteractiveRebaseSubmissionHandler } from "../../../../src/git/interactiveRebase/submission";
import { MAX_INTERACTIVE_REBASE_MESSAGE_BYTES } from "../../../../src/git/interactiveRebase/todo";
import type { RebaseSubmissionEntry } from "../../../../src/git/interactiveRebase/types";

const HASH_A = "a".repeat(40);
const HASH_B = "b".repeat(40);
const HASH_C = "c".repeat(40);
const BRANCH = "refs/heads/main";
// "🎉" is 2 UTF-16 code units but 4 UTF-8 bytes: a naive `.length` cap would under-count this
// message by half, so these fixtures prove the validator measures real UTF-8 bytes.
const MESSAGE_AT_CAP =
    "\u{1F389}".repeat(Math.floor(MAX_INTERACTIVE_REBASE_MESSAGE_BYTES / 4)) +
    "a".repeat(MAX_INTERACTIVE_REBASE_MESSAGE_BYTES % 4);
const MESSAGE_OVER_CAP = `${MESSAGE_AT_CAP}a`;

type GitResponse = string | Error | readonly (string | Error)[];

/** Builds a Git executor mock for the submission snapshot and guard probes. */
function executorFor(overrides: Record<string, GitResponse> = {}): GitExecutor {
    const responses: Record<string, GitResponse> = {
        "symbolic-ref --quiet HEAD": [BRANCH, BRANCH],
        "rev-parse HEAD": HASH_B,
        "bisect log": new Error("not bisecting"),
        [`rev-list --parents -n 1 --end-of-options ${HASH_A}`]: `${HASH_A} ${HASH_B}\n`,
        [`merge-base --is-ancestor --end-of-options ${HASH_A} HEAD`]: "",
        "status --porcelain=v1 -z -uno": "",
        [`rev-list --parents --end-of-options ${HASH_A}^..HEAD`]: `${HASH_B} ${HASH_A}\n${HASH_A}\n`,
        ...overrides,
    };
    return {
        run: vi.fn(async (args: string[]) => {
            const command = args.join(" ");
            const response = responses[command];
            const value = Array.isArray(response) ? response.shift() : response;
            if (value instanceof Error) throw value;
            if (value === undefined) throw new Error(`Unexpected Git command: ${command}`);
            return value;
        }),
        runBinary: vi.fn(async (args: string[]) => {
            if (args[0] !== "for-each-ref")
                throw new Error(`Unexpected Git binary command: ${args.join(" ")}`);
            return {
                stdout: Buffer.from("\0\0"),
                stderr: Buffer.alloc(0),
                exitCode: 0,
                truncated: false,
            };
        }),
    } as unknown as GitExecutor;
}

/** Registers one origin-bound request with a controllable offered range. */
function setup(
    options: {
        origin?: object;
        rangeHashes?: readonly string[];
        baseHash?: string;
        executor?: GitExecutor;
        getRepoRoot?: () => string;
        hasWholeIndexOperationInProgress?: () => Promise<boolean>;
    } = {},
) {
    const origin = options.origin ?? {};
    const requests = createPendingRebaseDialogRequests();
    const requestId = requests.register({
        originProvider: origin,
        repoRoot: "/repo",
        baseHash: options.baseHash ?? HASH_A,
        rangeHashes: options.rangeHashes ?? [HASH_A],
        expectedHead: HASH_B,
        expectedBranch: BRANCH,
    });
    return {
        origin,
        requestId,
        handler: createInteractiveRebaseSubmissionHandler({
            executor: options.executor ?? executorFor(),
            pendingRebaseDialogRequests: requests,
            getRepoRoot: options.getRepoRoot ?? (() => "/repo"),
            hasWholeIndexOperationInProgress:
                options.hasWholeIndexOperationInProgress ?? (async () => false),
        } as never),
    };
}

function validEntries(hash = HASH_A): RebaseSubmissionEntry[] {
    return [{ hash, action: "pick" }];
}

describe("interactive rebase submission handler", () => {
    it("accepts validated entries after consuming the origin-bound request", async () => {
        const { handler, origin, requestId } = setup();
        const submitted = validEntries(HASH_A.toUpperCase());

        const result = await handler.submit({ requestId, entries: submitted }, origin);

        expect(result).toMatchObject({
            status: "accepted",
            request: { requestId, expectedHead: HASH_B, expectedBranch: BRANCH },
            entries: [{ hash: HASH_A, action: "pick" }],
        });
        if (result.status !== "accepted") throw new Error("Expected accepted submission.");
        expect(result.entries).not.toBe(submitted);
        expect(result.entries[0]?.hash).toBe(HASH_A);
    });

    it("captures a complete upstream target at submission time", async () => {
        const executor = executorFor();
        (executor.runBinary as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
            stdout: Buffer.from(`origin\0refs/heads/main\0${HASH_C}`),
            stderr: Buffer.alloc(0),
            exitCode: 0,
            truncated: false,
        });
        const { handler, origin, requestId } = setup({ executor });

        await expect(
            handler.submit({ requestId, entries: validEntries() }, origin),
        ).resolves.toMatchObject({
            status: "accepted",
            request: {
                pushTarget: {
                    remoteName: "origin",
                    remoteHeadRef: "refs/heads/main",
                    upstreamOid: HASH_C,
                },
            },
        });
    });

    it("accepts a message exactly at the byte cap", async () => {
        const { handler, origin, requestId } = setup();

        await expect(
            handler.submit(
                { requestId, entries: [{ hash: HASH_A, action: "pick", message: MESSAGE_AT_CAP }] },
                origin,
            ),
        ).resolves.toMatchObject({ status: "accepted" });
    });

    it("does not consume a request when a different provider submits it", async () => {
        const { handler, origin, requestId } = setup();

        await expect(handler.submit({ requestId, entries: validEntries() }, {})).resolves.toEqual({
            status: "rejected",
            reason: "wrong-origin",
        });
        await expect(
            handler.submit({ requestId, entries: validEntries() }, origin),
        ).resolves.toMatchObject({
            status: "accepted",
        });
    });

    it("rejects an unknown or expired request ID", async () => {
        const { handler, origin } = setup();

        await expect(
            handler.submit({ requestId: "missing", entries: validEntries() }, origin),
        ).resolves.toEqual({ status: "rejected", reason: "unknown-or-expired" });
    });

    it.each([
        ["invalid action", [{ hash: HASH_A, action: "edit" }], [HASH_A], "invalid-action"],
        ["invalid hash", [{ hash: "short", action: "pick" }], [HASH_A], "invalid-hash"],
        ["hash outside offer", [{ hash: HASH_B, action: "pick" }], [HASH_A], "hash-not-offered"],
        [
            "duplicate hash",
            [
                { hash: HASH_A, action: "pick" },
                { hash: HASH_A, action: "drop" },
            ],
            [HASH_A, HASH_B],
            "duplicate-hash",
        ],
        [
            "entry count mismatch",
            [{ hash: HASH_A, action: "pick" }],
            [HASH_A, HASH_B],
            "entry-count-mismatch",
        ],
        ["missing message", [{ hash: HASH_A, action: "reword" }], [HASH_A], "missing-message"],
        [
            "invalid message",
            [{ hash: HASH_A, action: "pick", message: "bad\0text" }],
            [HASH_A],
            "invalid-message",
        ],
        [
            "message exceeds the byte cap",
            [{ hash: HASH_A, action: "pick", message: MESSAGE_OVER_CAP }],
            [HASH_A],
            "invalid-message",
        ],
        [
            "invalid first action",
            [{ hash: HASH_A, action: "fixup" }],
            [HASH_A],
            "invalid-first-action",
        ],
    ] as const)("surfaces validator rejection: %s", async (_name, entries, rangeHashes, reason) => {
        const { handler, origin, requestId } = setup({ rangeHashes });

        await expect(handler.submit({ requestId, entries }, origin)).resolves.toEqual({
            status: "rejected",
            reason,
        });
    });

    it("rejects when HEAD moved after the dialog opened", async () => {
        const { handler, origin, requestId } = setup({
            executor: executorFor({ "rev-parse HEAD": HASH_C }),
        });

        await expect(
            handler.submit({ requestId, entries: validEntries() }, origin),
        ).resolves.toEqual({
            status: "rejected",
            reason: "head-moved",
        });
    });

    it("rejects a same-tip switch to a different branch", async () => {
        const { handler, origin, requestId } = setup({
            executor: executorFor({
                "symbolic-ref --quiet HEAD": "refs/heads/feature/refs/heads/main",
            }),
        });

        await expect(
            handler.submit({ requestId, entries: validEntries() }, origin),
        ).resolves.toEqual({
            status: "rejected",
            reason: "branch-moved",
        });
    });

    it("rejects a submission after its repository root changed without running Git", async () => {
        const executor = executorFor();
        const { handler, origin, requestId } = setup({
            executor,
            getRepoRoot: () => "/other-repository",
        });

        await expect(
            handler.submit({ requestId, entries: validEntries() }, origin),
        ).resolves.toEqual({ status: "rejected", reason: "repo-changed" });
        expect(executor.run).not.toHaveBeenCalled();
    });

    it.each([
        [
            "cannot read the current branch",
            { "symbolic-ref --quiet HEAD": new Error("detached") },
            "branch-unavailable",
        ],
        ["cannot read HEAD", { "rev-parse HEAD": new Error("missing HEAD") }, "head-unavailable"],
    ] as const)("rejects when it %s", async (_name, overrides, reason) => {
        const { handler, origin, requestId } = setup({ executor: executorFor(overrides) });

        await expect(
            handler.submit({ requestId, entries: validEntries() }, origin),
        ).resolves.toEqual({
            status: "rejected",
            reason,
        });
    });

    it.each([
        ["invalid selected hash", {}, "invalid-selected-hash", "not-a-hash"],
        ["operation in progress", {}, "operation-in-progress", HASH_A, async () => true],
        [
            "detached HEAD",
            { "symbolic-ref --quiet HEAD": [BRANCH, new Error("detached")] },
            "detached-head",
        ],
        [
            "selected merge commit",
            {
                [`rev-list --parents -n 1 --end-of-options ${HASH_A}`]: `${HASH_A} ${HASH_B} ${HASH_C}\n`,
            },
            "selected-merge-commit",
        ],
        [
            "initial commit",
            { [`rev-list --parents -n 1 --end-of-options ${HASH_A}`]: `${HASH_A}\n` },
            "initial-commit",
        ],
        [
            "commit outside HEAD history",
            {
                [`merge-base --is-ancestor --end-of-options ${HASH_A} HEAD`]: new Error(
                    "not ancestor",
                ),
            },
            "commit-not-ancestor",
        ],
        [
            "dirty working tree",
            { "status --porcelain=v1 -z -uno": " M tracked.txt\0" },
            "working-tree-dirty",
        ],
        [
            "merge inside range",
            {
                [`rev-list --parents --end-of-options ${HASH_A}^..HEAD`]: `${HASH_A} ${HASH_B} ${HASH_C}\n`,
            },
            "range-contains-merge-commit",
        ],
        [
            "guard git error",
            { "status --porcelain=v1 -z -uno": new Error("status failed") },
            "git-error",
        ],
    ] as const)(
        "surfaces a guard that fails only at submit: %s",
        async (_name, overrides, reason, baseHash = HASH_A, hasWholeIndexOperationInProgress) => {
            const { handler, origin, requestId } = setup({
                baseHash,
                executor: executorFor(overrides),
                hasWholeIndexOperationInProgress,
            });

            await expect(
                handler.submit({ requestId, entries: validEntries() }, origin),
            ).resolves.toEqual({
                status: "rejected",
                reason,
            });
        },
    );

    it("consumes a cancelled request so a later submit is rejected", async () => {
        const { handler, origin, requestId } = setup();

        expect(handler.cancel({ requestId }, origin)).toBe(true);
        await expect(
            handler.submit({ requestId, entries: validEntries() }, origin),
        ).resolves.toEqual({
            status: "rejected",
            reason: "unknown-or-expired",
        });
    });
});
