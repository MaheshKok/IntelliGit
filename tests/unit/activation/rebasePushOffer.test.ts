import { beforeEach, describe, expect, it, vi } from "vitest";

const vscodeMock = vi.hoisted(() => ({
    l10n: {
        t: (message: string, args?: Record<string, string>) =>
            args
                ? Object.entries(args).reduce(
                      (text, [key, value]) => text.replaceAll(`{${key}}`, value),
                      message,
                  )
                : message,
    },
    window: {
        showErrorMessage: vi.fn(),
        showInformationMessage: vi.fn(),
        showWarningMessage: vi.fn(),
    },
}));

vi.mock("vscode", () => vscodeMock);

import { showInteractiveRebaseSubmissionRunResult } from "../../../src/activation/repositoryViewEvents";
import type { RebaseSessionManifest } from "../../../src/git/interactiveRebase/types";

const manifest: RebaseSessionManifest = {
    version: 1,
    sessionId: "session-1",
    repoRoot: "/repo",
    branch: "refs/heads/main",
    baseHash: "a".repeat(40),
    expectedHead: "b".repeat(40),
    createdAt: "2026-08-02T00:00:00.000Z",
    lifecycle: "completed-pending-push",
    rebasedHeadOid: "c".repeat(40),
    pushTarget: {
        remoteName: "origin",
        remoteHeadRef: "refs/heads/main",
        upstreamOid: "d".repeat(40),
    },
};

beforeEach(() => {
    vi.clearAllMocks();
});

describe("post-rebase force-push offer", () => {
    it("offers Force Push and an explicit Dismiss, then dismisses the retained manifest", async () => {
        const dismiss = vi.fn(async () => undefined);
        vscodeMock.window.showWarningMessage.mockResolvedValue("Dismiss");

        await showInteractiveRebaseSubmissionRunResult(
            { status: "completed-pending-push", manifest },
            vi.fn(async () => undefined),
            { forcePush: vi.fn(), dismiss },
        );

        expect(vscodeMock.window.showWarningMessage).toHaveBeenCalledWith(
            "Interactive rebase completed. Force-push the rewritten commits?",
            "Force Push",
            "Dismiss",
        );
        expect(dismiss).toHaveBeenCalledWith(manifest);
    });

    it("confirms a clean push without warning about the offer", async () => {
        const forcePush = vi.fn(async () => ({ status: "pushed" as const, offerRetained: false }));
        vscodeMock.window.showWarningMessage.mockResolvedValueOnce("Force Push");

        await showInteractiveRebaseSubmissionRunResult(
            { status: "completed-pending-push", manifest },
            vi.fn(async () => undefined),
            { forcePush, dismiss: vi.fn() },
        );

        expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledWith(
            "Force push completed.",
        );
        expect(vscodeMock.window.showWarningMessage).toHaveBeenCalledTimes(1);
    });

    it("reports a landed push whose offer survived as completed, not failed", async () => {
        const forcePush = vi.fn(async () => ({ status: "pushed" as const, offerRetained: true }));
        vscodeMock.window.showWarningMessage.mockResolvedValueOnce("Force Push");

        await showInteractiveRebaseSubmissionRunResult(
            { status: "completed-pending-push", manifest },
            vi.fn(async () => undefined),
            { forcePush, dismiss: vi.fn() },
        );

        // Never an error toast: the remote ref moved, and calling that a failure would push the
        // user toward a second force push against a lease that no longer matches.
        expect(vscodeMock.window.showErrorMessage).not.toHaveBeenCalled();
        expect(vscodeMock.window.showInformationMessage).not.toHaveBeenCalled();
        expect(vscodeMock.window.showWarningMessage).toHaveBeenLastCalledWith(
            "Force push completed, but its pending offer could not be cleared and may reappear.",
        );
    });

    it("reports a moved branch without pushing", async () => {
        const forcePush = vi.fn(async () => ({ status: "branch-moved" as const }));
        vscodeMock.window.showWarningMessage.mockResolvedValueOnce("Force Push");

        await showInteractiveRebaseSubmissionRunResult(
            { status: "completed-pending-push", manifest },
            vi.fn(async () => undefined),
            { forcePush, dismiss: vi.fn() },
        );

        expect(vscodeMock.window.showWarningMessage).toHaveBeenLastCalledWith(
            "The branch moved since the rebase — push manually.",
        );
    });
});
