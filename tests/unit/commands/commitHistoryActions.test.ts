import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const vscodeMock = vi.hoisted(() => ({
    l10n: {
        t: (message: string, args?: Record<string, string | number>) =>
            args
                ? Object.entries(args).reduce(
                      (text, [key, value]) => text.replaceAll(`{${key}}`, String(value)),
                      message,
                  )
                : message,
    },
    window: {
        createTerminal: vi.fn(),
        showErrorMessage: vi.fn(),
        showInformationMessage: vi.fn(),
        showInputBox: vi.fn(),
        showWarningMessage: vi.fn(),
    },
}));

vi.mock("vscode", () => vscodeMock);

vi.mock("../../../src/services/gitHelpers", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../../src/services/gitHelpers")>();
    return {
        ...actual,
        getCommitParentHashes: vi.fn(),
        isCommitUnpushed: vi.fn(),
        isMergeCommitHash: vi.fn(),
    };
});

vi.mock("../../../src/git/interactiveRebase/guards", () => ({
    evaluateInteractiveRebaseGuards: vi.fn(),
}));

vi.mock("../../../src/git/interactiveRebase/range", async (importOriginal) => {
    const actual =
        await importOriginal<typeof import("../../../src/git/interactiveRebase/range")>();
    return { ...actual, loadInteractiveRebaseRange: vi.fn() };
});

import * as vscode from "vscode";
import { interactiveRebaseFromHere } from "../../../src/commands/commitHistoryActions";
import type { CommitActionContext } from "../../../src/commands/commitActionContext";
import { evaluateInteractiveRebaseGuards } from "../../../src/git/interactiveRebase/guards";
import { createPendingRebaseDialogRequests } from "../../../src/git/interactiveRebase/pendingRequests";
import {
    loadInteractiveRebaseRange,
    MAX_INTERACTIVE_REBASE_RANGE_COMMITS,
} from "../../../src/git/interactiveRebase/range";
import type { InteractiveRebaseRangeCommit } from "../../../src/git/interactiveRebase/types";
import type { GitExecutor } from "../../../src/git/executor";
import type { GitOps } from "../../../src/git/operations";

const HASH_A = "a".repeat(40);
const HASH_B = "b".repeat(40);
const HASH_C = "c".repeat(40);
const COMMITS: readonly InteractiveRebaseRangeCommit[] = [
    {
        hash: HASH_A,
        authorName: "Ada Lovelace",
        authoredAt: "2026-08-01T12:00:00.000Z",
        body: "first commit",
        isPushed: true,
    },
    {
        hash: HASH_B,
        authorName: "Grace Hopper",
        authoredAt: "2026-08-01T13:00:00.000Z",
        body: "second commit",
        isPushed: false,
    },
];

/** Casts an imported mocked function to Vitest's simple assertion surface. */
function asMock(fn: unknown): Mock {
    return fn as unknown as Mock;
}

const errors = asMock(vscode.window.showErrorMessage);
const terminals = asMock(vscode.window.createTerminal);
const guards = asMock(evaluateInteractiveRebaseGuards);
const ranges = asMock(loadInteractiveRebaseRange);

/** Creates the command context with one origin-bound message callback and registry. */
function contextFor(overrides: Partial<CommitActionContext> = {}): {
    context: CommitActionContext;
    originProvider: object;
    postRebaseDialog: Mock;
    pendingRequests: ReturnType<typeof createPendingRebaseDialogRequests>;
} {
    const originProvider = {};
    const postRebaseDialog = vi.fn(() => true);
    const pendingRequests = createPendingRebaseDialogRequests();
    const executor = {
        run: vi.fn(async (args: readonly string[]) => {
            if (args[0] === "symbolic-ref") return "refs/heads/main\n";
            if (args[0] === "rev-parse" && args[1] === "--verify") return `${HASH_A}\n`;
            if (args[0] === "rev-parse") return `${HASH_B}\n`;
            return "";
        }),
    } as unknown as GitExecutor;
    const gitOps = {
        hasWholeIndexOperationInProgress: vi.fn(async () => false),
    } as unknown as GitOps;
    const context = {
        validatedHash: HASH_A,
        short: HASH_A.slice(0, 8),
        executor,
        gitOps,
        repoRoot: "/repo",
        currentBranches: [],
        refreshAll: vi.fn(),
        originProvider,
        postRebaseDialog,
        pendingRebaseDialogRequests: pendingRequests,
        ...overrides,
    } as unknown as CommitActionContext;
    return { context, originProvider, postRebaseDialog, pendingRequests };
}

beforeEach(() => {
    vi.clearAllMocks();
    guards.mockResolvedValue({ status: "ok" });
    ranges.mockResolvedValue({ status: "ok", commits: COMMITS });
});

afterEach(() => {
    vi.clearAllMocks();
});

