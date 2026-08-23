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
    const callSites = [
        "src/shelf/safeWorktreeWrite.ts",
        "src/shelf/recovery.ts",
        "src/services/shelfConflictSession.ts",
    ];

    it("route through the helper instead of re-deriving the flag", async () => {
        // A ratchet, not a style check. The defect existed in three places at once because the
        // expression is short enough to copy, and each copy was individually plausible. Re-deriving
        // it anywhere reintroduces the Windows EINVAL in exactly one code path, which is the kind
        // of partial regression a platform-specific bug hides best.
        for (const relativePath of callSites) {
            const source = await readFile(path.join(repositoryRoot, relativePath), "utf8");
            expect(source, `${relativePath} must not re-derive the flag`).not.toContain(
                "constants.O_NOFOLLOW",
            );
            expect(source, `${relativePath} must use the helper`).toContain("resolveNoFollowFlag");
        }
    });
});
