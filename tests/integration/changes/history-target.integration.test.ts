import { GitOps } from "../../../src/git/operations";
import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import {
    chmod,
    lstat,
    mkdtemp,
    readFile,
    readlink,
    realpath,
    symlink,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ABSENT_GIT_CONFIG_GLOBAL } from "../../helpers/gitConfigIsolation";
import { POSIX_PERMISSIONS_ENFORCED } from "../../helpers/platformCapabilities";
import { ChangelistPersistence } from "../../../src/changes/changelistPersistence";
import { ChangelistStore } from "../../../src/changes/changelistStore";
import { GitExecutor } from "../../../src/git/executor";
import { RepositoryMutationGate } from "../../../src/git/repositoryMutationGate";
import { RepositoryMutationCoordinator } from "../../../src/git/mutationCoordinator";
import { RepositoryLock } from "../../../src/git/repositoryLock";
import {
    applyTargetHistoryOperation,
    preflightUndoCommit,
} from "../../../src/git/targetHistoryOperation";
import { removeScratchDirectories } from "../../helpers/scratchDirectories";
import { failNextLeaseRelease } from "../../helpers/leaseReleaseFailure";
import { captureTargetNativeEvidence } from "../../../src/git/targetOperationRecovery";
import {
    captureTargetHistoryReview,
    continueReviewedTargetHistoryOperation,
    abortReviewedTargetHistoryOperation,
} from "../../../src/git/targetHistoryRecovery";

const roots: string[] = [];
afterEach(async () => {
    vi.restoreAllMocks();
    await removeScratchDirectories(...roots.splice(0));
});

/** A real native conflict leaves both unrelated index and worktree layers outstanding. */
async function targetedConflictFixture(kind: "cherryPick" | "revert") {
    const f = await fixture(kind);
    await writeFile(path.join(f.root, "affected"), "competing committed change\n");
    await f.git.run(["commit", "--only", "-qm", "competing", "--", "affected"]);
    const request = { ...f.request, head: (await f.git.run(["rev-parse", "HEAD"])).trim() };
    expect(
        (await applyTargetHistoryOperation(f.git, f.persistence, f.store, request)).outcome,
    ).toBe("conflicted");
    return { ...f, request };
}

it.each(["cherryPick", "revert"] as const)(
    "reviewed targeted %s conflict completion never auto-commits",
    async (kind) => {
        const f = await targetedConflictFixture(kind);
        await writeFile(path.join(f.root, "affected"), "accepted resolution\n");
        await f.git.run(["add", "affected"]);
        const review = await captureTargetHistoryReview(f.git, f.persistence, f.store, "continue");
        expect(review?.id).toBe(f.request.id);
        const calls = vi.spyOn(GitExecutor.prototype, "runBinary");
        const result = await continueReviewedTargetHistoryOperation(
            f.git,
            f.persistence,
            f.store,
            review!,
        );
        expect(
            calls.mock.calls.filter(([args]) => args.includes("--continue")),
            "targeted completion cannot invoke native continue",
        ).toHaveLength(0);
        expect(
            result.outcome,
            `reviewed resolution must finish the recorded operation: ${result.reason ?? ""}`,
        ).toBe("applied");
        expect(
            (await f.git.run(["rev-parse", "HEAD"])).trim(),
            "targeted conflict completion must never create a commit",
        ).toBe(f.request.head);
        if (kind === "cherryPick")
            expect(
                calls.mock.calls.filter(([args]) => args.includes("--quit")),
                "markerless completion must skip native cleanup",
            ).toHaveLength(0);
        expect(await f.git.run(["show", ":unrelated"])).toBe("staged unrelated\n");
        expect(await readFile(path.join(f.root, "unrelated"), "utf8")).toBe("working unrelated\n");
        expect(f.store.get(f.root).targetOperationReceipts?.[f.request.id]?.outcome).toBe(
            "applied",
        );
    },
    30_000,
);

it.each(["cherryPick", "revert"] as const)(
    "reviewed targeted %s abort preserves both unrelated layers without native abort or global reset",
    async (kind) => {
        const f = await targetedConflictFixture(kind);
        const review = await captureTargetHistoryReview(f.git, f.persistence, f.store, "abort");
        const calls = vi.spyOn(GitExecutor.prototype, "runBinary");
        const result = await abortReviewedTargetHistoryOperation(
            f.git,
            f.persistence,
            f.store,
            review!,
        );
        expect(
            result.outcome,
            `reviewed discard must restore the recorded operation: ${result.reason ?? ""}`,
        ).toBe("notApplied");
        expect(
            await readFile(path.join(f.root, "affected"), "utf8"),
            "targeted abort must restore only the affected before bytes",
        ).toBe("competing committed change\n");
        expect(
            calls.mock.calls.filter(([args]) => args.includes("--abort") || args[0] === "reset"),
            "targeted abort cannot route through global native abort/reset",
        ).toHaveLength(0);
        expect(await f.git.run(["show", ":unrelated"])).toBe("staged unrelated\n");
        expect(await readFile(path.join(f.root, "unrelated"), "utf8")).toBe("working unrelated\n");
        expect(f.store.get(f.root).targetOperationReceipts?.[f.request.id]?.outcome).toBe(
            "aborted",
        );
    },
    30_000,
);

/** Accepted resolution is durable before quit; cleanup can only advance its native fingerprints. */
async function completionCleanupFixture() {
    const f = await fixture("revert");
    await writeFile(path.join(f.root, "affected"), "competing committed change\n");
    await f.git.run(["commit", "--only", "-qm", "competing", "--", "affected"]);
    const request = { ...f.request, head: (await f.git.run(["rev-parse", "HEAD"])).trim() };
    expect(
        (await applyTargetHistoryOperation(f.git, f.persistence, f.store, request)).outcome,
    ).toBe("conflicted");
    await writeFile(path.join(f.root, "affected"), "accepted resolution\n");
    await f.git.run(["add", "affected"]);
    const lease = await f.store.acquireTargetOperationLease(f.root);
    const state = f.store.get(f.root);
    const pending = state.pendingTargetOperation!;
    const previous = await f.persistence.loadTargetOperationEvidence(pending.evidenceHash);
    const accepted = {
        ...(await captureTargetNativeEvidence(f.git, f.persistence, request.id, ["affected"])),
        checkpoint: "after" as const,
        previousEvidenceHash: pending.evidenceHash,
        entries: previous.entries.map((entry) => ({ ...entry, outcome: "applied" as const })),
    };
    expect(accepted.native.some((entry) => entry.name === "revertHead" && entry.present)).toBe(
        true,
    );
    const acceptedHash = await f.persistence.storeTargetOperationEvidence(accepted);
    const selected = await f.store.checkpointTargetOperation(lease, {
        id: request.id,
        revision: state.revision,
        expectedPhase: "conflicted",
        phase: "gitApplied",
        evidenceHash: acceptedHash,
    });
    await f.git.run(["revert", "--quit"]);
    const cleaned = {
        ...(await captureTargetNativeEvidence(f.git, f.persistence, request.id, ["affected"])),
        checkpoint: "after" as const,
        previousEvidenceHash: acceptedHash,
        entries: accepted.entries,
    };
    return { ...f, lease, accepted, acceptedHash, selected, cleaned };
}

it("native completion cleanup advances only the durable evidence pointer after quit", async () => {
    const f = await completionCleanupFixture();
    try {
        const hash = await f.persistence.storeTargetOperationEvidence(f.cleaned);
        const state = await f.store.checkpointTargetNativeCompletionCleanup(f.lease, {
            id: f.request.id,
            revision: f.selected.revision,
            expectedPhase: "gitApplied",
            evidenceHash: hash,
        });
        expect(
            state.pendingTargetOperation?.evidenceHash,
            "cleanup must durably acknowledge the native-absent result",
        ).toBe(hash);
        expect(state.pendingTargetOperation?.beforeEvidenceHash).toBe(
            f.selected.pendingTargetOperation?.beforeEvidenceHash,
        );
        expect(state.pendingTargetOperation?.phase).toBe("gitApplied");
    } finally {
        await f.lease.release();
    }
}, 30_000);

it.each(["head", "index", "entries"] as const)(
    "native completion cleanup rejects changed %s evidence",
    async (field) => {
        const f = await completionCleanupFixture();
        try {
            const changed = {
                ...f.cleaned,
                ...(field === "head" ? { head: "a".repeat(40) } : {}),
                ...(field === "index" ? { indexFingerprint: "b".repeat(64) } : {}),
                ...(field === "entries"
                    ? {
                          entries: f.cleaned.entries.map((entry) => ({
                              ...entry,
                              outcome: "retained" as const,
                          })),
                      }
                    : {}),
            };
            const hash = await f.persistence.storeTargetOperationEvidence(changed);
            await expect(
                f.store.checkpointTargetNativeCompletionCleanup(f.lease, {
                    id: f.request.id,
                    revision: f.selected.revision,
                    expectedPhase: "gitApplied",
                    evidenceHash: hash,
                }),
                "native cleanup cannot authorize changed accepted content",
            ).rejects.toThrow();
            expect(f.store.get(f.root).pendingTargetOperation?.evidenceHash).toBe(f.acceptedHash);
        } finally {
            await f.lease.release();
        }
    },
    30_000,
);

