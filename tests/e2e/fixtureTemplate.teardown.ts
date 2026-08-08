// Playwright teardown project (PLAN.md step 8, wired via playwright.e2e.config.ts's
// `fixtureTemplateSetup` project's `teardown` property). Thin wrapper only — all
// fixture-template logic lives in tests/fixtures/repo/runFixtureTeardown.ts, which
// is exercised directly by tests/unit/fixtures/runFixtureTeardown.test.ts. Nothing
// beyond the call belongs here.

import { test as teardown } from "@playwright/test";

import { runFixtureTeardown } from "../fixtures/repo/runFixtureTeardown";

teardown("remove fixture template", async () => {
    await runFixtureTeardown();
});
