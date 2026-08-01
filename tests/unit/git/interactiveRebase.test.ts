import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
    buildRebaseTodo,
    createRebaseSessionDirectory,
    deleteRebaseSessionDirectory,
    getRebaseStoragePaths,
    readRebaseManifest,
    releaseRebaseReservation,
    sweepOrphanedRebaseReservation,
    tryAcquireRebaseReservation,
    validateRebaseSubmission,
    writeRebaseManifest,
    type RebaseAction,
    type RebaseSessionManifest,
    type RebaseSubmissionEntry,
    type RebaseTodoEntry,
} from "../../../src/git/interactiveRebase";

const HASH_A = "a".repeat(40);
const HASH_B = "b".repeat(40);
const HASH_C = "c".repeat(40);
const HASH_D = "d".repeat(40);
const HASH_E = "e".repeat(40);
const HASH_64 = "f".repeat(64);
const directories: string[] = [];

afterEach(async () => {
    await Promise.all(
        directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
    );
});

/** Creates an isolated storage root, repository root, and Git directory. */
async function rebasePaths(): Promise<{ storageRoot: string; repoRoot: string; gitDir: string }> {
    const storageRoot = await mkdtemp(path.join(tmpdir(), "intelligit-rebase-storage-"));
    const repoRoot = await mkdtemp(path.join(tmpdir(), "intelligit-rebase-repo-"));
    const gitDir = path.join(repoRoot, ".git");
    directories.push(storageRoot, repoRoot);
    await mkdir(gitDir);
    return { storageRoot, repoRoot, gitDir };
}

/** Builds a manifest with the required, valid stable fields. */
function manifest(
    repoRoot: string,
    sessionId: string,
    pushTarget?: RebaseSessionManifest["pushTarget"],
): RebaseSessionManifest {
    return {
        version: 1,
        sessionId,
        repoRoot,
        branch: "refs/heads/main",
        ...(pushTarget ? { pushTarget } : {}),
        baseHash: HASH_A,
        expectedHead: HASH_B,
        createdAt: "2026-08-01T10:00:00.000Z",
        lifecycle: "starting",
    };
}

