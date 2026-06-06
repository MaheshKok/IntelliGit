// Shared error handling utilities used by extension host and view providers.

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

export function isBranchNotFullyMergedError(error: unknown): boolean {
    return getErrorMessage(error).toLowerCase().includes("is not fully merged");
}
