import { isValidGitHash } from "../services/gitHelpers";
import { assertRepoRelativePath } from "../utils/fileOps";

function assertStringArray(value: unknown, field: string): string[] {
    if (!Array.isArray(value)) {
        throw new Error(`Expected string[] for '${field}', got ${typeof value}`);
    }
    if (!value.every((item): item is string => typeof item === "string")) {
        throw new Error(`Expected all elements of '${field}' to be strings`);
    }
    return value;
}

/**
 * Validates a webview path array before any panel Git file operation consumes it.
 *
 * Every entry must be a string and must survive repository-relative path validation so a webview
 * payload cannot stage, rollback, or stash files outside the active repository.
 */
export function assertRepoPathArray(value: unknown, field: string): string[] {
    const strings = assertStringArray(value, field);
    return strings.map((s) => assertRepoRelativePath(s));
}

/**
 * Extracts a required string field from an untrusted webview payload without normalizing it.
 *
 * Callers decide whether trimming is appropriate so paths, branch names, and messages keep their
 * intended whitespace until a narrower validator applies its own rules.
 */
export function assertString(value: unknown, field: string): string {
    if (typeof value !== "string") {
        throw new Error(`Expected string for '${field}', got ${typeof value}`);
    }
    return value;
}

/**
 * Accepts the explicit `null` sentinel used by webviews to clear optional string state.
 *
 * Non-null values still pass through the required-string validator so branch filters and similar
 * fields cannot silently coerce arbitrary payloads.
 */
export function assertNullableString(value: unknown, field: string): string | null {
    if (value === null) return null;
    return assertString(value, field);
}

/**
 * Normalizes and validates a commit hash from webview selection or diff messages.
 *
 * The hash is trimmed for UI-originated whitespace, then rejected unless it matches the Git hash
 * policy shared with host-side command handlers.
 */
export function assertGitHash(value: unknown, field: string): string {
    const hash = assertString(value, field).trim();
    if (!isValidGitHash(hash)) {
        throw new Error(`Invalid git hash for '${field}'.`);
    }
    return hash;
}

/**
 * Validates finite numeric fields used for stash indexes and persisted layout dimensions.
 *
 * Rejecting `NaN` and infinities keeps webview-originated state from reaching Git stash commands or
 * being written back into VS Code workspace storage.
 */
export function assertNumber(value: unknown, field: string): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`Expected number for '${field}', got ${typeof value}`);
    }
    return value;
}

/**
 * Validates the envelope shared by commit panel and undocked webview messages.
 *
 * The returned object still carries untrusted fields; callers must validate individual paths,
 * hashes, numbers, and strings before invoking Git operations or VS Code commands.
 *
 * @throws When the payload is not an object with a string `type` discriminator.
 */
export function assertMessage(msg: unknown): { type: string; [key: string]: unknown } {
    if (typeof msg === "object" && msg !== null && "type" in msg) {
        const typed = msg as { type?: unknown; [key: string]: unknown };
        if (typeof typed.type === "string") {
            return typed as { type: string; [key: string]: unknown };
        }
    }
    throw new Error("Invalid message received from webview.");
}
