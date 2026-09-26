import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitOps } from "../../../src/git/operations";
import { GitExecutor } from "../../../src/git/executor";

const mocks = vi.hoisted(() => {
    class Uri {
        constructor(
            readonly fsPath: string,
            readonly scheme = "file",
        ) {}
    }
    const scopedExecutor = { run: vi.fn(async (_args: string[]) => undefined) };
    return {
        Uri,
        activeUri: new Uri("/repo-a/active.txt"),
        realpath: vi.fn(async (value: string) => value),
        discover: vi.fn(async () => "/repo-b\n"),
        scopedExecutor,
        deriveExecutor: vi.fn(() => scopedExecutor),
        operation: vi.fn(async () => "none"),
        input: vi.fn(async () => "new-feature" as string | undefined),
        error: vi.fn(),
        info: vi.fn(),
    };
});

vi.mock("node:fs/promises", () => ({ realpath: mocks.realpath }));
vi.mock("vscode", () => ({
    Uri: mocks.Uri,
    window: {
        get activeTextEditor() {
            return { document: { uri: mocks.activeUri } };
        },
        showInputBox: mocks.input,
        showErrorMessage: mocks.error,
        showInformationMessage: mocks.info,
    },
    l10n: {
        t: (message: string, args?: Record<string, unknown>) =>
            Object.entries(args ?? {}).reduce(
                (text, [key, value]) => text.replace(`{${key}}`, String(value)),
                message,
            ),
    },
}));
vi.mock("../../../src/git/executor", () => ({
    GitExecutor: class {
        run = mocks.discover;
        deriveFor = mocks.deriveExecutor;
    },
}));
vi.mock("../../../src/services/diffService", () => ({}));
vi.mock("../../../src/utils/notifications", () => ({ showTimedInformationMessage: mocks.info }));

import { newBranchFileFromContext } from "../../../src/commands/fileContextCommands";

const scoped = { getActiveOperation: mocks.operation } as unknown as GitOps;
const deriveFor = vi.fn(() => scoped);
const gitOps = { deriveFor } as unknown as GitOps;
const executor = new GitExecutor("/repo-a");
const refresh = vi.fn(async (_repoRoot: string) => undefined);

beforeEach(() => {
    vi.clearAllMocks();
    mocks.activeUri = new mocks.Uri("/repo-a/active.txt");
    mocks.discover.mockResolvedValue("/repo-b\n");
    mocks.operation.mockResolvedValue("none");
    mocks.input.mockResolvedValue("new-feature");
    mocks.scopedExecutor.run.mockResolvedValue(undefined);
    refresh.mockResolvedValue(undefined);
});

