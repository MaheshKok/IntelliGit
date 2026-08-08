/**
 * Spec-derived tests for `tests/fixtures/repo/snapshot.ts`'s top-level orchestration (PLAN.md
 * Phase 1 step 9): `snapshotWorkspace()` captures the full restorable domain for BOTH the
 * workspace and the bare `origin`, and the durable-VS-Code-state seam (step 10) is either
 * genuinely `captured` through a caller-supplied `DurableStateProvider` or explicitly
 * `not-captured` with a reason -- never a silent empty object, and the two must never compare
 * equal (Phase 6's actual defence against a false green, restated in `snapshot.ts`'s own module
 * doc comment: "a `not-captured` section can never compare equal to a captured-but-empty one...
 * `tests/unit/fixtures/snapshot.test.ts` proves this directly").
 *
 * Per-section detail (working tree, index, refs, worktrees, git-dir private state, object store)
 * already has its own dedicated, RED-proofed test file next to this one; this file covers what
 * only exists at the `snapshotWorkspace()` orchestration layer itself: both repositories captured
 * together, a total read failure propagating instead of collapsing into an empty section, and the
 * durable-state seam's two-armed contract.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_TEXT_CAPTURE_LIMIT_BYTES, inventoryDirectory } from "../../fixtures/repo/fsInventory";
import { createSanitizedGitEnv, seedFixtureTemplate, type FixtureTemplate } from "../../fixtures/repo/seed";
// Imported through the public barrel (`snapshot.ts`), not the internal `snapshotTypes.ts`/
// `snapshotDurableState.ts` modules: this file exercises `snapshotWorkspace()`'s own public
// contract -- the same surface step 8's `harness.ts` will consume -- rather than one internal
// module in isolation, which is what the sibling `snapshotXxx.test.ts` files already do.
import {
    captured,
    snapshotWorkspace,
    type DurableStateProvider,
    type DurableStateSnapshot,
} from "../../fixtures/repo/snapshot";

const FIXTURE_TIMEOUT_MS = 30_000;
const UNUSED_PROFILE_DIR = "/nonexistent/profile";

function buildDurableStateSnapshot(overrides: Partial<DurableStateSnapshot> = {}): DurableStateSnapshot {
    return {
        shelfFiles: [],
        memento: { global: {}, workspace: {} },
        secrets: {},
        configuration: {},
        webviewState: {},
        ...overrides,
    };
}

function buildProvider(data: DurableStateSnapshot): DurableStateProvider {
    return { snapshotDurableState: vi.fn().mockResolvedValue(data) };
}

describe("snapshotWorkspace -- captures the full restorable domain for both repositories", () => {
    let scratchDest: string | undefined;
    let template: FixtureTemplate | undefined;

    afterEach(async () => {
        if (template) await rm(template.home, { recursive: true, force: true });
        if (scratchDest) await rm(scratchDest, { recursive: true, force: true });
        template = undefined;
        scratchDest = undefined;
    }, FIXTURE_TIMEOUT_MS);

    it("captures real seeded state for the workspace and reports the origin as bare with no working tree", async () => {
        scratchDest = await mkdtemp(path.join(tmpdir(), "intelligit-snapshotworkspace-"));
        template = await seedFixtureTemplate(scratchDest);

        const snapshot = await snapshotWorkspace({
            root: template.root,
            originRoot: template.originRoot,
            profileDir: UNUSED_PROFILE_DIR,
            env: template.env,
        });

        expect(snapshot.workspace.isBare).toBe(false);
        expect(snapshot.workspace.workingTree.status).toBe("captured");
        if (snapshot.workspace.workingTree.status === "captured") {
            const paths = snapshot.workspace.workingTree.data.map((entry) => entry.relativePath);
            expect(paths).toContain("README.md"); // committed history
            expect(paths).toContain("untracked.txt"); // dirty layer: untracked
            expect(paths).toContain("ignored/build.log"); // dirty layer: ignored
        }

        expect(snapshot.workspace.index.status).toBe("captured");
        if (snapshot.workspace.index.status === "captured") {
            const mutableEntries = snapshot.workspace.index.data.filter((entry) => entry.path === "mutable.txt");
            expect(mutableEntries.length).toBeGreaterThan(0); // dirty layer: staged-and-unstaged
        }

        expect(snapshot.workspace.refs.status).toBe("captured");
        if (snapshot.workspace.refs.status === "captured") {
            const names = snapshot.workspace.refs.data.map((entry) => entry.name);
            expect(names).toContain("refs/stash"); // pre-seeded stash entries
            expect(names).toContain("refs/heads/feature/awesome");
        }

        // The bare origin has no working tree at all -- `not-captured` here is a correct,
        // reasoned absence (PLAN.md's binary Section contract), never a bug to paper over.
        expect(snapshot.origin.isBare).toBe(true);
        expect(snapshot.origin.workingTree.status).toBe("not-captured");
        expect(snapshot.origin.refs.status).toBe("captured");
        if (snapshot.origin.refs.status === "captured") {
            const names = snapshot.origin.refs.data.map((entry) => entry.name);
            expect(names).toContain("refs/heads/main");
            expect(names).toContain("refs/tags/v1.0.0");
        }
    }, FIXTURE_TIMEOUT_MS);

    it("REJECTS rather than returning an empty captured section when a root is not a git repository at all", async () => {
        // The governing principle's sharpest edge, verified directly: a total read failure must
        // propagate as a rejection, never collapse into a silently empty (but structurally
        // "captured") section -- confirmed empirically that a bare `git rev-parse` against a
        // non-repository directory exits 128 and rejects the promisified subprocess call, which
        // every snapshot* module lets propagate rather than swallowing in a `catch {}`.
        const sanitized = await createSanitizedGitEnv();
        scratchDest = await mkdtemp(path.join(tmpdir(), "intelligit-snapshotworkspace-notrepo-"));
        const notARepo = path.join(scratchDest, "not-a-repo");
        await mkdir(notARepo, { recursive: true });

        await expect(
            snapshotWorkspace({
                root: notARepo,
                originRoot: notARepo,
                profileDir: UNUSED_PROFILE_DIR,
                env: sanitized.env,
            }),
        ).rejects.toThrow();

        await rm(sanitized.home, { recursive: true, force: true });
    }, FIXTURE_TIMEOUT_MS);
});

describe("snapshotWorkspace -- durable VS Code state seam (PLAN.md step 10)", () => {
    let scratchDest: string | undefined;
    let template: FixtureTemplate | undefined;

    afterEach(async () => {
        if (template) await rm(template.home, { recursive: true, force: true });
        if (scratchDest) await rm(scratchDest, { recursive: true, force: true });
        template = undefined;
        scratchDest = undefined;
    }, FIXTURE_TIMEOUT_MS);

    async function seedMinimalTemplate(prefix: string): Promise<FixtureTemplate> {
        scratchDest = await mkdtemp(path.join(tmpdir(), prefix));
        template = await seedFixtureTemplate(scratchDest);
        return template;
    }

    it("is not-captured, with a non-empty reason, when no provider is supplied", async () => {
        const tpl = await seedMinimalTemplate("intelligit-durable-noprovider-");
        const snapshot = await snapshotWorkspace({
            root: tpl.root,
            originRoot: tpl.originRoot,
            profileDir: UNUSED_PROFILE_DIR,
            env: tpl.env,
        });
        expect(snapshot.durableState.status).toBe("not-captured");
        if (snapshot.durableState.status !== "not-captured") return;
        expect(snapshot.durableState.reason.length).toBeGreaterThan(0);
    }, FIXTURE_TIMEOUT_MS);

    it("is captured, wired through to the provider's real data, when a provider IS supplied", async () => {
        const tpl = await seedMinimalTemplate("intelligit-durable-withprovider-");
        const providerData = buildDurableStateSnapshot({
            secrets: { commitChecks: { present: true, digest: "abc123" } },
        });
        const provider = buildProvider(providerData);

        const snapshot = await snapshotWorkspace({
            root: tpl.root,
            originRoot: tpl.originRoot,
            profileDir: UNUSED_PROFILE_DIR,
            env: tpl.env,
            durableState: provider,
        });

        expect(provider.snapshotDurableState).toHaveBeenCalledTimes(1);
        expect(snapshot.durableState).toEqual(captured(providerData));
    }, FIXTURE_TIMEOUT_MS);

    it("RED-proof: the not-captured seam and the captured seam never compare equal -- Phase 6's actual defence", async () => {
        const tpl = await seedMinimalTemplate("intelligit-durable-redproof-");

        const withoutProvider = await snapshotWorkspace({
            root: tpl.root,
            originRoot: tpl.originRoot,
            profileDir: UNUSED_PROFILE_DIR,
            env: tpl.env,
        });
        const withProvider = await snapshotWorkspace({
            root: tpl.root,
            originRoot: tpl.originRoot,
            profileDir: UNUSED_PROFILE_DIR,
            env: tpl.env,
            durableState: buildProvider(buildDurableStateSnapshot()),
        });

        // The literal claim PLAN.md's work order asks to be proven: a `not-captured` durable
        // section must not compare equal to a `captured` one, even when the captured payload is
        // itself empty -- otherwise a Phase 6 comparison against a template snapshot taken WITH a
        // live host (captured) could pass against a later copy snapshotted WITHOUT one
        // (not-captured), and a real regression in durable state would never be caught.
        expect(withoutProvider.durableState).not.toEqual(withProvider.durableState);
        expect(withoutProvider).not.toEqual(withProvider);
    }, FIXTURE_TIMEOUT_MS);

    it("RED-proof: the provider's actual data flows through unmangled, not a hardcoded constant", async () => {
        const tpl = await seedMinimalTemplate("intelligit-durable-datadiffers-");

        const [snapA, snapB] = await Promise.all([
            snapshotWorkspace({
                root: tpl.root,
                originRoot: tpl.originRoot,
                profileDir: UNUSED_PROFILE_DIR,
                env: tpl.env,
                durableState: buildProvider(buildDurableStateSnapshot({ configuration: { undockableWindow: true } })),
            }),
            snapshotWorkspace({
                root: tpl.root,
                originRoot: tpl.originRoot,
                profileDir: UNUSED_PROFILE_DIR,
                env: tpl.env,
                durableState: buildProvider(buildDurableStateSnapshot({ configuration: { undockableWindow: false } })),
            }),
        ]);

        expect(snapA.durableState.status).toBe("captured");
        expect(snapB.durableState.status).toBe("captured");
        // Same comparison shape as the RED-proof above; it distinguishes two DIFFERENT captured
        // payloads too, not just captured-vs-not-captured -- proving this seam is not short-
        // circuited to a single constant result regardless of what the provider returns.
        expect(snapA.durableState).not.toEqual(snapB.durableState);
    }, FIXTURE_TIMEOUT_MS);
});

describe("inventoryDirectory -- text capture limit boundary (fsInventory.ts)", () => {
    let scratch: string | undefined;

    afterEach(async () => {
        if (scratch) await rm(scratch, { recursive: true, force: true });
        scratch = undefined;
    });

    it("captures decoded text for a file at the default limit, and withholds it for one byte over -- digest is captured either way", async () => {
        scratch = await mkdtemp(path.join(tmpdir(), "intelligit-textcapture-"));
        await writeFile(path.join(scratch, "at-limit.txt"), "a".repeat(DEFAULT_TEXT_CAPTURE_LIMIT_BYTES));
        await writeFile(path.join(scratch, "over-limit.txt"), "a".repeat(DEFAULT_TEXT_CAPTURE_LIMIT_BYTES + 1));

        const entries = await inventoryDirectory({ root: scratch });
        const byPath = new Map(entries.map((entry) => [entry.relativePath, entry]));

        expect(byPath.get("at-limit.txt")?.text).not.toBeNull();
        expect(byPath.get("over-limit.txt")?.text).toBeNull();
        expect(byPath.get("over-limit.txt")?.digest).toHaveLength(64);
    });

    it("RED-proof: a caller-supplied lower limit withholds text that the default limit would have captured", async () => {
        scratch = await mkdtemp(path.join(tmpdir(), "intelligit-textcapture-custom-"));
        await writeFile(path.join(scratch, "small.txt"), "hello\n");

        const withDefault = await inventoryDirectory({ root: scratch });
        expect(withDefault[0]?.text).toBe("hello\n");

        // Same file, same call shape; only the limit changes -- and the same "text is captured"
        // assertion now flips to null, proving the option is genuinely honoured rather than the
        // default constant being silently reapplied underneath it.
        const withTinyLimit = await inventoryDirectory({ root: scratch, textCaptureLimitBytes: 1 });
        expect(withTinyLimit[0]?.text).toBeNull();
    });
});

describe("inventoryDirectory -- deterministic, locale-independent ordering (fsInventory.ts)", () => {
    let scratch: string | undefined;

    afterEach(async () => {
        if (scratch) await rm(scratch, { recursive: true, force: true });
        scratch = undefined;
    });

    it("RED-proof: orders entries by plain codepoint, not by this machine's default-locale collation", async () => {
        // Confirmed empirically (see `fsInventory.ts`'s `compareCodepoints` doc comment): on this
        // very machine, with no LANG/LC_ALL set, `String.prototype.localeCompare`'s default
        // collation sorts "README.md" AFTER "commondir"/"conflict.txt"/"mutable.txt" -- real
        // git-admin and fixture file names this suite actually uses -- while plain codepoint
        // order (what `compareCodepoints` produces) sorts "README.md" BEFORE all three, because
        // uppercase ASCII sorts below lowercase ASCII. If `inventoryDirectory` ever reverts to
        // `localeCompare`, this exact assertion fails on this exact machine: it is not a
        // hypothetical portability worry, it is a reproduced-right-here divergence.
        scratch = await mkdtemp(path.join(tmpdir(), "intelligit-codepoint-order-"));
        await writeFile(path.join(scratch, "commondir"), "c\n");
        await writeFile(path.join(scratch, "conflict.txt"), "c\n");
        await writeFile(path.join(scratch, "mutable.txt"), "m\n");
        await writeFile(path.join(scratch, "README.md"), "r\n");

        const entries = await inventoryDirectory({ root: scratch });
        const order = entries.map((entry) => entry.relativePath);

        expect(order).toEqual(["README.md", "commondir", "conflict.txt", "mutable.txt"]);
        // Sanity: this machine's locale collation genuinely disagrees with that order --
        // otherwise this test would pass for the wrong reason (locale collation happening to
        // coincide with codepoint order on this particular machine).
        const localeOrder = [...order].sort((a, b) => a.localeCompare(b));
        expect(localeOrder).not.toEqual(order);
    });
});
