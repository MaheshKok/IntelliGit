/**
 * Pins the `O_NOFOLLOW` platform contract, and pins that no call site re-derives it by hand.
 *
 * The bug this covers is invisible on the host that runs the suite: on macOS and Linux
 * `resolveNoFollowFlag` returns exactly what the old inline expression returned, so no POSIX test
 * can tell the fix from the defect. The Windows branch is therefore reached by supplying the
 * platform rather than inheriting it.
 */

import { constants } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveNoFollowFlag } from "../../../src/shelf/noFollowFlag";

const repositoryRoot = path.resolve(__dirname, "../../..");

describe("resolveNoFollowFlag", () => {
    it("returns zero on Windows, where open rejects the flag outright", () => {
        // The whole point. `constants.O_NOFOLLOW` being defined does not mean `open` accepts it,
        // and passing it on Windows produced `EINVAL: invalid argument, open '...tracked.txt'`
        // from `replaceRegularWorktreeFile` for every user of the shelf, not only in tests.
        expect(resolveNoFollowFlag("win32")).toBe(0);
    });

    it("returns the real flag on POSIX platforms", () => {
        // Vacuity guard. A function that returned 0 everywhere would also pass the assertion above
        // while silently dropping the symlink protection on the platforms that do enforce it.
        const expected = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
        if (expected === 0) {
            // The host itself does not define O_NOFOLLOW, so there is no real flag to compare
            // against and the guard below cannot hold. Measured on the Windows leg of #223 (run
            // 32648506739), where this assertion failed with `expected 0 to be greater than 0` --
            // which is also the evidence that the original `typeof` guard in `noFollowFlag.ts` was
            // already returning 0 there, and that O_NOFOLLOW was never the cause of that leg's
            // EINVAL. The POSIX legs cover the branch below.
            expect(resolveNoFollowFlag("darwin")).toBe(0);
            return;
        }
        expect(expected, "this test host should define O_NOFOLLOW").toBeGreaterThan(0);
        for (const platform of ["darwin", "linux", "freebsd"] as const) {
            expect(resolveNoFollowFlag(platform), platform).toBe(expected);
        }
    });

    it("defaults to the running platform", () => {
        // The default argument is what every production call site actually uses, so a seam that is
        // only ever correct when a test passes an argument would prove nothing about them.
        expect(resolveNoFollowFlag()).toBe(resolveNoFollowFlag(process.platform));
    });
});

describe("O_NOFOLLOW call sites", () => {
    // Files that still hand the flag to `open`.
    const callSites = ["src/shelf/recovery.ts", "src/services/shelfConflictSession.ts"];
    // `safeWorktreeWrite` no longer opens the caller's path at all -- it writes an exclusively
    // created temporary and renames it over the target, which no platform follows a symlink
    // through -- so it has no flag to pass. It stays in the re-derivation ratchet because a future
    // edit reaching for `open` there must reach for the helper, not for the expression.
    const mustNotRederive = [...callSites, "src/shelf/safeWorktreeWrite.ts"];

    it("route through the helper instead of re-deriving the flag", async () => {
        // A ratchet, not a style check. The defect existed in three places at once because the
        // expression is short enough to copy, and each copy was individually plausible. Re-deriving
        // it anywhere reintroduces the Windows EINVAL in exactly one code path, which is the kind
        // of partial regression a platform-specific bug hides best.
        for (const relativePath of mustNotRederive) {
            const source = await readFile(path.join(repositoryRoot, relativePath), "utf8");
            expect(source, `${relativePath} must not re-derive the flag`).not.toContain(
                "constants.O_NOFOLLOW",
            );
        }
        for (const relativePath of callSites) {
            const source = await readFile(path.join(repositoryRoot, relativePath), "utf8");
            expect(source, `${relativePath} must use the helper`).toContain("resolveNoFollowFlag");
        }
    });
});
