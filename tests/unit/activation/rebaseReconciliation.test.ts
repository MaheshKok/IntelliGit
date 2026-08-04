import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    discardRebaseSession: vi.fn(),
    gatherRebaseReconciliationEvidence: vi.fn(),
    l10nT: vi.fn(),
    reconcileRebaseSessions: vi.fn(),
    resolveGitDir: vi.fn(),
    showWarningMessage: vi.fn(),
    sweepOrphanedRebaseReservation: vi.fn(),
}));

// `t` is indirected through a mock rather than hardcoded to identity: an identity translator
// makes an English source string and its translation the same value, which is exactly the
// condition under which a locale-sensitive comparison bug is invisible.
vi.mock("vscode", () => ({
    l10n: { t: (message: string) => mocks.l10nT(message) },
    window: { showWarningMessage: mocks.showWarningMessage },
}));

vi.mock("../../../src/git/gitDirectory", () => ({ resolveGitDir: mocks.resolveGitDir }));
vi.mock("../../../src/git/interactiveRebase/reconcile", () => ({
    gatherRebaseReconciliationEvidence: mocks.gatherRebaseReconciliationEvidence,
    reconcileRebaseSessions: mocks.reconcileRebaseSessions,
}));
vi.mock("../../../src/git/interactiveRebase/storage", () => ({
    discardRebaseSession: mocks.discardRebaseSession,
    sweepOrphanedRebaseReservation: mocks.sweepOrphanedRebaseReservation,
}));

import { reconcileRebaseSessionsOnActivation } from "../../../src/activation/rebaseReconciliation";

const repositoryRoot = "/repo";
const storageRoot = "/storage";
const executor = { runBinary: vi.fn() };
const refresh = vi.fn(async () => undefined);
const discardAction = "Discard rebase session state";

function arrange(dispositions: unknown[]): void {
    mocks.resolveGitDir.mockReturnValue("/repo/.git");
    mocks.gatherRebaseReconciliationEvidence.mockResolvedValue({ snapshot: true });
    mocks.reconcileRebaseSessions.mockReturnValue({ rebaseControl: "none", dispositions });
    mocks.sweepOrphanedRebaseReservation.mockResolvedValue({ status: "none" });
}

async function reconcile(): Promise<void> {
    await reconcileRebaseSessionsOnActivation(repositoryRoot, { storageRoot, executor, refresh });
}

