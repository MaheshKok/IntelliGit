/**
 * Spec-derived tests for `tests/fixtures/repo/snapshotNormalize.ts` (PLAN.md Phase 1 step 8:
 * normalization is comparison-only, rewriting concrete per-copy paths to the canonical
 * placeholders `<ROOT>`, `<ORIGIN>`, `<PROFILE>` so two workspaces at different paths compare
 * equal; placeholders never touch the filesystem; the comparison stays case-sensitive on
 * recorded names).
 *
 * The realistic scenario this module exists for is exactly what `tests/fixtures/repo/harness.ts`
 * (step 8, not this suite's job) will do per test: one seed, N raw copies at different paths,
 * normalize each and diff. That scenario is what "two copies of one seed" below exercises.
 *
 * A related, *narrower* scenario -- two INDEPENDENTLY seeded templates -- was probed empirically
 * before writing this file and found NOT byte-identical even after normalization: `.git/index`'s
 * binary stat-cache embeds the real filesystem mtimes observed at `git add` time, which differ
 * between two separate `seedFixtureTemplate` calls made at different real wall-clock instants.
 * That is a property of git's index format, not a bug in this module or in `seedFixtureTemplate`
 * (whose own determinism proof in `seed.test.ts` deliberately stays at the ref/SHA level, never
 * diffing raw `.git/index` bytes, for the same reason). This suite does not assert byte-identity
 * across independent seeds for that reason; the "two copies of one seed" tests below are the
 * scenario normalization is actually built for and are proven equal, including the index file.
 */

