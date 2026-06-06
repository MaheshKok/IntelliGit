import * as vscode from "vscode";

export interface LanguageAssociations {
    byExtension: Map<string, string>;
    byFilename: Map<string, string>;
}

interface LanguageContribution {
    id?: string;
    extensions?: string[];
    filenames?: string[];
}

interface LanguagePackageJson {
    contributes?: {
        languages?: LanguageContribution[];
    };
}

export function createLanguageAssociations(): LanguageAssociations {
    const associations: LanguageAssociations = {
        byExtension: new Map<string, string>(),
        byFilename: new Map<string, string>(),
    };
    const allExtensions = (vscode.extensions as unknown as { all?: vscode.Extension<unknown>[] })
        .all;
    if (Array.isArray(allExtensions)) {
        for (const extension of allExtensions) {
            for (const language of getExtensionContributedLanguages(extension)) {
                addLanguageAssociation(language, associations);
            }
        }
    }
    return associations;
}

function getExtensionContributedLanguages(
    extension: vscode.Extension<unknown>,
): LanguageContribution[] {
    const contributedLanguages = (extension.packageJSON as LanguagePackageJson | undefined)
        ?.contributes?.languages;
    return Array.isArray(contributedLanguages) ? contributedLanguages : [];
}

function addLanguageAssociation(
    language: LanguageContribution,
    associations: LanguageAssociations,
): void {
    if (!language || typeof language.id !== "string") return;
    const languageId = language.id.toLowerCase();
    addLanguageExtensions(languageId, language.extensions, associations.byExtension);
    addLanguageFilenames(languageId, language.filenames, associations.byFilename);
}

function addLanguageExtensions(
    languageId: string,
    extensions: unknown,
    byExtension: Map<string, string>,
): void {
    if (!Array.isArray(extensions)) return;
    for (const extName of extensions) {
        if (typeof extName !== "string") continue;
        const key = extName.toLowerCase();
        if (!key.startsWith(".")) continue;
        if (!byExtension.has(key)) {
            byExtension.set(key, languageId);
        }
    }
}

function addLanguageFilenames(
    languageId: string,
    filenames: unknown,
    byFilename: Map<string, string>,
): void {
    if (!Array.isArray(filenames)) return;
    for (const filename of filenames) {
        if (typeof filename !== "string") continue;
        const key = filename.toLowerCase();
        if (!byFilename.has(key)) {
            byFilename.set(key, languageId);
        }
    }
}
