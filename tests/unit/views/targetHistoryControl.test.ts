import { ChangelistStore } from "../../../src/changes/changelistStore";
import { beforeEach, expect, it, vi } from "vitest";
import type { GitOps } from "../../../src/git/operations";
import { RepositoryLockBusyError } from "../../../src/git/repositoryLock";

const mocks = vi.hoisted(() => ({
    error: vi.fn(),
    target: vi.fn(),
}));
vi.mock("vscode", () => ({
    window: { showWarningMessage: vi.fn(), showErrorMessage: mocks.error },
    l10n: {
        t: (message: string, args?: { message: string }) =>
            message.replace("{message}", args?.message ?? ""),
    },
}));
vi.mock("../../../src/utils/notifications", () => ({
    showTimedInformationMessage: vi.fn(),
}));

import { controlTargetHistoryWithConfirmation } from "../../../src/views/targetHistoryControl";

beforeEach(() => vi.clearAllMocks());

async function controlAfter(error: Error) {
    mocks.target.mockRejectedValueOnce(error);
    const refreshed = vi.fn(async () => undefined);
    const consumed = await controlTargetHistoryWithConfirmation({
        gitOps: { controlTargetHistory: mocks.target } as unknown as GitOps,
        root: "/captured",
        changelists: new ChangelistStore(),
        action: "continue",
        onConflictStateChanged: refreshed,
    });
    expect(consumed, "unknown pending state must never allow the native fallback").toBe(true);
    expect(refreshed).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalledOnce();
    return mocks.error.mock.calls[0][0] as string;
}

it("tells the user to retry when another operation holds the target lease", async () => {
    const message = await controlAfter(new RepositoryLockBusyError());
    expect(message, "a busy lease is transient and must say to retry").toContain(
        "Try again in a moment",
    );
    expect(message, "a busy lease must not send the user to a terminal").not.toContain("terminal");
});

it("names the terminal way out when pending metadata cannot be read", async () => {
    const message = await controlAfter(
        new Error("Conflicting changelist migration metadata requires review."),
    );
    expect(message, "a lasting failure must name a way forward").toContain("terminal");
    expect(message, "the way out must warn that it skips targeted recovery").toContain(
        "skips IntelliGit's targeted recovery",
    );
    expect(message, "the cause must still be shown").toContain(
        "Conflicting changelist migration metadata requires review.",
    );
});
