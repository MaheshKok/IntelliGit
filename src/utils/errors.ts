// Shared error handling utilities used by extension host and view providers.

/**
 * Convert any thrown value into a display-safe message for UI notifications and logs.
 * Credential-bearing remote URLs are sanitized before the message leaves this helper.
 */
export function getErrorMessage(error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error);
    return sanitizeErrorMessage(raw);
}

/**
 * Strip embedded credentials from URLs in error messages.
 * Git error output may contain remote URLs with user-info patterns:
 *
 * ```text
 * https://user:password\@host  (user + password)
 * https://token\@host          (token-only, e.g. GitHub PAT)
 * https://user:\@host          (empty password)
 * ```
 */
export function sanitizeErrorMessage(message: string): string {
    // Match any user-info portion: user:pass@, token@, user:@
    return message.replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/g, "$1***@");
}

/**
 * Detect git failures that mean `git rm` was asked to remove an untracked or missing path.
 * Callers use this to fall back to workspace filesystem deletion without masking other git errors.
 */
export function isUntrackedPathspecError(error: unknown): boolean {
    const message = getErrorMessage(error).toLowerCase();
    const rawCode =
        typeof error === "object" && error !== null && "code" in error
            ? (error as { code?: unknown }).code
            : undefined;
    const code = typeof rawCode === "string" ? rawCode.toLowerCase() : "";

    return (
        message.includes("did not match any files") ||
        (message.includes("pathspec") && message.includes("did not match")) ||
        code === "enoent"
    );
}

/**
 * Detect git's protected branch deletion failure for branches that are not fully merged.
 * The check intentionally works on sanitized message text so credential redaction stays centralized.
 */
export function isBranchNotFullyMergedError(error: unknown): boolean {
    return getErrorMessage(error).toLowerCase().includes("is not fully merged");
}
