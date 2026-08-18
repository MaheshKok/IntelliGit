// Spec-derived tests for the E2E control channel's secret digest: "Secrets are reported as
// presence + digest, never as values" (PLAN.md Phase 1 step 10). digestSecret must be
// deterministic for a fixed salt, salt-dependent (so a digest from one process run cannot be
// compared against a digest from another), and must never expose the raw value through its
// own output.

import { describe, expect, it } from "vitest";
import { digestSecret, generateSecretDigestSalt } from "../../../src/e2e/secretDigest";

describe("digestSecret", () => {
    it("is deterministic for the same value and salt", () => {
        expect(digestSecret("glpat-abc123", "salt-a")).toBe(digestSecret("glpat-abc123", "salt-a"));
    });

    it("produces a 64-character lowercase hex string (SHA-256 digest length)", () => {
        const digest = digestSecret("glpat-abc123", "salt-a");
        expect(digest).toMatch(/^[0-9a-f]{64}$/);
    });

    it("never contains the raw value as a substring", () => {
        const secret = "glpat-SUPERSECRET";
        const digest = digestSecret(secret, "salt-a");
        expect(digest).not.toContain(secret);
        expect(digest.toLowerCase()).not.toContain(secret.toLowerCase());
    });

    it("differs across different salts for the same value", () => {
        // Proves the digest is not a bare hash: without the salt, an attacker who captured a
        // digest from one process run could dictionary-attack a low-entropy test token.
        expect(digestSecret("glpat-abc123", "salt-a")).not.toBe(
            digestSecret("glpat-abc123", "salt-b"),
        );
    });

    it("differs across different values for the same salt", () => {
        expect(digestSecret("value-one", "salt-a")).not.toBe(digestSecret("value-two", "salt-a"));
    });

    it("differs for values that share a common prefix (no length-extension leakage)", () => {
        expect(digestSecret("glpat-abc", "salt-a")).not.toBe(
            digestSecret("glpat-abc123", "salt-a"),
        );
    });
});

describe("generateSecretDigestSalt", () => {
    it("returns a non-empty hex string", () => {
        const salt = generateSecretDigestSalt();
        expect(salt).toMatch(/^[0-9a-f]+$/);
        expect(salt.length).toBeGreaterThanOrEqual(32);
    });

    it("returns a different salt on every call", () => {
        const salts = new Set(Array.from({ length: 20 }, () => generateSecretDigestSalt()));
        expect(salts.size).toBe(20);
    });
});
