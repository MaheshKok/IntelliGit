/** Read-only configuration surface used while shelf services are activated. */
export interface ShelfSettings {
    pathOverride: string | undefined;
    recordBaseRevisions: boolean;
    cleanupAfterDays: number;
    removeOnUnshelve: boolean;
    recoveryRetentionMs: number;
}

/**
 * Normalizes shelf settings once at activation. Changes require a window reload.
 */
export function readShelfSettings(configuration: {
    get<T>(section: string, defaultValue?: T): T | undefined;
}): ShelfSettings {
    const path = configuration.get<string>("shelf.path", "") ?? "";
    const cleanup = configuration.get<number>("shelf.cleanupAfterDays", 0) ?? 0;
    const hours = configuration.get<number>("shelf.recoveryRetentionHours", 24) ?? 24;
    return {
        pathOverride: path || undefined,
        recordBaseRevisions:
            configuration.get<boolean>("shelf.recordBaseRevisions", true) !== false,
        cleanupAfterDays: Number.isFinite(cleanup) ? Math.max(0, cleanup) : 0,
        removeOnUnshelve: configuration.get<boolean>("shelf.removeOnUnshelve", true) !== false,
        recoveryRetentionMs: (Number.isFinite(hours) && hours >= 1 ? hours : 24) * 60 * 60 * 1000,
    };
}