/** Real Git separates the committed delta from unrelated staged and working layers. */
async function fixture(
    kind: "cherryPick" | "revert",
    change: (root: string, git: GitExecutor) => Promise<void> = async (root) =>
        writeFile(path.join(root, "affected"), "source change\n"),
    seed: (root: string, git: GitExecutor) => Promise<void> = async () => undefined,
) {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "history-target-")));
    roots.push(root);
    const git = new GitExecutor(
        root,
        new RepositoryMutationGate(new RepositoryMutationCoordinator(), new RepositoryLock()),
        { GIT_CONFIG_GLOBAL: ABSENT_GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: "1" },
    );
    await git.run(["init", "-q"]);
    await git.run(["config", "user.name", "Fixture"]);
    await git.run(["config", "user.email", "fixture@example.invalid"]);
    await writeFile(path.join(root, "affected"), "base\n");
    await writeFile(path.join(root, "unrelated"), "original\n");
    await seed(root, git);
    await git.run(["add", "."]);
    await git.run(["commit", "-qm", "base"]);
    const base = (await git.run(["rev-parse", "HEAD"])).trim();
    await change(root, git);
    await git.run(["add", "-A", "--", ".", ":!unrelated"]);
    await git.run(["commit", "-qm", "source"]);
    const commit = (await git.run(["rev-parse", "HEAD"])).trim();
    if (kind === "cherryPick") await git.run(["reset", "--hard", base]);
    await writeFile(path.join(root, "unrelated"), "staged unrelated\n");
    await git.run(["add", "unrelated"]);
    await writeFile(path.join(root, "unrelated"), "working unrelated\n");
    const store = new ChangelistStore();
    await store.connect(root, path.join(root, ".git"));
    await store.reconcileFiles(root, ["unrelated"]);
    await store.create(root, store.get(root).revision, "Existing", "", false, ["unrelated"]);
    const owner = store.get(root).files.unrelated;
    const persistence = await ChangelistPersistence.open(root, path.join(root, ".git"));
    const head = (await git.run(["rev-parse", "HEAD"])).trim();
    const request = {
        id: randomUUID(),
        kind,
        commit,
        head,
        target: { kind: "new" as const, name: "Destination", revision: store.get(root).revision },
    };
    return { root, git, store, persistence, request, owner };
}

it.each(["cherryPick", "revert"] as const)(
    "targeted %s leaves HEAD unchanged and preserves unrelated ownership and both layers",
    async (kind) => {
        const f = await fixture(kind);
        const outcome = await applyTargetHistoryOperation(f.git, f.persistence, f.store, f.request);
        expect(
            outcome.outcome,
            `actual adapter must publish its applied result: ${outcome.reason ?? "no reason"}`,
        ).toBe("applied");
        expect(
            (await f.git.run(["rev-parse", "HEAD"])).trim(),
            "targeted native action must never create a commit",
        ).toBe(f.request.head);
        expect(await f.git.run(["show", ":unrelated"]), "unrelated staged bytes survive").toBe(
            "staged unrelated\n",
        );
        expect(
            await readFile(path.join(f.root, "unrelated"), "utf8"),
            "unrelated working bytes survive",
        ).toBe("working unrelated\n");
        expect(await readFile(path.join(f.root, "affected"), "utf8")).toBe(
            kind === "cherryPick" ? "source change\n" : "base\n",
        );
        const state = f.store.get(f.root);
        const destination = state.lists.find((list) => list.name === "Destination")!;
        expect(state.files.unrelated, "existing unrelated owner survives").toBe(f.owner);
        // affected was clean before the operation, so the destination owns all of it.
        expect(state.files.affected, "introduced changes belong to the destination").toBe(
            destination.id,
        );
        expect(state.changes.affected.lines, "no line is owned apart from its file").toEqual({});
        expect(
            state.pendingTargetOperation,
            "terminal receipt closes the operation",
        ).toBeUndefined();
        expect(state.targetOperationReceipts?.[f.request.id]?.outcome).toBe("applied");
    },
    30_000,
);

it.each(["cherryPick", "revert"] as const)(
    "duplicate %s request after receipt never applies Git twice",
    async (kind) => {
        const f = await fixture(kind);
        const calls = vi.spyOn(GitExecutor.prototype, "runBinary");
        expect(
            (await applyTargetHistoryOperation(f.git, f.persistence, f.store, f.request)).outcome,
        ).toBe("applied");
        const second = new ChangelistStore();
        await second.connect(f.root, f.persistence.gitDir);
        expect(
            (await applyTargetHistoryOperation(f.git, f.persistence, second, f.request)).outcome,
        ).toBe("applied");
        expect(
            calls.mock.calls.filter(([args]) => args.includes("--no-commit")),
            "terminal replay must execute the native apply exactly once",
        ).toHaveLength(1);
    },
    30_000,
);

it.each(["cherryPick", "revert"] as const)(
    "targeted %s with an otherwise clean index never creates a commit",
    async (kind) => {
        const f = await fixture(kind);
        await f.git.run(["reset", "--", "unrelated"]);
        const result = await applyTargetHistoryOperation(f.git, f.persistence, f.store, f.request);
        expect(
            (await f.git.run(["rev-parse", "HEAD"])).trim(),
            "no-commit flag must preserve exact HEAD even when Git could commit",
        ).toBe(f.request.head);
        expect(result.outcome, result.reason).toBe("applied");
    },
    30_000,
);

it.each(["cherryPick", "revert"] as const)(
    "metadata failure after %s never replays the original native command",
    async (kind) => {
        const f = await fixture(kind);
        const calls = vi.spyOn(GitExecutor.prototype, "runBinary");
        vi.spyOn(f.store, "checkpointTargetOperation").mockRejectedValueOnce(
            new Error("Injected after-Git metadata failure"),
        );
        const first = await applyTargetHistoryOperation(f.git, f.persistence, f.store, f.request);
        expect(first.outcome, "after-Git failure must retain review identity").toBe(
            "appliedNeedsReview",
        );
        expect(f.store.get(f.root).pendingTargetOperation?.id).toBe(f.request.id);
        const second = new ChangelistStore();
        await second.connect(f.root, f.persistence.gitDir);
        const retry = await applyTargetHistoryOperation(f.git, f.persistence, second, f.request);
        expect(retry.outcome).toBe("appliedNeedsReview");
        expect(
            calls.mock.calls.filter(([args]) => args.includes("--no-commit")),
            "metadata failure must never replay native apply",
        ).toHaveLength(1);
        expect((await f.git.run(["rev-parse", "HEAD"])).trim()).toBe(f.request.head);
        expect(await f.git.run(["show", ":unrelated"])).toBe("staged unrelated\n");
        expect(await readFile(path.join(f.root, "unrelated"), "utf8")).toBe("working unrelated\n");
    },
    30_000,
);

it.each(["cherryPick", "revert"] as const)(
    "targeted %s conflict retains actual native stages and replay identity",
    async (kind) => {
        const f = await fixture(kind);
        await writeFile(path.join(f.root, "affected"), "competing committed change\n");
        await f.git.run(["commit", "--only", "-qm", "competing", "--", "affected"]);
        const request = { ...f.request, head: (await f.git.run(["rev-parse", "HEAD"])).trim() };
        const calls = vi.spyOn(GitExecutor.prototype, "runBinary");
        const result = await applyTargetHistoryOperation(f.git, f.persistence, f.store, request);
        expect(result.outcome, result.reason).toBe("conflicted");
        const pending = f.store.get(f.root).pendingTargetOperation!;
        expect(pending.phase).toBe("conflicted");
        const after = await f.persistence.loadTargetOperationEvidence(pending.evidenceHash);
        expect(
            after.index.filter((entry) => entry.path === "affected").map((entry) => entry.stage),
            "native conflict must retain stages 1, 2 and 3",
        ).toEqual([1, 2, 3]);
        expect(after.entries[0].outcome).toBe("conflicted");
        expect(
            (await applyTargetHistoryOperation(f.git, f.persistence, f.store, request)).outcome,
        ).toBe("appliedNeedsReview");
        expect(
            calls.mock.calls.filter(([args]) => args.includes("--no-commit")),
            "pending conflict must never apply again",
        ).toHaveLength(1);
        expect((await f.git.run(["rev-parse", "HEAD"])).trim()).toBe(request.head);
        expect(await f.git.run(["show", ":unrelated"])).toBe("staged unrelated\n");
        expect(await readFile(path.join(f.root, "unrelated"), "utf8")).toBe("working unrelated\n");
    },
    30_000,
);

