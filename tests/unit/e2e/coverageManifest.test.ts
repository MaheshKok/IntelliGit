import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { COVERAGE_MANIFEST } from "../../e2e/coverage-manifest";
import { IMPLEMENTED_FLOW_IDS } from "../../e2e/flows/matrix";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const WEBVIEW_ROOT = path.join(REPO_ROOT, "src", "webviews");

interface PackageJson {
    contributes?: {
        commands?: Array<{ command?: unknown }>;
    };
}

/** Reads the real contributed command ids from the checked-in extension manifest. */
function readContributedCommandIds(): string[] {
    const packageJson = JSON.parse(
        readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
    ) as PackageJson;
    return (packageJson.contributes?.commands ?? [])
        .map((entry) => entry.command)
        .filter((command): command is string => typeof command === "string");
}

/** Recursively finds source files that can declare an outbound webview protocol union. */
function listWebviewSourceFiles(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) return listWebviewSourceFiles(entryPath);
        return /\.tsx?$/.test(entry.name) ? [entryPath] : [];
    });
}

/**
 * The outbound unions this scraper is willing to read, pinned as `<repo-relative path>:<type name>`.
 *
 * Without this the gate has a silent blind spot: `readOutboundTypeIds` finds a union by the shape of
 * its NAME, so renaming `GraphOutbound` to `GraphMessages` would drop that file's whole action set
 * out of the required surface and leave every assertion below green. Pinning the declarations turns
 * that drift into a failure. It does not catch a brand-new union following no existing convention --
 * all nine here follow one, so a tenth that did not would be the first, and its ids would still have
 * to be absent from the manifest to go unnoticed.
 */
const OUTBOUND_UNION_DECLARATIONS = [
    "src/webviews/protocol/commitGraphTypes.ts:CommitGraphOutbound",
    "src/webviews/protocol/commitInfoTypes.ts:CommitInfoOutbound",
    "src/webviews/protocol/commitPanelMessages.ts:OutboundMessage",
    "src/webviews/protocol/mergeConflictSessionTypes.ts:OutboundMessage",
    "src/webviews/protocol/undockedMessages.ts:GraphOutbound",
    "src/webviews/protocol/undockedMessages.ts:UndockedCommitPanelOutbound",
    "src/webviews/protocol/undockedMessages.ts:UnifiedOutbound",
    "src/webviews/react/merge-editor/types.ts:OutboundMessage",
    "src/webviews/react/shared/hooks/useRebaseDialogController.ts:RebaseDialogOutbound",
];

/** Extracts one source-level discriminant set from every outbound type alias in a file. */
function readOutboundTypeIds(source: string): string[] {
    const ids = new Set<string>();
    for (const { block } of readOutboundBlocks(source)) {
        for (const match of block.matchAll(/\btype:\s*"([^"]+)"/g)) ids.add(match[1]);
    }
    return [...ids];
}

