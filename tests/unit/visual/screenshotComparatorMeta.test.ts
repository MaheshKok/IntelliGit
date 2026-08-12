import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { chromium } from "@playwright/test";
import { expect, it } from "vitest";

// Derived from this file's own location, not `process.cwd()`: a cwd-derived root silently
// resolves to whatever directory the runner happened to start in, and every path below would
// then point at something that does not exist rather than failing where the mistake is.
const REPOSITORY_ROOT = path.resolve(__dirname, "../../..");
const NEGATIVE_SPEC_DIRECTORY = path.join(REPOSITORY_ROOT, "tests/visual/negative");
const PLAYWRIGHT_CLI = path.join(REPOSITORY_ROOT, "node_modules/@playwright/test/cli.js");
const PLAYWRIGHT_TEST_MODULE = path.join(REPOSITORY_ROOT, "node_modules/@playwright/test/index");
const VIEWPORT = { width: 160, height: 120 } as const;

interface PlaywrightRun {
    readonly exitCode: number | null;
    readonly output: string;
}

interface PngDimensions {
    readonly height: number;
    readonly width: number;
}

/** Creates a fixed viewport document whose only visible content is one solid-colour block. */
function solidColourDocument(colour: string): string {
    return `<!doctype html>
<html>
    <head>
        <style>
            html, body { width: ${VIEWPORT.width}px; height: ${VIEWPORT.height}px; margin: 0; overflow: hidden; }
            #pixel-comparator { width: ${VIEWPORT.width}px; height: ${VIEWPORT.height}px; background: ${colour}; }
        </style>
    </head>
    <body><div id="pixel-comparator"></div></body>
</html>`;
}

/** Writes a temporary config that carries only the visual screenshot assertion settings forward. */
async function writeComparatorConfig(tempDirectory: string): Promise<string> {
    const configPath = path.join(tempDirectory, "playwright.screenshotComparator.config.ts");
    const snapshotDirectory = path.join(tempDirectory, "snapshots");
    const visualConfigPath = path.join(REPOSITORY_ROOT, "playwright.visual.config");
    const config = `import { defineConfig } from ${JSON.stringify(PLAYWRIGHT_TEST_MODULE)};
import visualConfig from ${JSON.stringify(visualConfigPath)};

export default defineConfig({
    testDir: ${JSON.stringify(NEGATIVE_SPEC_DIRECTORY)},
    testMatch: /screenshotComparator\\.negative\\.ts$/,
    snapshotDir: ${JSON.stringify(snapshotDirectory)},
    reporter: [["list"]],
    workers: 1,
    retries: 0,
    projects: [
        {
            name: "pixel-comparator",
            use: {
                browserName: "chromium",
                viewport: { width: ${VIEWPORT.width}, height: ${VIEWPORT.height} },
            },
        },
    ],
    expect: {
        toHaveScreenshot: visualConfig.expect?.toHaveScreenshot,
    },
    snapshotPathTemplate: visualConfig.snapshotPathTemplate,
});
`;

    await writeFile(configPath, config, "utf8");
    return configPath;
}

/** Runs the repository-local Playwright CLI through Node and combines stdout/stderr. */
function runComparator(configPath: string): Promise<PlaywrightRun> {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [PLAYWRIGHT_CLI, "test", "--config", configPath], {
            cwd: REPOSITORY_ROOT,
            env: { ...process.env, CI: "1" },
            stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";

        child.stdout.on("data", (chunk: Buffer) => {
            output += chunk.toString();
        });
        child.stderr.on("data", (chunk: Buffer) => {
            output += chunk.toString();
        });
        child.once("error", reject);
        child.once("close", (exitCode) => resolve({ exitCode, output }));
    });
}

/** Recursively finds PNG artifacts so the assertion does not depend on Playwright's path internals. */
async function findPngFiles(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            files.push(...(await findPngFiles(entryPath)));
        } else if (entry.isFile() && entry.name.endsWith(".png")) {
            files.push(entryPath);
        }
    }

    return files;
}

/** Reads the PNG signature and IHDR dimensions without adding an image-processing dependency. */
async function readPngDimensions(filePath: string): Promise<PngDimensions> {
    const bytes = await readFile(filePath);
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

    expect(bytes.subarray(0, signature.length)).toEqual(signature);
    expect(bytes.subarray(12, 16).toString("ascii")).toBe("IHDR");

    return {
        width: bytes.readUInt32BE(16),
        height: bytes.readUInt32BE(20),
    };
}

/** Replaces the baseline with a valid PNG of the same fixed dimensions and a different solid colour. */
async function overwriteBaselineWithSolidColour(filePath: string): Promise<void> {
    const browser = await chromium.launch();

    try {
        const page = await browser.newPage({ viewport: VIEWPORT });
        await page.setContent(solidColourDocument("rgb(255, 70, 70)"));
        await page.screenshot({ path: filePath });
    } finally {
        await browser.close();
    }
}

it("proves missing, matching, and mismatching screenshot baselines", async () => {
    const tempDirectory = await mkdtemp(
        path.join(os.tmpdir(), "intelligit-screenshot-comparator-"),
    );

    let configPath: string | undefined;

    try {
        configPath = await writeComparatorConfig(tempDirectory);
        const snapshotDirectory = path.join(tempDirectory, "snapshots");

        const firstRun = await runComparator(configPath);
        expect(firstRun.exitCode).toBeGreaterThan(0);
        expect(firstRun.output).toMatch(/A snapshot doesn't exist/i);
        expect(firstRun.output).toMatch(/writing actual/i);

        const firstPngFiles = await findPngFiles(snapshotDirectory);
        expect(firstPngFiles).toHaveLength(1);
        const baselinePath = firstPngFiles[0];
        if (baselinePath === undefined) throw new Error("Playwright did not write a baseline PNG");
        const firstBaselineBytes = await readFile(baselinePath);
        expect(await readPngDimensions(baselinePath)).toEqual(VIEWPORT);

        const secondRun = await runComparator(configPath);
        expect(secondRun.exitCode).toBe(0);
        expect(await readFile(baselinePath)).toEqual(firstBaselineBytes);

        await overwriteBaselineWithSolidColour(baselinePath);
        expect(await readPngDimensions(baselinePath)).toEqual(VIEWPORT);

        const thirdRun = await runComparator(configPath);
        expect(thirdRun.exitCode).toBeGreaterThan(0);
        expect(thirdRun.output).toContain("expect(page).toHaveScreenshot(expected) failed");
        expect(thirdRun.output).not.toMatch(/A snapshot doesn't exist|missing snapshot/i);
    } finally {
        if (configPath !== undefined) await rm(configPath, { force: true });
        await rm(tempDirectory, { recursive: true, force: true });
    }
}, 60_000);
