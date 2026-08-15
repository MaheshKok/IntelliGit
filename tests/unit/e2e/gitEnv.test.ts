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

import { afterEach, describe, expect, it } from "vitest";
import { sanitizedGitEnv } from "../../e2e/oracles/gitEnv";

/** Names this file writes into `process.env`, removed again after every test so a leaked
 * variable cannot silently satisfy a later assertion (or escape into the rest of the suite). */
const TOUCHED: string[] = [];

function setEnv(name: string, value: string): void {
    TOUCHED.push(name);
    process.env[name] = value;
}

afterEach(() => {
    for (const name of TOUCHED.splice(0)) delete process.env[name];
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
        expect(
            Object.keys(result).filter((name) => name.toUpperCase().startsWith("GIT_")),
        ).toEqual([]);
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