beforeEach(() => {
    vi.clearAllMocks();
    refresh.mockClear();
    mocks.l10nT.mockImplementation((message: string) => message);
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe("reconcileRebaseSessionsOnActivation", () => {
    it("discards provably dead manifests without showing a notice", async () => {
        arrange([{ status: "discard", sessionId: "dead" }]);

        await reconcile();

        expect(mocks.discardRebaseSession).toHaveBeenCalledWith(
            storageRoot,
            repositoryRoot,
            "dead",
        );
        expect(mocks.showWarningMessage).not.toHaveBeenCalled();
    });

    it("shows one notice and discards every ambiguous manifest only after the action is chosen", async () => {
        arrange([
            { status: "ambiguous", sessionId: "ambiguous-one", reason: "head-moved" },
            { status: "owned", sessionId: "live" },
            { status: "ambiguous", sessionId: "ambiguous-two", reason: "pending-push-retained" },
        ]);
        mocks.showWarningMessage.mockResolvedValue(discardAction);

        await reconcile();

        expect(mocks.showWarningMessage).toHaveBeenCalledTimes(1);
        expect(mocks.showWarningMessage).toHaveBeenCalledWith(
            "A rebase session did not finish cleanly — verify your branch, then push manually if intended",
            discardAction,
        );
        expect(mocks.discardRebaseSession).toHaveBeenCalledTimes(2);
        expect(mocks.discardRebaseSession).toHaveBeenCalledWith(
            storageRoot,
            repositoryRoot,
            "ambiguous-one",
        );
        expect(mocks.discardRebaseSession).toHaveBeenCalledWith(
            storageRoot,
            repositoryRoot,
            "ambiguous-two",
        );
        expect(refresh).toHaveBeenCalledOnce();
    });

    it("acts on the action the dialog returns rather than on its English source", async () => {
        arrange([{ status: "ambiguous", sessionId: "ambiguous", reason: "head-moved" }]);
        // The dialog echoes back the exact label it was handed — the translated one. A comparison
        // against the untranslated source silently discards nothing in every non-English locale,
        // and the notice then returns on every reload with no user action able to clear it.
        mocks.l10nT.mockImplementation((message: string) => `xx:${message}`);
        mocks.showWarningMessage.mockResolvedValue("xx:Discard rebase session state");

        await reconcile();

        expect(mocks.discardRebaseSession).toHaveBeenCalledWith(
            storageRoot,
            repositoryRoot,
            "ambiguous",
        );
        expect(refresh).toHaveBeenCalledOnce();
    });

    it("finishes discarding before refreshing so the repaint cannot render what it removed", async () => {
        arrange([{ status: "ambiguous", sessionId: "ambiguous", reason: "head-moved" }]);
        mocks.showWarningMessage.mockResolvedValue(discardAction);
        let discardSettled = false;
        let discardSettledAtRefresh: boolean | undefined;
        mocks.discardRebaseSession.mockImplementationOnce(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
            discardSettled = true;
        });
        // Captured rather than asserted in place: an expectation that throws here would be
        // swallowed by the activation surface's own catch and the test would pass regardless.
        refresh.mockImplementationOnce(async () => {
            discardSettledAtRefresh = discardSettled;
        });

        await reconcile();

        // The refresh reads durable state. Overlapping it with its own deletions renders the
        // session being removed, and leaving them unawaited also rejects outside the catch.
        expect(discardSettledAtRefresh).toBe(true);
    });

    it("keeps ambiguous state when the notice is dismissed", async () => {
        arrange([{ status: "ambiguous", sessionId: "ambiguous", reason: "head-moved" }]);
        mocks.showWarningMessage.mockResolvedValue(undefined);

        await reconcile();

        expect(mocks.discardRebaseSession).not.toHaveBeenCalled();
        expect(refresh).not.toHaveBeenCalled();
    });

    it("leaves an owned session untouched", async () => {
        arrange([{ status: "owned", sessionId: "live" }]);

        await reconcile();

        expect(mocks.discardRebaseSession).not.toHaveBeenCalled();
        expect(mocks.showWarningMessage).not.toHaveBeenCalled();
    });

    it("retains completed-pending-push state behind the rebase-state notice without a push offer", async () => {
        arrange([
            {
                status: "ambiguous",
                sessionId: "pending-push",
                reason: "pending-push-retained",
            },
        ]);
        mocks.showWarningMessage.mockResolvedValue(undefined);

        await reconcile();

        expect(mocks.showWarningMessage).toHaveBeenCalledWith(
            "A rebase session did not finish cleanly — verify your branch, then push manually if intended",
            discardAction,
        );
        expect(mocks.showWarningMessage).not.toHaveBeenCalledWith(
            expect.anything(),
            "Force Push",
            expect.anything(),
        );
        expect(mocks.discardRebaseSession).not.toHaveBeenCalled();
    });

    it("logs a failed evidence collection and completes activation without treating it as empty state", async () => {
        arrange([]);
        const failure = new Error("EACCES manifests");
        mocks.gatherRebaseReconciliationEvidence.mockRejectedValue(failure);
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

        await expect(reconcile()).resolves.toBeUndefined();

        expect(error).toHaveBeenCalledWith(
            "[IntelliGit] Could not check rebase session state for /repo:",
            failure,
        );
        expect(mocks.reconcileRebaseSessions).not.toHaveBeenCalled();
        expect(mocks.showWarningMessage).not.toHaveBeenCalled();
    });

    it("discards before sweeping so the same activation reclaims that reservation pointer", async () => {
        let discarded = false;
        let sweepStatus: "reclaimed" | "retained" | undefined;
        arrange([{ status: "discard", sessionId: "orphaned" }]);
        mocks.discardRebaseSession.mockImplementation(async () => {
            discarded = true;
        });
        mocks.sweepOrphanedRebaseReservation.mockImplementation(async () => {
            sweepStatus = discarded ? "reclaimed" : "retained";
            return sweepStatus === "reclaimed"
                ? { status: "reclaimed" }
                : { status: "retained", reason: "live-manifest" };
        });

        await reconcile();

        expect(discarded).toBe(true);
        expect(sweepStatus).toBe("reclaimed");
        expect(mocks.sweepOrphanedRebaseReservation).toHaveBeenCalledWith({
            storageRoot,
            repoRoot: repositoryRoot,
            gitDir: "/repo/.git",
        });
        expect(mocks.discardRebaseSession.mock.invocationCallOrder[0]).toBeLessThan(
            mocks.sweepOrphanedRebaseReservation.mock.invocationCallOrder[0],
        );
    });
});
