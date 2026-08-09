import path from "node:path";

import { describe, expect, it } from "vitest";

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
        expect(visualConfig.expect?.toHaveScreenshot).toEqual({
            threshold: 0.2,
            maxDiffPixels: 0,
        });
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
        const distDir = "/repo/dist";
        const required = ["present.js", "missing.js"];
        const exists = (filePath: string): boolean => !filePath.endsWith("missing.js");

        expect(missingDistAssets(distDir, required, exists)).toEqual(["missing.js"]);
        expect(() => assertRequiredDistAssets(distDir, required, exists)).toThrow(
            new RegExp(`${path.join(distDir, "missing.js")}.*bun run build`),
        );
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
    const distDir = "/repo/dist";

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
