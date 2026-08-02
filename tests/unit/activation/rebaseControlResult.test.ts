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

import {
    showInteractiveRebaseControlResult,
    showInteractiveRebaseSubmissionRunResult,
} from "../../../src/activation/repositoryViewEvents";
import type { InteractiveRebaseControlResult } from "../../../src/git/interactiveRebase/control";
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

async function report(result: InteractiveRebaseControlResult) {
    const refresh = vi.fn(async () => undefined);
    await showInteractiveRebaseControlResult(result, refresh, {
        forcePush: vi.fn(async () => ({ status: "pushed" as const, offerRetained: false })),
        dismiss: vi.fn(async () => undefined),
    });
    expect(refresh).toHaveBeenCalledTimes(1);
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe("interactive rebase control result messages", () => {
    it("reports no-rebase-in-progress", async () => {
        await report({ status: "no-rebase-in-progress" });
        expect(vscodeMock.window.showWarningMessage).toHaveBeenCalledWith(
            "No interactive rebase is in progress.",
        );
    });

    it("reports foreign-continue-refused", async () => {
        await report({ status: "foreign-continue-refused" });
        expect(vscodeMock.window.showWarningMessage).toHaveBeenCalledWith(
            "Another tool owns this rebase. IntelliGit cannot continue it.",
        );
    });

    it("reports unowned continued", async () => {
        await report({ status: "continued", rebaseControl: "unowned" });
        expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledWith(
            "Interactive rebase continued.",
        );
    });

    it("reports aborted", async () => {
        await report({ status: "aborted", rebaseControl: "foreign" });
        expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledWith(
            "Interactive rebase aborted.",
        );
    });

    it("reports completed", async () => {
        await report({ status: "completed", rebasedHeadOid: "c".repeat(40) });
        expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledWith(
            "Interactive rebase completed.",
        );
    });

    it("refreshes the completed rebase state before notifying the user", async () => {
        const events: string[] = [];
        const refresh = vi.fn(async () => {
            events.push("refresh");
        });
        vscodeMock.window.showInformationMessage.mockImplementationOnce(async () => {
            events.push("notification");
        });

        await showInteractiveRebaseControlResult(
            { status: "completed", rebasedHeadOid: "c".repeat(40) },
            refresh,
            { forcePush: vi.fn(), dismiss: vi.fn() },
        );

        expect(events).toEqual(["refresh", "notification"]);
    });

    it("refreshes a submitted completed rebase before notifying the user", async () => {
        const events: string[] = [];
        const refresh = vi.fn(async () => {
            events.push("refresh");
        });
        vscodeMock.window.showInformationMessage.mockImplementationOnce(async () => {
            events.push("notification");
        });

        await showInteractiveRebaseSubmissionRunResult(
            { status: "completed", rebasedHeadOid: "c".repeat(40) },
            refresh,
            { forcePush: vi.fn(), dismiss: vi.fn() },
        );

        expect(events).toEqual(["refresh", "notification"]);
    });

    it("routes completed-pending-push through the existing force-push offer", async () => {
        await report({ status: "completed-pending-push", manifest });
        expect(vscodeMock.window.showWarningMessage).toHaveBeenCalledWith(
            "Interactive rebase completed. Force-push the rewritten commits?",
            "Force Push",
            "Dismiss",
        );
    });

    it("lets the delegated offer refresh again once the force push lands", async () => {
        vscodeMock.window.showWarningMessage.mockResolvedValueOnce("Force Push");
        const refresh = vi.fn(async () => undefined);
        const forcePush = vi.fn(async () => ({
            status: "pushed" as const,
            offerRetained: false,
        }));

        await showInteractiveRebaseControlResult(
            { status: "completed-pending-push", manifest },
            refresh,
            { forcePush, dismiss: vi.fn(async () => undefined) },
        );

        expect(forcePush).toHaveBeenCalledTimes(1);
        // The finished rebase and the landed push are two states the user can tell apart, so
        // the panel repaints for each. A once-per-outcome guard around the delegated offer
        // swallows the second one and leaves the pre-push branch state on screen.
        expect(refresh).toHaveBeenCalledTimes(2);
    });

    it("reports paused-conflict without reading ownership", async () => {
        await report({ status: "paused-conflict" });
        expect(vscodeMock.window.showWarningMessage).toHaveBeenCalledWith(
            "Rebase paused on conflict — resolve, then Continue.",
        );
    });

    it("reports paused-helper-stop", async () => {
        await report({ status: "paused-helper-stop", stderr: "message helper stopped" });
        expect(vscodeMock.window.showErrorMessage).toHaveBeenCalledWith(
            "Rebase editor stopped: message helper stopped",
        );
    });

    it("distinguishes a Git control failure", async () => {
        await report({
            status: "failed",
            rebaseControl: "owned",
            reason: "git-failed",
            message: "git exit 1",
        });
        expect(vscodeMock.window.showErrorMessage).toHaveBeenCalledWith(
            "Git could not complete the rebase: git exit 1",
        );
    });

    it("distinguishes an ownership-change control failure", async () => {
        await report({
            status: "failed",
            rebaseControl: "owned",
            reason: "ownership-changed",
            message: "marker changed",
        });
        expect(vscodeMock.window.showErrorMessage).toHaveBeenCalledWith(
            "Rebase ownership changed while the action was running: marker changed",
        );
    });
});