describe("interactiveRebaseFromHere", () => {
    it.each([
        [
            "invalid-selected-hash",
            "Interactive Rebase from Here received an invalid selected commit.",
        ],
        [
            "operation-in-progress",
            "Interactive Rebase from Here cannot start while another Git operation is in progress.",
        ],
        ["detached-head", "Interactive Rebase from Here requires a checked-out branch."],
        [
            "selected-merge-commit",
            "Interactive Rebase from Here is not available for merge commits.",
        ],
        ["commit-not-ancestor", "The selected commit is not in the current branch history."],
        ["initial-commit", "Interactive Rebase from Here is not available for the initial commit."],
        ["working-tree-dirty", "Interactive Rebase from Here requires a clean working tree."],
        [
            "range-contains-merge-commit",
            "Interactive Rebase from Here is not available for ranges containing merge commits.",
        ],
        ["git-error", "Interactive Rebase from Here could not inspect the repository."],
    ] as const)(
        "shows a distinct actionable error for guard rejection %s",
        async (reason, message) => {
            guards.mockResolvedValueOnce({ status: "rejected", reason });
            const { context, postRebaseDialog } = contextFor();

            await interactiveRebaseFromHere(context);

            expect(errors).toHaveBeenCalledWith(message);
            expect(postRebaseDialog).not.toHaveBeenCalled();
            expect(ranges).not.toHaveBeenCalled();
        },
    );

    it.each([
        ["invalid-base-hash", "Interactive Rebase from Here received an invalid selected commit."],
        ["invalid-head-hash", "Interactive Rebase from Here could not resolve the current HEAD."],
        [
            "range-too-large",
            `Interactive Rebase from Here supports at most ${MAX_INTERACTIVE_REBASE_RANGE_COMMITS} commits at once.`,
        ],
        ["invalid-range-count", "Interactive Rebase from Here could not count the selected range."],
        ["empty-range", "Interactive Rebase from Here found no commits to rebase."],
        [
            "output-truncated",
            "Interactive Rebase from Here could not safely load the selected range.",
        ],
        [
            "missing-trailing-sentinel",
            "Interactive Rebase from Here received incomplete range output.",
        ],
        ["malformed-arity", "Interactive Rebase from Here received malformed range output."],
        ["count-mismatch", "Interactive Rebase from Here received an inconsistent commit range."],
        ["git-error", "Interactive Rebase from Here could not load the selected range."],
    ] as const)(
        "shows a distinct actionable error for range rejection %s",
        async (reason, message) => {
            ranges.mockResolvedValueOnce({ status: "rejected", reason });
            const { context, postRebaseDialog } = contextFor();

            await interactiveRebaseFromHere(context);

            expect(errors).toHaveBeenCalledWith(message);
            expect(postRebaseDialog).not.toHaveBeenCalled();
        },
    );

    it("accepts pushed commits and posts one dialog payload plus its registered lease", async () => {
        const { context, originProvider, postRebaseDialog, pendingRequests } = contextFor();

        await interactiveRebaseFromHere(context);

        expect(terminals).not.toHaveBeenCalled();
        expect(postRebaseDialog).toHaveBeenCalledTimes(1);
        expect(postRebaseDialog).toHaveBeenCalledWith({
            type: "showRebaseDialog",
            requestId: expect.any(String),
            commits: COMMITS,
            branch: "refs/heads/main",
            hasPushed: true,
        });
        const [{ requestId }] = postRebaseDialog.mock.calls[0] as [{ requestId: string }];
        expect(pendingRequests.consume(requestId, originProvider)).toEqual({
            status: "consumed",
            request: expect.objectContaining({
                requestId,
                repoRoot: "/repo",
                baseHash: HASH_A,
                rangeHashes: [HASH_A, HASH_B],
                expectedHead: HASH_B,
                expectedBranch: "refs/heads/main",
            }),
        });
    });

    it("stores the selected commit's parent as the rebase base while preserving the selected range", async () => {
        const selectedHash = HASH_C;
        const parentHash = HASH_A;
        const executor = {
            run: vi.fn(async (args: readonly string[]) => {
                if (args[0] === "symbolic-ref") return "refs/heads/main\n";
                if (args[0] === "rev-parse" && args[1] === "--verify") return `${parentHash}\n`;
                if (args[0] === "rev-parse") return `${HASH_B}\n`;
                return "";
            }),
        } as unknown as GitExecutor;
        ranges.mockResolvedValueOnce({
            status: "ok",
            commits: [{ ...COMMITS[0], hash: selectedHash }],
        });
        const { context, originProvider, postRebaseDialog, pendingRequests } = contextFor({
            validatedHash: selectedHash,
            executor,
        });

        await interactiveRebaseFromHere(context);

        expect(executor.run).toHaveBeenCalledWith([
            "rev-parse",
            "--verify",
            "--end-of-options",
            `${selectedHash}^`,
        ]);
        expect(ranges).toHaveBeenCalledWith(executor, selectedHash, HASH_B);
        const [{ requestId }] = postRebaseDialog.mock.calls[0] as [{ requestId: string }];
        expect(pendingRequests.consume(requestId, originProvider)).toEqual({
            status: "consumed",
            request: expect.objectContaining({
                baseHash: parentHash,
                rangeHashes: [selectedHash],
            }),
        });
    });

    it("fails closed when the selected parent is not a lower-case full object ID", async () => {
        const executor = {
            run: vi.fn(async (args: readonly string[]) => {
                if (args[0] === "symbolic-ref") return "refs/heads/main\n";
                if (args[0] === "rev-parse" && args[1] === "--verify") return "not-a-hash\n";
                return `${HASH_B}\n`;
            }),
        } as unknown as GitExecutor;
        const { context, postRebaseDialog } = contextFor({ executor });

        await interactiveRebaseFromHere(context);

        expect(errors).toHaveBeenCalledWith(
            "Interactive Rebase from Here could not inspect the repository.",
        );
        expect(ranges).not.toHaveBeenCalled();
        expect(postRebaseDialog).not.toHaveBeenCalled();
    });

    it("pins the range load to the resolved tip rather than a live HEAD reference", async () => {
        const { context } = contextFor();

        await interactiveRebaseFromHere(context);

        // A literal "HEAD" here would let the loader observe a different tip than the one registered.
        expect(ranges).toHaveBeenCalledWith(context.executor, HASH_A, HASH_B);
    });

    it("refuses the request when HEAD advances while the range is loading", async () => {
        let head = HASH_B;
        const executor = {
            run: vi.fn(async (args: readonly string[]) => {
                if (args[0] === "symbolic-ref") return "refs/heads/main\n";
                if (args[0] === "rev-parse") return `${head}\n`;
                return "";
            }),
        } as unknown as GitExecutor;
        ranges.mockImplementationOnce(async () => {
            head = HASH_C; // A commit lands from another client mid-load.
            return { status: "ok", commits: COMMITS };
        });
        const { context, postRebaseDialog } = contextFor({ executor });

        await interactiveRebaseFromHere(context);

        expect(postRebaseDialog).not.toHaveBeenCalled();
        expect(errors).toHaveBeenCalledWith(
            "The branch moved while the rebase range was loading. Try again.",
        );
    });

    it("refuses the request when the checked-out branch changes while the range is loading", async () => {
        let branch = "refs/heads/main";
        const executor = {
            run: vi.fn(async (args: readonly string[]) => {
                if (args[0] === "symbolic-ref") return `${branch}\n`;
                if (args[0] === "rev-parse") return `${HASH_B}\n`;
                return "";
            }),
        } as unknown as GitExecutor;
        ranges.mockImplementationOnce(async () => {
            branch = "refs/heads/feature"; // A checkout to a branch pointing at the same commit.
            return { status: "ok", commits: COMMITS };
        });
        const { context, postRebaseDialog } = contextFor({ executor });

        await interactiveRebaseFromHere(context);

        expect(postRebaseDialog).not.toHaveBeenCalled();
        expect(errors).toHaveBeenCalledWith(
            "The branch moved while the rebase range was loading. Try again.",
        );
    });

    it.each([
        ["symbolic-ref", "Interactive Rebase from Here could not resolve the current branch."],
        ["rev-parse", "Interactive Rebase from Here could not resolve the current HEAD."],
    ] as const)(
        "reports a failed %s tip read without registering a request",
        async (failing, message) => {
            const executor = {
                run: vi.fn(async (args: readonly string[]) => {
                    if (args[0] === "rev-parse" && args[1] === "--verify") return `${HASH_A}\n`;
                    if (args[0] === failing) throw new Error("git failed");
                    if (args[0] === "symbolic-ref") return "refs/heads/main\n";
                    return `${HASH_B}\n`;
                }),
            } as unknown as GitExecutor;
            const { context, postRebaseDialog } = contextFor({ executor });

            await interactiveRebaseFromHere(context);

            expect(errors).toHaveBeenCalledWith(message);
            expect(postRebaseDialog).not.toHaveBeenCalled();
            expect(ranges).not.toHaveBeenCalled();
        },
    );

    it("awaits and retracts the registered request when the originating view cannot show the dialog", async () => {
        const { context, originProvider, postRebaseDialog, pendingRequests } = contextFor();
        postRebaseDialog.mockResolvedValue(false);

        await interactiveRebaseFromHere(context);

        const [{ requestId }] = postRebaseDialog.mock.calls[0] as [{ requestId: string }];
        expect(pendingRequests.consume(requestId, originProvider)).toEqual({
            status: "rejected",
            reason: "unknown-or-expired",
        });
        expect(errors).toHaveBeenCalledWith(
            "Interactive Rebase from Here could not open its dialog.",
        );
    });
});
