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

export function assertRepoPathArray(value: unknown, field: string): string[] {
    const strings = assertStringArray(value, field);
    return strings.map((s) => assertRepoRelativePath(s));
}

export function assertString(value: unknown, field: string): string {
    if (typeof value !== "string") {
        throw new Error(`Expected string for '${field}', got ${typeof value}`);
    }
    return value;
}

export function assertNullableString(value: unknown, field: string): string | null {
    if (value === null) return null;
    return assertString(value, field);
}

export function assertGitHash(value: unknown, field: string): string {
    const hash = assertString(value, field).trim();
    if (!isValidGitHash(hash)) {
        throw new Error(`Invalid git hash for '${field}'.`);
    }
    return hash;
}

export function assertNumber(value: unknown, field: string): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`Expected number for '${field}', got ${typeof value}`);
    }
    return value;
}

export function assertMessage(msg: unknown): { type: string; [key: string]: unknown } {
    if (typeof msg === "object" && msg !== null && "type" in msg) {
        const typed = msg as { type?: unknown; [key: string]: unknown };
        if (typeof typed.type === "string") {
            return typed as { type: string; [key: string]: unknown };
        }
    }
    throw new Error("Invalid message received from webview.");
}
