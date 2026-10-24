import { ChangelistStore } from "../../../src/changes/changelistStore";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitOps } from "../../../src/git/operations";

const mocks = vi.hoisted(() => ({
    confirm: vi.fn(async (_message: string, _options: unknown, action: string) => action),
    error: vi.fn(),
    info: vi.fn(),
    abort: vi.fn(async () => undefined),
    target: vi.fn(),
}));
vi.mock("vscode", () => ({
    window: { showWarningMessage: mocks.confirm, showErrorMessage: mocks.error },
    l10n: {
        t: (message: string, args?: { message: string }) =>
            message.replace("{message}", args?.message ?? ""),
    },
}));
vi.mock("../../../src/utils/notifications", () => ({
    runWithNotificationProgress: vi.fn(async (_title: string, task: () => Promise<void>) => task()),
    showTimedInformationMessage: mocks.info,
}));

import { abortMergeWithConfirmation } from "../../../src/views/mergeAbort";

const changelists = new ChangelistStore();
beforeEach(() => {
    vi.clearAllMocks();
    mocks.target.mockResolvedValue({ status: "noPending" });
});

describe("captured conflict abort", () => {
    it("labels and aborts an active rebase through its captured Git facade", async () => {
        const refreshed = vi.fn(async () => undefined);
        await abortMergeWithConfirmation({
            gitOps: {
                abortMerge: mocks.abort,
                controlTargetHistory: mocks.target,
            } as unknown as GitOps,
            root: "/captured",
            changelists,
            operation: "rebase",
            onConflictStateChanged: refreshed,
        });
        expect(mocks.confirm).toHaveBeenCalledWith(
            "Abort the current rebase? Local conflict resolutions will be discarded.",
            { modal: true },
            "Abort Rebase",
        );
        expect(mocks.abort).toHaveBeenCalledOnce();
        expect(refreshed).toHaveBeenCalledOnce();
        expect(mocks.info).toHaveBeenCalledWith("Rebase aborted.");
    });
    it("keeps Merge as the default for existing callers", async () => {
        await abortMergeWithConfirmation({
            gitOps: {
                abortMerge: mocks.abort,
                controlTargetHistory: mocks.target,
            } as unknown as GitOps,
            root: "/captured",
            changelists,
            onConflictStateChanged: vi.fn(async () => undefined),
        });
        expect(mocks.confirm).toHaveBeenCalledWith(
            "Abort the current merge? Local conflict resolutions will be discarded.",
            { modal: true },
            "Abort Merge",
        );
        expect(mocks.info).toHaveBeenCalledWith("Merge aborted.");
    });
});

it.each(["handled", "cancelled"] as const)(
    "targeted %s abort never falls through to ordinary native abort",
    async (status) => {
        mocks.target.mockResolvedValueOnce(
            status === "handled"
                ? { status, result: { id: "target-id", outcome: "notApplied" } }
                : { status, id: "target-id" },
        );
        const native = vi.fn(async () => "merge" as const);
        await abortMergeWithConfirmation({
            gitOps: {
                abortMerge: mocks.abort,
                controlTargetHistory: mocks.target,
            } as unknown as GitOps,
            root: "/captured",
            changelists,
            operation: native,
            onConflictStateChanged: vi.fn(async () => undefined),
        });
        expect(
            mocks.abort,
            "targeted pending must bypass ordinary native abort/reset",
        ).not.toHaveBeenCalled();
        expect(
            native,
            "targeted pending must be checked before native classification",
        ).not.toHaveBeenCalled();
    },
);

it("targeted metadata read failure never authorizes ordinary native abort", async () => {
    mocks.target.mockRejectedValueOnce(new Error("Corrupt pending metadata"));
    await abortMergeWithConfirmation({
        gitOps: {
            abortMerge: mocks.abort,
            controlTargetHistory: mocks.target,
        } as unknown as GitOps,
        root: "/captured",
        changelists,
        onConflictStateChanged: vi.fn(async () => undefined),
    });
    expect(
        mocks.abort,
        "unknown pending state must fail closed before native fallback",
    ).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalled();
});

it("ordinary Abort rechecks targeted pending state after its confirmation prompt", async () => {
    mocks.confirm.mockImplementationOnce(
        async (_message: string, _options: unknown, action: string) => {
            mocks.target.mockResolvedValueOnce({ status: "cancelled", id: "new-pending" });
            return action;
        },
    );
    await abortMergeWithConfirmation({
        gitOps: {
            abortMerge: mocks.abort,
            controlTargetHistory: mocks.target,
        } as unknown as GitOps,
        root: "/captured",
        changelists,
        onConflictStateChanged: vi.fn(async () => undefined),
    });
    expect(
        mocks.target,
        "pending state must be revalidated after ordinary confirmation",
    ).toHaveBeenCalledTimes(2);
    expect(
        mocks.abort,
        "newly pending targeted state must prevent native abort after an ordinary prompt",
    ).not.toHaveBeenCalled();
});
