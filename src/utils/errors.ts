// Shared error handling utilities used by extension host and view providers.

export function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function isUntrackedPathspecError(error: unknown): boolean {
    const message = getErrorMessage(error).toLowerCase();
    const code =
        typeof error === "object" && error !== null && "code" in error
            ? String((error as { code?: unknown }).code ?? "").toLowerCase()
            : "";

    return (
        message.includes("did not match any files") ||
        (message.includes("pathspec") && message.includes("did not match")) ||
        code === "enoent"
    );
}

export function isBranchNotFullyMergedError(error: unknown): boolean {
    return getErrorMessage(error).toLowerCase().includes("is not fully merged");
}