it.each(["revert"] as const)(
    "reviewed targeted %s resumes after quit before cleanup publication without repeating Git",
    async (kind) => {
        const f = await targetedConflictFixture(kind);
        await writeFile(path.join(f.root, "affected"), "accepted resolution\n");
        await f.git.run(["add", "affected"]);
        const review = await captureTargetHistoryReview(f.git, f.persistence, f.store, "continue");
        const calls = vi.spyOn(GitExecutor.prototype, "runBinary");
        const checkpoint = vi
            .spyOn(f.store, "checkpointTargetNativeCompletionCleanup")
            .mockRejectedValueOnce(new Error("Injected quit-before-pointer crash"));
        const first = await continueReviewedTargetHistoryOperation(
            f.git,
            f.persistence,
            f.store,
            review!,
        );
        expect(first.outcome).toBe("appliedNeedsReview");
        expect(f.store.get(f.root).pendingTargetOperation?.phase).toBe("gitApplied");
        expect(
            calls.mock.calls.filter(([args]) => args.includes("--quit")),
            "the first attempt must reach native cleanup",
        ).toHaveLength(1);
        checkpoint.mockRestore();
        const second = new ChangelistStore();
        await second.connect(f.root, f.persistence.gitDir);
        const retryReview = await captureTargetHistoryReview(
            f.git,
            f.persistence,
            second,
            "continue",
        );
        const retry = await continueReviewedTargetHistoryOperation(
            f.git,
            f.persistence,
            second,
            retryReview!,
        );
        expect(
            retry.outcome,
            `cleanup crash replay must finish metadata only: ${retry.reason ?? ""}`,
        ).toBe("applied");
        expect(
            calls.mock.calls.filter(([args]) => args.includes("--quit")),
            "cleanup crash recovery must never repeat quit",
        ).toHaveLength(1);
        expect(
            calls.mock.calls.filter(
                ([args]) => args.includes("--no-commit") || args.includes("--continue"),
            ),
            "cleanup crash recovery must never repeat source apply or native continue",
        ).toHaveLength(0);
        expect((await f.git.run(["rev-parse", "HEAD"])).trim()).toBe(f.request.head);
        expect(await readFile(path.join(f.root, "affected"), "utf8")).toBe("accepted resolution\n");
        expect(await f.git.run(["show", ":unrelated"])).toBe("staged unrelated\n");
        expect(await readFile(path.join(f.root, "unrelated"), "utf8")).toBe("working unrelated\n");
    },
    30_000,
);

it.each(["continue", "abort"] as const)(
    "reviewed targeted %s rejects affected edits made after the prompt",
    async (action) => {
        const f = await targetedConflictFixture("revert");
        await writeFile(path.join(f.root, "affected"), "accepted resolution\n");
        await f.git.run(["add", "affected"]);
        const review = await captureTargetHistoryReview(f.git, f.persistence, f.store, action);
        await writeFile(path.join(f.root, "affected"), "external edit after prompt\n");
        const calls = vi.spyOn(GitExecutor.prototype, "runBinary");
        const operation =
            action === "continue"
                ? continueReviewedTargetHistoryOperation
                : abortReviewedTargetHistoryOperation;
        const result = await operation(f.git, f.persistence, f.store, review!);
        expect(result.outcome, "post-prompt affected edit must block destructive recovery").toBe(
            "appliedNeedsReview",
        );
        expect(result.reason).toContain("changed after the review");
        expect(
            await readFile(path.join(f.root, "affected"), "utf8"),
            "external affected bytes must survive stale consent",
        ).toBe("external edit after prompt\n");
        expect(
            calls.mock.calls.filter(
                ([args]) =>
                    args.includes("--quit") ||
                    args.includes("--abort") ||
                    args.includes("--continue") ||
                    args[0] === "reset",
            ),
        ).toHaveLength(0);
        expect(f.store.get(f.root).pendingTargetOperation?.id).toBe(f.request.id);
    },
    30_000,
);

it("reviewed targeted fresh discard accepts explicitly reviewed affected edits and restores before bytes", async () => {
    const f = await targetedConflictFixture("revert");
    await writeFile(path.join(f.root, "affected"), "explicitly discarded edit\n");
    await f.git.run(["add", "affected"]);
    const review = await captureTargetHistoryReview(f.git, f.persistence, f.store, "abort");
    const result = await abortReviewedTargetHistoryOperation(
        f.git,
        f.persistence,
        f.store,
        review!,
    );
    expect(result.outcome, result.reason).toBe("notApplied");
    expect(await readFile(path.join(f.root, "affected"), "utf8")).toBe(
        "competing committed change\n",
    );
    expect(await f.git.run(["show", ":unrelated"])).toBe("staged unrelated\n");
    expect(await readFile(path.join(f.root, "unrelated"), "utf8")).toBe("working unrelated\n");
}, 30_000);

it("targeted host control routes markerless pending before native classification and captures root across the prompt", async () => {
    const f = await targetedConflictFixture("cherryPick");
    const other = await fixture("revert");
    const ops = new GitOps(f.git);
    const nativeClassification = vi.spyOn(ops, "getActiveOperation");
    const confirm = vi.fn(async (review) => {
        expect(review.id).toBe(f.request.id);
        expect(review.paths).toEqual(["affected"]);
        f.git.setRoot(other.root);
        return true;
    });
    const result = await ops.controlTargetHistory(f.root, f.store, "abort", confirm);
    expect(result.status, "markerless pending must be handled before any ordinary fallback").toBe(
        "handled",
    );
    expect(result.status === "handled" && result.result.outcome).toBe("notApplied");
    expect(
        nativeClassification,
        "pending-first host routing must never classify native markers",
    ).not.toHaveBeenCalled();
    expect(confirm).toHaveBeenCalledOnce();
    expect(await readFile(path.join(f.root, "affected"), "utf8")).toBe(
        "competing committed change\n",
    );
    expect(
        await readFile(path.join(other.root, "affected"), "utf8"),
        "active-root switch must never retarget recovery",
    ).toBe("source change\n");
    expect(await other.git.run(["show", ":unrelated"])).toBe("staged unrelated\n");
}, 30_000);

it("targeted host control cancellation leaves pending, HEAD and both Git layers unchanged", async () => {
    const f = await targetedConflictFixture("revert");
    const before = await captureTargetNativeEvidence(f.git, f.persistence, f.request.id, [
        "affected",
    ]);
    const pending = f.store.get(f.root).pendingTargetOperation;
    const result = await new GitOps(f.git).controlTargetHistory(
        f.root,
        f.store,
        "abort",
        async () => false,
    );
    expect(result.status, "cancelled target review must never permit ordinary fallback").toBe(
        "cancelled",
    );
    expect(f.store.get(f.root).pendingTargetOperation).toEqual(pending);
    expect(
        await captureTargetNativeEvidence(f.git, f.persistence, f.request.id, ["affected"]),
    ).toEqual(before);
}, 30_000);

it("targeted host control permits ordinary fallback only after authoritative pending absence", async () => {
    const f = await fixture("revert");
    const confirm = vi.fn(async () => true);
    const result = await new GitOps(f.git).controlTargetHistory(f.root, f.store, "abort", confirm);
    expect(result.status).toBe("noPending");
    expect(confirm).not.toHaveBeenCalled();
}, 30_000);

/** One commit adds, deletes, renames, links and re-modes paths that start clean and unassigned. */
const structuralSeed = async (root: string) => {
    await writeFile(path.join(root, "gone"), "gone text\n");
    await writeFile(path.join(root, "old"), "renamed text\n");
    await writeFile(path.join(root, "tool"), "tool text\n");
};
const structuralChange = async (root: string, git: GitExecutor) => {
    await writeFile(path.join(root, "added"), "added text\n");
    await git.run(["rm", "-q", "gone"]);
    await git.run(["mv", "old", "renamed"]);
    await symlink("affected", path.join(root, "link"));
    await chmod(path.join(root, "tool"), 0o755);
    // Windows runs with core.filemode=false, where chmod reaches neither the file nor Git.
    await git.run(["update-index", "--chmod=+x", "tool"]);
};
const STRUCTURAL_PATHS = ["added", "gone", "link", "old", "renamed", "tool"];

/** Index modes keyed by path; a missing key is an absent index entry. */
async function indexModes(git: GitExecutor): Promise<Record<string, string>> {
    const out = await git.run(["ls-files", "-s", "--", ...STRUCTURAL_PATHS]);
    return Object.fromEntries(
        out
            .split("\n")
            .filter(Boolean)
            .map((line) => [line.split("\t")[1], line.split(" ")[0]]),
    );
}

