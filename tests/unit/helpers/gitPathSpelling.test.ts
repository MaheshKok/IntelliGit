/**
 * Proves `gitSpellingOf` on both platform branches from one macOS run. The Windows separator branch
 * is supplied rather than inherited; the 8.3 short-name half is reproduced through the mechanism it
 * actually depends on -- `fs.realpathSync.native` recovering a canonical on-disk spelling that
 * `fs.realpathSync` does not -- which a case-insensitive filesystem exposes just as well as a
 * Windows one.
 */

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { gitSpellingOf } from "../../helpers/gitPathSpelling";

describe("gitSpellingOf -- separators", () => {
    it("rewrites Node's separators to the ones git emits when the platform separator is a backslash", () => {
        expect(gitSpellingOf("C:\\Users\\runneradmin\\Temp\\ig-abc\\workspace", "\\")).toBe(
            "C:/Users/runneradmin/Temp/ig-abc/workspace",
        );
    });

    it("leaves a POSIX filename containing a literal backslash alone", () => {
        // The ratchet against an unconditional `replace(/\\/g, "/")`: on POSIX a backslash is a
        // legal filename character, so rewriting one names a DIFFERENT directory than the caller
        // asked about -- an assertion that then passes or fails for the wrong reason.
        expect(gitSpellingOf("/tmp/weird\\name", "/")).toBe("/tmp/weird\\name");
    });

    it("defaults to the running platform's separator", () => {
        expect(gitSpellingOf("/tmp/plain")).toBe(gitSpellingOf("/tmp/plain", path.sep));
    });
});

describe("gitSpellingOf -- the canonical on-disk spelling", () => {
    let scratch: string | undefined;

    afterEach(async () => {
        if (scratch) await rm(scratch, { recursive: true, force: true });
        scratch = undefined;
    });

    it("recovers the on-disk spelling when the caller built a differently-cased path", async () => {
        scratch = await mkdtemp(path.join(tmpdir(), "intelligit-git-spelling-"));
        const onDisk = path.join(scratch, "FooBar");
        await mkdir(onDisk, { recursive: true });
        const asked = path.join(scratch, "foobar");

        try {
            realpathSync.native(asked);
        } catch {
            // Case-sensitive filesystem (typically Linux): `foobar` does not exist, so there is no
            // divergence between the two resolvers to prove. The macOS and Windows legs cover it.
            return;
        }
        // Otherwise this proves nothing: it must be the native resolver, and only it, that recovers
        // the on-disk spelling -- exactly as it recovers `runneradmin` from `RUNNER~1` on Windows.
        expect(realpathSync(asked).endsWith("foobar")).toBe(true);

        expect(
            gitSpellingOf(asked, "/").endsWith("FooBar"),
            "git reports the on-disk spelling, so the needle must use it too",
        ).toBe(true);
    });

    it("falls back to the literal spelling for a path that does not exist", () => {
        const missing = path.join(tmpdir(), "intelligit-git-spelling-definitely-absent", "child");

        expect(gitSpellingOf(missing, "/")).toBe(missing);
    });
});
