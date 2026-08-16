import { describe, expect, it } from "vitest";

import {
    assertExactInstalledExtensionVersion,
    buildInstalledExtensionLaunchArgs,
    buildPackageCliInvocation,
} from "../../e2e/hostFixtures/packageSmokeHelpers";

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
