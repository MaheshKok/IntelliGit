/**
 * Spec-derived tests for `tests/fixtures/repo/copyTemplate.ts` (PLAN.md Phase 1 step 8, the
 * copy-and-inventory slice). Every scenario below is checked against the real filesystem -- real
 * symlinks, real hardlinks, a real case-only rename -- never by trusting `copyTemplate`'s own
 * return value alone, because a harness bug here is exactly the "one test's mutation corrupts
 * every other" failure mode PLAN.md step 8 exists to prevent (Codex R3 #5, #6).
 *
 * The governing principle carried over from `snapshotObjectStore.test.ts`: every oracle here must
 * be provably able to fail. Where a check is exposed as its own function (`assertNoSharedInodes`),
 * it is also exercised directly with deliberately bad input, mirroring
 * `assertAlternatesContained`'s "THROWS -- the deliberate break" convention already established in
 * this package.
 */

import {
    link,
    mkdir,
    mkdtemp,
    readFile,
    readlink,
    realpath,
    rename,
    symlink,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
    assertNoSharedInodes,
    sharesStorage,
    type FileIdentity,
} from "../../fixtures/repo/copyInodeGuard";
import { copyTemplate } from "../../fixtures/repo/copyTemplate";
import { inventoryDirectory } from "../../fixtures/repo/fsInventory";
import { seedFixtureTemplate } from "../../fixtures/repo/seed";
import type { FsEntry } from "../../fixtures/repo/snapshotTypes";
import { removeScratchDirectories } from "../../helpers/scratchDirectories";