it.each(["cherryPick", "revert"] as const)(
    "targeted %s supports add, delete, rename endpoints, symlink and mode changes",
    async (kind) => {
        const f = await fixture(kind, structuralChange, structuralSeed);
        const result = await applyTargetHistoryOperation(f.git, f.persistence, f.store, f.request);
        expect(result.outcome, `structural apply must publish: ${result.reason ?? ""}`).toBe(
            "applied",
        );
        expect((await f.git.run(["rev-parse", "HEAD"])).trim()).toBe(f.request.head);
        expect(
            await indexModes(f.git),
            "structural index entries must match the applied direction",
        ).toEqual(
            kind === "cherryPick"
                ? { added: "100644", link: "120000", renamed: "100644", tool: "100755" }
                : { gone: "100644", old: "100644", tool: "100644" },
        );
        if (kind === "cherryPick") {
            const link = path.join(f.root, "link");
            // With core.symlinks=false (Windows CI) Git checks a link out as a plain file holding its target.
            const symlinks = await f.git.run([
                "config",
                "--bool",
                "--default",
                "true",
                "core.symlinks",
            ]);
            if (symlinks.trim() === "true")
                expect(await readlink(link), "the link checks out pointing at its target").toBe(
                    "affected",
                );
            else {
                expect(
                    (await lstat(link)).isFile(),
                    "with core.symlinks=false the link checks out as a plain file",
                ).toBe(true);
                expect(
                    await readFile(link, "utf8"),
                    "the plain-file link holds exactly its target text",
                ).toBe("affected");
            }
            if (POSIX_PERMISSIONS_ENFORCED)
                expect((await lstat(path.join(f.root, "tool"))).mode & 0o111).not.toBe(0);
            expect(await readFile(path.join(f.root, "renamed"), "utf8")).toBe("renamed text\n");
        } else {
            expect(await readFile(path.join(f.root, "old"), "utf8")).toBe("renamed text\n");
            if (POSIX_PERMISSIONS_ENFORCED)
                expect((await lstat(path.join(f.root, "tool"))).mode & 0o111).toBe(0);
        }
        const state = f.store.get(f.root);
        const destination = state.lists.find((list) => list.name === "Destination")!;
        for (const file of STRUCTURAL_PATHS)
            expect(state.files[file], `${file} belongs to the explicit destination`).toBe(
                destination.id,
            );
        expect(state.files.unrelated, "existing unrelated owner survives").toBe(f.owner);
        expect(await f.git.run(["show", ":unrelated"])).toBe("staged unrelated\n");
        expect(await readFile(path.join(f.root, "unrelated"), "utf8")).toBe("working unrelated\n");
        expect(state.pendingTargetOperation).toBeUndefined();
    },
    30_000,
);

it("targeted revert of a mode change applies where core.fileMode=false leaves the file non-executable", async () => {
    const f = await fixture("revert", structuralChange, structuralSeed);
    // Windows Git sets core.fileMode=false and never marks a checked-out file executable.
    await f.git.run(["config", "core.fileMode", "false"]);
    await chmod(path.join(f.root, "tool"), 0o644);
    const result = await applyTargetHistoryOperation(f.git, f.persistence, f.store, f.request);
    expect(result.outcome, `structural apply must publish: ${result.reason ?? ""}`).toBe("applied");
    expect(await indexModes(f.git), "the revert restores the regular mode in the index").toEqual({
        gone: "100644",
        old: "100644",
        tool: "100644",
    });
    const state = f.store.get(f.root);
    const destination = state.lists.find((list) => list.name === "Destination")!;
    expect(state.files.tool, "tool belongs to the explicit destination").toBe(destination.id);
    expect(state.pendingTargetOperation).toBeUndefined();
}, 30_000);

it("reviewed continue publishes a re-moded revert after a crash where core.fileMode=false", async () => {
    const f = await fixture("revert", structuralChange, structuralSeed);
    // Windows Git sets core.fileMode=false and never marks a checked-out file executable.
    await f.git.run(["config", "core.fileMode", "false"]);
    await chmod(path.join(f.root, "tool"), 0o644);
    const publish = vi
        .spyOn(f.store, "publishTargetOwnership")
        .mockRejectedValueOnce(new Error("Injected crash before ownership publication"));
    const first = await applyTargetHistoryOperation(f.git, f.persistence, f.store, f.request);
    expect(first.outcome, "the crash leaves the applied revert for review").toBe(
        "appliedNeedsReview",
    );
    publish.mockRestore();
    const review = await captureTargetHistoryReview(f.git, f.persistence, f.store, "continue");
    const result = await continueReviewedTargetHistoryOperation(
        f.git,
        f.persistence,
        f.store,
        review!,
    );
    expect(result.outcome, `reviewed continue must publish: ${result.reason ?? ""}`).toBe(
        "applied",
    );
    const state = f.store.get(f.root);
    const destination = state.lists.find((list) => list.name === "Destination")!;
    expect(state.files.tool, "tool belongs to the explicit destination").toBe(destination.id);
}, 30_000);

/** Commits `affected` as 100755 on every platform; chmod alone reaches Git only where fileMode is true. */
const executableAffected = async (root: string, git: GitExecutor) => {
    await chmod(path.join(root, "affected"), 0o755);
    await git.run(["add", "affected"]);
    await git.run(["update-index", "--chmod=+x", "affected"]);
};

it("reviewed targeted revert conflict completes an executable script where core.fileMode=false", async () => {
    const f = await fixture("revert", undefined, executableAffected);
    // Windows Git sets core.fileMode=false and never marks a checked-out file executable.
    await f.git.run(["config", "core.fileMode", "false"]);
    await chmod(path.join(f.root, "affected"), 0o644);
    await writeFile(path.join(f.root, "affected"), "competing committed change\n");
    await f.git.run(["commit", "--only", "-qm", "competing", "--", "affected"]);
    const request = { ...f.request, head: (await f.git.run(["rev-parse", "HEAD"])).trim() };
    expect(
        (await applyTargetHistoryOperation(f.git, f.persistence, f.store, request)).outcome,
    ).toBe("conflicted");
    await writeFile(path.join(f.root, "affected"), "accepted resolution\n");
    await chmod(path.join(f.root, "affected"), 0o644);
    await f.git.run(["add", "affected"]);
    const review = await captureTargetHistoryReview(f.git, f.persistence, f.store, "continue");
    const result = await continueReviewedTargetHistoryOperation(
        f.git,
        f.persistence,
        f.store,
        review!,
    );
    expect(result.outcome, `reviewed resolution must finish: ${result.reason ?? ""}`).toBe(
        "applied",
    );
    expect(
        (await f.git.run(["ls-files", "-s", "--", "affected"])).split(" ")[0],
        "the script keeps its executable mode",
    ).toBe("100755");
}, 30_000);

it.skipIf(!POSIX_PERMISSIONS_ENFORCED)(
    "reviewed targeted revert conflict still refuses a local executable-bit change where core.fileMode is true",
    async () => {
        const f = await fixture("revert", undefined, executableAffected);
        await writeFile(path.join(f.root, "affected"), "competing committed change\n");
        await f.git.run(["commit", "--only", "-qm", "competing", "--", "affected"]);
        const request = { ...f.request, head: (await f.git.run(["rev-parse", "HEAD"])).trim() };
        expect(
            (await applyTargetHistoryOperation(f.git, f.persistence, f.store, request)).outcome,
        ).toBe("conflicted");
        await writeFile(path.join(f.root, "affected"), "accepted resolution\n");
        await f.git.run(["add", "affected"]);
        // The index keeps 100755; only the disk loses the bit, which Git reports as a mode change.
        await chmod(path.join(f.root, "affected"), 0o644);
        const review = await captureTargetHistoryReview(f.git, f.persistence, f.store, "continue");
        const result = await continueReviewedTargetHistoryOperation(
            f.git,
            f.persistence,
            f.store,
            review!,
        );
        expect(result.outcome, "a local mode change is not a text resolution").toBe(
            "appliedNeedsReview",
        );
        expect(result.reason).toBe("History resolution needs supported regular text evidence.");
    },
    30_000,
);

it("Undo Commit stays targeted for an executable file where core.fileMode=false", async () => {
    const f = await fixture("revert", undefined, executableAffected);
    const request = { ...f.request, kind: "undoCommit" as const };
    // Windows Git sets core.fileMode=false and never marks a checked-out file executable.
    await f.git.run(["config", "core.fileMode", "false"]);
    await chmod(path.join(f.root, "affected"), 0o644);
    const route = await preflightUndoCommit(f.git, f.persistence, f.store, request);
    expect(route, "an unchanged executable file is clean for the targeted undo").toEqual({
        route: "targeted",
    });
    const result = await applyTargetHistoryOperation(f.git, f.persistence, f.store, request);
    expect(result.outcome, `targeted undo must publish: ${result.reason ?? ""}`).toBe("applied");
    const state = f.store.get(f.root);
    expect(state.files.affected, "the undone file belongs to the explicit destination").toBe(
        state.lists.find((list) => list.name === "Destination")!.id,
    );
}, 30_000);

it.skipIf(!POSIX_PERMISSIONS_ENFORCED)(
    "targeted revert still refuses a local executable-bit change where core.fileMode is true",
    async () => {
        const f = await fixture("revert", structuralChange, structuralSeed);
        await chmod(path.join(f.root, "tool"), 0o644);
        const result = await applyTargetHistoryOperation(f.git, f.persistence, f.store, f.request);
        expect(result.outcome, "the local executable-bit change is refused before Git runs").toBe(
            "notApplied",
        );
        expect(result.reason, "refusal names the re-moded path").toContain(
            '"tool" has local changes',
        );
        expect((await indexModes(f.git)).tool, "the index keeps the executable mode").toBe(
            "100755",
        );
    },
    30_000,
);

