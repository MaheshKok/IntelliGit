// Reads and validates the `intelligit.commitChecks.hosts` setting into a HostMap.
// Self-hosted Git hosts are user-supplied, so each entry is checked at this trust
// boundary: only an implemented host-config provider id is accepted and host keys
// are lowercased to match how providers and the credential store compare hosts.
// Invalid entries are dropped rather than throwing so one bad mapping cannot
// break commit checks.

import type { HostMap, ProviderId } from "./types";

/** Provider ids accepted in the hosts config; expand when more providers are wired. */
const SUPPORTED_HOST_CONFIG_PROVIDER_IDS: ReadonlySet<ProviderId> = new Set<ProviderId>(["gitlab"]);

/**
 * Normalizes a raw `intelligit.commitChecks.hosts` config value into a HostMap.
 *
 * Accepts a plain object mapping a hostname to a provider id. Entries whose value
 * is not an implemented provider id, or whose host is blank, are skipped. Host
 * keys are trimmed and lowercased so lookups match the provider and credential-store
 * convention. Malformed input (null, array, or non-object) yields an empty map.
 *
 * @param raw - The unvalidated config value (any shape; typically a Record).
 * @returns A validated HostMap; empty when input is missing or malformed.
 */
export function normalizeHostMap(raw: unknown): HostMap {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};

    const result: HostMap = {};
    for (const [rawHost, rawId] of Object.entries(raw as Record<string, unknown>)) {
        const host = rawHost.trim().toLowerCase();
        if (!host) continue;
        if (typeof rawId !== "string") continue;
        const id = rawId.trim().toLowerCase();
        if (!isProviderId(id)) continue;
        result[host] = id;
    }
    return result;
}

/**
 * Type guard reporting whether a string is supported in host config.
 *
 * @param value - The candidate provider id, already trimmed/lowercased.
 * @returns True when the value is one of the implemented host-config provider ids.
 */
function isProviderId(value: string): value is ProviderId {
    return SUPPORTED_HOST_CONFIG_PROVIDER_IDS.has(value as ProviderId);
}
