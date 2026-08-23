import { afterEach, describe, expect, it, vi } from "vitest";

import {
    assertExactInstalledExtensionVersion,
    buildInstalledExtensionLaunchArgs,
    buildPackageCliInvocation,
} from "../../e2e/hostFixtures/packageSmokeHelpers";

// `process` belongs to the whole worker, not to this file, so a platform spy left standing decides
// what every later file sees -- and only when the run order happens to put one downstream.
afterEach(() => {
    vi.restoreAllMocks();
});

describe("buildPackageCliInvocation", () => {
    it("builds an install command from the resolved CLI tuple and fresh directories", () => {
        expect(
            buildPackageCliInvocation({
                cliArgs: ["/cached/Code", "--cli-data-dir=/cached/cli"],
                userDataDir: "/tmp/package-smoke-profile",
                extensionsDir: "/tmp/package-smoke-extensions",
                operation: { kind: "install", vsixPath: "/repo/intelligit.vsix" },
            }),
        ).toEqual({
            executablePath: "/cached/Code",
            args: [
                "--cli-data-dir=/cached/cli",
                "--user-data-dir=/tmp/package-smoke-profile",
                "--extensions-dir=/tmp/package-smoke-extensions",
                "--install-extension",
                "/repo/intelligit.vsix",
                "--force",
            ],
            useShell: false,
        });
    });

    it("builds a list command with the version output flag", () => {
        expect(
            buildPackageCliInvocation({
                cliArgs: ["/cached/Code"],
                userDataDir: "/tmp/package-smoke-profile",
                extensionsDir: "/tmp/package-smoke-extensions",
                operation: { kind: "list" },
            }),
        ).toEqual({
            executablePath: "/cached/Code",
            args: [
                "--user-data-dir=/tmp/package-smoke-profile",
                "--extensions-dir=/tmp/package-smoke-extensions",
                "--list-extensions",
                "--show-versions",
            ],
            useShell: false,
        });
    });

    // Node refuses to spawn the `bin\code.cmd` the resolver returns on Windows unless a shell runs
    // it (CVE-2024-27980), and `spawn EINVAL` was the entire Windows package smoke for as long as
    // the job has existed -- it never got far enough to report anything else. Stubbing the platform
    // is the only way to reach this branch from the machines the suite is developed on; skipping it
    // off Windows would leave the one platform that needs it as the only one never asserted.
    it("runs the Windows CLI through a shell, quoted for the shell that re-parses it", () => {
        vi.spyOn(process, "platform", "get").mockReturnValue("win32");

        expect(
            buildPackageCliInvocation({
                cliArgs: ["C:\\cache\\bin\\code.cmd", "--cli-data-dir=C:\\cache\\cli"],
                userDataDir: "C:\\Users\\Some Name\\profile",
                extensionsDir: "C:\\Users\\Some Name\\extensions",
                operation: { kind: "list" },
            }),
        ).toEqual({
            executablePath: '"C:\\cache\\bin\\code.cmd"',
            args: [
                '"--cli-data-dir=C:\\cache\\cli"',
                '"--user-data-dir=C:\\Users\\Some Name\\profile"',
                '"--extensions-dir=C:\\Users\\Some Name\\extensions"',
                '"--list-extensions"',
                '"--show-versions"',
            ],
            useShell: true,
        });
    });
});

describe("buildInstalledExtensionLaunchArgs", () => {
    it("launches an installed extension without a development path", () => {
        const args = buildInstalledExtensionLaunchArgs({
            userDataDir: "/tmp/package-smoke-profile",
            extensionsDir: "/tmp/package-smoke-extensions",
            workspacePath: "/tmp/package-smoke-repository",
        });

        expect(args).not.toContainEqual(expect.stringMatching(/^--extensionDevelopmentPath=/));
        expect(args).toEqual(
            expect.arrayContaining([
                "--disable-workspace-trust",
                "--skip-release-notes",
                "--skip-welcome",
                "--disable-gpu",
                "--password-store=basic",
                "--use-inmemory-secretstorage",
                "--force-disable-user-env",
                "--user-data-dir=/tmp/package-smoke-profile",
                "--extensions-dir=/tmp/package-smoke-extensions",
                "/tmp/package-smoke-repository",
            ]),
        );
    });
});

describe("assertExactInstalledExtensionVersion", () => {
    it("accepts the exact publisher, name, and package version line", () => {
        expect(() =>
            assertExactInstalledExtensionVersion(
                "other.extension@1.0.0\nmaheshkok.intelligit@0.25.3\n",
                "MaheshKok.intelligit@0.25.3",
            ),
        ).not.toThrow();
    });

    it("rejects a missing, mismatched, or duplicated exact version line", () => {
        for (const output of [
            "MaheshKok.intelligit@0.25.2\n",
            "other.extension@0.25.3\n",
            "MaheshKok.intelligit@0.25.3\nMaheshKok.intelligit@0.25.3\n",
        ]) {
            expect(() =>
                assertExactInstalledExtensionVersion(output, "MaheshKok.intelligit@0.25.3"),
            ).toThrow(/exactly one installed extension/);
        }
    });
});
