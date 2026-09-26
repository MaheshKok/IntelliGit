import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitOps } from "../../../src/git/operations";

const mocks = vi.hoisted(() => ({
    confirm: vi.fn(async (_message: string, _options: unknown, action: string) => action),
    error: vi.fn(),
    info: vi.fn(),
    abort: vi.fn(async () => undefined),
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

beforeEach(() => vi.clearAllMocks());

describe("captured conflict abort", () => {
    it("labels and aborts an active rebase through its captured Git facade", async () => {
        const refreshed = vi.fn(async () => undefined);
        await abortMergeWithConfirmation({
            gitOps: { abortMerge: mocks.abort } as unknown as GitOps,
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
            gitOps: { abortMerge: mocks.abort } as unknown as GitOps,
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
