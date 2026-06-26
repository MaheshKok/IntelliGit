// Spec-derived tests for normalizeHostMap. Cases are written from the documented
// contract — validate a host→provider-id object at the config trust boundary, drop
// invalid entries, lowercase/trim host keys, and return an empty map for malformed
// input — not by mirroring the implementation. No VS Code or I/O is involved.

import { describe, expect, it } from "vitest";
import { normalizeHostMap } from "../../../../src/services/commitChecks/hostConfig";

describe("normalizeHostMap — malformed input", () => {
    it("returns an empty map for null", () => {
        expect(normalizeHostMap(null)).toEqual({});
    });

    it("returns an empty map for undefined", () => {
        expect(normalizeHostMap(undefined)).toEqual({});
    });

    it("returns an empty map for an array", () => {
        // Arrays are objects, but a config value of array shape is malformed and must
        // not be treated as host entries (Object.entries would yield numeric keys).
        expect(normalizeHostMap(["gitlab"])).toEqual({});
    });

    it("returns an empty map for a string", () => {
        expect(normalizeHostMap("git.acme.com")).toEqual({});
    });

    it("returns an empty map for a number", () => {
        expect(normalizeHostMap(42)).toEqual({});
    });

    it("returns an empty map for an empty object", () => {
        expect(normalizeHostMap({})).toEqual({});
    });
});

describe("normalizeHostMap — valid entries", () => {
    it("keeps a single gitlab entry", () => {
        expect(normalizeHostMap({ "git.acme.com": "gitlab" })).toEqual({
            "git.acme.com": "gitlab",
        });
    });

    it("keeps self-hosted provider ids and drops the fixed-host SaaS ones", () => {
        // gitlab and bitbucket-server are self-hosted (host config is meaningful); github
        // and bitbucket-cloud are SaaS with fixed hosts, so mapping a host to them is
        // dropped as meaningless.
        expect(
            normalizeHostMap({
                "a.example.com": "github",
                "b.example.com": "gitlab",
                "c.example.com": "bitbucket-cloud",
                "d.example.com": "bitbucket-server",
            }),
        ).toEqual({
            "b.example.com": "gitlab",
            "d.example.com": "bitbucket-server",
        });
    });

    it("keeps a bitbucket-server entry with normalized case and whitespace", () => {
        expect(normalizeHostMap({ "BB.acme.com": "  Bitbucket-Server " })).toEqual({
            "bb.acme.com": "bitbucket-server",
        });
    });

    it("lowercases host keys", () => {
        expect(normalizeHostMap({ "Git.ACME.com": "gitlab" })).toEqual({
            "git.acme.com": "gitlab",
        });
    });

    it("trims surrounding whitespace from host keys", () => {
        expect(normalizeHostMap({ "  git.acme.com  ": "gitlab" })).toEqual({
            "git.acme.com": "gitlab",
        });
    });

    it("normalizes a provider id with different case or whitespace", () => {
        expect(normalizeHostMap({ "git.acme.com": "  GitLab " })).toEqual({
            "git.acme.com": "gitlab",
        });
    });
});

describe("normalizeHostMap — invalid entries are dropped", () => {
    it("drops an unknown provider id", () => {
        expect(normalizeHostMap({ "git.acme.com": "gitbucket" })).toEqual({});
    });

    it("drops an entry whose value is not a string", () => {
        const raw = {
            "a.example.com": 1 as unknown,
            "b.example.com": null as unknown,
            "c.example.com": { id: "gitlab" } as unknown,
        };
        expect(normalizeHostMap(raw)).toEqual({});
    });

    it("drops a blank host key", () => {
        expect(normalizeHostMap({ "": "gitlab", "   ": "gitlab" })).toEqual({});
    });

    it("keeps valid entries and drops invalid ones in a mixed map", () => {
        const raw = {
            "good.example.com": "gitlab",
            "bad.example.com": "not-a-provider",
            "blank-value.example.com": "",
        };
        expect(normalizeHostMap(raw)).toEqual({ "good.example.com": "gitlab" });
    });

    it("lets the last valid entry win when two hosts collide after lowercasing", () => {
        const raw = {
            "GIT.acme.com": "gitlab",
            "git.acme.com": "gitlab",
        };
        expect(normalizeHostMap(raw)).toEqual({ "git.acme.com": "gitlab" });
    });
});