/** Every outbound type alias in a file, paired with the source slice its members live in. */
function readOutboundBlocks(source: string): Array<{ name: string; block: string }> {
    const declarations = [...source.matchAll(/^(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/gm)];
    const blocks: Array<{ name: string; block: string }> = [];
    for (let index = 0; index < declarations.length; index += 1) {
        const declaration = declarations[index];
        if (!/(?:OutboundMessage|Outbound)$/.test(declaration[1])) continue;
        const nextDeclaration = declarations[index + 1];
        const start = declaration.index ?? 0;
        const end = nextDeclaration?.index ?? source.length;
        blocks.push({ name: declaration[1], block: source.slice(start, end) });
    }
    return blocks;
}

/** The `<repo-relative path>:<type name>` of every outbound union the scraper actually matched. */
function readOutboundUnionDeclarations(): string[] {
    const declarations: string[] = [];
    for (const filePath of listWebviewSourceFiles(WEBVIEW_ROOT)) {
        const relativePath = path.relative(REPO_ROOT, filePath).split(path.sep).join("/");
        for (const { name } of readOutboundBlocks(readFileSync(filePath, "utf8"))) {
            declarations.push(`${relativePath}:${name}`);
        }
    }
    return declarations.sort();
}

/** Enumerates the real discriminated outbound webview registries in the source tree. */
function readWebviewActionIds(): string[] {
    const ids = new Set<string>();
    for (const filePath of listWebviewSourceFiles(WEBVIEW_ROOT)) {
        const source = readFileSync(filePath, "utf8");
        for (const id of readOutboundTypeIds(source)) ids.add(id);
    }
    return [...ids].sort();
}

/** Builds the stable key used to reject duplicate manifest surfaces. */
function manifestKey(entry: (typeof COVERAGE_MANIFEST)[number]): string {
    return `${entry.kind}:${entry.id}`;
}

describe("E2E coverage manifest", () => {
    it("classifies every entry and resolves every mutating decision", () => {
        const implementedFlowIds = new Set<string>(IMPLEMENTED_FLOW_IDS);
        const contributedCommandIds = new Set(readContributedCommandIds());
        const webviewActionIds = new Set(readWebviewActionIds());

        expect(new Set(COVERAGE_MANIFEST.map(manifestKey)).size).toBe(COVERAGE_MANIFEST.length);

        for (const entry of COVERAGE_MANIFEST) {
            const isRealSurface =
                entry.kind === "command"
                    ? contributedCommandIds.has(entry.id)
                    : webviewActionIds.has(entry.id);
            expect(
                isRealSurface,
                `${entry.kind} ${entry.id} must be a real registered surface`,
            ).toBe(true);

            const coverageReferences = [
                entry.coveredBy !== undefined,
                entry.notCovered !== undefined,
            ];
            if (entry.mutating) {
                expect(
                    coverageReferences.filter(Boolean),
                    `${entry.kind} ${entry.id} must have exactly one coverage decision`,
                ).toHaveLength(1);
                if (entry.coveredBy !== undefined) {
                    expect(
                        implementedFlowIds.has(entry.coveredBy),
                        `${entry.kind} ${entry.id} coveredBy must resolve to IMPLEMENTED_FLOW_IDS`,
                    ).toBe(true);
                }
                if (entry.notCovered !== undefined) {
                    expect(
                        entry.notCovered.trim().length,
                        `${entry.kind} ${entry.id} notCovered must be specific and non-empty`,
                    ).toBeGreaterThan(0);
                }
            } else {
                expect(
                    coverageReferences.filter(Boolean),
                    `${entry.kind} ${entry.id} is non-mutating`,
                ).toEqual([]);
            }

            if (entry.kind === "command" && entry.id.endsWith(".color")) {
                const baseId = entry.id.slice(0, -".color".length);
                expect(entry.aliasOf, `${entry.id} must collapse onto its base command`).toBe(
                    baseId,
                );
                expect(
                    contributedCommandIds.has(baseId),
                    `${entry.id} base must be contributed`,
                ).toBe(true);
            } else {
                expect(
                    entry.aliasOf,
                    `${entry.kind} ${entry.id} cannot declare an alias`,
                ).toBeUndefined();
            }
        }
    });

    it("matches every contributed command in both directions", () => {
        const contributedCommandIds = readContributedCommandIds();
        const manifestCommandIds = COVERAGE_MANIFEST.filter(
            (entry) => entry.kind === "command",
        ).map((entry) => entry.id);

        expect(manifestCommandIds).toHaveLength(contributedCommandIds.length);
        expect(new Set(manifestCommandIds)).toEqual(new Set(contributedCommandIds));
    });

    it("collapses aliases and preserves the measured command surface", () => {
        const contributedCommandIds = readContributedCommandIds();
        const aliasIds = contributedCommandIds.filter((id) => id.endsWith(".color"));
        const collapsedBaseIds = new Set(
            contributedCommandIds.map((id) =>
                id.endsWith(".color") ? id.slice(0, -".color".length) : id,
            ),
        );
        const manifestCommandEntries = COVERAGE_MANIFEST.filter(
            (entry) => entry.kind === "command",
        );
        const collapsedManifestBaseIds = new Set(
            manifestCommandEntries.map((entry) => entry.aliasOf ?? entry.id),
        );

        expect(aliasIds).toHaveLength(9);
        expect(collapsedBaseIds).toHaveLength(63);
        expect(collapsedManifestBaseIds).toEqual(collapsedBaseIds);
    });

    it("reads every outbound union it is pinned to, and no others", () => {
        expect(readOutboundUnionDeclarations()).toEqual(OUTBOUND_UNION_DECLARATIONS);
    });

    it("matches every outbound webview action in both directions", () => {
        const webviewActionIds = readWebviewActionIds();
        const manifestWebviewIds = COVERAGE_MANIFEST.filter((entry) => entry.kind === "webview")
            .map((entry) => entry.id)
            .sort();

        expect(manifestWebviewIds).toHaveLength(webviewActionIds.length);
        expect(manifestWebviewIds).toEqual(webviewActionIds);
    });
});
