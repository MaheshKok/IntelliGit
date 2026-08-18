/**
 * Guards `sanitizedGitEnv` against leaking an ambient repository pointer into an oracle.
 *
 * The failure this protects against is silent by construction: a leaked `GIT_DIR` aims the
 * oracle at a different repository, where `git` still returns well-formed object IDs and the
 * assertion still passes -- while measuring nothing the flow did.
 *
 * These deliberately do NOT stub `process.platform`. `sanitizedGitEnv` has no platform branch,
 * so a win32-stubbed test would assert the same code path under a different label and prove
 * nothing extra. What makes the lowercase case Windows-specific is the *host*, not the function:
 * Windows environment variable names are case-insensitive, so `git_dir` there IS `GIT_DIR` to
 * git, while `Object.entries(process.env)` still reports the lowercase spelling. Asserting the
 * real behaviour -- lowercase names are dropped -- is what catches it on every platform.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sanitizedGitEnv } from "../../e2e/oracles/gitEnv";

/**
 * Names this file writes into `process.env`, each mapped to whatever was there beforehand.
 *
 * Restoring the previous value rather than deleting matters because the names under test are
 * exactly the ones a developer shell is likely to already export: a run in a shell that has
 * `GIT_DIR` set would otherwise delete it out from under every later test in the process. A
 * name that was genuinely absent records `undefined` and is deleted again, so cleanup never
 * invents a variable either.
 *
 * Only the FIRST write for a name is recorded, so a test that sets the same name twice still
 * restores the ambient value rather than its own intermediate one.
 */
const ORIGINAL = new Map<string, string | undefined>();

function setEnv(name: string, value: string): void {
    if (!ORIGINAL.has(name)) ORIGINAL.set(name, process.env[name]);
    process.env[name] = value;
}

afterEach(() => {
    for (const [name, original] of ORIGINAL) {
        if (original === undefined) delete process.env[name];
        else process.env[name] = original;
    }
    ORIGINAL.clear();
});

describe("sanitizedGitEnv drops every inherited git pointer", () => {
    it("drops an upper-case GIT_DIR", () => {
        setEnv("GIT_DIR", "/somewhere/else/.git");
        expect(sanitizedGitEnv()).not.toHaveProperty("GIT_DIR");
    });

    // The regression. On Windows this name is the same variable as GIT_DIR.
    it("drops a lower-case git_dir", () => {
        setEnv("git_dir", "/somewhere/else/.git");
        const result = sanitizedGitEnv();
        expect(
            Object.keys(result).filter((name) => name.toUpperCase() === "GIT_DIR"),
            "a lower-case git_dir survives the filter and redirects git on Windows, where " +
                "environment variable names are case-insensitive",
        ).toEqual([]);
    });

    it("drops a mixed-case Git_Work_Tree", () => {
        setEnv("Git_Work_Tree", "/somewhere/else");
        const result = sanitizedGitEnv();
        expect(Object.keys(result).filter((name) => name.toUpperCase().startsWith("GIT_"))).toEqual(
            [],
        );
    });

    // The other direction: a filter widened to `includes("GIT_")` would pass every test above
    // while silently stripping unrelated variables out of the child's environment.
    it("keeps names that merely contain git_ without starting with it", () => {
        setEnv("LEGIT_DIRECTORY", "keep-me");
        setEnv("MY_GIT_DIR", "keep-me-too");
        const result = sanitizedGitEnv();
        expect(result.LEGIT_DIRECTORY).toBe("keep-me");
        expect(result.MY_GIT_DIR).toBe("keep-me-too");
    });

    it("keeps ordinary inherited variables", () => {
        setEnv("INTELLIGIT_FIXTURE_MARKER", "present");
        expect(sanitizedGitEnv().INTELLIGIT_FIXTURE_MARKER).toBe("present");
    });

    it("puts the fixture's own overlay back, including its GIT_ names", () => {
        setEnv("GIT_DIR", "/ambient/.git");
        const result = sanitizedGitEnv({ GIT_DIR: "/fixture/.git", GIT_AUTHOR_NAME: "Fixture" });
        expect(result.GIT_DIR).toBe("/fixture/.git");
        expect(result.GIT_AUTHOR_NAME).toBe("Fixture");
    });

    it("lets the overlay win over an inherited non-git variable", () => {
        setEnv("INTELLIGIT_FIXTURE_MARKER", "ambient");
        expect(sanitizedGitEnv({ INTELLIGIT_FIXTURE_MARKER: "overlay" })).toHaveProperty(
            "INTELLIGIT_FIXTURE_MARKER",
            "overlay",
        );
    });
});

/**
 * Guards the harness above rather than the function under test.
 *
 * These tests overwrite the exact variable names a developer shell is most likely to already
 * export, so a cleanup that deletes instead of restoring would silently strip the ambient
 * environment for every test that runs after this file's first case. The damage is invisible
 * from inside the test that causes it -- it only shows up later -- which is why the check has
 * to span two cases.
 */
describe("the harness restores the environment it borrowed", () => {
    const AMBIENT = "/ambient/repo/.git";

    // Set outside `setEnv`, so only the afterEach restore can bring it back.
    beforeAll(() => {
        process.env.GIT_DIR = AMBIENT;
    });
    afterAll(() => {
        delete process.env.GIT_DIR;
    });

    it("overwrites an ambient GIT_DIR while a test is running", () => {
        setEnv("GIT_DIR", "/somewhere/else/.git");
        expect(process.env.GIT_DIR).toBe("/somewhere/else/.git");
        expect(sanitizedGitEnv()).not.toHaveProperty("GIT_DIR");
    });

    it("has put the ambient GIT_DIR back by the next test", () => {
        expect(
            process.env.GIT_DIR,
            "cleanup deleted a variable the surrounding environment owned instead of restoring it",
        ).toBe(AMBIENT);
    });

    // The first-write guard: a second write must not overwrite the recorded ambient value with
    // the test's own intermediate one, or cleanup restores something the test invented.
    it("overwrites the ambient GIT_DIR twice within one test", () => {
        setEnv("GIT_DIR", "/first/.git");
        setEnv("GIT_DIR", "/second/.git");
        expect(process.env.GIT_DIR).toBe("/second/.git");
    });

    it("restores the ambient value rather than the intermediate one", () => {
        expect(
            process.env.GIT_DIR,
            "cleanup restored a value the test itself wrote instead of the ambient one",
        ).toBe(AMBIENT);
    });

    it("still deletes a name that was absent before the test set it", () => {
        expect(process.env.INTELLIGIT_ABSENT_MARKER).toBeUndefined();
        setEnv("INTELLIGIT_ABSENT_MARKER", "temporary");
        expect(process.env.INTELLIGIT_ABSENT_MARKER).toBe("temporary");
    });

    it("has removed the previously absent name again", () => {
        expect(
            process.env.INTELLIGIT_ABSENT_MARKER,
            "cleanup invented a variable that was not there before",
        ).toBeUndefined();
    });
});
