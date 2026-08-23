/**
 * Spec-derived tests for the shared placeholder-canonicalization core extracted out of
 * `snapshotNormalize.ts` (PLAN.md Phase 1 step 8 + Phase 2 step 12's recorder requirement to use
 * "the same canonicalization"). This file exists to prove the extracted core -- not
 * `snapshotNormalize.ts`'s own already-tested behavior -- carries the two properties Phase 2's
 * recorder depends on and cannot re-derive without duplicating: longest-needle-first ordering for
 * a nested root, and realpath-vs-literal spelling duality. Both are proven directly against
 * `buildPlaceholderReplacements` / `normalizeUnknownDeep`, the exact functions the recorder's
 * `canonicalizeCapturedMessages` consumes, so a regression here is a regression for both
 * consumers by construction -- there is exactly one implementation for both tests to exercise.
 */

import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
    buildPlaceholderReplacements,
    normalizeUnknownDeep,
    normalizeString,
    type PlaceholderRoots,
} from "../../fixtures/repo/placeholderCanonicalization";

/**
 * Every webview fixture recorder passes `profileDir: ""` -- those slices never allocate a VS Code
 * profile directory, so there is no concrete path to rewrite. That is deliberate and documented,
 * and it makes `spellingsFor`'s empty-root guard load-bearing for all eight entries in
 * `webviewFixtureRegistry.ts`. Nothing else exercises it: every other case in this file passes a
 * non-empty profileDir, so the one input the recorders actually use was the one input never tested.
 *
 * Delete that guard and `spellingsFor("")` yields the needle `""`, so `normalizeString` runs
 * `value.split("").join("<PROFILE>")` -- the placeholder lands between EVERY character of every
 * recorded payload. The corruption happens at record time, in the canonicalization pass that
 * exists to keep real paths out of committed fixtures, and it would be committed looking normal
 * to every gate that does not read the fixture bytes.
 */
describe("buildPlaceholderReplacements -- an empty root contributes no needles", () => {
    it("emits no replacement at all for an empty profileDir", () => {
        const replacements = buildPlaceholderReplacements({
            root: "/scratch/empty/root",
            originRoot: "/scratch/empty/origin",
            profileDir: "",
        });

        expect(
            replacements.filter(([, placeholder]) => placeholder === "<PROFILE>"),
            "an empty profileDir must contribute zero needles",
        ).toEqual([]);
        expect(
            replacements.filter(([needle]) => needle.length === 0),
            "an empty needle matches every position and would shred every recorded string",
        ).toEqual([]);
    });

    it("leaves a payload untouched when every root is empty", () => {
        const replacements = buildPlaceholderReplacements({
            root: "",
            originRoot: "",
            profileDir: "",
        });

        expect(normalizeString("/a/real/path", replacements)).toBe("/a/real/path");
    });
});

describe("buildPlaceholderReplacements -- longest-needle-first ordering", () => {
    it("collapses a profileDir nested INSIDE root to <PROFILE>, not to <ROOT>/... ", () => {
        const roots: PlaceholderRoots = {
            root: "/scratch/case/root",
            originRoot: "/scratch/case/origin",
            profileDir: "/scratch/case/root/profile",
        };
        const replacements = buildPlaceholderReplacements(roots);

        const value = {
            settingsPath: "/scratch/case/root/profile/settings.json",
        };
        const normalized = normalizeUnknownDeep(value, replacements) as typeof value;

        expect(normalized.settingsPath).toBe("<PROFILE>/settings.json");
        // Specifically NOT the wrong ordering's result -- the failure mode this test exists to
        // catch, spelled out so a future reader sees exactly what "wrong" looks like here.
        expect(normalized.settingsPath).not.toBe("<ROOT>/profile/settings.json");
    });

    it("still collapses a bare, non-nested root to its own placeholder", () => {
        const roots: PlaceholderRoots = {
            root: "/scratch/case2/root",
            originRoot: "/scratch/case2/origin",
            profileDir: "/scratch/case2/profile",
        };
        const replacements = buildPlaceholderReplacements(roots);
        expect(normalizeString("/scratch/case2/root/file.txt", replacements)).toBe(
            "<ROOT>/file.txt",
        );
        expect(normalizeString("/scratch/case2/profile/settings.json", replacements)).toBe(
            "<PROFILE>/settings.json",
        );
    });
});