it("targeted cherryPick refuses an owned structural path before any Git mutation", async () => {
    const f = await fixture("cherryPick", structuralChange, structuralSeed);
    await f.store.reconcileFiles(f.root, ["unrelated", "gone"]);
    await f.store.create(f.root, f.store.get(f.root).revision, "Owner", "", false, ["gone"]);
    const owner = f.store.get(f.root).files.gone;
    const request = {
        ...f.request,
        target: { ...f.request.target, revision: f.store.get(f.root).revision },
    };
    const calls = vi.spyOn(GitExecutor.prototype, "runBinary");
    const result = await applyTargetHistoryOperation(f.git, f.persistence, f.store, request);
    expect(result.outcome).toBe("notApplied");
    expect(result.reason, "refusal names the structural path").toContain("gone");
    expect(
        calls.mock.calls.filter(([args]) => args.includes("--no-commit")),
        "unsupported structural ownership must refuse before native apply",
    ).toHaveLength(0);
    const state = f.store.get(f.root);
    expect(state.lists.some((list) => list.name === "Destination")).toBe(false);
    expect(state.pendingTargetOperation).toBeUndefined();
    expect(state.files.gone, "pre-existing whole-file owner is never stolen").toBe(owner);
    expect((await f.git.run(["rev-parse", "HEAD"])).trim()).toBe(request.head);
    expect(await readFile(path.join(f.root, "gone"), "utf8")).toBe("gone text\n");
}, 30_000);

it("targeted cherryPick keeps a pre-existing staged edit's owner in the same file", async () => {
    const lines = ["one", "two", "three", "four", "five", "six", "seven", "eight", ""];
    const f = await fixture(
        "cherryPick",
        async (root) =>
            writeFile(path.join(root, "affected"), ["ONE", ...lines.slice(1)].join("\n")),
        async (root) => writeFile(path.join(root, "affected"), lines.join("\n")),
    );
    await writeFile(path.join(f.root, "affected"), [...lines.slice(0, 7), "EIGHT", ""].join("\n"));
    await f.git.run(["add", "affected"]);
    const prior = f.store.get(f.root).activeId;
    const result = await applyTargetHistoryOperation(f.git, f.persistence, f.store, f.request);
    expect(result.outcome, result.reason).toBe("applied");
    expect(await readFile(path.join(f.root, "affected"), "utf8")).toBe(
        ["ONE", ...lines.slice(1, 7), "EIGHT", ""].join("\n"),
    );
    const state = f.store.get(f.root);
    const destination = state.lists.find((list) => list.name === "Destination")!;
    expect(state.files.affected, "the pre-existing file owner is retained").toBe(prior);
    expect(state.changes.affected.totalChanges).toBe(4);
    expect(
        Object.values(state.changes.affected.lines).filter((id) => id === destination.id),
        "same-file pre-existing lines keep their owner while operation lines go to the target",
    ).toHaveLength(2);
    expect((await f.git.run(["rev-parse", "HEAD"])).trim()).toBe(f.request.head);
}, 30_000);

it("native refusal of an unstaged affected edit leaves no list, pending record or Git change", async () => {
    const f = await fixture("cherryPick");
    await writeFile(path.join(f.root, "affected"), "local edit\n");
    const result = await applyTargetHistoryOperation(f.git, f.persistence, f.store, f.request);
    expect(result.outcome, `native refusal must stay unapplied: ${result.reason ?? ""}`).toBe(
        "notApplied",
    );
    const state = f.store.get(f.root);
    expect(
        state.lists.some((list) => list.name === "Destination"),
        "a refused operation must not leave its new destination behind",
    ).toBe(false);
    expect(state.pendingTargetOperation).toBeUndefined();
    expect(await readFile(path.join(f.root, "affected"), "utf8")).toBe("local edit\n");
    expect((await f.git.run(["rev-parse", "HEAD"])).trim()).toBe(f.request.head);
}, 30_000);

it("reviewed targeted abort preserves unrelated index edits introduced after the prompt", async () => {
    const f = await targetedConflictFixture("revert");
    const review = await captureTargetHistoryReview(f.git, f.persistence, f.store, "abort");
    await writeFile(path.join(f.root, "unrelated"), "new staged unrelated\n");
    await f.git.run(["add", "unrelated"]);
    await writeFile(path.join(f.root, "unrelated"), "new working unrelated\n");
    const result = await abortReviewedTargetHistoryOperation(
        f.git,
        f.persistence,
        f.store,
        review!,
    );
    expect(
        result.outcome,
        `unrelated post-prompt edits must remain outside targeted discard: ${result.reason ?? ""}`,
    ).toBe("notApplied");
    expect(
        await f.git.run(["show", ":unrelated"]),
        "fresh unrelated index entries must survive targeted abort",
    ).toBe("new staged unrelated\n");
    expect(await readFile(path.join(f.root, "unrelated"), "utf8")).toBe("new working unrelated\n");
    expect(await readFile(path.join(f.root, "affected"), "utf8")).toBe(
        "competing committed change\n",
    );
}, 30_000);

/** Undo starts at the source commit, with an unrelated file carrying distinct staged and working edits. */
async function undoFixture() {
    const f = await fixture("revert");
    const parent = (await f.git.run(["rev-parse", "HEAD^"])).trim();
    return { ...f, parent, request: { ...f.request, kind: "undoCommit" as const } };
}

it("undo preserves working bytes and produces expected staged diff", async () => {
    const f = await undoFixture();
    const undone = await f.git.run(["diff", f.parent, f.request.head, "--", "affected"]);
    const result = await applyTargetHistoryOperation(f.git, f.persistence, f.store, f.request);
    expect(result.outcome, `undo must publish its soft reset: ${result.reason ?? ""}`).toBe(
        "applied",
    );
    expect(
        (await f.git.run(["rev-parse", "HEAD"])).trim(),
        "undo moves HEAD to the undone commit's parent",
    ).toBe(f.parent);
    expect(
        await f.git.run(["diff", "--cached", "--name-status"]),
        "the index keeps the undone commit plus the pre-existing staged unrelated edit",
    ).toBe("M\taffected\nM\tunrelated\n");
    expect(
        await f.git.run(["diff", "--cached", "--", "affected"]),
        "the staged diff is the undone commit relative to the new base",
    ).toBe(undone);
    expect(await f.git.run(["show", ":unrelated"])).toBe("staged unrelated\n");
    expect(await readFile(path.join(f.root, "affected"), "utf8")).toBe("source change\n");
    expect(await readFile(path.join(f.root, "unrelated"), "utf8")).toBe("working unrelated\n");
    const state = f.store.get(f.root);
    const destination = state.lists.find((list) => list.name === "Destination")!;
    expect(state.files.affected, "undone file belongs to the explicit destination").toBe(
        destination.id,
    );
    expect(state.files.unrelated, "existing unrelated owner survives").toBe(f.owner);
    expect(state.pendingTargetOperation).toBeUndefined();
    expect(destination.draft, "message copy is opt-in").toBe("");
}, 30_000);

it("undo retains pre-existing mixed ownership", async () => {
    const lines = ["one", "two", "three", "four", "five", "six", "seven", "eight", ""];
    const f = await fixture(
        "cherryPick",
        async (root) =>
            writeFile(path.join(root, "affected"), ["ONE", ...lines.slice(1)].join("\n")),
        async (root) => writeFile(path.join(root, "affected"), lines.join("\n")),
    );
    await writeFile(path.join(f.root, "affected"), [...lines.slice(0, 7), "EIGHT", ""].join("\n"));
    await f.git.run(["add", "affected"]);
    expect(
        (await applyTargetHistoryOperation(f.git, f.persistence, f.store, f.request)).outcome,
    ).toBe("applied");
    await writeFile(path.join(f.root, "doc"), "doc\n");
    await f.git.run(["add", "doc"]);
    await f.git.run(["commit", "--only", "-qm", "doc", "--", "doc"]);
    const head = (await f.git.run(["rev-parse", "HEAD"])).trim();
    const prior = structuredClone(f.store.get(f.root));
    const picked = prior.lists.find((list) => list.name === "Destination")!.id;
    expect(prior.files.affected, "precondition: the file owner differs from").not.toBe(picked);
    expect(
        new Set(Object.values(prior.changes.affected.lines)),
        "precondition: the picked lines' owner",
    ).toEqual(new Set([picked]));
    const result = await applyTargetHistoryOperation(f.git, f.persistence, f.store, {
        id: randomUUID(),
        kind: "undoCommit",
        commit: head,
        head,
        target: { kind: "new", name: "Undone", revision: prior.revision },
    });
    expect(result.outcome, result.reason).toBe("applied");
    expect((await f.git.run(["rev-parse", "HEAD"])).trim()).toBe(
        (await f.git.run(["rev-parse", `${head}^`])).trim(),
    );
    const state = f.store.get(f.root);
    expect(state.files.affected, "mixed file owner survives the base change").toBe(
        prior.files.affected,
    );
    expect(state.changes.affected, "mixed line owners survive the base change").toEqual(
        prior.changes.affected,
    );
    expect(state.files.doc).toBe(state.lists.find((list) => list.name === "Undone")!.id);
    expect(state.files.unrelated).toBe(f.owner);
}, 30_000);

