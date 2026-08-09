import { defineConfig } from "@playwright/test";

export default defineConfig({
    // Restrict discovery to the visual suite; recorder and harness helpers are
    // intentionally kept beside the specs but are not test files.
    testDir: "tests/visual",

    // Only `.spec.ts` files are executable visual tests, so helper directories
    // cannot be swept into collection by their location alone.
    testMatch: /.*\.spec\.ts$/,

    // Check the dist manifest before collection; otherwise a missing bundle
    // appears later as an opaque in-page 404 instead of naming the file and fix.
    globalSetup: "./tests/visual/playwright/globalSetup.ts",

    // A second browser instance adds font/layout scheduling noise without
    // increasing confidence in a suite whose output is intentionally fixed.
    workers: 1,
    fullyParallel: false,

    // A retry would hide the intermittent render this suite exists to detect.
    retries: 0,

    // Accidental `.only` selectors must fail CI instead of silently shrinking
    // the visual matrix; local iteration remains allowed.
    forbidOnly: Boolean(process.env.CI),

    use: {
        // This suite targets the Chromium renderer only; adding another engine
        // would create a second pixel contract rather than a useful baseline.
        browserName: "chromium",

        // GPU compositing changes antialiasing and layer rasterization between
        // machines, so disable it before any page is created.
        launchOptions: { args: ["--disable-gpu"] },

        // A fixed scale factor prevents the same CSS viewport from producing
        // different device-pixel dimensions on retina and non-retina hosts.
        deviceScaleFactor: 1,

        // Animations and transitions must settle at the same point before a
        // screenshot; `contextOptions` is Playwright's supported path for
        // forwarding this browser media emulation setting.
        contextOptions: { reducedMotion: "reduce" },

        // Locale- and timezone-dependent formatting must not vary by runner.
        timezoneId: "UTC",
        locale: "en-GB",
    },

    // Name each combination so a failure identifies both the host fixture and
    // viewport; `harnessPage` resolves the fixture id from this project name.
    projects: [
        {
            name: "dark-modern-narrow",
            use: { viewport: { width: 320, height: 720 } },
        },
        {
            name: "dark-modern-wide",
            use: { viewport: { width: 1200, height: 800 } },
        },
        {
            name: "light-modern-narrow",
            use: { viewport: { width: 320, height: 720 } },
        },
        {
            name: "light-modern-wide",
            use: { viewport: { width: 1200, height: 800 } },
        },
    ],

    // Declare screenshot comparison policy now; Phase 3-iv will add the first
    // assertions after container-generated baselines exist.
    expect: {
        toHaveScreenshot: {
            threshold: 0.2,
            maxDiffPixels: 0,
        },
    },

    // Keep future baselines separate from source fixtures and recorder output.
    snapshotDir: "tests/visual/__screenshots__",
});