describe("interactive rebase domain", () => {
    it("builds deterministic todo content in dialog order including dropped commits", () => {
        expect(
            buildRebaseTodo([
                { hash: HASH_A, action: "pick", message: "oldest" },
                { hash: HASH_B, action: "drop", message: "removed" },
                { hash: HASH_C, action: "squash", message: "combined" },
            ]),
        ).toBe(`pick ${HASH_A} oldest\ndrop ${HASH_B} removed\nsquash ${HASH_C} combined\n`);
    });

    it("accepts exactly the allowed actions with full offered hashes", () => {
        const entries = [
            { hash: HASH_A, action: "pick" },
            { hash: HASH_B, action: "reword", message: "rewrite" },
            { hash: HASH_C, action: "squash", message: "combine" },
            { hash: HASH_D, action: "fixup" },
            { hash: HASH_64, action: "drop" },
        ] as const satisfies readonly RebaseSubmissionEntry[];

        expect(
            validateRebaseSubmission(entries, new Set(entries.map((entry) => entry.hash))),
        ).toMatchObject({ status: "valid" });
    });

    it.each(["\n", "\r", "\0"])(
        "rejects a pick label containing a control character",
        (controlCharacter) => {
            expect(
                validateRebaseSubmission(
                    [
                        {
                            hash: HASH_A,
                            action: "pick",
                            message: `subject${controlCharacter}injected`,
                        },
                    ],
                    new Set([HASH_A]),
                ),
            ).toEqual({ status: "invalid", reason: "invalid-message" });
        },
    );

    it.each(["reword", "squash"] as const satisfies readonly RebaseAction[])(
        "rejects a %s message containing every todo control character",
        (action) => {
            for (const controlCharacter of ["\n", "\r", "\0"]) {
                expect(
                    validateRebaseSubmission(
                        [
                            {
                                hash: HASH_A,
                                action,
                                message: `replacement${controlCharacter}injected`,
                            },
                        ],
                        new Set([HASH_A]),
                    ),
                ).toEqual({ status: "invalid", reason: "invalid-message" });
            }
        },
    );

    it("limits validation-free todo entries to one physical line each", () => {
        const entries: readonly RebaseTodoEntry[] = [
            { hash: HASH_A, action: "pick", message: "subject\ninjected" },
            { hash: HASH_B, action: "reword", message: "replacement\rreturn" },
            { hash: HASH_C, action: "squash", message: "combined\0suffix" },
        ];

        const lines = buildRebaseTodo(entries).split("\n");
        expect(lines).toHaveLength(entries.length + 1);
        expect(lines.at(-1)).toBe("");
    });

    it("normalizes uppercase object IDs in validated entries", () => {
        const uppercaseHash = HASH_A.toUpperCase();

        expect(
            validateRebaseSubmission([{ hash: uppercaseHash, action: "pick" }], new Set([HASH_A])),
        ).toEqual({
            status: "valid",
            entries: [{ hash: HASH_A, action: "pick" }],
        });
    });

    it.each([
        [
            "an unsupported action",
            [{ hash: HASH_A, action: "edit" }],
            new Set([HASH_A]),
            "invalid-action",
        ],
        [
            "a short hash",
            [{ hash: HASH_A.slice(0, 39), action: "pick" }],
            new Set([HASH_A]),
            "invalid-hash",
        ],
        [
            "a long hash",
            [{ hash: `${HASH_A}a`, action: "pick" }],
            new Set([HASH_A]),
            "invalid-hash",
        ],
        [
            "a non-hex hash",
            [{ hash: `${HASH_A.slice(0, 39)}g`, action: "pick" }],
            new Set([HASH_A]),
            "invalid-hash",
        ],
        [
            "a CR in a hash",
            [{ hash: `${HASH_A}\r`, action: "pick" }],
            new Set([HASH_A]),
            "invalid-hash",
        ],
        [
            "an LF in a hash",
            [{ hash: `${HASH_A}\n`, action: "pick" }],
            new Set([HASH_A]),
            "invalid-hash",
        ],
        [
            "a NUL in a hash",
            [{ hash: `${HASH_A}\0`, action: "pick" }],
            new Set([HASH_A]),
            "invalid-hash",
        ],
        [
            "a hash outside the offered range",
            [{ hash: HASH_A, action: "pick" }],
            new Set([HASH_B]),
            "hash-not-offered",
        ],
        [
            "a duplicate hash",
            [
                { hash: HASH_A, action: "pick" },
                { hash: HASH_A, action: "drop" },
            ],
            new Set([HASH_A, HASH_B]),
            "duplicate-hash",
        ],
        [
            "a missing offered entry",
            [{ hash: HASH_A, action: "pick" }],
            new Set([HASH_A, HASH_B]),
            "entry-count-mismatch",
        ],
        [
            "an empty reword message",
            [{ hash: HASH_A, action: "reword", message: "" }],
            new Set([HASH_A]),
            "missing-message",
        ],
        [
            "an absent squash message",
            [{ hash: HASH_A, action: "squash" }],
            new Set([HASH_A]),
            "missing-message",
        ],
    ])("rejects %s", (_name, entries, offered, reason) => {
        expect(validateRebaseSubmission(entries, offered)).toMatchObject({
            status: "invalid",
            reason,
        });
    });

    it.each([
        [
            "a squash after a leading drop",
            [
                { hash: HASH_A, action: "drop" },
                { hash: HASH_B, action: "squash", message: "combine" },
            ],
        ],
        [
            "a fixup after a leading drop",
            [
                { hash: HASH_A, action: "drop" },
                { hash: HASH_B, action: "fixup" },
            ],
        ],
        [
            "a reordered first squash",
            [
                { hash: HASH_B, action: "squash", message: "combine" },
                { hash: HASH_A, action: "drop" },
            ],
        ],
    ])("rejects %s as the first non-dropped entry", (_name, entries) => {
        expect(validateRebaseSubmission(entries, new Set([HASH_A, HASH_B]))).toMatchObject({
            status: "invalid",
            reason: "invalid-first-action",
        });
    });

    it("recomputes the first non-dropped entry after reordered drops", () => {
        const entries = [
            { hash: HASH_C, action: "drop" },
            { hash: HASH_A, action: "pick" },
            { hash: HASH_B, action: "fixup" },
        ] as const;

        expect(
            validateRebaseSubmission(entries, new Set(entries.map((entry) => entry.hash))),
        ).toMatchObject({
            status: "valid",
        });
    });
});

