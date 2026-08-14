// One-way digesting for E2E secret snapshots. The control channel must never let a raw
// secret value cross the transport (PLAN.md Phase 1 step 10: "Secrets are reported as
// presence + digest, never as values"), so every secret snapshot response carries this
// digest instead of the plaintext.

import { createHmac, randomBytes } from "node:crypto";

/**
 * Computes a salted, one-way digest of a secret value for E2E snapshot reporting. HMAC-SHA256
 * (not a plain hash) is used deliberately: many real E2E test tokens are short and
 * low-entropy, and a plain SHA-256 digest of a low-entropy value is reversible by a
 * dictionary/rainbow-table attack, which would defeat the whole point of not returning the
 * raw value. The salt makes that infeasible even for a guessable token.
 */
export function digestSecret(value: string, salt: string): string {
    return createHmac("sha256", salt).update(value, "utf8").digest("hex");
}

/**
 * Generates a fresh random salt for `digestSecret`. Called once per control-channel
 * activation and held only in memory for the process's lifetime -- it is never persisted or
 * transmitted, so a captured transcript of digests from one run cannot be replayed or
 * compared against digests from a different run.
 */
export function generateSecretDigestSalt(): string {
    return randomBytes(32).toString("hex");
}
