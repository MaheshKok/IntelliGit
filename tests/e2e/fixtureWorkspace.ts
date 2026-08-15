import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test as base } from "@playwright/test";

import {
    createFixtureWorkspace,
    type FixtureScenarioId,
    type FixtureWorkspace,
} from "../fixtures/repo/harness";

/** The per-test workspace plus its disposable control-channel directory. */
export interface FixtureWorkspaceFixture {
    readonly workspace: FixtureWorkspace;
    readonly channelDir: string;
}

type FixtureWorkspaceFixtures = {
    fixtureWorkspace: FixtureWorkspaceFixture;
    scenario: FixtureScenarioId;
};

/**
 * Playwright fixture that gives each real Electron test a fresh repository, profile, channel, and
 * scratch environment, then disposes the whole ownership tree even when the test or launch fails.
 */
export const test = base.extend<FixtureWorkspaceFixtures>({
    scenario: ["dirty", { option: true }],
    fixtureWorkspace: async ({ scenario }, use) => {
        const workspace = await createFixtureWorkspace({ scenario });
        try {
            const channelDir = path.join(path.dirname(workspace.profileDir), "channel");
            await mkdir(channelDir, { recursive: true });
            await use({ workspace, channelDir });
        } finally {
            await workspace.dispose();
        }
    },
});

export { expect };