/** Git argument lists of every `reset` or `update-ref` (the plain undo's HEAD move) the spy saw. */
const resets = (calls: { mock: { calls: unknown[][] } }) =>
    calls.mock.calls
        .map(([args]) => args as string[])
        .filter((args) => args[0] === "reset" || args[0] === "update-ref");

/** ORIG_HEAD's object ID, or "" while the repository has none. */
const origHead = async (git: GitExecutor) =>
    (
        await git.runBinary(["rev-parse", "--verify", "-q", "ORIG_HEAD"], {
            expectedExitCodes: [0, 1],
        })
    ).stdout
        .toString("utf8")
        .trim();

it("undo of a locally changed affected file falls back to the plain soft reset", async () => {
    const f = await undoFixture();
    await writeFile(path.join(f.root, "affected"), "local edit\n");
    const calls = vi.spyOn(GitExecutor.prototype, "runBinary");
    const refused = await applyTargetHistoryOperation(f.git, f.persistence, f.store, f.request);
    expect(refused.outcome, "the targeted adapter alone still refuses").toBe("notApplied");
    expect(refused.reason, "refusal names the changed path").toContain("affected");
    expect(resets(calls), "refused targeted undo must never reset").toHaveLength(0);
    const route = await preflightUndoCommit(f.git, f.persistence, f.store, f.request);
    expect(route, "a local edit routes Undo Commit to the previous release's reset").toEqual({
        route: "plainReset",
        path: "affected",
        reason: "localChanges",
    });
    expect(resets(calls), "the plain undo soft-resets exactly once").toEqual([
        ["update-ref", "-m", `reset: moving to ${f.parent}`, "--stdin"],
    ]);
    expect((await f.git.run(["rev-parse", "HEAD"])).trim()).toBe(f.parent);
    expect(await origHead(f.git), "the plain undo records ORIG_HEAD like reset --soft").toBe(
        f.request.head,
    );
    expect(await readFile(path.join(f.root, "affected"), "utf8"), "the local edit survives").toBe(
        "local edit\n",
    );
    expect(await f.git.run(["show", ":affected"]), "the undone commit stays staged").toBe(
        "source change\n",
    );
    const state = f.store.get(f.root);
    expect(state.lists.some((list) => list.name === "Destination")).toBe(false);
    expect(state.pendingTargetOperation).toBeUndefined();
    expect(state.files.unrelated).toBe(f.owner);
}, 30_000);

it("plain undo keeps staged and unstaged edits to an undone file", async () => {
    const f = await undoFixture();
    await writeFile(path.join(f.root, "affected"), "staged edit\n");
    await f.git.run(["add", "affected"]);
    await writeFile(path.join(f.root, "affected"), "working edit\n");
    const route = await preflightUndoCommit(f.git, f.persistence, f.store, f.request);
    expect(route.route, "a staged edit also routes to the plain reset").toBe("plainReset");
    expect((await f.git.run(["rev-parse", "HEAD"])).trim(), "the undo succeeded").toBe(f.parent);
    expect(await f.git.run(["show", ":affected"]), "the staged edit stays staged").toBe(
        "staged edit\n",
    );
    expect(await readFile(path.join(f.root, "affected"), "utf8"), "the working edit survives").toBe(
        "working edit\n",
    );
    expect(await f.git.run(["show", ":unrelated"])).toBe("staged unrelated\n");
    expect(await readFile(path.join(f.root, "unrelated"), "utf8")).toBe("working unrelated\n");
}, 30_000);

it("plain undo of a file that belongs to a list keeps its owner", async () => {
    const f = await undoFixture();
    await f.store.reconcileFiles(f.root, ["unrelated", "affected"]);
    await f.store.create(f.root, f.store.get(f.root).revision, "Owner", "", false, ["affected"]);
    const owner = f.store.get(f.root).files.affected;
    const route = await preflightUndoCommit(f.git, f.persistence, f.store, f.request);
    expect(route, "list membership routes Undo Commit to the previous release's reset").toEqual({
        route: "plainReset",
        path: "affected",
        reason: "owned",
    });
    expect((await f.git.run(["rev-parse", "HEAD"])).trim()).toBe(f.parent);
    const state = f.store.get(f.root);
    expect(state.files.affected, "the existing owner is kept").toBe(owner);
    expect(state.lists.some((list) => list.name === "Destination")).toBe(false);
}, 30_000);

it.each(["an empty commit", "a commit a later commit exactly reverses"] as const)(
    "undo of %s falls back to the plain soft reset",
    async (shape) => {
        const f = await undoFixture();
        if (shape === "an empty commit")
            await f.git.run(["commit", "--allow-empty", "--only", "-qm", "empty"]);
        else {
            await writeFile(path.join(f.root, "affected"), "base\n");
            await f.git.run(["commit", "--only", "-qm", "reverse", "--", "affected"]);
        }
        const head = (await f.git.run(["rev-parse", "HEAD"])).trim();
        const commit = shape === "an empty commit" ? head : f.request.commit;
        const parent = (await f.git.run(["rev-parse", `${commit}^`])).trim();
        expect(await f.git.run(["diff", "--name-only", parent, head]), "precondition").toBe("");
        const prior = structuredClone(f.store.get(f.root));
        const calls = vi.spyOn(GitExecutor.prototype, "runBinary");
        const request = { ...f.request, commit, head };
        const refused = await applyTargetHistoryOperation(f.git, f.persistence, f.store, request);
        expect(refused.outcome, "the targeted adapter alone still refuses").toBe("notApplied");
        expect(refused.reason).toBe("The selected commit contains no changes.");
        expect(resets(calls), "refused targeted undo must never reset").toHaveLength(0);
        const route = await preflightUndoCommit(f.git, f.persistence, f.store, request);
        expect(route, "no net change routes to the previous release's reset").toEqual({
            route: "plainReset",
            reason: "noChanges",
        });
        expect(resets(calls), "the plain undo soft-resets exactly once").toEqual([
            ["update-ref", "-m", `reset: moving to ${parent}`, "--stdin"],
        ]);
        expect((await f.git.run(["rev-parse", "HEAD"])).trim(), "the undo succeeded").toBe(parent);
        expect(f.store.get(f.root), "no destination list or pending operation").toEqual(prior);
    },
    30_000,
);

it("a clean undo keeps the targeted path and changes nothing before the prompt", async () => {
    const f = await undoFixture();
    const paths = ["affected", "unrelated"];
    const before = await captureTargetNativeEvidence(f.git, f.persistence, f.request.id, paths);
    const prior = structuredClone(f.store.get(f.root));
    const calls = vi.spyOn(GitExecutor.prototype, "runBinary");
    const route = await preflightUndoCommit(f.git, f.persistence, f.store, f.request);
    expect(route, "a clean undo keeps its destination choice").toEqual({ route: "targeted" });
    expect(resets(calls), "the preflight never resets a clean undo").toHaveLength(0);
    expect(await captureTargetNativeEvidence(f.git, f.persistence, f.request.id, paths)).toEqual(
        before,
    );
    expect(f.store.get(f.root)).toEqual(prior);
}, 30_000);

it("a pending target operation blocks the plain undo before any reset", async () => {
    // Markerless and conflict-free, so only the fence (not Git) can stop the reset.
    const f = await fixture("cherryPick");
    await writeFile(path.join(f.root, "doc"), "doc\n");
    await f.git.run(["add", "doc"]);
    await f.git.run(["commit", "--only", "-qm", "doc", "--", "doc"]);
    const head = (await f.git.run(["rev-parse", "HEAD"])).trim();
    vi.spyOn(f.store, "checkpointTargetOperation").mockRejectedValueOnce(
        new Error("Injected after-Git metadata failure"),
    );
    const request = { ...f.request, head };
    expect(
        (await applyTargetHistoryOperation(f.git, f.persistence, f.store, request)).outcome,
    ).toBe("appliedNeedsReview");
    const pending = f.store.get(f.root).pendingTargetOperation;
    expect(pending?.id, "precondition: a target operation is pending").toBe(request.id);
    await writeFile(path.join(f.root, "doc"), "local edit\n");
    const calls = vi.spyOn(GitExecutor.prototype, "runBinary");
    const route = await preflightUndoCommit(f.git, f.persistence, f.store, { commit: head, head });
    expect(route, "a pending target operation fences the plain undo").toEqual({ route: "busy" });
    expect(resets(calls), "a fenced undo must never reset").toHaveLength(0);
    expect((await f.git.run(["rev-parse", "HEAD"])).trim()).toBe(head);
    expect(f.store.get(f.root).pendingTargetOperation).toEqual(pending);
}, 30_000);