import { cp, mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { normalizeSnapshot } from "../../fixtures/repo/snapshotNormalize";
import { snapshotWorkspace } from "../../fixtures/repo/snapshot";
import type { FsEntry } from "../../fixtures/repo/snapshotTypes";
import { captured, notCaptured } from "../../fixtures/repo/snapshotTypes";
import { seedFixtureTemplate, type FixtureTemplate } from "../../fixtures/repo/seed";
import { removeScratchDirectories } from "../../helpers/scratchDirectories";

/**
 * The two tests below each seed a git template and then copy the whole tree -- `.git` included --
 * twice. That is thousands of tiny files, and on Windows every one of them goes through Defender,
 * so the same work costs an order of magnitude more there than anywhere else. Measured on one
 * commit's runners (run 33092933861): 713ms on ubuntu-latest, 906ms on macos-latest, 7096ms on
 * windows-latest. The next run on the same branch (33098964139) took the whole file from 14.3s to
 * 65.7s with no change to it or anything it imports, and killed this suite's first test at the
 * 30s default -- a 4.6x swing that is runner IO variance, not a regression.
 *
 * The number guards nothing. These tests assert that two normalized snapshots are deep-equal, not
 * how long a copy takes, so headroom costs nothing when they pass and only delays a genuine hang.
 * Sized at roughly 12x the measured Windows cost rather than at that bad day, because one
 * observed swing is a floor on the variance, not a ceiling.
 */
const COPY_HEAVY_TIMEOUT_MS = 90_000;

describe("normalizeSnapshot -- two raw copies of one seed compare equal (step 8's real scenario)", () => {
    let scratchDirs: string[] = [];
    let template: FixtureTemplate | undefined;

    afterEach(async () => {
        await Promise.all(scratchDirs.map((dir) => removeScratchDirectories(dir)));
        scratchDirs = [];
        if (template) await removeScratchDirectories(template.home);
        template = undefined;
    }, COPY_HEAVY_TIMEOUT_MS);

    it(
        "normalizes two independent copies of the same template to a deep-equal snapshot",
        async () => {
            const seedDest = await mkdtemp(path.join(tmpdir(), "intelligit-normalize-seed-"));
            scratchDirs.push(seedDest);
            template = await seedFixtureTemplate(seedDest);

            const copy1Dest = await mkdtemp(path.join(tmpdir(), "intelligit-normalize-copy1-"));
            const copy2Dest = await mkdtemp(path.join(tmpdir(), "intelligit-normalize-copy2-"));
            await removeScratchDirectories(copy1Dest);
            await removeScratchDirectories(copy2Dest);
            scratchDirs.push(copy1Dest, copy2Dest);
            await cp(seedDest, copy1Dest, {
                recursive: true,
                preserveTimestamps: true,
                verbatimSymlinks: true,
            });
            await cp(seedDest, copy2Dest, {
                recursive: true,
                preserveTimestamps: true,
                verbatimSymlinks: true,
            });

            const roots1 = {
                root: path.join(copy1Dest, "workspace"),
                originRoot: path.join(copy1Dest, "origin.git"),
                profileDir: "/nonexistent/profile-1",
            };
            const roots2 = {
                root: path.join(copy2Dest, "workspace"),
                originRoot: path.join(copy2Dest, "origin.git"),
                profileDir: "/nonexistent/profile-2",
            };

            const [snap1, snap2] = await Promise.all([
                snapshotWorkspace({ ...roots1, env: template.env }),
                snapshotWorkspace({ ...roots2, env: template.env }),
            ]);

            const norm1 = normalizeSnapshot(snap1, roots1);
            const norm2 = normalizeSnapshot(snap2, roots2);

            expect(norm1).toEqual(norm2);
            // And the un-normalized inputs must genuinely have differed -- otherwise this proves
            // nothing about normalization, only that two identical things are identical.
            expect(snap1.workspace.repoRoot).not.toBe(snap2.workspace.repoRoot);
        },
        COPY_HEAVY_TIMEOUT_MS,
    );

    it(
        "RED-proof: a real divergence between the two copies survives normalization",
        async () => {
            const seedDest = await mkdtemp(path.join(tmpdir(), "intelligit-normalize-seed-red-"));
            scratchDirs.push(seedDest);
            template = await seedFixtureTemplate(seedDest);

            const copy1Dest = await mkdtemp(path.join(tmpdir(), "intelligit-normalize-red-copy1-"));
            const copy2Dest = await mkdtemp(path.join(tmpdir(), "intelligit-normalize-red-copy2-"));
            await removeScratchDirectories(copy1Dest);
            await removeScratchDirectories(copy2Dest);
            scratchDirs.push(copy1Dest, copy2Dest);
            await cp(seedDest, copy1Dest, {
                recursive: true,
                preserveTimestamps: true,
                verbatimSymlinks: true,
            });
            await cp(seedDest, copy2Dest, {
                recursive: true,
                preserveTimestamps: true,
                verbatimSymlinks: true,
            });

            // Deliberately break copy2: add an extra untracked file that copy1 never gets.
            await writeFile(
                path.join(copy2Dest, "workspace", "only-in-copy2.txt"),
                "divergence\n",
                "utf8",
            );

            const roots1 = {
                root: path.join(copy1Dest, "workspace"),
                originRoot: path.join(copy1Dest, "origin.git"),
                profileDir: "/nonexistent/profile-1",
            };
            const roots2 = {
                root: path.join(copy2Dest, "workspace"),
                originRoot: path.join(copy2Dest, "origin.git"),
                profileDir: "/nonexistent/profile-2",
            };

            const [snap1, snap2] = await Promise.all([
                snapshotWorkspace({ ...roots1, env: template.env }),
                snapshotWorkspace({ ...roots2, env: template.env }),
            ]);
            const norm1 = normalizeSnapshot(snap1, roots1);
            const norm2 = normalizeSnapshot(snap2, roots2);

            // Same comparison as the healthy test above (`toEqual`); it now fails, proving the
            // oracle is sensitive to a real, planted difference rather than always trivially equal.
            expect(norm1).not.toEqual(norm2);
        },
        COPY_HEAVY_TIMEOUT_MS,
    );
});

describe("normalizeSnapshot -- placeholder rewriting", () => {
    it("rewrites repoRoot, commonDir, and nested fs-entry text to <ROOT>/<ORIGIN>/<PROFILE>", () => {
        const roots = {
            root: "/tmp/fakeworkspace",
            originRoot: "/tmp/fakeorigin.git",
            profileDir: "/tmp/fakeprofile",
        };
        const fakeEntry: FsEntry = {
            relativePath: ".git/config",
            type: "file",
            mode: 0o644,
            digest: "original-digest-before-rewrite",
            text: `[remote "origin"]\n\turl = file:///tmp/fakeorigin.git\n`,
            symlinkTarget: null,
        };
        const snapshot = {
            workspace: {
                repoRoot: roots.root,
                commonDir: `${roots.root}/.git`,
                isBare: false,
                workingTree: captured([fakeEntry]),
                index: captured([]),
                refs: captured([]),
                head: captured({ kind: "symbolic" as const, target: "refs/heads/main" }),
                reflogs: captured([]),
                worktrees: captured([]),
                gitDirState: captured({}),
                objectStore: captured({
                    objects: [],
                    alternates: { present: false, rawLines: [], resolvedAbsolutePaths: [] },
                }),
            },
            origin: {
                repoRoot: roots.originRoot,
                commonDir: roots.originRoot,
                isBare: true,
                workingTree: notCaptured<readonly FsEntry[]>("bare"),
                index: captured([]),
                refs: captured([]),
                head: captured({ kind: "symbolic" as const, target: "refs/heads/main" }),
                reflogs: captured([]),
                worktrees: captured([]),
                gitDirState: captured({}),
                objectStore: captured({
                    objects: [],
                    alternates: { present: false, rawLines: [], resolvedAbsolutePaths: [] },
                }),
            },
            durableState: notCaptured<never>("no provider"),
        };

        const normalized = normalizeSnapshot(snapshot, roots);

        expect(normalized.workspace.repoRoot).toBe("<ROOT>");
        expect(normalized.workspace.commonDir).toBe("<ROOT>/.git");
        expect(normalized.origin.repoRoot).toBe("<ORIGIN>");
        const rewrittenEntry = (
            normalized.workspace.workingTree as { status: "captured"; data: readonly FsEntry[] }
        ).data[0];
        expect(rewrittenEntry?.text).toBe('[remote "origin"]\n\turl = file://<ORIGIN>\n');
        // Digest must be recomputed from the NEW text, not left pointing at stale bytes.
        expect(rewrittenEntry?.digest).not.toBe("original-digest-before-rewrite");

        // The input snapshot itself must be untouched -- normalization is comparison-only.
        expect(snapshot.workspace.repoRoot).toBe(roots.root);
        expect(fakeEntry.text).toContain("/tmp/fakeorigin.git");
    });

    it("never touches the filesystem: normalizing a snapshot for a profileDir that does not exist does not throw", () => {
        const roots = {
            root: "/tmp/whatever",
            originRoot: "/tmp/whatever-origin",
            profileDir: "/definitely/not/a/real/path",
        };
        const snapshot = {
            workspace: {
                repoRoot: roots.root,
                commonDir: `${roots.root}/.git`,
                isBare: false,
                workingTree: captured([]),
                index: captured([]),
                refs: captured([]),
                head: captured({ kind: "symbolic" as const, target: "refs/heads/main" }),
                reflogs: captured([]),
                worktrees: captured([]),
                gitDirState: captured({}),
                objectStore: captured({
                    objects: [],
                    alternates: { present: false, rawLines: [], resolvedAbsolutePaths: [] },
                }),
            },
            origin: {
                repoRoot: roots.originRoot,
                commonDir: roots.originRoot,
                isBare: true,
                workingTree: notCaptured<readonly FsEntry[]>("bare"),
                index: captured([]),
                refs: captured([]),
                head: captured({ kind: "symbolic" as const, target: "refs/heads/main" }),
                reflogs: captured([]),
                worktrees: captured([]),
                gitDirState: captured({}),
                objectStore: captured({
                    objects: [],
                    alternates: { present: false, rawLines: [], resolvedAbsolutePaths: [] },
                }),
            },
            durableState: notCaptured<never>("no provider"),
        };
        expect(() => normalizeSnapshot(snapshot, roots)).not.toThrow();
    });
});

describe("normalizeSnapshot -- realpath duality", () => {
    let scratch: string | undefined;

    afterEach(async () => {
        if (scratch) await removeScratchDirectories(scratch);
        scratch = undefined;
    });

    it("collapses both the literal spelling and the realpath'd spelling of a root to the same placeholder", async () => {
        // Controlled, portable reproduction of "root sits under a symlinked ancestor" (macOS
        // /var -> /private/var by default) without depending on that OS-specific symlink: build
        // our own symlink alias for a real directory and treat the alias as the "root".
        scratch = await mkdtemp(path.join(tmpdir(), "intelligit-realpath-duality-"));
        const real = path.join(scratch, "real-target");
        await mkdir(real, { recursive: true });
        const alias = path.join(scratch, "alias-root");
        await symlink(real, alias);

        const literalRoot = alias;
        const realpathRoot = realpathSync(alias);
        expect(realpathRoot).not.toBe(literalRoot); // otherwise this test proves nothing

        const entryWithRealpathSpelling: FsEntry = {
            relativePath: "worktrees/x/gitdir",
            type: "file",
            mode: 0o644,
            digest: "irrelevant",
            text: `${realpathRoot}/.git\n`,
            symlinkTarget: null,
        };
        const snapshot = {
            workspace: {
                repoRoot: literalRoot,
                commonDir: `${literalRoot}/.git`,
                isBare: false,
                workingTree: captured([]),
                index: captured([]),
                refs: captured([]),
                head: captured({ kind: "symbolic" as const, target: "refs/heads/main" }),
                reflogs: captured([]),
                worktrees: captured([]),
                gitDirState: captured({ common: [entryWithRealpathSpelling] }),
                objectStore: captured({
                    objects: [],
                    alternates: { present: false, rawLines: [], resolvedAbsolutePaths: [] },
                }),
            },
            origin: {
                repoRoot: "/tmp/unused-origin",
                commonDir: "/tmp/unused-origin",
                isBare: true,
                workingTree: notCaptured<readonly FsEntry[]>("bare"),
                index: captured([]),
                refs: captured([]),
                head: captured({ kind: "symbolic" as const, target: "refs/heads/main" }),
                reflogs: captured([]),
                worktrees: captured([]),
                gitDirState: captured({}),
                objectStore: captured({
                    objects: [],
                    alternates: { present: false, rawLines: [], resolvedAbsolutePaths: [] },
                }),
            },
            durableState: notCaptured<never>("no provider"),
        };

        const normalized = normalizeSnapshot(snapshot, {
            root: literalRoot,
            originRoot: "/tmp/unused-origin",
            profileDir: "/tmp/unused-profile",
        });

        expect(normalized.workspace.repoRoot).toBe("<ROOT>");
        const rewritten = (
            normalized.workspace.gitDirState as {
                status: "captured";
                data: Record<string, readonly FsEntry[]>;
            }
        ).data.common?.[0];
        // The entry's `text` used the REALPATH'd spelling, which is not the literal root string,
        // yet still collapses to the placeholder.
        expect(rewritten?.text).toBe("<ROOT>/.git\n");
    });
});

describe("normalizeSnapshot -- comparison stays case-sensitive on recorded names", () => {
    it("does not fold the case of a relativePath, so two entries differing only in case remain distinct", () => {
        const roots = {
            root: "/tmp/case-test",
            originRoot: "/tmp/case-test-origin",
            profileDir: "/tmp/case-test-profile",
        };
        const lower: FsEntry = {
            relativePath: "file.txt",
            type: "file",
            mode: 0o644,
            digest: "d1",
            text: null,
            symlinkTarget: null,
        };
        const upper: FsEntry = {
            relativePath: "FILE.txt",
            type: "file",
            mode: 0o644,
            digest: "d2",
            text: null,
            symlinkTarget: null,
        };

        const buildSnapshot = (entries: readonly FsEntry[]) => ({
            workspace: {
                repoRoot: roots.root,
                commonDir: `${roots.root}/.git`,
                isBare: false,
                workingTree: captured(entries),
                index: captured([]),
                refs: captured([]),
                head: captured({ kind: "symbolic" as const, target: "refs/heads/main" }),
                reflogs: captured([]),
                worktrees: captured([]),
                gitDirState: captured({}),
                objectStore: captured({
                    objects: [],
                    alternates: { present: false, rawLines: [], resolvedAbsolutePaths: [] },
                }),
            },
            origin: {
                repoRoot: roots.originRoot,
                commonDir: roots.originRoot,
                isBare: true,
                workingTree: notCaptured<readonly FsEntry[]>("bare"),
                index: captured([]),
                refs: captured([]),
                head: captured({ kind: "symbolic" as const, target: "refs/heads/main" }),
                reflogs: captured([]),
                worktrees: captured([]),
                gitDirState: captured({}),
                objectStore: captured({
                    objects: [],
                    alternates: { present: false, rawLines: [], resolvedAbsolutePaths: [] },
                }),
            },
            durableState: notCaptured<never>("no provider"),
        });

        const normalizedLower = normalizeSnapshot(buildSnapshot([lower]), roots);
        const normalizedUpper = normalizeSnapshot(buildSnapshot([upper]), roots);

        // On a case-insensitive filesystem these two entries would be the SAME path on disk; the
        // comparison contract must still treat them as different recorded names.
        expect(normalizedLower).not.toEqual(normalizedUpper);
    });
});

describe("normalizeSnapshot -- durableState.shelfFiles carries FsEntry digests, not opaque JSON", () => {
    /**
     * `DurableStateSnapshot.shelfFiles` is `readonly FsEntry[]`, so every rule the module doc
     * comment states about an `FsEntry` applies to it: a rewritten `text` must get a recomputed
     * `digest`, or the digest still hashes the ORIGINAL per-root bytes and two workspaces at
     * different roots keep comparing unequal on exactly the field normalization exists to make
     * equal.
     *
     * The assertion is the contract itself -- two roots normalize to an equal snapshot -- not
     * "the digest equals the hash of the normalized text", which would only restate the fix.
     */
    function buildSnapshot(roots: {
        readonly root: string;
        readonly originRoot: string;
        readonly profileDir: string;
    }) {
        const shelfText = `{"originalRepoRoot":"${roots.root}","shelvedAt":"2026-01-01T00:00:00Z"}`;
        const shelfFile: FsEntry = {
            relativePath: "shelf/entry-1.json",
            type: "file",
            mode: 0o644,
            // The digest a real capture records: a hash of the bytes actually on disk, which
            // embed this workspace's own absolute root.
            digest: createHash("sha256").update(Buffer.from(shelfText, "utf8")).digest("hex"),
            text: shelfText,
            symlinkTarget: null,
        };

        const emptyRepo = (repoRoot: string, isBare: boolean) => ({
            repoRoot,
            commonDir: isBare ? repoRoot : `${repoRoot}/.git`,
            isBare,
            workingTree: notCaptured<readonly FsEntry[]>("not under test"),
            index: captured([]),
            refs: captured([]),
            head: captured({ kind: "symbolic" as const, target: "refs/heads/main" }),
            reflogs: captured([]),
            worktrees: captured([]),
            gitDirState: captured({}),
            objectStore: captured({
                objects: [],
                alternates: { present: false, rawLines: [], resolvedAbsolutePaths: [] },
            }),
        });

        return {
            workspace: emptyRepo(roots.root, false),
            origin: emptyRepo(roots.originRoot, true),
            durableState: captured({
                shelfFiles: [shelfFile],
                memento: { global: {}, workspace: {} },
                secrets: {},
                configuration: {},
                webviewState: {},
            }),
        };
    }

    const rootsA = {
        root: "/tmp/intelligit-durable-a/copy/workspace",
        originRoot: "/tmp/intelligit-durable-a/copy/origin.git",
        profileDir: "/tmp/intelligit-durable-a/profile",
    };
    const rootsB = {
        root: "/tmp/intelligit-durable-b/copy/workspace",
        originRoot: "/tmp/intelligit-durable-b/copy/origin.git",
        profileDir: "/tmp/intelligit-durable-b/profile",
    };

    it("normalizes two workspaces' shelf files to an equal snapshot, digest included", () => {
        const normalizedA = normalizeSnapshot(buildSnapshot(rootsA), rootsA);
        const normalizedB = normalizeSnapshot(buildSnapshot(rootsB), rootsB);

        expect(
            normalizedA,
            "a shelf file's text was rewritten to <ROOT> but its digest still hashes this " +
                "workspace's own absolute root, so the equivalence oracle reports a difference " +
                "that does not exist",
        ).toEqual(normalizedB);
    });

    it("the two snapshots really do differ before normalization (the assertion above is not vacuous)", () => {
        expect(buildSnapshot(rootsA)).not.toEqual(buildSnapshot(rootsB));
    });
});

describe("Section discriminator -- not-captured must never compare equal to captured-but-empty", () => {
    it("a not-captured section and a captured-empty-object section are structurally distinct", () => {
        const notCapturedSection = notCaptured<Record<string, unknown>>("no provider was supplied");
        const capturedEmptySection = captured<Record<string, unknown>>({});

        expect(notCapturedSection).not.toEqual(capturedEmptySection);
        expect(notCapturedSection.status).toBe("not-captured");
        expect(capturedEmptySection.status).toBe("captured");
    });
});
