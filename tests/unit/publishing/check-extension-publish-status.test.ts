import { describe, expect, it } from "vitest";

import {
    getExtensionId,
    isVsceVersionPublished,
    isOvsxVersionPublished,
    lookupPublishStatus,
} from "../../../scripts/check-extension-publish-status";

describe("getExtensionId", () => {
    it("builds the extension id from publisher and name", () => {
        expect(getExtensionId({ publisher: "MaheshKok", name: "intelligit" })).toBe(
            "MaheshKok.intelligit",
        );
    });
});

describe("isVsceVersionPublished", () => {
    it("returns true when the version exists in marketplace metadata", () => {
        expect(
            isVsceVersionPublished(
                {
                    versions: [{ version: "0.5.5" }, { version: "0.6.0" }],
                },
                "0.6.0",
            ),
        ).toBe(true);
    });

    it("returns false when the version is absent", () => {
        expect(
            isVsceVersionPublished(
                {
                    versions: [{ version: "0.5.5" }],
                },
                "0.6.0",
            ),
        ).toBe(false);
    });
});

describe("isOvsxVersionPublished", () => {
    it("returns true when the exact version is present in metadata", () => {
        expect(
            isOvsxVersionPublished(
                {
                    version: "0.6.0",
                    allVersions: {
                        latest: "https://open-vsx.org/api/MaheshKok/intelligit/universal/latest",
                        "0.6.0":
                            "https://open-vsx.org/api/MaheshKok/intelligit/universal/0.6.0",
                    },
                },
                "0.6.0",
            ),
        ).toBe(true);
    });

    it("returns false when the exact version is absent", () => {
        expect(
            isOvsxVersionPublished(
                {
                    version: "0.5.5",
                    allVersions: {
                        latest: "https://open-vsx.org/api/MaheshKok/intelligit/universal/latest",
                        "0.5.5":
                            "https://open-vsx.org/api/MaheshKok/intelligit/universal/0.5.5",
                    },
                },
                "0.6.0",
            ),
        ).toBe(false);
    });
});

describe("lookupPublishStatus", () => {
    it("treats missing Open VSX versions as unpublished but preserves marketplace status", () => {
        const result = lookupPublishStatus({
            packageJson: {
                publisher: "MaheshKok",
                name: "intelligit",
                version: "0.6.0",
            },
            runCommand: (_command, args) => {
                if (args[0] === "vsce") {
                    return JSON.stringify({
                        versions: [{ version: "0.6.0" }],
                    });
                }
                throw new Error(
                    "Extension MaheshKok.intelligit has no published version matching '0.6.0'",
                );
            },
        });

        expect(result).toEqual({
            extensionId: "MaheshKok.intelligit",
            version: "0.6.0",
            vscePublished: true,
            ovsxPublished: false,
        });
    });

    it("preserves the parse failure as the cause for marketplace lookup errors", () => {
        let thrownError;

        try {
            lookupPublishStatus({
                packageJson: {
                    publisher: "MaheshKok",
                    name: "intelligit",
                    version: "0.6.0",
                },
                runCommand: (_command, args) => {
                    if (args[0] === "vsce") {
                        return "{";
                    }
                    return "{}";
                },
            });
        } catch (error) {
            thrownError = error;
        }

        expect(thrownError).toBeInstanceOf(Error);
        expect(thrownError.message).toContain("VS Code Marketplace lookup failed");
        expect(thrownError.cause).toBeInstanceOf(Error);
        expect(thrownError.cause.message).toContain("Failed to parse vsce JSON output");
        expect(thrownError.cause.cause).toBeInstanceOf(SyntaxError);
    });

    it("preserves the original lookup failure as the cause for Open VSX errors", () => {
        const rootCause = new Error("bunx ovsx not found");
        let thrownError;

        try {
            lookupPublishStatus({
                packageJson: {
                    publisher: "MaheshKok",
                    name: "intelligit",
                    version: "0.6.0",
                },
                runCommand: (_command, args) => {
                    if (args[0] === "vsce") {
                        return JSON.stringify({
                            versions: [{ version: "0.6.0" }],
                        });
                    }

                    throw rootCause;
                },
            });
        } catch (error) {
            thrownError = error;
        }

        expect(thrownError).toBeInstanceOf(Error);
        expect(thrownError.message).toContain("Open VSX lookup failed");
        expect(thrownError.cause).toBe(rootCause);
    });
});