describe("normalizeUnknownDeep -- realpath duality", () => {
    let scratch: string | undefined;

    afterEach(async () => {
        if (scratch) await rm(scratch, { recursive: true, force: true });
        scratch = undefined;
    });

    it("collapses both the literal and realpath'd spellings of a root to the same placeholder", async () => {
        scratch = await mkdtemp(path.join(tmpdir(), "intelligit-recorder-realpath-"));
        const real = path.join(scratch, "real-target");
        await mkdir(real, { recursive: true });
        const alias = path.join(scratch, "alias-root");
        await symlink(real, alias);

        const literalRoot = alias;
        const realpathRoot = realpathSync(alias);
        expect(realpathRoot).not.toBe(literalRoot); // otherwise this test proves nothing

        const roots: PlaceholderRoots = {
            root: literalRoot,
            originRoot: "/scratch/unused-origin",
            profileDir: "/scratch/unused-profile",
        };
        const replacements = buildPlaceholderReplacements(roots);

        // A value spelled using the REALPATH'd form (as `git worktree list --porcelain` does for
        // the primary worktree) must still collapse, even though the caller only ever passed the
        // literal spelling as `roots.root`.
        const value = { gitDir: `${realpathRoot}/.git` };
        const normalized = normalizeUnknownDeep(value, replacements) as typeof value;
        expect(normalized.gitDir).toBe("<ROOT>/.git");
    });
});

describe("normalizeUnknownDeep -- arbitrary JSON-shaped data, not just WorkspaceSnapshot", () => {
    it("deeply rewrites strings nested through objects and arrays alike", () => {
        const roots: PlaceholderRoots = {
            root: "/scratch/deep/root",
            originRoot: "/scratch/deep/origin",
            profileDir: "/scratch/deep/profile",
        };
        const replacements = buildPlaceholderReplacements(roots);

        const value = {
            type: "state",
            paths: ["/scratch/deep/root/a.txt", "/scratch/deep/origin/b.txt"],
            nested: { deeper: { path: "/scratch/deep/profile/settings.json" } },
            untouched: 42,
            flag: true,
            missing: null,
        };
        const normalized = normalizeUnknownDeep(value, replacements) as typeof value;

        expect(normalized.paths).toEqual(["<ROOT>/a.txt", "<ORIGIN>/b.txt"]);
        expect(normalized.nested.deeper.path).toBe("<PROFILE>/settings.json");
        expect(normalized.untouched).toBe(42);
        expect(normalized.flag).toBe(true);
        expect(normalized.missing).toBeNull();
        // The input is untouched -- normalization is comparison-only, never in place.
        expect(value.paths[0]).toBe("/scratch/deep/root/a.txt");
    });
});

describe("normalizeUnknownDeep -- object KEYS, not only values", () => {
    it("rewrites an absolute path that appears as an object key", () => {
        // Not hypothetical: `UndockedViewProvider.getCommitDraftStorageKey`
        // (src/views/UndockedViewProvider.ts:1941) builds its workspace-state key as
        // `${COMMIT_DRAFT_KEY_PREFIX}${repositoryRoot}`, so the absolute repository root is the
        // KEY, not the value. That Memento content is exactly what a snapshot's `durableState`
        // section carries and what a recorded webview payload can echo back. A value-only walker
        // leaves the real path in the committed artifact while every visible string looks clean.
        const roots: PlaceholderRoots = {
            root: "/scratch/keys/root",
            originRoot: "/scratch/keys/origin",
            profileDir: "/scratch/keys/profile",
        };
        const replacements = buildPlaceholderReplacements(roots);

        const value = {
            "intelligit.commitDraft:/scratch/keys/root": "wip: message",
            nested: { "/scratch/keys/origin/a.txt": "staged" },
        };
        const normalized = normalizeUnknownDeep(value, replacements) as Record<string, unknown>;

        expect(Object.keys(normalized)).toEqual(["intelligit.commitDraft:<ROOT>", "nested"]);
        expect(normalized["intelligit.commitDraft:<ROOT>"]).toBe("wip: message");
        expect(Object.keys(normalized.nested as Record<string, unknown>)).toEqual([
            "<ORIGIN>/a.txt",
        ]);
        // The whole serialized artifact is clean, which is the property Phase 7 audits.
        expect(JSON.stringify(normalized)).not.toContain("/scratch/keys/");
    });

    it("throws rather than silently dropping an entry when two keys collapse to one", () => {
        // `Object.fromEntries` keeps the LAST of two identical keys. Silently losing a captured
        // entry is the exact false-green this suite exists to prevent, so a collision has to be
        // loud. Reachable in practice: a literal and a realpath'd spelling of the same root both
        // appearing as keys collapse to the same placeholder.
        const roots: PlaceholderRoots = {
            root: "/scratch/collide/root",
            originRoot: "/scratch/collide/origin",
            profileDir: "/scratch/collide/profile",
        };
        const replacements = buildPlaceholderReplacements(roots);

        const value = {
            "/scratch/collide/root/a.txt": 1,
            "<ROOT>/a.txt": 2,
        };

        expect(() => normalizeUnknownDeep(value, replacements)).toThrow(/collide|collision/i);
    });
});

/**
 * Windows spells one directory several ways, and git picks a different one than Node does (#223).
 * Both mismatches below left a real absolute path sitting un-redacted inside a COMMITTED fixture on
 * the Windows leg, while every macOS run looked clean -- `webviewFixtureGate` reported
 * `committed="\"worktreePath\": \"<ROOT>\"" fresh="\"worktreePath\": \"C:\\\\Users\\\\runneradmin\\\\..."`
 * for four contexts at once. The separator half is proven here by supplying the platform rather
 * than inheriting it; the 8.3 short-name half (`RUNNER~1` vs `runneradmin`) cannot be reproduced
 * off Windows, since POSIX has no short names to expand, and is covered by the CI leg instead.
 */
