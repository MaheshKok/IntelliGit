const FULL_OBJECT_ID = /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/;

/** Reports whether a value is a complete SHA-1 or SHA-256 object ID in either hexadecimal case. */
function isFullObjectId(value: unknown): value is string {
    return typeof value === "string" && FULL_OBJECT_ID.test(value);
}

/** Reports whether a value is a complete lower-case object ID safe for Git argv construction. */
export function isLowerCaseFullObjectId(value: unknown): value is string {
    return isFullObjectId(value) && value === value.toLowerCase();
}

/** Normalizes a complete case-insensitive object ID at a trusted input boundary. */
export function normalizeFullObjectId(value: unknown): string | undefined {
    return isFullObjectId(value) ? value.toLowerCase() : undefined;
}
