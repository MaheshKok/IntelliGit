// Host-agnostic mappers shared by every commit-check provider. Each provider fetches
// its own JSON and maps rows into `CommitCheckItem`s, then reuses these pure helpers
// to filter CI/CD checks, aggregate a single badge state, and summarize the result.
// No provider-specific logic and no network access live here.

import * as vscode from "vscode";
import type { CommitCheckItem, CommitChecksSnapshot, CommitCheckState } from "../../types";

/** Matches check names that represent CI/CD pipeline work worth showing as a badge. */
export const CICD_CHECK_PATTERN =
    /\b(ci|cd|build|release|deploy|deployment|test|tests|lint|typecheck|coverage|security|secret|secrets|scan|codeql|guard|package|publish|workflow|actions?)\b/i;
/** Matches code-review bots that should be excluded from the CI/CD badge. */
export const REVIEW_CHECK_PATTERN = /\b(code\s*review|coderabbit|reviewdog|qodo)\b/i;

/** Keeps CI/CD checks while excluding code-review bot rows. */
export function isCiCdCheckItem(item: CommitCheckItem): boolean {
    const text = `${item.name} ${item.description}`;
    return CICD_CHECK_PATTERN.test(text) && !REVIEW_CHECK_PATTERN.test(text);
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

/** Builds the terminal snapshot shown when checks cannot be retrieved. */
export function unavailableSnapshot(hash: string, error: string): CommitChecksSnapshot {
    return {
        hash,
        state: "unavailable",
        summary: summaryForState("unavailable"),
        items: [],
        error,
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
