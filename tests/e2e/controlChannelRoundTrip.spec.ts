// Phase 4 seam acceptance: a real Playwright process reaches a real VS Code
// Extension Development Host through the file-exchange control channel. Each
// assertion guards a different contract: allowlisted memento round-trip,
// allowlist rejection, and secret redaction.

import { expect, test } from "./fixtureWorkspace";
import { E2eControlChannelClient } from "./controlChannelClient";
import { launchFixtureWorkspace } from "./hostFixtures/electronLaunchHelpers";
import { resolveVSCodeExecutable } from "./hostFixtures/resolveVSCodeExecutable";

import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../..");
const SECRET_PLAINTEXT = "probe-token-do-not-echo-6f2a91";

test("the E2E control channel round-trips against a real VS Code host without a manual activation wait", async ({
    fixtureWorkspace,
}) => {
    test.setTimeout(240_000);
    const executablePath = await resolveVSCodeExecutable(REPO_ROOT);
    const electronApp = await launchFixtureWorkspace({
        executablePath,
        repoRoot: REPO_ROOT,
        workspace: fixtureWorkspace.workspace,
        channelDir: fixtureWorkspace.channelDir,
        timeout: 60_000,
    });

    try {
        const window = await electronApp.firstWindow();
        await window.waitForLoadState("domcontentloaded");
        const channel = new E2eControlChannelClient(fixtureWorkspace.channelDir);

        // The first request is issued immediately after the host document loads. The client
        // waits for the server-published readiness marker; no activity-bar click or other
        // activation-forcing UI action is allowed to hide a startup drain regression.
        const seeded = await channel.request({
            store: "memento",
            scope: "workspace",
            key: "intelligit.selectedRepositoryRoot",
            operation: "seed",
            value: "/probe/seeded/path",
        });
        expect(seeded.ok, `seed failed: ${seeded.ok ? "" : seeded.error}`).toBe(true);

        const snapshot = await channel.request({
            store: "memento",
            scope: "workspace",
            key: "intelligit.selectedRepositoryRoot",
            operation: "snapshot",
        });
        expect(snapshot.ok, `snapshot failed: ${snapshot.ok ? "" : snapshot.error}`).toBe(true);
        expect(
            snapshot.ok && snapshot.result?.kind === "value" ? snapshot.result.value : undefined,
        ).toBe("/probe/seeded/path");

        const rejected = await channel.request({
            store: "memento",
            scope: "workspace",
            key: "intelligit.definitelyNotAllowlisted",
            operation: "snapshot",
        });
        expect(rejected.ok).toBe(false);

        const secretSeed = await channel.request({
            store: "secret",
            key: "intelligit.commitChecks.token:probe.example",
            operation: "seed",
            value: SECRET_PLAINTEXT,
        });
        expect(secretSeed.ok, `secret seed failed: ${secretSeed.ok ? "" : secretSeed.error}`).toBe(
            true,
        );

        const secretSnapshot = await channel.request({
            store: "secret",
            key: "intelligit.commitChecks.token:probe.example",
            operation: "snapshot",
        });
        expect(secretSnapshot.ok).toBe(true);
        expect(secretSnapshot.ok ? secretSnapshot.result : undefined).toMatchObject({
            kind: "secretPresence",
            present: true,
        });
        expect(JSON.stringify(secretSnapshot)).not.toContain(SECRET_PLAINTEXT);
    } finally {
        await electronApp.close();
    }
});
