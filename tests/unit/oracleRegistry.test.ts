import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

import { ORACLE_IDS } from "../oracles";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const oracleDirectories = [
    path.join(repositoryRoot, "tests", "visual", "oracles"),
    path.join(repositoryRoot, "tests", "e2e", "oracles"),
];
const expectedDirectOracleImporters = new Set([
    "tests/oracles.ts",
    "tests/unit/e2e/gitEnv.test.ts",
    "tests/unit/e2e/oracles.test.ts",
    "tests/unit/visual/oracles/accessibleNameVerdict.test.ts",
    "tests/unit/visual/oracles/baselineLayout.test.ts",
    "tests/unit/visual/oracles/catalogSources.test.ts",
    "tests/unit/visual/oracles/contrast.test.ts",
    "tests/unit/visual/oracles/findingsBaseline.test.ts",
    "tests/unit/visual/oracles/findingsBaselineFile.test.ts",
    "tests/unit/visual/oracles/geometry.test.ts",
    "tests/unit/visual/oracles/pinnedBaseImage.test.ts",
    "tests/unit/visual/oracles/pixelAssertionPlan.test.ts",
    "tests/unit/visual/oracles/truncationSources.test.ts",
    "tests/unit/visual/oracles/visualEnvironment.test.ts",
    "tests/unit/visual/playwright/visualEnvironmentGuard.test.ts",
]);
const valueOracleImportPattern =
    /\bimport\s+(?!type\b)(?:(?!;)[\s\S])*?\sfrom\s+["']([^"']*\/oracles\/[^"']+)["']/g;

async function discoverTypeScriptModules(directory: string): Promise<string[]> {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
        left.name.localeCompare(right.name),
    );
    const discoveredPaths = await Promise.all(
        entries.map((entry) => {
            const entryPath = path.join(directory, entry.name);
            return entry.isDirectory()
                ? discoverTypeScriptModules(entryPath)
                : entry.isFile() && entry.name.endsWith(".ts")
                  ? Promise.resolve([entryPath])
                  : Promise.resolve([]);
        }),
    );
    return discoveredPaths.flat();
}

async function findValueOracleImporters(): Promise<Set<string>> {
    const testsRoot = path.join(repositoryRoot, "tests");
    const testFiles = await discoverTypeScriptModules(testsRoot);
    const importers = new Set<string>();
    let valueImportCount = 0;

    for (const filePath of testFiles) {
        const source = await readFile(filePath, "utf8");
        for (const _match of source.matchAll(valueOracleImportPattern)) {
            valueImportCount += 1;
            // Normalized to forward slashes so the pinned set reads the same on every platform.
            // `path.relative` yields `tests\unit\...` on Windows, which matches nothing in a set
            // written with `/`, so this test failed there for a reason unrelated to what it pins.
            // Same idiom the repository's other two path-pinning meta-tests already use --
            // tsconfigCoverage.test.ts:49 and coverageManifest.test.ts:87.
            importers.add(path.relative(repositoryRoot, filePath).split(path.sep).join("/"));
        }
    }

    expect(
        valueImportCount,
        "oracle value-import scanner must find a known-present import",
    ).toBeGreaterThan(0);
    return importers;
}

describe("oracle registry", () => {
    it("matches every TypeScript oracle module exactly once", async () => {
        const modulePaths = (
            await Promise.all(
                oracleDirectories.map((directory) => discoverTypeScriptModules(directory)),
            )
        ).flat();
        const discoveredIds = modulePaths.map((modulePath) => path.basename(modulePath, ".ts"));
        const duplicateIds = discoveredIds.filter(
            (id, index) => discoveredIds.indexOf(id) !== index,
        );

        expect(duplicateIds).toEqual([]);
        expect([...new Set(discoveredIds)].sort()).toEqual([...new Set(ORACLE_IDS)].sort());
    });

    it("bans oracle value imports at a depth nobody enumerated", async () => {
        // The lint rule is half the "unregistered oracle is unusable" structure, and its
        // generality is invisible to every other gate: an enumerated `group` list
        // ("./oracles/*", "../oracles/*", "../../../visual/oracles/*", ...) lints clean and
        // passes both meta-tests while banning only the depths someone happened to write down.
        // That exact defect shipped once -- a consumer at tests/visual/playwright/deep/ importing
        // "../../oracles/geometry" produced `lint` rc=0 -- so the ban is asserted behaviourally
        // here rather than by reading the config back.
        //
        // The probe path deliberately does not exist on disk. `lintText` resolves config by path
        // without reading the file, so this cannot leave debris that would then break the
        // importer-pinning test below.
        // The specifier is assembled rather than written literally. Meta-test B's importer scan is
        // textual, so a literal `from "../../oracles/geometry"` anywhere in this file -- even as
        // test data inside a string -- would count this file as a direct oracle importer. The
        // alternative, adding this file to the pinned exemption set, would hand it a permanent
        // licence to import an oracle for real.
        const oracleSpecifier = ["..", "..", "oracles", "geometry"].join("/");
        const probePath = path.join(
            repositoryRoot,
            "tests",
            "visual",
            "playwright",
            "deep",
            "probe.ts",
        );
        const lintOracleImport = async (source: string): Promise<readonly string[]> => {
            const results = await new ESLint({ cwd: repositoryRoot }).lintText(source, {
                filePath: probePath,
            });
            return results
                .flatMap((result) => result.messages)
                .filter((message) => message.ruleId === "@typescript-eslint/no-restricted-imports")
                .map((message) => message.message);
        };

        expect(
            await lintOracleImport(`import { findClippingLosses } from "${oracleSpecifier}";\n`),
            "a value import of an oracle must be restricted at any depth",
        ).toHaveLength(1);
        expect(
            await lintOracleImport(`import type { Box } from "${oracleSpecifier}";\n`),
            "type-only imports stay legal: collectOracleInputs.ts needs them and never calls an oracle",
        ).toEqual([]);
        // Vacuity guard: without this, a harness that always returned [] would make the
        // type-import assertion pass for the wrong reason.
        expect(
            await lintOracleImport('import { join } from "node:path";\n'),
            "an unrelated import must not be restricted",
        ).toEqual([]);
    }, 60_000);

    it("pins every direct oracle importer to the deliberate lint exemptions", async () => {
        // The lint block's ignores are a deliberate hole: an exempt path can import an oracle
        // directly, so this test pins the exemptions to the exact files instead of a glob.
        const actualImporters = await findValueOracleImporters();

        expect([...actualImporters].sort()).toEqual([...expectedDirectOracleImporters].sort());
    });
});
