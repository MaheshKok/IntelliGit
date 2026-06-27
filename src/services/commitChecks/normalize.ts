// Host-agnostic mappers shared by every commit-check provider. Each provider fetches
// its own JSON and maps rows into `CommitCheckItem`s, then reuses these pure helpers
// to filter CI/CD checks, aggregate a single badge state, and summarize the result.
// No provider-specific logic and no network access live here.

import * as vscode from "vscode";
import type { CommitCheckItem, CommitChecksSnapshot, CommitCheckState } from "../../types";

/** Matches check names that represent CI/CD pipeline work worth showing as a badge. */
const CICD_CHECK_PATTERN =
    /\b(ci|cd|build|release|deploy|deployment|test|tests|lint|typecheck|coverage|security|secret|secrets|scan|codeql|guard|package|publish|workflow|actions?)\b/i;
/** Matches code-review bots that should be excluded from the CI/CD badge. */
const REVIEW_CHECK_PATTERN = /\b(code\s*review|coderabbit|reviewdog|qodo)\b/i;

/**
 * Keeps CI/CD checks while excluding code-review bot rows.
 *
 * The include pattern is overridable so a user-supplied `commitChecks.ciCdFilter` can
 * widen or narrow which rows count as CI/CD. The review-bot exclusion is unconditional:
 * a row matching `REVIEW_CHECK_PATTERN` is dropped regardless of the include pattern, so
 * a custom filter can never resurface a code-review bot into the CI/CD badge.
 *
 * @param item - The check row to test (name and description are matched).
 * @param pattern - Include pattern for CI/CD names; defaults to the built-in pattern.
 * @returns True when the row is a CI/CD check and not a code-review bot.
 */
export function isCiCdCheckItem(
    item: CommitCheckItem,
    pattern: RegExp = CICD_CHECK_PATTERN,
): boolean {
    const text = `${item.name} ${item.description}`;
    return pattern.test(text) && !REVIEW_CHECK_PATTERN.test(text);
}

/** Reduces per-check states into one badge state, failing closed on any failure-like state. */
export function aggregateState(items: CommitCheckItem[]): CommitCheckState {
    if (items.length === 0) return "none";
    const states = items.map((item) => item.state);
    if (states.some((state) => ["failure", "timed_out", "action_required"].includes(state))) {
        return "failure";
    }
    if (states.includes("pending")) return "pending";
    if (states.every((state) => state === "success")) return "success";
    if (states.every((state) => ["skipped", "neutral", "cancelled"].includes(state))) {
        return "skipped";
    }
    if (states.includes("unknown")) return "unknown";
    return "success";
}

/** Localized one-line summary for a badge state. */
export function summaryForState(state: CommitCheckState): string {
    switch (state) {
        case "success":
            return vscode.l10n.t("All checks passed");
        case "failure":
            return vscode.l10n.t("Checks failed");
        case "pending":
            return vscode.l10n.t("Checks pending");
        case "skipped":
            return vscode.l10n.t("Checks skipped");
        case "none":
            return vscode.l10n.t("No checks found");
        case "unavailable":
            return vscode.l10n.t("Checks unavailable");
        default:
            return vscode.l10n.t("Checks completed");
    }
}

/** Prefers a meaningful skipped-check description over the generic success summary. */
export function summaryForItems(items: CommitCheckItem[], state: CommitCheckState): string {
    if (state === "success") {
        const skippedItem = items.find(
            (item) =>
                ["skipped", "neutral", "cancelled"].includes(item.state) &&
                item.description &&
                item.description.toLowerCase() !== "completed",
        );
        if (skippedItem?.description) return skippedItem.description;
    }
    return summaryForState(state);
}

/**
 * Removes every literal occurrence of a secret from an error message.
 *
 * The shared `getErrorMessage` helper only strips credentials embedded in URLs
 * (`https://token@host`); it cannot know a provider's stored access token. A
 * transport, proxy, or SDK error may echo a request header verbatim, so any
 * error text bound for a snapshot must have the token redacted here first.
 *
 * @param message - The already display-safe error message.
 * @param secret - The access token to remove; empty values are a no-op.
 * @returns The message with the secret replaced by `***`.
 */
export function redactSecret(message: string, secret: string): string {
    if (!secret) return message;
    return message.split(secret).join("***");
}

/**
 * Builds the terminal snapshot shown when checks cannot be retrieved.
 *
 * @param hash - The commit hash the snapshot describes.
 * @param error - The display-safe (token-redacted) error message.
 * @param signInHost - The host to sign into, set only when a missing/rejected token is
 *   the cause so the popover can offer a "Sign in" button; a blank value is treated as
 *   no host. Omit for generic network/HTTP errors.
 * @returns An immutable `unavailable` snapshot, with `signInHost` set only when actionable.
 */
export function unavailableSnapshot(
    hash: string,
    error: string,
    signInHost?: string,
): CommitChecksSnapshot {
    return {
        hash,
        state: "unavailable",
        summary: summaryForState("unavailable"),
        items: [],
        error,
        signInHost: signInHost || undefined,
    };
}

/** Trims a value to a string, returning "" for non-strings. */
export function readString(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

/** Collapses internal whitespace runs into single spaces. */
export function compactText(value: string): string {
    return value.replace(/\s+/g, " ").trim();
}
