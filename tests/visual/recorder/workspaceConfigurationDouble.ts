/**
 * Process-wide fake for `vscode.workspace.getConfiguration`, installed explicitly by the recorder
 * that owns a recording. The default is deliberately "not installed": callers that need a
 * configuration must pin it themselves, while existing recorders continue to exercise their real
 * guarded fallbacks instead of silently inheriting a new fake configuration surface.
 */

import { throwingDouble } from "./throwingDouble";

let installedValues: Readonly<Record<string, unknown>> | undefined;

/**
 * Installs one immutable snapshot of fully qualified configuration values. Undefined values are
 * omitted so a caller cannot make an absent setting look present; `get` uses own-property
 * membership below to distinguish a pinned value from a missing key.
 */
export function setFakeWorkspaceConfiguration(values: Readonly<Record<string, unknown>>): void {
    installedValues = Object.fromEntries(
        Object.entries(values).filter(([, value]) => value !== undefined),
    );
}

/** Removes the process-wide store, restoring the default throwing behavior for existing recorders. */
export function resetFakeWorkspaceConfigurationForTests(): void {
    installedValues = undefined;
}

/**
 * Creates the minimal configuration object delegated to by the `vscode` double. Construction
 * itself throws when no recorder installed a store, preserving the earlier phases' guarded
 * fallback behavior; an installed store still throws for an unpinned resolved key so a new caller
 * cannot silently record an unrepresentative `undefined` branch. The returned object is also
 * throwingDouble-wrapped so unsupported WorkspaceConfiguration members fail by section name.
 *
 * The store is snapshotted into `values` at CONSTRUCTION, and `get` reads that snapshot rather than
 * the module-level `installedValues`. Reading the module variable at call time made the check at
 * the top of this function a lie: a configuration object built while a store was installed, then
 * called after `resetFakeWorkspaceConfigurationForTests` (a recorder's own `afterEach`, or a
 * `vscode.workspace.getConfiguration` reference a panel captured and used later), reached
 * `Object.prototype.hasOwnProperty.call(undefined, key)` and died with `TypeError: Cannot convert
 * undefined or null to object` -- swallowing the diagnostic this module exists to produce. Because
 * `setFakeWorkspaceConfiguration` already builds a fresh object per install and never mutates it,
 * holding the reference is a snapshot, not a live view.
 */
export function createFakeWorkspaceConfiguration(section?: string): {
    get<T>(key: string): T | undefined;
} {
    const member =
        section === undefined || section === ""
            ? "vscode.workspace.getConfiguration()"
            : `vscode.workspace.getConfiguration("${section}")`;
    const values = installedValues;
    if (values === undefined) {
        throw new Error(
            `${member} was called during a recording, but no fake workspace configuration is installed.`,
        );
    }

    return throwingDouble(member, {
        get<T>(key: string): T | undefined {
            const resolvedKey = section ? `${section}.${key}` : key;
            if (!Object.prototype.hasOwnProperty.call(values, resolvedKey)) {
                throw new Error(
                    `${member}.get("${key}") resolved to uninstalled fake workspace configuration key "${resolvedKey}".`,
                );
            }
            return values[resolvedKey] as T | undefined;
        },
    });
}
