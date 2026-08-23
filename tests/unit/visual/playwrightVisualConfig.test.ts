import path from "node:path";

import { describe, expect, it } from "vitest";

import { fixturePath } from "../../helpers/fixturePaths";
import visualConfig from "../../../playwright.visual.config";
import {
    assertNoNetworkEscapes,
    assertRequiredDistAssets,
    hostFixtureIdForProject,
    missingDistAssets,
    requiredDistAssets,
    resolveDistAssetPath,
} from "../../visual/playwright/visualHarnessUtils";

describe("visual Playwright config", () => {
    it("declares the deterministic matrix and screenshot contract", () => {
        const use = visualConfig.use as {
            readonly contextOptions?: { readonly reducedMotion?: string };
            readonly deviceScaleFactor?: number;
            readonly locale?: string;
            readonly timezoneId?: string;
        };
        const projectNames = visualConfig.projects?.map((project) => project.name);

        expect(visualConfig.testDir).toBe("tests/visual");
        expect(visualConfig.testMatch?.toString()).toContain("\\.spec\\.ts");
        expect(use.contextOptions?.reducedMotion).toBe("reduce");
        expect(use.deviceScaleFactor).toBe(1);
        expect(use.locale).toBe("en-GB");
        expect(use.timezoneId).toBe("UTC");
        expect(projectNames).toEqual([
            "dark-modern-narrow",
            "dark-modern-wide",
            "light-modern-narrow",
            "light-modern-wide",
            "hc-black-narrow",
            "hc-black-wide",
            "hc-light-narrow",
            "hc-light-wide",
        ]);
        const ignoringProjects =
            visualConfig.projects?.filter((project) => project.testIgnore !== undefined) ?? [];

        expect(ignoringProjects.map((project) => project.name)).toEqual([
            "light-modern-narrow",
            "light-modern-wide",
            "hc-black-narrow",
            "hc-black-wide",
            "hc-light-narrow",
            "hc-light-wide",
        ]);
        expect(visualConfig.projects?.[0].testIgnore).toBeUndefined();
        expect(visualConfig.projects?.[1].testIgnore).toBeUndefined();
        // Checking only that the option is set would pass for a pattern matching nothing, which
        // silently restores the locale sweep on all eight projects, or one matching everything,
        // which drops the other visual specs. Assert what the pattern actually selects.
        for (const project of ignoringProjects) {
            const ignorePattern = project.testIgnore as RegExp;

            expect(ignorePattern.test("tests/visual/localeSweep.spec.ts")).toBe(true);
            expect(ignorePattern.test("tests/visual/nonPixelOracles.spec.ts")).toBe(false);
        }

        const pixelSpecPath = "tests/visual/pixelBaselines.spec.ts";
        const pixelIgnoredProjects = new Set(
            visualConfig.projects
                ?.filter((project) =>
                    (project.testIgnore as RegExp | undefined)?.test(pixelSpecPath),
                )
                .map((project) => project.name),
        );
        const expectedPixelIgnoredProjects = new Set([
            "hc-black-narrow",
            "hc-black-wide",
            "hc-light-narrow",
            "hc-light-wide",
        ]);
        expect(pixelIgnoredProjects).toEqual(expectedPixelIgnoredProjects);
        expect(expectedPixelIgnoredProjects).toEqual(pixelIgnoredProjects);

        const pixelRunningProjects = new Set(
            visualConfig.projects
                ?.filter(
                    (project) => !(project.testIgnore as RegExp | undefined)?.test(pixelSpecPath),
                )
                .map((project) => project.name),
        );
        const expectedPixelRunningProjects = new Set([
            "dark-modern-narrow",
            "dark-modern-wide",
            "light-modern-narrow",
            "light-modern-wide",
        ]);
        expect(pixelRunningProjects).toEqual(expectedPixelRunningProjects);
        expect(expectedPixelRunningProjects).toEqual(pixelRunningProjects);

        // Playwright reads snapshotPathTemplate from the config root only. Nested under
        // toHaveScreenshot it typechecks, reads back correctly from the object literal, and
        // does nothing -- baselines silently land at the default path with a `-linux` suffix.
        // So assert both halves: present at the root, and absent from the nested options.
        expect(visualConfig.snapshotPathTemplate).toBe(
            "{snapshotDir}/{testFileName}/{arg}-{projectName}{ext}",
        );
        expect(visualConfig.expect?.toHaveScreenshot).toEqual({
            threshold: 0.2,
            maxDiffPixels: 0,
            animations: "disabled",
        });
        expect(
            (visualConfig.expect?.toHaveScreenshot as Record<string, unknown>).snapshotPathTemplate,
        ).toBeUndefined();
        expect(visualConfig.snapshotDir).toBe("tests/visual/__screenshots__");
        expect(visualConfig.retries).toBe(0);
    });
});

