import { beforeEach, describe, expect, it, vi } from "vitest";

async function loadLanguageAssociations(allExtensions?: unknown[]) {
    vi.resetModules();
    vi.doMock("vscode", () => ({
        extensions: {
            get all() {
                return allExtensions;
            },
        },
    }));
    return import("../../../src/utils/languageAssociations");
}

describe("createLanguageAssociations", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        // `doUnmock`, not `unmock`: the hoisted form is lifted out of this hook and runs once
        // before any test, so it could never undo the `doMock` each case installs. Vitest 4 warns
        // on it and will make it an error.
        vi.doUnmock("vscode");
    });

    it("returns empty associations when VS Code extension metadata is unavailable", async () => {
        const { createLanguageAssociations } = await loadLanguageAssociations(undefined);

        const associations = createLanguageAssociations();

        expect([...associations.byExtension.entries()]).toEqual([]);
        expect([...associations.byFilename.entries()]).toEqual([]);
    });

    it("collects lower-case extension and filename mappings from valid language contributions", async () => {
        const { createLanguageAssociations } = await loadLanguageAssociations([
            {
                packageJSON: {
                    contributes: {
                        languages: [
                            {
                                id: "TypeScriptReact",
                                extensions: [".TSX", "tsx", 42, ".shared"],
                                filenames: ["Dockerfile", 123, "Jenkinsfile"],
                            },
                            {
                                id: "IgnoredDuplicate",
                                extensions: [".tsx", ".shared"],
                                filenames: ["dockerfile"],
                            },
                            { id: "NoArrays" },
                            { id: 123, extensions: [".bad"], filenames: ["badfile"] },
                        ],
                    },
                },
            },
            {
                packageJSON: {
                    contributes: {
                        languages: "not-an-array",
                    },
                },
            },
            {
                packageJSON: undefined,
            },
        ]);

        const associations = createLanguageAssociations();

        expect([...associations.byExtension.entries()]).toEqual([
            [".tsx", "typescriptreact"],
            [".shared", "typescriptreact"],
        ]);
        expect([...associations.byFilename.entries()]).toEqual([
            ["dockerfile", "typescriptreact"],
            ["jenkinsfile", "typescriptreact"],
        ]);
    });
});
