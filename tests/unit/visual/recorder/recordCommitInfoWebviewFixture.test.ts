/**
 * Spec-derived tests for `tests/visual/recorder/recordCommitInfoWebviewFixture.ts` -- Phase 2c-i's
 * one thin vertical slice: a REAL `CommitInfoViewProvider`, resolved through Phase 2a's capture
 * seam, driven against a REAL seeded git workspace (Phase 1's fixture repository), canonicalized
 * with Phase 2b, and serialized to the exact bytes a committed fixture carries.
 *
 * Every test here is written to be able to fail for a REAL reason:
 *  - "parses" fails if the recorder ever emits a shape `parseWebviewFixture` rejects.
 *  - "byte-identical across two independent roots" fails if canonicalization misses a source of
 *    nondeterminism (an absolute path, a per-run identifier) -- and is deliberately built from TWO
 *    separately seeded workspaces (`workspaceA`, `workspaceB`), never the same root recorded twice,
 *    because that would prove nothing about canonicalization at all.
 *  - "non-trivial" fails if the recorder captures zero messages (which would make the byte-equality
 *    test above pass trivially, for the wrong reason) or fails to carry recognizable production
 *    fields (a real commit message, a real file list) through to the serialized fixture.
 *  - "no leaked identity" fails if a future change to the recorded call chain starts threading an
 *    absolute path into a posted message that canonicalization does not know to rewrite.
 *  - "gate honored" fails if the recorder ever succeeds -- silently producing an empty or partial
 *    fixture -- while the E2E control channel gate it depends on is inactive.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createCommitInfoVscodeDouble } from "../../../visual/recorder/commitInfoVscodeDouble";

// Hoisted by vitest above the imports below -- `createCommitInfoVscodeDouble` is a plain,
// non-mocked import (not "vscode" itself), so it is already bound by the time "vscode" is first
// resolved through the production import chain this test file pulls in below. Mirrors the exact
// convention `tests/integration/extension/view-providers.integration.test.ts` already uses.
vi.mock("vscode", () => createCommitInfoVscodeDouble());

import { setE2eControlChannelActive } from "../../../../src/e2e/activationState";
import { resetE2eWebviewCaptureSinkForTests } from "../../../../src/e2e/webviewCapture";
import { seedFixtureTemplate, type FixtureTemplate } from "../../../fixtures/repo/seed";
import {
    COMMIT_INFO_CLEAN_SCENARIO,
    recordCommitInfoWebviewFixture,
} from "../../../visual/recorder/recordCommitInfoWebviewFixture";
import { parseWebviewFixture } from "../../../visual/recorder/validateWebviewFixture";
import { serializeWebviewFixture } from "../../../visual/recorder/webviewFixtureFile";

describe("recordCommitInfoWebviewFixture", () => {
    let parentDir: string;
    let workspaceA: FixtureTemplate;
    let workspaceB: FixtureTemplate;

    // Every scratch path this file allocated, registered the moment it EXISTS rather than read back
    // off `workspaceA`/`workspaceB` in `afterAll`. Seeding is a real `git` build and can fail: with
    // the old shape, a rejected `beforeAll` left both workspaces unassigned, so `workspaceA.home`
    // threw a TypeError that replaced the real seeding error in the report AND skipped `parentDir`'s
    // removal entirely -- leaking the scratch tree in exactly the run whose failure most needed to
    // be legible. Registering per-path also survives partial failure: if `root-a` seeds and `root-b`
    // throws, `Promise.all` rejects with neither assigned, but A's `HOME` is already recorded here.
    const scratchPaths: string[] = [];

    async function seedTracked(destination: string): Promise<FixtureTemplate> {
        const template = await seedFixtureTemplate(destination);
        scratchPaths.push(template.home);
        return template;
    }

    beforeAll(async () => {
        parentDir = await mkdtemp(path.join(tmpdir(), "intelligit-webview-recorder-fixture-test-"));
        scratchPaths.push(parentDir);
        // Two INDEPENDENT seeded destinations -- not the same root recorded twice -- so the
        // byte-equality test below actually exercises canonicalization instead of vacuously
        // comparing a recording against itself.
        [workspaceA, workspaceB] = await Promise.all([
            seedTracked(path.join(parentDir, "root-a")),
            seedTracked(path.join(parentDir, "root-b")),
        ]);
    }, 60_000);

    afterAll(async () => {
        await Promise.all(
            scratchPaths.map((scratchPath) => rm(scratchPath, { recursive: true, force: true })),
        );
    });

    beforeEach(() => {
        setE2eControlChannelActive(true);
    });

    afterEach(() => {
        setE2eControlChannelActive(false);
        resetE2eWebviewCaptureSinkForTests();
    });

    // `commits.conflictBase` ("Add conflict target"), not `commits.initial`: `GitOps.getCommitDetail`
    // runs `git diff-tree` WITHOUT `--root`, which is empty-output for a root commit by git's own
    // design (a root commit has no parent tree to diff against without that flag). Any ordinary,
    // non-root commit exercises the real `--name-status`/`--numstat` parsing this scenario needs to
    // prove "recognizable production fields", which the root commit cannot.
    function optionsFor(workspace: FixtureTemplate) {
        return {
            repoRoot: workspace.root,
            commitHash: workspace.commits.conflictBase,
            roots: { root: workspace.root, originRoot: workspace.originRoot, profileDir: "" },
            env: workspace.env,
        };
    }

    it("records a real end-to-end fixture that parseWebviewFixture accepts", async () => {
        const fixture = await recordCommitInfoWebviewFixture(optionsFor(workspaceA));

        const bytes = serializeWebviewFixture(fixture);
        const reparsed = parseWebviewFixture(JSON.parse(bytes));

        expect(reparsed.schemaVersion).toBe(fixture.schemaVersion);
        expect(reparsed.contextId).toBe("commit-info");
        expect(reparsed.scenario).toBe(COMMIT_INFO_CLEAN_SCENARIO);
        expect(reparsed).toEqual(fixture);
    });

    it("produces byte-identical fixtures from two independently seeded temp roots", async () => {
        // Sequential, not Promise.all: both recordings share the process-wide capture sink
        // (`captureWebviewViewProvider` always allocates through it), so running them concurrently
        // would interleave their messages.
        const fixtureA = await recordCommitInfoWebviewFixture(optionsFor(workspaceA));
        const fixtureB = await recordCommitInfoWebviewFixture(optionsFor(workspaceB));

        expect(serializeWebviewFixture(fixtureA)).toBe(serializeWebviewFixture(fixtureB));
    });

    it("captures a non-trivial payload carrying recognizable production fields", async () => {
        const fixture = await recordCommitInfoWebviewFixture(optionsFor(workspaceA));

        expect(fixture.messages.length).toBeGreaterThan(0);

        const setDetailMessages = fixture.messages.filter(
            (captured) =>
                typeof captured.message === "object" &&
                captured.message !== null &&
                (captured.message as { type?: unknown }).type === "setCommitDetail",
        );
        expect(setDetailMessages.length).toBeGreaterThan(0);

        const detail = (
            setDetailMessages[0].message as {
                detail: { message: string; files: Array<{ path: string; status: string }> };
            }
        ).detail;
        // "Add conflict target" adds exactly one file, `conflict.txt` (seed.ts's own
        // `buildMainAndTopicHistory`) -- proves the REAL git service produced this, not a
        // hand-fabricated stand-in.
        expect(detail.message).toBe("Add conflict target");
        expect(detail.files.length).toBeGreaterThan(0);
        expect(detail.files.every((file) => file.status === "A")).toBe(true);
        expect(detail.files.map((file) => file.path).sort()).toEqual(["conflict.txt"]);
    });

    it("never leaks the temp root, real HOME, or /Users/ into the serialized bytes", async () => {
        const fixture = await recordCommitInfoWebviewFixture(optionsFor(workspaceA));
        const bytes = serializeWebviewFixture(fixture);

        expect(bytes).not.toContain(workspaceA.root);
        expect(bytes).not.toContain(workspaceA.home);
        expect(bytes).not.toContain("/Users/");
        if (process.env.HOME) {
            expect(bytes).not.toContain(process.env.HOME);
        }
    });

    // The former "matches the committed fixture on disk, byte for byte" test used to live here.
    // It is now redundant with -- and strictly subsumed by -- `webviewFixtureGate.test.ts`'s
    // repo-wide regenerate-and-compare gate (PLAN.md step 13), which runs this exact byte
    // comparison for this recorder (and every other registered one) via
    // `webviewFixtureRegistry.ts`. Removed here rather than kept as a duplicate.

    it("fails loudly instead of silently recording nothing when the E2E gate is inactive", async () => {
        setE2eControlChannelActive(false);

        await expect(recordCommitInfoWebviewFixture(optionsFor(workspaceA))).rejects.toThrow(
            /E2E control channel/i,
        );
    });
});