describe("visual harness configuration guards", () => {
    it("collects unique scripts and styles from the resolved host table", () => {
        expect(
            requiredDistAssets([
                { scriptFile: "one.js", styleFiles: ["one.css"] },
                { scriptFile: "one.js", styleFiles: ["two.css"] },
            ]),
        ).toEqual(["one.js", "one.css", "two.css"]);
    });

    it("can fail: a missing manifest entry reaches the fail-fast build guard", () => {
        const distDir = fixturePath("/repo/dist");
        const required = ["present.js", "missing.js"];
        const exists = (filePath: string): boolean => !filePath.endsWith("missing.js");

        expect(missingDistAssets(distDir, required, exists)).toEqual(["missing.js"]);
        // Asserted as two matches rather than one interpolated RegExp. A Windows path carries
        // backslashes, and `new RegExp("...\\repo\\dist\\missing.js...")` reads `\r` as a carriage
        // return and `\d` as a digit class, so the pattern silently stopped meaning the path it
        // was built from. `toThrow(string)` is a plain substring match and needs no escaping.
        const guard = (): unknown => assertRequiredDistAssets(distDir, required, exists);
        expect(guard).toThrow(path.join(distDir, "missing.js"));
        expect(guard).toThrow(/bun run build/);
    });

    it("can fail: a request that escaped the route interceptor reaches the teardown guard", () => {
        expect(() => assertNoNetworkEscapes(["https://outside.example/asset.js"])).toThrow(
            /escaped interceptor/,
        );
    });

    it.each([
        ["dark-modern-narrow", "dark-modern"],
        ["light-modern-wide", "light-modern"],
        ["hc-black-narrow", "hc-black"],
        ["hc-light-wide", "hc-light"],
    ] as const)("resolves %s to host fixture %s", (projectName, expected) => {
        expect(hostFixtureIdForProject(projectName)).toBe(expected);
    });

    it("can fail: an unrecognised project name cannot select a host fixture", () => {
        expect(() => hostFixtureIdForProject("unknown-wide")).toThrow(
            /does not identify a host fixture/,
        );
    });
});

describe("visual harness dist traversal guard", () => {
    const distDir = fixturePath("/repo/dist");

    it("resolves a normal dist asset below the dist root", () => {
        expect(resolveDistAssetPath(distDir, "/dist/webview-mergeeditor.js")).toBe(
            path.join(distDir, "webview-mergeeditor.js"),
        );
    });

    it("can fail: raw and encoded traversal paths are rejected", () => {
        const adversarialPaths = [
            "/dist/../../etc/passwd",
            "/dist/%2e%2e/%2e%2e/etc/passwd",
            "/dist/%252e%252e/%252e%252e/etc/passwd",
            "/dist/..%2F..%2Fetc/passwd",
            "/dist/%2Fetc/passwd",
        ];

        for (const requestPath of adversarialPaths) {
            expect(resolveDistAssetPath(distDir, requestPath), requestPath).toBeUndefined();
        }
    });
});
