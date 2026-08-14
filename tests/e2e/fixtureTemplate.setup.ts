// Playwright setup project (PLAN.md step 8, wired via playwright.e2e.config.ts's
// `fixtureTemplateSetup` project). Thin wrapper only — all fixture-template logic
// lives in tests/fixtures/repo/runFixtureSetup.ts, which is exercised directly by
// tests/unit/fixtures/runFixtureSetup.test.ts. Nothing beyond the call belongs here.

import { test as setup } from "@playwright/test";

import { runFixtureSetup } from "../fixtures/repo/runFixtureSetup";

setup("build fixture template", async () => {
    await runFixtureSetup();
});
