import { describe, expect, it } from "vitest";
import {
    githubBlobUrl,
    githubCompareUrl,
    githubGistUrl,
    githubIdentityFromRemote,
    githubIdentityFromName,
} from "../../../src/git/githubUrls";

describe("GitHub URL boundaries", () => {
    it("accepts public GitHub Git remotes and canonicalizes the identity", () => {
        for (const remote of [
            "https://github.com/owner/repo.git",
            "https://github.com/owner/repo.git/",
            "git@github.com:owner/repo.git",
            "git@GitHub.com:owner/repo.git",
            "ssh://git@github.com/owner/repo.git",
            "git://github.com/owner/repo.git",
        ]) {
            expect(githubIdentityFromRemote(remote)).toEqual({ owner: "owner", repo: "repo" });
        }
    });

    it("canonicalizes one trailing HTTPS slash without accepting extra path segments", () => {
        expect(githubIdentityFromRemote("https://github.com/owner/repo/")).toEqual({
            owner: "owner",
            repo: "repo",
        });
        expect(githubIdentityFromRemote("https://github.com/owner/repo//")).toBeNull();
    });

    it("rejects credential-bearing, lookalike, and malformed remotes", () => {
        for (const remote of [
            "https://token@github.com/owner/repo.git",
            "https://github.com.evil.test/owner/repo.git",
            "http://github.com/owner/repo.git",
            "https://github.com/owner/repo/extra",
            "https://github.com/owner/repo?redirect=evil",
            "git@github.com.evil.test:owner/repo.git",
            "file:///owner/repo.git",
            "https://github.com/../repo.git",
        ]) {
            expect(githubIdentityFromRemote(remote), remote).toBeNull();
        }
        expect(githubIdentityFromName("owner/repo/extra")).toBeNull();
        expect(githubIdentityFromName("owner/repo.git")).toEqual({
            owner: "owner",
            repo: "repo.git",
        });
    });

    it("encodes branch and file data without altering GitHub URL structure", () => {
        const identity = { owner: "owner", repo: "repo" };
        expect(githubCompareUrl(identity, "feature/foo")).toBe(
            "https://github.com/owner/repo/compare/feature%2Ffoo?expand=1",
        );
        expect(githubBlobUrl(identity, "a".repeat(40), "dir/sp ace#%?.é", "L2-L4")).toBe(
            `https://github.com/owner/repo/blob/${"a".repeat(40)}/dir/sp%20ace%23%25%3F.%C3%A9#L2-L4`,
        );
    });

    it("accepts only a canonical public GitHub Gist destination", () => {
        expect(githubGistUrl("https://gist.github.com/owner/" + "a".repeat(32))).toBe(
            "https://gist.github.com/owner/" + "a".repeat(32),
        );
        expect(
            githubGistUrl("https://gist.github.com.evil.test/owner/" + "a".repeat(32)),
        ).toBeNull();
        expect(githubGistUrl("https://secret@gist.github.com/owner/" + "a".repeat(32))).toBeNull();
    });
});