describe("interactive rebase storage", () => {
    it("atomically reserves a repository, rejects contention and active rebases, then releases", async () => {
        const { storageRoot, repoRoot, gitDir } = await rebasePaths();
        const first = await tryAcquireRebaseReservation({
            storageRoot,
            repoRoot,
            gitDir,
            sessionId: "session-one",
        });

        expect(first).toMatchObject({ status: "acquired" });
        const second = await tryAcquireRebaseReservation({
            storageRoot,
            repoRoot,
            gitDir,
            sessionId: "session-two",
        });
        expect(second).toEqual({ status: "rejected", reason: "reservation-exists" });

        if (first.status !== "acquired")
            throw new Error("Reservation should be acquired for test setup.");
        await releaseRebaseReservation(first.reservation);
        expect(
            await tryAcquireRebaseReservation({
                storageRoot,
                repoRoot,
                gitDir,
                sessionId: "session-two",
            }),
        ).toMatchObject({ status: "acquired" });

        await mkdir(path.join(gitDir, "rebase-merge"));
        expect(
            await tryAcquireRebaseReservation({
                storageRoot,
                repoRoot,
                gitDir,
                sessionId: "session-three",
            }),
        ).toEqual({ status: "rejected", reason: "rebase-in-progress" });
    });

    it("does not release a reservation owned by another session", async () => {
        const { storageRoot, repoRoot, gitDir } = await rebasePaths();
        const acquired = await tryAcquireRebaseReservation({
            storageRoot,
            repoRoot,
            gitDir,
            sessionId: "owning-session",
        });
        if (acquired.status !== "acquired")
            throw new Error("Reservation should be acquired for test setup.");

        await releaseRebaseReservation({
            ...acquired.reservation,
            sessionId: "non-owning-session",
        });

        expect(existsSync(acquired.reservation.pointerPath)).toBe(true);
    });

    it("reclaims an orphaned reservation but preserves a live manifest reservation", async () => {
        const { storageRoot, repoRoot, gitDir } = await rebasePaths();
        const acquired = await tryAcquireRebaseReservation({
            storageRoot,
            repoRoot,
            gitDir,
            sessionId: "orphaned-session",
        });
        if (acquired.status !== "acquired")
            throw new Error("Reservation should be acquired for test setup.");

        expect(await sweepOrphanedRebaseReservation({ storageRoot, repoRoot, gitDir })).toEqual({
            status: "reclaimed",
        });
        expect(existsSync(acquired.reservation.pointerPath)).toBe(false);

        const live = await tryAcquireRebaseReservation({
            storageRoot,
            repoRoot,
            gitDir,
            sessionId: "live-session",
        });
        if (live.status !== "acquired")
            throw new Error("Reservation should be acquired for test setup.");
        await writeRebaseManifest(storageRoot, manifest(repoRoot, "live-session"));

        expect(await sweepOrphanedRebaseReservation({ storageRoot, repoRoot, gitDir })).toEqual({
            status: "retained",
            reason: "live-manifest",
        });
        expect(existsSync(live.reservation.pointerPath)).toBe(true);
    });

    it.each([
        ["completed-pending-push", "reclaimed"],
        ["done", "reclaimed"],
        ["running", "retained"],
        ["paused", "retained"],
        ["starting", "retained"],
    ] as const)("sweeps a %s manifest according to its lifecycle", async (lifecycle, status) => {
        const { storageRoot, repoRoot, gitDir } = await rebasePaths();
        const acquired = await tryAcquireRebaseReservation({
            storageRoot,
            repoRoot,
            gitDir,
            sessionId: `lifecycle-${lifecycle}`,
        });
        if (acquired.status !== "acquired")
            throw new Error("Reservation should be acquired for test setup.");
        await writeRebaseManifest(storageRoot, {
            ...manifest(repoRoot, `lifecycle-${lifecycle}`),
            lifecycle,
        });

        await expect(
            sweepOrphanedRebaseReservation({ storageRoot, repoRoot, gitDir }),
        ).resolves.toEqual(
            status === "reclaimed"
                ? { status: "reclaimed" }
                : { status: "retained", reason: "live-manifest" },
        );
        expect(existsSync(acquired.reservation.pointerPath)).toBe(status === "retained");
    });

    it("creates and deletes a per-submission helper-artifact directory", async () => {
        const { storageRoot, repoRoot } = await rebasePaths();
        const session = await createRebaseSessionDirectory(
            storageRoot,
            repoRoot,
            "session-artifacts",
        );

        expect(path.basename(session.directory)).toBe("session-artifacts");
        expect(session.todoPath.startsWith(session.directory)).toBe(true);
        expect(session.messageMapPath.startsWith(session.directory)).toBe(true);
        expect(session.consumptionDirectory.startsWith(session.directory)).toBe(true);
        expect(existsSync(session.directory)).toBe(true);

        await deleteRebaseSessionDirectory(storageRoot, repoRoot, "session-artifacts");
        expect(existsSync(session.directory)).toBe(false);
    });

    it("writes valid manifests atomically for both push-target forms", async () => {
        const { storageRoot, repoRoot } = await rebasePaths();
        const paths = getRebaseStoragePaths(storageRoot, repoRoot);
        const withoutPushTarget = manifest(repoRoot, "without-push-target");
        const withPushTarget = manifest(repoRoot, "with-push-target", {
            remoteName: "origin",
            remoteHeadRef: "refs/remotes/origin/main",
            upstreamOid: HASH_C,
        });

        await writeRebaseManifest(storageRoot, withoutPushTarget);
        await writeRebaseManifest(storageRoot, withPushTarget);

        await expect(
            readRebaseManifest(storageRoot, repoRoot, withoutPushTarget.sessionId),
        ).resolves.toMatchObject({
            status: "valid",
            manifest: withoutPushTarget,
        });
        await expect(
            readRebaseManifest(storageRoot, repoRoot, withPushTarget.sessionId),
        ).resolves.toMatchObject({
            status: "valid",
            manifest: withPushTarget,
        });
        expect((await readdir(paths.manifestDirectory)).sort()).toEqual([
            "with-push-target.json",
            "without-push-target.json",
        ]);
    });

    it("rejects partial push targets before an atomic manifest write", async () => {
        const { storageRoot, repoRoot } = await rebasePaths();
        const invalid = {
            ...manifest(repoRoot, "partial-push-target"),
            pushTarget: { remoteName: "origin" },
        } as unknown as RebaseSessionManifest;

        await expect(writeRebaseManifest(storageRoot, invalid)).rejects.toMatchObject({
            code: "invalid-push-target",
        });
        expect(
            existsSync(
                getRebaseStoragePaths(storageRoot, repoRoot).manifestPath("partial-push-target"),
            ),
        ).toBe(false);
    });

    it.each([
        ["an unqualified branch", { branch: "main" }],
        ["a malformed object ID", { baseHash: "not-an-object-id" }],
        ["an unknown lifecycle", { lifecycle: "unknown" }],
        ["a malformed creation time", { createdAt: "not-a-date" }],
        ["an uppercase base hash", { baseHash: "A".repeat(40) }],
        ["an uppercase expected head", { expectedHead: "B".repeat(40) }],
    ])("rejects %s before an atomic manifest write", async (_name, invalidFields) => {
        const { storageRoot, repoRoot } = await rebasePaths();
        const invalid = {
            ...manifest(repoRoot, `invalid-${_name.replaceAll(" ", "-")}`),
            ...invalidFields,
        } as unknown as RebaseSessionManifest;

        await expect(writeRebaseManifest(storageRoot, invalid)).rejects.toMatchObject({
            code: "invalid-schema",
        });
    });

    it.each([
        ["corrupt", "{ definitely not JSON }", "corrupt"],
        ["truncated", '{"version": 1', "truncated"],
        ["unknown version", '{"version": 2}', "unknown-version"],
    ])("classifies %s manifests as ambiguous", async (_name, contents, reason) => {
        const { storageRoot, repoRoot } = await rebasePaths();
        const paths = getRebaseStoragePaths(storageRoot, repoRoot);
        await mkdir(paths.manifestDirectory, { recursive: true });
        await writeFile(paths.manifestPath("ambiguous-session"), contents, "utf8");

        await expect(
            readRebaseManifest(storageRoot, repoRoot, "ambiguous-session"),
        ).resolves.toEqual({
            status: "ambiguous",
            reason,
        });
    });
});
