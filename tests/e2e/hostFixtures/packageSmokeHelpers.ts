/** A VS Code CLI invocation resolved from `@vscode/test-electron`'s CLI tuple. */
export interface PackageCliInvocation {
    readonly executablePath: string;
    readonly args: readonly string[];
}

/** The package-management operation to run against the fresh VS Code profile. */
export type PackageCliOperation =
    | { readonly kind: "install"; readonly vsixPath: string }
    | { readonly kind: "list" };

/**
 * Builds one VS Code package-management invocation from the tuple returned by
 * `resolveCliArgsFromVSCodeExecutablePath`.
 *
 * The resolver's first item is the executable and the remaining items are CLI
 * bootstrap arguments. Fresh profile paths are appended after those arguments
 * so neither installation nor listing can observe a machine-level extension.
 *
 * @param options Invocation inputs and the package operation to perform.
 * @returns The executable and arguments suitable for `execFile`.
 * @throws If the resolver returns no executable path.
 */
export function buildPackageCliInvocation(options: {
    readonly cliArgs: readonly string[];
    readonly userDataDir: string;
    readonly extensionsDir: string;
    readonly operation: PackageCliOperation;
}): PackageCliInvocation {
    const [executablePath, ...resolvedArgs] = options.cliArgs;
    if (executablePath === undefined) {
        throw new Error("VS Code CLI resolver returned no executable path");
    }

    const operationArgs =
        options.operation.kind === "install"
            ? ["--install-extension", options.operation.vsixPath, "--force"]
            : ["--list-extensions", "--show-versions"];

    return {
        executablePath,
        args: [
            ...resolvedArgs,
            `--user-data-dir=${options.userDataDir}`,
            `--extensions-dir=${options.extensionsDir}`,
            ...operationArgs,
        ],
    };
}

/**
 * Builds the isolated Electron arguments for an extension already installed in
 * the supplied extensions directory.
 *
 * There is intentionally no `--extensionDevelopmentPath`: the package smoke
 * must exercise VS Code's installed-extension path, not the checkout.
 *
 * @param options Fresh profile, extension, and Git workspace paths.
 * @returns Arguments for Playwright's Electron launch.
 */
export function buildInstalledExtensionLaunchArgs(options: {
    readonly userDataDir: string;
    readonly extensionsDir: string;
    readonly workspacePath: string;
}): readonly string[] {
    return [
        "--disable-workspace-trust",
        "--skip-release-notes",
        "--skip-welcome",
        "--disable-gpu",
        "--password-store=basic",
        "--use-inmemory-secretstorage",
        "--force-disable-user-env",
        `--user-data-dir=${options.userDataDir}`,
        `--extensions-dir=${options.extensionsDir}`,
        options.workspacePath,
    ];
}

/**
 * Verifies that VS Code's `--list-extensions --show-versions` output contains
 * exactly one line for the expected extension ID and package version. VS Code
 * canonicalizes extension IDs to lowercase in CLI output, so only the ID's
 * casing is normalized; the version remains an exact match.
 *
 * @param output Raw stdout from the VS Code CLI.
 * @param expectedExtensionVersion Exact `publisher.name@version` line required.
 * @throws If the expected line is absent, mismatched, or duplicated.
 */
export function assertExactInstalledExtensionVersion(
    output: string,
    expectedExtensionVersion: string,
): void {
    const lines = output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    const separator = expectedExtensionVersion.lastIndexOf("@");
    const expectedExtensionId = expectedExtensionVersion.slice(0, separator);
    const expectedVersion = expectedExtensionVersion.slice(separator + 1);
    const installedLines = lines.filter((line) =>
        line.toLowerCase().startsWith(`${expectedExtensionId.toLowerCase()}@`),
    );
    const [actualExtensionId, ...actualVersionParts] = installedLines[0]?.split("@") ?? [];
    const actualVersion = actualVersionParts.join("@");

    if (
        installedLines.length !== 1 ||
        actualExtensionId?.toLowerCase() !== expectedExtensionId.toLowerCase() ||
        actualVersion !== expectedVersion
    ) {
        throw new Error(
            `Expected exactly one installed extension "${expectedExtensionVersion}"; ` +
                `received ${JSON.stringify(installedLines.length === 0 ? lines : installedLines)}`,
        );
    }
}