describe("native New Branch repository contract", () => {
    it("creates and checks out from clicked B HEAD, then refreshes B", async () => {
        await newBranchFileFromContext(
            new mocks.Uri("/repo-b/selected.txt"),
            gitOps,
            executor,
            refresh,
        );
        expect(deriveFor, "clicked B owns operation fences").toHaveBeenCalledWith("/repo-b");
        expect(mocks.deriveExecutor, "clicked B owns mutation").toHaveBeenCalledWith("/repo-b");
        expect(
            mocks.scopedExecutor.run,
            "create and checkout from current HEAD",
        ).toHaveBeenCalledWith(["checkout", "-b", "new-feature"]);
        expect(mocks.operation).toHaveBeenCalledTimes(2);
        expect(refresh, "refresh follows checkout").toHaveBeenCalledWith("/repo-b");
        expect(mocks.scopedExecutor.run.mock.invocationCallOrder[0]).toBeLessThan(
            refresh.mock.invocationCallOrder[0]!,
        );
        expect(mocks.info).toHaveBeenCalledWith("Created and checked out new-feature");
    });

    it("waits for checkout completion before success and refresh", async () => {
        let finishCheckout!: () => void;
        mocks.scopedExecutor.run.mockImplementationOnce(
            () => new Promise<void>((resolve) => (finishCheckout = resolve)),
        );
        const pending = newBranchFileFromContext(
            new mocks.Uri("/repo-b/selected.txt"),
            gitOps,
            executor,
            refresh,
        );
        await vi.waitFor(() => expect(mocks.scopedExecutor.run).toHaveBeenCalledOnce());
        expect(mocks.info, "success requires completed checkout").not.toHaveBeenCalled();
        expect(refresh, "refresh requires completed checkout").not.toHaveBeenCalled();
        finishCheckout();
        await pending;
        expect(refresh).toHaveBeenCalledWith("/repo-b");
    });

    it("keeps clicked B after active A changes during input", async () => {
        let release!: (value: string) => void;
        mocks.input.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
        const pending = newBranchFileFromContext(
            new mocks.Uri("/repo-b/selected.txt"),
            gitOps,
            executor,
            refresh,
        );
        await vi.waitFor(() => expect(mocks.input).toHaveBeenCalledOnce());
        mocks.activeUri = new mocks.Uri("/repo-c/active.txt");
        release("drift-safe");
        await pending;
        expect(deriveFor).toHaveBeenCalledOnce();
        expect(deriveFor).toHaveBeenCalledWith("/repo-b");
        expect(mocks.deriveExecutor).toHaveBeenCalledOnce();
        expect(mocks.deriveExecutor).toHaveBeenCalledWith("/repo-b");
        expect(mocks.scopedExecutor.run).toHaveBeenCalledWith(["checkout", "-b", "drift-safe"]);
        expect(refresh).toHaveBeenCalledExactlyOnceWith("/repo-b");
    });

    it("cancels without mutation or refresh", async () => {
        mocks.input.mockResolvedValueOnce(undefined);
        await newBranchFileFromContext(
            new mocks.Uri("/repo-b/selected.txt"),
            gitOps,
            executor,
            refresh,
        );
        expect(mocks.scopedExecutor.run).not.toHaveBeenCalled();
        expect(refresh).not.toHaveBeenCalled();
    });

    it("rejects invalid input with the existing branch-name contract", async () => {
        mocks.input.mockResolvedValueOnce("-bad");
        await newBranchFileFromContext(
            new mocks.Uri("/repo-b/selected.txt"),
            gitOps,
            executor,
            refresh,
        );
        expect(mocks.error).toHaveBeenCalledWith(
            expect.stringContaining("Invalid branch name '-bad'"),
        );
        expect(mocks.scopedExecutor.run).not.toHaveBeenCalled();
        expect(refresh).not.toHaveBeenCalled();
    });

    it("rejects malformed explicit context instead of falling back to active A", async () => {
        await newBranchFileFromContext(
            new mocks.Uri("/repo-b/selected.txt", "git"),
            gitOps,
            executor,
            refresh,
        );
        expect(mocks.error).toHaveBeenCalledWith("New Branch is only available for local files.");
        expect(deriveFor).not.toHaveBeenCalled();
        expect(mocks.scopedExecutor.run).not.toHaveBeenCalled();
    });

    it("blocks before input when an operation is in progress", async () => {
        mocks.operation.mockResolvedValueOnce("merge");
        await newBranchFileFromContext(
            new mocks.Uri("/repo-b/selected.txt"),
            gitOps,
            executor,
            refresh,
        );
        expect(mocks.input).not.toHaveBeenCalled();
        expect(mocks.scopedExecutor.run).not.toHaveBeenCalled();
    });

    it("blocks when an operation starts during input", async () => {
        let release!: (value: string) => void;
        mocks.input.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
        const pending = newBranchFileFromContext(
            new mocks.Uri("/repo-b/selected.txt"),
            gitOps,
            executor,
            refresh,
        );
        await vi.waitFor(() => expect(mocks.input).toHaveBeenCalledOnce());
        mocks.operation.mockResolvedValue("merge");
        release("new-feature");
        await pending;
        expect(
            mocks.scopedExecutor.run,
            "operation after input must block mutation",
        ).not.toHaveBeenCalled();
        expect(refresh).not.toHaveBeenCalled();
    });

    it("fails closed when the post-input operation probe rejects", async () => {
        let release!: (value: string) => void;
        mocks.input.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
        const pending = newBranchFileFromContext(
            new mocks.Uri("/repo-b/selected.txt"),
            gitOps,
            executor,
            refresh,
        );
        await vi.waitFor(() => expect(mocks.input).toHaveBeenCalledOnce());
        expect(mocks.operation).toHaveBeenCalledOnce();
        mocks.operation.mockRejectedValueOnce(new Error("probe unavailable after input"));
        release("new-feature");
        await pending;
        expect(mocks.operation).toHaveBeenCalledTimes(2);
        expect(
            mocks.scopedExecutor.run,
            "failed post-input probe must block mutation",
        ).not.toHaveBeenCalled();
        expect(mocks.info).not.toHaveBeenCalled();
        expect(refresh).not.toHaveBeenCalled();
        expect(mocks.error).toHaveBeenCalledWith(expect.stringContaining("Unable to check"));
    });

    it("fails closed when the operation probe rejects", async () => {
        mocks.operation.mockRejectedValueOnce(new Error("probe unavailable"));
        await newBranchFileFromContext(
            new mocks.Uri("/repo-b/selected.txt"),
            gitOps,
            executor,
            refresh,
        );
        expect(mocks.input).not.toHaveBeenCalled();
        expect(mocks.scopedExecutor.run).not.toHaveBeenCalled();
        expect(mocks.error).toHaveBeenCalledWith(expect.stringContaining("Unable to check"));
    });

    it.each(["a branch named 'new-feature' already exists", "checkout refused"])(
        "reports create or checkout refusal: %s",
        async (reason) => {
            mocks.scopedExecutor.run.mockRejectedValueOnce(new Error(reason));
            await newBranchFileFromContext(
                new mocks.Uri("/repo-b/selected.txt"),
                gitOps,
                executor,
                refresh,
            );
            expect(mocks.error).toHaveBeenCalledWith(`Failed to create branch: ${reason}`);
            expect(mocks.info).not.toHaveBeenCalled();
            expect(refresh).not.toHaveBeenCalled();
        },
    );

    it("reports refresh failure separately after successful creation", async () => {
        refresh.mockRejectedValueOnce(new Error("refresh unavailable"));
        await newBranchFileFromContext(
            new mocks.Uri("/repo-b/selected.txt"),
            gitOps,
            executor,
            refresh,
        );
        expect(mocks.scopedExecutor.run).toHaveBeenCalledOnce();
        expect(mocks.info).toHaveBeenCalledWith("Created and checked out new-feature");
        expect(mocks.error).toHaveBeenCalledWith(
            "Checkout succeeded, but refresh failed: refresh unavailable",
        );
        expect(mocks.error).not.toHaveBeenCalledWith(
            expect.stringContaining("Failed to create branch"),
        );
    });
});