it("a failed lease release after the plain undo still reports the completed reset", async () => {
    const f = await undoFixture();
    await writeFile(path.join(f.root, "affected"), "local edit\n");
    const { failure, logged } = failNextLeaseRelease();
    await expect(
        preflightUndoCommit(f.git, f.persistence, f.store, f.request),
        "a release failure must not replace the completed plain reset",
    ).resolves.toEqual({ route: "plainReset", path: "affected", reason: "localChanges" });
    expect((await f.git.run(["rev-parse", "HEAD"])).trim(), "the soft reset moved HEAD").toBe(
        f.parent,
    );
    expect(logged, "the release failure is logged, not lost").toHaveBeenCalledWith(
        expect.any(String),
        failure,
    );
}, 30_000);

/**
 * Runs a real write from a second Git process, outside IntelliGit's mutation gate, at the latest
 * point one can interleave: after the undo's last read, just before its HEAD move runs. By default
 * it lands a commit; `landed.head` is what the write returned. `when` picks an earlier Git call.
 */
function writeOutsideBeforeHeadMove(
    root: string,
    write = async (outside: GitExecutor) => {
        await outside.run(["commit", "--allow-empty", "--only", "-qm", "outside"]);
        return (await outside.run(["rev-parse", "HEAD"])).trim();
    },
    when = (args: readonly string[]) => args[0] === "reset" || args[0] === "update-ref",
): { head?: string } {
    const outside = new GitExecutor(root, undefined, {
        GIT_CONFIG_GLOBAL: ABSENT_GIT_CONFIG_GLOBAL,
        GIT_CONFIG_NOSYSTEM: "1",
    });
    const original = GitExecutor.prototype.runBinary;
    const landed: { head?: string } = {};
    let armed = true;
    vi.spyOn(GitExecutor.prototype, "runBinary").mockImplementation(async function (
        this: GitExecutor,
        args,
        options,
    ) {
        if (armed && when(args)) {
            armed = false;
            landed.head = await write(outside);
        }
        return original.call(this, args, options);
    });
    return landed;
}

it("an outside commit before the plain undo's HEAD move stays on the branch", async () => {
    const f = await undoFixture();
    await writeFile(path.join(f.root, "affected"), "local edit\n");
    const origBefore = await origHead(f.git);
    const outside = writeOutsideBeforeHeadMove(f.root);
    const route = await preflightUndoCommit(f.git, f.persistence, f.store, f.request);
    expect(
        outside.head,
        "precondition: an outside commit landed before the HEAD move",
    ).toBeDefined();
    expect(
        (await f.git.run(["rev-parse", "HEAD"])).trim(),
        "the outside commit is still HEAD after the plain undo",
    ).toBe(outside.head);
    expect(
        (await f.git.run(["rev-parse", "HEAD^"])).trim(),
        "the commit to undo is still under the outside commit",
    ).toBe(f.request.head);
    expect(await origHead(f.git), "the refused move leaves ORIG_HEAD alone").toBe(origBefore);
    expect(route, "a moved HEAD hands Undo Commit to the targeted path's checks").toEqual({
        route: "targeted",
    });
    const applied = await applyTargetHistoryOperation(f.git, f.persistence, f.store, f.request);
    expect(applied.outcome, "the targeted path refuses the moved HEAD").toBe("stale");
    expect((await f.git.run(["rev-parse", "HEAD"])).trim()).toBe(outside.head);
    expect(
        f.store.get(f.root).pendingTargetOperation,
        "nothing is left for review",
    ).toBeUndefined();
}, 30_000);

it("an outside commit before the targeted undo's HEAD move stays on the branch", async () => {
    const f = await undoFixture();
    const origBefore = await origHead(f.git);
    const outside = writeOutsideBeforeHeadMove(f.root);
    const result = await applyTargetHistoryOperation(f.git, f.persistence, f.store, f.request);
    expect(
        outside.head,
        "precondition: an outside commit landed before the HEAD move",
    ).toBeDefined();
    expect(
        (await f.git.run(["rev-parse", "HEAD"])).trim(),
        "the outside commit is still HEAD after the targeted undo",
    ).toBe(outside.head);
    expect(await origHead(f.git), "the refused move leaves ORIG_HEAD alone").toBe(origBefore);
    expect(
        { outcome: result.outcome, pending: f.store.get(f.root).pendingTargetOperation?.phase },
        "a refused HEAD move applies nothing and leaves nothing to review",
    ).toEqual({ outcome: "stale", pending: undefined });
    expect(
        f.store.get(f.root).lists.map((list) => list.name),
        "the refused undo removes the destination list it created",
    ).not.toContain("Destination");
    expect(
        (await applyTargetHistoryOperation(f.git, f.persistence, f.store, f.request)).outcome,
        "the same request answers from its receipt",
    ).toBe("stale");
}, 30_000);

it("an outside commit after the targeted undo is prepared stays on the branch", async () => {
    const f = await undoFixture();
    const outside = new GitExecutor(f.root, undefined, {
        GIT_CONFIG_GLOBAL: ABSENT_GIT_CONFIG_GLOBAL,
        GIT_CONFIG_NOSYSTEM: "1",
    });
    const prepare = f.store.prepareTargetOperation.bind(f.store);
    let landed: string | undefined;
    vi.spyOn(f.store, "prepareTargetOperation").mockImplementationOnce(async (...args) => {
        const prepared = await prepare(...args);
        await outside.run(["commit", "--allow-empty", "--only", "-qm", "outside"]);
        landed = (await outside.run(["rev-parse", "HEAD"])).trim();
        return prepared;
    });
    const result = await applyTargetHistoryOperation(f.git, f.persistence, f.store, f.request);
    expect(landed, "precondition: an outside commit landed after preparation").toBeDefined();
    expect((await f.git.run(["rev-parse", "HEAD"])).trim()).toBe(landed);
    expect(
        { outcome: result.outcome, pending: f.store.get(f.root).pendingTargetOperation?.phase },
        `a HEAD moved before the undo's own move leaves nothing to review: ${result.reason ?? ""}`,
    ).toEqual({ outcome: "stale", pending: undefined });
}, 30_000);

/**
 * Leaves a pending merge before the move's own checks: MERGE_HEAD as a conflict-free
 * `git merge --no-commit` would, or unmerged stages with no MERGE_HEAD as a conflicted
 * cherry-pick would.
 */
function mergeBeforeHeadMove(
    f: Awaited<ReturnType<typeof undoFixture>>,
    leave: "MERGE_HEAD" | "unmerged stages" = "MERGE_HEAD",
): { head?: string } {
    return writeOutsideBeforeHeadMove(
        f.root,
        async (outside) => {
            if (leave === "MERGE_HEAD")
                await writeFile(
                    path.join(f.persistence.gitDir, "MERGE_HEAD"),
                    `${f.request.head}\n`,
                );
            else {
                const blob = (
                    await outside.run(["rev-parse", `${f.request.head}:affected`])
                ).trim();
                const stages = [1, 2, 3].map((stage) => `100644 ${blob} ${stage}\tconflicted\n`);
                await outside.runBinary(["update-index", "--index-info"], {
                    input: Buffer.from(stages.join("")),
                });
            }
            return "merging";
        },
        (args) => (args[0] === "ls-files" && args[1] === "-u") || args[0] === "reset",
    );
}

it.each(["MERGE_HEAD", "unmerged stages"] as const)(
    "a merge left as %s before the plain undo's HEAD move refuses the undo",
    async (leave) => {
        const f = await undoFixture();
        await writeFile(path.join(f.root, "affected"), "local edit\n");
        const merge = mergeBeforeHeadMove(f, leave);
        await expect(
            preflightUndoCommit(f.git, f.persistence, f.store, f.request),
            "a pending merge refuses the plain undo, as reset --soft does",
        ).rejects.toThrow("Cannot do a soft reset in the middle of a merge.");
        expect(merge.head, "precondition: the merge appeared before the move").toBe("merging");
        expect(
            (await f.git.run(["rev-parse", "HEAD"])).trim(),
            "the merge's first parent stays where the merge started",
        ).toBe(f.request.head);
    },
    30_000,
);

it("a merge started before the targeted undo's HEAD move keeps HEAD", async () => {
    const f = await undoFixture();
    const merge = mergeBeforeHeadMove(f);
    const result = await applyTargetHistoryOperation(f.git, f.persistence, f.store, f.request);
    expect(merge.head, "precondition: MERGE_HEAD appeared before the move").toBe("merging");
    expect(
        (await f.git.run(["rev-parse", "HEAD"])).trim(),
        "the targeted undo never moves HEAD under a pending merge",
    ).toBe(f.request.head);
    expect(result.outcome).not.toBe("applied");
}, 30_000);