describe("copyTemplate", () => {
    let cleanupDirs: string[] = [];

    afterEach(async () => {
        await Promise.all(cleanupDirs.map((dir) => removeScratchDirectories(dir)));
        cleanupDirs = [];
    });

    /** A fresh `source`/`destination` pair under one throwaway work directory, tracked for cleanup. */
    async function makeWorkspace(
        prefix: string,
    ): Promise<{ readonly source: string; readonly destination: string }> {
        const workDir = await mkdtemp(path.join(tmpdir(), `intelligit-copytemplate-${prefix}-`));
        cleanupDirs.push(workDir);
        const source = path.join(workDir, "source");
        const destination = path.join(workDir, "destination");
        await mkdir(source, { recursive: true });
        return { source, destination };
    }

    function findEntry(entries: readonly FsEntry[], relativePath: string): FsEntry | undefined {
        return entries.find((entry) => entry.relativePath === relativePath);
    }

    describe("copying a real seeded template", () => {
        it("copies a seeded fixture template wholesale and returns a non-empty inventory of the copy", async () => {
            const workDir = await mkdtemp(path.join(tmpdir(), "intelligit-copytemplate-seeded-"));
            cleanupDirs.push(workDir);
            const templateDir = path.join(workDir, "template");
            const destination = path.join(workDir, "destination");

            const template = await seedFixtureTemplate(templateDir);
            cleanupDirs.push(template.home);

            const { inventory } = await copyTemplate(templateDir, destination);

            expect(inventory.length).toBeGreaterThan(0);
            expect(findEntry(inventory, "workspace/README.md")).toBeDefined();
            expect(findEntry(inventory, "workspace/.git")).toBeDefined();
            expect(findEntry(inventory, "origin.git/HEAD")).toBeDefined();

            const copiedReadme = await readFile(
                path.join(destination, "workspace", "README.md"),
                "utf8",
            );
            expect(copiedReadme).toBe("# IntelliGit Fixture Repo\n");
        });
    });

    describe("symlink containment", () => {
        it("rejects a copied symlink whose relative target escapes the copy, at copy time", async () => {
            const { source, destination } = await makeWorkspace("escape");
            await mkdir(path.join(source, "nested"), { recursive: true });
            await writeFile(path.join(source, "nested", "file.txt"), "irrelevant\n");
            // Escapes upward past the source root once resolved from its new location under `destination`.
            await symlink("../../outside/secret.txt", path.join(source, "nested", "escape-link"));

            await expect(copyTemplate(source, destination)).rejects.toThrow(/escapes the copy/);
        });

        it("rejects a copied symlink whose absolute target points outside the template entirely", async () => {
            const { source, destination } = await makeWorkspace("abs-outside");
            await writeFile(path.join(source, "file.txt"), "irrelevant\n");
            // An absolute path that is valid but shares no prefix with `source` at all.
            const outsideTarget = path.join(tmpdir(), "definitely-not-the-template", "secret.txt");
            await symlink(outsideTarget, path.join(source, "abs-outside-link"));

            await expect(copyTemplate(source, destination)).rejects.toThrow(
                /absolute target outside the template/,
            );
        });

        it("rebases a template-contained absolute symlink target onto the copy, resolving inside it", async () => {
            const { source, destination } = await makeWorkspace("rebase");
            await mkdir(path.join(source, "data"), { recursive: true });
            await writeFile(path.join(source, "data", "real.txt"), "hello\n");
            await symlink(path.join(source, "data", "real.txt"), path.join(source, "abs-link"));

            await copyTemplate(source, destination);

            const linkTarget = await readlink(path.join(destination, "abs-link"));
            expect(linkTarget.startsWith(destination)).toBe(true);
            expect(linkTarget.startsWith(source)).toBe(false);

            // `realpath` also resolves the OS temp directory's own symlinks (e.g. macOS's
            // `/var` -> `/private/var`), so the comparison must realpath `destination` too --
            // otherwise this assertion would fail on a correct implementation, for a reason that
            // has nothing to do with symlink containment.
            const resolved = await realpath(path.join(destination, "abs-link"));
            const realDestination = await realpath(destination);
            expect(resolved.startsWith(realDestination)).toBe(true);
            expect(await readFile(resolved, "utf8")).toBe("hello\n");
        });

        it("THE TEETH TEST: writing through a rebased copied symlink never touches the template", async () => {
            const { source, destination } = await makeWorkspace("teeth");
            await mkdir(path.join(source, "data"), { recursive: true });
            await writeFile(path.join(source, "data", "real.txt"), "original\n");
            await symlink(path.join(source, "data", "real.txt"), path.join(source, "abs-link"));

            await copyTemplate(source, destination);

            // Write through the copied link -- this is the exact defect class PLAN.md's Codex R3 #6
            // exists to close: without the rebase above, this write would land in the template.
            await writeFile(path.join(destination, "abs-link"), "mutated by a test\n");

            const templateContent = await readFile(path.join(source, "data", "real.txt"), "utf8");
            expect(templateContent).toBe("original\n");

            const copyContent = await readFile(path.join(destination, "data", "real.txt"), "utf8");
            expect(copyContent).toBe("mutated by a test\n");
        });

        it("records a symlink's literal, unresolved target text -- verbatimSymlinks/dereference:false took effect", async () => {
            const { source, destination } = await makeWorkspace("verbatim");
            await mkdir(path.join(source, "data"), { recursive: true });
            await writeFile(path.join(source, "data", "real.txt"), "hello\n");
            await symlink("data/real.txt", path.join(source, "rel-link"));

            const { inventory } = await copyTemplate(source, destination);

            const linkEntry = findEntry(inventory, "rel-link");
            expect(linkEntry).toBeDefined();
            expect(linkEntry?.type).toBe("symlink");
            // The literal text, unresolved -- a dereferenced or path-resolved copy would report
            // something other than the exact relative string this symlink was created with.
            // Forward slashes on every platform: `inventoryDirectory` normalizes the `readlink`
            // result, so this literal is the portable spelling rather than the host's.
            expect(linkEntry?.symlinkTarget).toBe("data/real.txt");
        });
    });

    describe("inode isolation", () => {
        it("shares no inode between any regular file in the copy and the template", async () => {
            const { source, destination } = await makeWorkspace("inodes");
            await mkdir(path.join(source, "nested"), { recursive: true });
            await writeFile(path.join(source, "top.txt"), "top\n");
            await writeFile(path.join(source, "nested", "deep.txt"), "deep\n");

            const { inventory } = await copyTemplate(source, destination);

            // Re-derives what `assertNoSharedInodes` already asserted internally, using evidence
            // this test generated itself rather than trusting `copyTemplate`'s internals (Gate 4).
            await expect(
                assertNoSharedInodes(source, destination, inventory),
            ).resolves.not.toThrow();
        });

        it("THROWS when a copy shares an inode with the template -- the deliberate break", async () => {
            const { source, destination } = await makeWorkspace("hardlink");
            await mkdir(destination, { recursive: true });
            await writeFile(path.join(source, "shared.txt"), "hello\n");
            // Deliberately hardlinks instead of copying content -- exactly the defect
            // `assertNoSharedInodes` exists to catch, planted directly rather than by breaking a
            // real copier.
            await link(path.join(source, "shared.txt"), path.join(destination, "shared.txt"));

            const entries: readonly FsEntry[] = [
                {
                    relativePath: "shared.txt",
                    type: "file",
                    mode: 0o644,
                    digest: null,
                    text: null,
                    symlinkTarget: null,
                },
            ];

            await expect(assertNoSharedInodes(source, destination, entries)).rejects.toThrow(
                /shares an inode with the template/,
            );
        });

        // `fs.cp` has no mechanism that can produce a hardlink -- it copies through the platform's
        // own file-copy call -- so when this guard fired on `windows-latest` for exactly one loose
        // Git object (`origin.git/objects/72/44a2...`, run 32772636554), the pair it condemned
        // could not have been linked. Four earlier Windows runs of the same test were green: what
        // `lstat` reports for `dev`/`ino` there is not, on its own, stable enough to identify a
        // file, and the guard read a match into it.
        //
        // A second name is what a hardlink IS, and `nlink` is reported independently of the ids.
        // The failing values cannot be manufactured by creating files -- an unlinked pair on a
        // healthy filesystem never reports matching ids -- so the decision is asserted directly
        // rather than through a copy the host would have to cooperate in breaking.
        it("needs a second name, not just matching ids, before calling a pair linked", () => {
            const cases: readonly {
                readonly what: string;
                readonly source: FileIdentity;
                readonly destination: FileIdentity;
                readonly shared: boolean;
            }[] = [
                {
                    what: "a real hardlink: matching ids, and both sides admit a second name",
                    source: { dev: 16_777_232, ino: 4_211_009, nlink: 2 },
                    destination: { dev: 16_777_232, ino: 4_211_009, nlink: 2 },
                    shared: true,
                },
                {
                    what: "ids the platform declined to fill in -- two separate files, both zero",
                    source: { dev: 0, ino: 0, nlink: 1 },
                    destination: { dev: 0, ino: 0, nlink: 1 },
                    shared: false,
                },
                {
                    what: "plausible matching ids, but each file has exactly one name",
                    source: { dev: 16_777_232, ino: 4_211_009, nlink: 1 },
                    destination: { dev: 16_777_232, ino: 4_211_009, nlink: 1 },
                    shared: false,
                },
                {
                    what: "link counts that disagree cannot both describe one file",
                    source: { dev: 16_777_232, ino: 4_211_009, nlink: 2 },
                    destination: { dev: 16_777_232, ino: 4_211_009, nlink: 1 },
                    shared: false,
                },
                {
                    what: "distinct inodes on one device are distinct files",
                    source: { dev: 16_777_232, ino: 4_211_009, nlink: 2 },
                    destination: { dev: 16_777_232, ino: 4_211_010, nlink: 2 },
                    shared: false,
                },
                {
                    what: "one inode number on two devices is a coincidence, not a link",
                    source: { dev: 16_777_232, ino: 4_211_009, nlink: 2 },
                    destination: { dev: 16_777_233, ino: 4_211_009, nlink: 2 },
                    shared: false,
                },
            ];

            for (const testCase of cases) {
                expect(sharesStorage(testCase.source, testCase.destination), testCase.what).toBe(
                    testCase.shared,
                );
            }
        });
    });

    describe("case sensitivity", () => {
        it("records an exact-case relative path and detects a later case-only rename as a real difference", async () => {
            const { source, destination } = await makeWorkspace("case");
            await writeFile(path.join(source, "MixedCase.txt"), "content\n");

            const { inventory } = await copyTemplate(source, destination);

            expect(findEntry(inventory, "MixedCase.txt")).toBeDefined();
            expect(findEntry(inventory, "mixedcase.txt")).toBeUndefined();

            // Case-only rename, performed directly on the copy -- confirmed empirically on this
            // filesystem to change the recorded case without an intermediate name.
            await rename(
                path.join(destination, "MixedCase.txt"),
                path.join(destination, "mixedcase.txt"),
            );

            const renamedInventory = await inventoryDirectory({ root: destination });
            expect(findEntry(renamedInventory, "mixedcase.txt")).toBeDefined();
            expect(findEntry(renamedInventory, "MixedCase.txt")).toBeUndefined();

            // The two inventories' path sets must genuinely differ -- a case-insensitive
            // comparison would have called these equal, which is exactly the false-green this
            // oracle exists to prevent.
            const before = inventory.map((entry) => entry.relativePath).sort();
            const after = renamedInventory.map((entry) => entry.relativePath).sort();
            expect(after).not.toEqual(before);
        });
    });
});