describe("buildPlaceholderReplacements -- Windows spells one root several ways (#223)", () => {
    const NODE_SPELLING = "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\ig-abc\\workspace";
    /** git addresses paths with `/` on every platform, including Windows. */
    const GIT_SPELLING = "C:/Users/runneradmin/AppData/Local/Temp/ig-abc/workspace";

    it("redacts the forward-slash spelling git reports, not only the backslash spelling Node builds", () => {
        const replacements = buildPlaceholderReplacements(
            { root: NODE_SPELLING, originRoot: "", profileDir: "" },
            "\\",
        );

        expect(
            normalizeString(GIT_SPELLING, replacements),
            "a path out of `git worktree list --porcelain` must still collapse to the placeholder",
        ).toBe("<ROOT>");
        expect(normalizeString(NODE_SPELLING, replacements)).toBe("<ROOT>");
    });

    it("does not fabricate a needle from a POSIX filename containing a literal backslash", () => {
        // The ratchet against fixing the above with an unconditional `replace(/\\/g, "/")`: a
        // backslash is a legal character in a POSIX filename, so rewriting one on a POSIX run
        // invents a needle that redacts a DIFFERENT, unrelated real directory. The forward-slash
        // variant is therefore added only when the platform separator is itself a backslash.
        const replacements = buildPlaceholderReplacements(
            { root: "/tmp/weird\\name", originRoot: "", profileDir: "" },
            "/",
        );

        expect(normalizeString("/tmp/weird\\name", replacements)).toBe("<ROOT>");
        expect(
            normalizeString("/tmp/weird/name", replacements),
            "a distinct real directory must not be redacted by a fabricated needle",
        ).toBe("/tmp/weird/name");
    });

    it("defaults to the running platform's separator", () => {
        const roots: PlaceholderRoots = {
            root: "/scratch/default/root",
            originRoot: "",
            profileDir: "",
        };

        expect(buildPlaceholderReplacements(roots)).toEqual(
            buildPlaceholderReplacements(roots, path.sep),
        );
    });
});

/**
 * `fs.realpathSync` and `fs.realpathSync.native` are not interchangeable, and the difference is
 * what made #223's Windows leg leak paths. `realpathSync` is Node's own JS resolver: it follows
 * symlinks but otherwise hands back the spelling you asked for. `realpathSync.native` goes through
 * the OS -- `GetFinalPathNameByHandle` on Windows -- and returns the CANONICAL ON-DISK spelling.
 *
 * On a Windows runner that is the difference between `C:\Users\RUNNER~1\...` (what `os.tmpdir()`
 * returns, an 8.3 short name) and `C:/Users/runneradmin/...` (what git reports). A needle list
 * built only from the JS resolver never contains the long form, so nothing redacts.
 *
 * POSIX has no 8.3 short names, but a case-insensitive filesystem exposes the SAME mechanism: ask
 * for `foobar` when the directory is really `FooBar` and only the native resolver tells you so.
 * That makes the Windows-only defect reproducible here, instead of first executing on CI 28
 * minutes later. Skipped on a case-sensitive filesystem, where the two resolvers cannot diverge
 * this way -- the Windows and macOS legs both cover it.
 */
describe("buildPlaceholderReplacements -- the native resolver's canonical spelling (#223)", () => {
    let scratch: string | undefined;

    afterEach(async () => {
        if (scratch) await rm(scratch, { recursive: true, force: true });
        scratch = undefined;
    });

    it("collapses the on-disk spelling when the caller passed a differently-cased one", async () => {
        scratch = await mkdtemp(path.join(tmpdir(), "intelligit-recorder-native-"));
        const onDisk = path.join(scratch, "FooBar");
        await mkdir(onDisk, { recursive: true });
        const asked = path.join(scratch, "foobar");

        let nativeSpelling: string;
        try {
            nativeSpelling = realpathSync.native(asked);
        } catch {
            // Case-sensitive filesystem (typically Linux): `foobar` simply does not exist, so the
            // two resolvers cannot diverge and there is nothing to prove here.
            return;
        }

        // Otherwise this test proves nothing: it must be the NATIVE resolver, and only it, that
        // recovers the on-disk spelling.
        expect(nativeSpelling.endsWith("FooBar")).toBe(true);
        expect(realpathSync(asked).endsWith("foobar")).toBe(true);

        const replacements = buildPlaceholderReplacements({
            root: asked,
            originRoot: "",
            profileDir: "",
        });

        expect(
            normalizeString(nativeSpelling, replacements),
            "a path reported in its canonical on-disk spelling must still collapse",
        ).toBe("<ROOT>");
        expect(normalizeString(asked, replacements)).toBe("<ROOT>");
    });
});