it.each([
    ["HEAD did not move", async () => {}],
    [
        "HEAD moved and the undone path changed",
        async (root: string) => {
            const outside = new GitExecutor(root, undefined, {
                GIT_CONFIG_GLOBAL: ABSENT_GIT_CONFIG_GLOBAL,
                GIT_CONFIG_NOSYSTEM: "1",
            });
            await writeFile(path.join(root, "affected"), "outside staged\n");
            await outside.run(["add", "affected"]);
            await outside.run(["commit", "--allow-empty", "--only", "-qm", "outside"]);
        },
    ],
] as const)(
    "the store keeps a prepared undo for review when %s",
    async (_name, change) => {
        const f = await undoFixture();
        const prepare = f.store.prepareTargetOperation.bind(f.store);
        vi.spyOn(f.store, "prepareTargetOperation").mockImplementationOnce(async (...args) => {
            await prepare(...args);
            throw new Error("Injected stop after preparation");
        });
        await applyTargetHistoryOperation(f.git, f.persistence, f.store, f.request);
        await change(f.root);
        const lease = await f.store.acquireTargetOperationLease(f.root);
        try {
            const observed = await captureTargetNativeEvidence(f.git, f.persistence, f.request.id, [
                "affected",
            ]);
            const state = await f.store.closeStaleTargetOperation(lease, {
                id: f.request.id,
                revision: f.store.inspectTargetOperationLease(f.root, lease).revision,
                expectedPhase: "prepared",
                observedEvidenceHash: await f.persistence.storeTargetOperationEvidence(observed),
            });
            expect(
                state.pendingTargetOperation?.phase,
                "only a moved HEAD with nothing else changed closes as stale",
            ).toBe("reviewRequired");
        } finally {
            await lease.release();
        }
    },
    30_000,
);

it("a failed plain undo whose HEAD did not move surfaces its error and moves nothing", async () => {
    const f = await undoFixture();
    await writeFile(path.join(f.root, "affected"), "local edit\n");
    await writeFile(path.join(f.persistence.gitDir, "ORIG_HEAD.lock"), "");
    await expect(
        preflightUndoCommit(f.git, f.persistence, f.store, f.request),
        "a failure other than a moved HEAD surfaces instead of rerouting",
    ).rejects.toThrow("ORIG_HEAD");
    expect(
        (await f.git.run(["rev-parse", "HEAD"])).trim(),
        "HEAD moves only together with ORIG_HEAD",
    ).toBe(f.request.head);
}, 30_000);

it("a HEAD switched to an unborn branch before the plain undo's move surfaces the error", async () => {
    const f = await undoFixture();
    await writeFile(path.join(f.root, "affected"), "local edit\n");
    const branch = (await f.git.run(["symbolic-ref", "HEAD"])).trim();
    const outside = writeOutsideBeforeHeadMove(f.root, async (git) => {
        await git.run(["symbolic-ref", "HEAD", "refs/heads/unborn-outside"]);
        return "unborn";
    });
    await expect(
        preflightUndoCommit(f.git, f.persistence, f.store, f.request),
        "a HEAD that cannot be read after a refused move surfaces the error instead of rerouting",
    ).rejects.toThrow();
    expect(outside.head, "precondition: HEAD was switched before the move").toBe("unborn");
    expect(
        (await f.git.run(["rev-parse", branch])).trim(),
        "the commit to undo stays on its branch",
    ).toBe(f.request.head);
}, 30_000);

it("the plain undo still refuses while the index holds unresolved conflicts", async () => {
    const f = await undoFixture();
    await writeFile(path.join(f.root, "affected"), "local edit\n");
    // A conflicted stash pop leaves these stages without MERGE_HEAD, which the evidence reads.
    const blob = (await f.git.run(["rev-parse", ":unrelated"])).trim();
    const stages = [1, 2, 3].map((stage) => `100644 ${blob} ${stage}\tunrelated\n`).join("");
    await f.git.runBinary(["update-index", "--index-info"], {
        input: Buffer.from(`0 ${blob.replace(/./g, "0")}\tunrelated\n${stages}`),
    });
    expect(await f.git.run(["ls-files", "-u"]), "precondition: unrelated is unmerged").not.toBe("");
    await expect(
        preflightUndoCommit(f.git, f.persistence, f.store, f.request),
        "an unresolved conflict refuses the plain undo, as reset --soft does",
    ).rejects.toThrow("Cannot do a soft reset in the middle of a merge.");
    expect((await f.git.run(["rev-parse", "HEAD"])).trim(), "the refused undo leaves HEAD").toBe(
        f.request.head,
    );
}, 30_000);

it("a failed lease release never replaces the plain undo's own error", async () => {
    const f = await undoFixture();
    const { failure, logged } = failNextLeaseRelease();
    await expect(
        preflightUndoCommit(f.git, f.persistence, f.store, {
            commit: f.parent,
            head: f.request.head,
        }),
        "the undo's own refusal surfaces, not the release failure",
    ).rejects.toThrow("History action requires a commit parent.");
    expect(logged, "the release failure is logged, not lost").toHaveBeenCalledWith(
        expect.any(String),
        failure,
    );
}, 30_000);

it("metadata failure after soft reset never resets again", async () => {
    const f = await undoFixture();
    const calls = vi.spyOn(GitExecutor.prototype, "runBinary");
    vi.spyOn(f.store, "checkpointTargetOperation").mockRejectedValueOnce(
        new Error("Injected after-reset metadata failure"),
    );
    const first = await applyTargetHistoryOperation(f.git, f.persistence, f.store, f.request);
    expect(first.outcome, "after-reset failure must retain review identity").toBe(
        "appliedNeedsReview",
    );
    expect(f.store.get(f.root).pendingTargetOperation?.id).toBe(f.request.id);
    const second = new ChangelistStore();
    await second.connect(f.root, f.persistence.gitDir);
    const retry = await applyTargetHistoryOperation(f.git, f.persistence, second, f.request);
    expect(
        calls.mock.calls.filter(([args]) => args[0] === "update-ref"),
        "metadata failure must never repeat the soft reset",
    ).toHaveLength(1);
    expect((await f.git.run(["rev-parse", "HEAD"])).trim()).toBe(f.parent);
    expect(retry.outcome, "the retried undo stays in review").toBe("appliedNeedsReview");
    expect(await f.git.run(["show", ":unrelated"])).toBe("staged unrelated\n");
    expect(await readFile(path.join(f.root, "unrelated"), "utf8")).toBe("working unrelated\n");
}, 30_000);

it("undo copies the commit message into the destination only when chosen", async () => {
    const f = await undoFixture();
    const message = await f.git.run(["log", "-1", "--format=%B", f.request.head]);
    const result = await applyTargetHistoryOperation(f.git, f.persistence, f.store, {
        ...f.request,
        draftChoice: {
            kind: "copySource",
            sourceListId: randomUUID(),
            expectedDestinationDraft: "",
        },
        sourceDraft: message,
    });
    expect(result.outcome, result.reason).toBe("applied");
    const destination = f.store.get(f.root).lists.find((list) => list.name === "Destination")!;
    expect(destination.draft, "explicit copy choice publishes the undone message").toBe(message);
}, 30_000);

it("undo after a changelist commit admits the consumed record", async () => {
    const f = await undoFixture();
    await f.store.reconcileFiles(f.root, ["unrelated", "affected"]);
    await f.store.consumeCommitted(f.root, "affected", "committed", "all", new Set(), new Set(), 0);
    await f.store.reconcileFiles(f.root, ["unrelated"]);
    const prior = f.store.get(f.root);
    expect(
        prior.changes.affected?.selections,
        "precondition: the commit kept its record",
    ).toBeDefined();
    expect(prior.files.affected, "precondition: the record keeps its old list").toBe(
        prior.activeId,
    );
    const result = await applyTargetHistoryOperation(f.git, f.persistence, f.store, {
        ...f.request,
        target: { kind: "new", name: "Destination", revision: prior.revision },
    });
    expect(result.outcome, `undo right after a normal commit: ${result.reason ?? ""}`).toBe(
        "applied",
    );
    expect(
        (await f.git.run(["rev-parse", "HEAD"])).trim(),
        "undo moves HEAD to the undone commit's parent",
    ).toBe(f.parent);
    const state = f.store.get(f.root);
    const destination = state.lists.find((list) => list.name === "Destination")!;
    expect(state.files.affected, "the destination owns the whole undone file").toBe(destination.id);
    expect(state.changes.affected, "the consumed record is replaced, not kept").toBeUndefined();
    expect(state.files.unrelated).toBe(f.owner);
}, 30_000);

it("undo still refuses a path whose record owns a live change", async () => {
    const f = await undoFixture();
    await f.store.reconcileFiles(f.root, ["unrelated", "affected"]);
    await writeFile(path.join(f.root, "affected"), "local edit\n");
    await f.store.consumeCommitted(f.root, "affected", "live", "all", new Set(), new Set(), 1);
    const prior = f.store.get(f.root);
    const calls = vi.spyOn(GitExecutor.prototype, "runBinary");
    const result = await applyTargetHistoryOperation(f.git, f.persistence, f.store, {
        ...f.request,
        target: { kind: "new", name: "Destination", revision: prior.revision },
    });
    expect(result.outcome).toBe("notApplied");
    expect(result.reason, "a record owning a live change still owns the path").toContain(
        "already belongs to a changelist",
    );
    expect(calls.mock.calls.filter(([args]) => args[0] === "reset")).toHaveLength(0);
    expect(f.store.get(f.root).files.affected, "the live owner is never stolen").toBe(
        prior.files.affected,
    );
    expect((await f.git.run(["rev-parse", "HEAD"])).trim()).toBe(f.request.head);
}, 30_000);
