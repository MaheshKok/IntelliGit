// Reads and validates the `intelligit.commitChecks` settings object into a typed,
// immutable shape consumed by the coordinator and view layer. Like `hostConfig`, this
// is a pure trust boundary: non-boolean toggles are coerced to their safe defaults,
// unknown provider keys are ignored, and a user-supplied CI/CD name filter is compiled
// defensively so a malformed regex never throws — it falls back to the built-in pattern
// and raises a visible "invalid" flag instead. No VS Code or I/O lives here.

import type { ProviderId } from "./types";

/** Every commit-check provider id, used to seed the per-provider toggle map. */
const ALL_PROVIDER_IDS: readonly ProviderId[] = [
    "github",
    "gitlab",
    "bitbucket-cloud",
    "bitbucket-server",
];
const MAX_CICD_FILTER_LENGTH = 120;
const SAFE_CICD_FILTER_PATTERN = /^[\w\s./:|()-]+$/u;

/**
 * Validated, immutable view of the `intelligit.commitChecks` settings.
 *
 * `enabled` gates the whole feature. `providers` carries an explicit boolean for every
 * known provider id (defaulting to enabled). `ciCdPattern` is the user's compiled CI/CD
 * include filter when one was supplied and valid; it is absent when the setting is empty,
 * the wrong type, unsafe, or failed to compile. `ciCdFilterInvalid` is true only when a
 * non-empty string was supplied but was rejected, so the caller can surface a warning.
 */
export interface CommitChecksSettings {
    readonly enabled: boolean;
    readonly providers: Readonly<Record<ProviderId, boolean>>;
    readonly ciCdPattern?: RegExp;
    readonly ciCdFilterInvalid?: boolean;
}

/**
 * Normalizes a raw `intelligit.commitChecks` config value into CommitChecksSettings.
 *
 * Malformed input (null, array, scalar) yields all-default settings. `enabled` and each
 * provider toggle honor an explicit boolean and coerce anything else to the default
 * (enabled), so a stray string or number can never silently disable the feature. A
 * non-empty string `ciCdFilter` is compiled case-insensitively; an unsafe or invalid
 * value leaves `ciCdPattern` unset and flags `ciCdFilterInvalid`. The returned object
 * and its provider map are frozen.
 *
 * @param raw - The unvalidated config value (any shape; typically a Record).
 * @returns Immutable, fully-populated settings safe to share across the activation.
 */
export function normalizeCommitChecksSettings(raw: unknown): CommitChecksSettings {
    const source = isPlainObject(raw) ? raw : {};
    const enabled = typeof source.enabled === "boolean" ? source.enabled : true;
    const providers = normalizeProviders(source.providers);
    const filter = compileCiCdFilter(source.ciCdFilter);
    return Object.freeze({
        enabled,
        providers,
        ciCdPattern: filter.ciCdPattern,
        ciCdFilterInvalid: filter.ciCdFilterInvalid,
    });
}

/**
 * Returns the content-affecting settings fingerprint used in commit-check cache keys.
 *
 * @param settings - Validated commit-check settings.
 * @returns Stable fingerprint for settings that change provider snapshot contents.
 */
export function commitChecksSettingsFingerprint(settings?: CommitChecksSettings): string {
    const pattern = settings?.ciCdPattern;
    return pattern ? `${pattern.source}/${pattern.flags}` : "-";
}

/**
 * Type guard for a non-null, non-array object (a config map, not a scalar or list).
 *
 * @param value - The candidate value.
 * @returns True when the value is a plain object usable as a string-keyed record.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Builds the frozen per-provider toggle map, defaulting every unknown or non-boolean
 * entry to enabled and ignoring keys that are not known provider ids.
 *
 * @param raw - The raw `providers` config value.
 * @returns A frozen record with an explicit boolean for every provider id.
 */
function normalizeProviders(raw: unknown): Readonly<Record<ProviderId, boolean>> {
    const source = isPlainObject(raw) ? raw : {};
    const result = {} as Record<ProviderId, boolean>;
    for (const id of ALL_PROVIDER_IDS) {
        const value = source[id];
        result[id] = typeof value === "boolean" ? value : true;
    }
    return Object.freeze(result);
}

/**
 * Compiles a user-supplied CI/CD include filter without ever throwing.
 *
 * An empty string or non-string value is treated as "no override" (keep the built-in
 * pattern) and is not an error. A non-empty string is compiled with the case-insensitive
 * flag; unsafe syntax or a compile error yields no pattern and sets the invalid flag.
 *
 * @param raw - The raw `ciCdFilter` config value.
 * @returns The compiled pattern (when valid) and whether a supplied value failed to compile.
 */
function compileCiCdFilter(raw: unknown): { ciCdPattern?: RegExp; ciCdFilterInvalid: boolean } {
    if (typeof raw !== "string" || raw === "") {
        return { ciCdFilterInvalid: false };
    }
    if (raw.length > MAX_CICD_FILTER_LENGTH || !SAFE_CICD_FILTER_PATTERN.test(raw)) {
        return { ciCdFilterInvalid: true };
    }
    try {
        return { ciCdPattern: new RegExp(raw, "i"), ciCdFilterInvalid: false };
    } catch {
        return { ciCdFilterInvalid: true };
    }
}
