import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const WORKFLOW_PATH = resolve(__dirname, "../../../.github/workflows/publish.yml");
const DOCKERFILE_PATH = resolve(__dirname, "../../../tests/e2e/docker/Dockerfile");
const PACKAGE_JSON_PATH = resolve(__dirname, "../../../package.json");
const NIGHTLY_WORKFLOW_PATH = resolve(__dirname, "../../../.github/workflows/e2e-nightly.yml");
const WORKFLOWS_DIRECTORY = resolve(__dirname, "../../../.github/workflows");
const INSIDERS_WORKFLOW_PATH = resolve(WORKFLOWS_DIRECTORY, "e2e-insiders.yml");

/**
 * Extracts one top-level job from a workflow so assertions cannot be satisfied by another job.
 * Returns an empty string when the requested job is absent, allowing the caller to report the
 * missing contract as a test assertion instead of failing while parsing the fixture.
 */
function extractJobBlock(workflow: string, jobName: string): string {
    const header = `    ${jobName}:\n`;
    const start = workflow.indexOf(header);
    if (start === -1) {
        return "";
    }

    const bodyStart = start + header.length;
    const nextJobOffset = workflow.slice(bodyStart).search(/^    [a-z0-9-]+:\n/m);
    const bodyEnd = nextJobOffset === -1 ? workflow.length : bodyStart + nextJobOffset;

    // A job's own body is indented deeper than four spaces, so any trailing four-space comment
    // lines are the NEXT job's header comment. Leaving them in would attribute one job's prose to
    // the job above it -- which is a false pass waiting to happen, since a comment can say
    // anything an assertion looks for.
    return workflow.slice(bodyStart, bodyEnd).replace(/(?:^ {4}#.*\n)+$/m, "");
}

/** Extracts one named step from a job so an assertion cannot be satisfied by another job. */
function extractStepBlock(job: string, stepName: string): string {
    const header = `            - name: ${stepName}\n`;
    const start = job.indexOf(header);
    if (start === -1) {
        return "";
    }

    const bodyStart = start + header.length;
    const nextStepOffset = job.slice(bodyStart).search(/^            - name: /m);
    const bodyEnd = nextStepOffset === -1 ? job.length : bodyStart + nextStepOffset;
    return job.slice(start, bodyEnd);
}

/** The nightly workflow, or an empty string when it is absent, so a missing file reads as a
 * failed assertion rather than a thrown read. */
function readNightlyWorkflow(): string {
    return existsSync(NIGHTLY_WORKFLOW_PATH) ? readFileSync(NIGHTLY_WORKFLOW_PATH, "utf8") : "";
}

describe("publish visual workflow", () => {
    it("runs the visual suite through the pinned container wrapper", () => {
        const workflow = readFileSync(WORKFLOW_PATH, "utf8");

        expect(workflow).toMatch(
            /- name: Run visual suite in the pinned container\n\s+run: \.\/tests\/e2e\/docker\/run\.sh .*bun run test:visual/,
        );
    });

    it("can fail: the visual command never appears as a bare runner step", () => {
        const workflow = readFileSync(WORKFLOW_PATH, "utf8");
        const visualCommandLines = workflow
            .split("\n")
            .filter((line) => line.includes("bun run test:visual"));

        expect(visualCommandLines).toHaveLength(1);
        expect(visualCommandLines[0]).toContain("./tests/e2e/docker/run.sh");
    });

    it("waits for build, visual, and e2e-full before release", () => {
        const releaseJob = extractJobBlock(readFileSync(WORKFLOW_PATH, "utf8"), "release");
        const needsLine = releaseJob.match(/^\s+needs:.*$/m)?.[0].trim() ?? "";

        expect(needsLine, "release must wait for build, visual, and e2e-full").toBe(
            "needs: [build, visual, e2e-full]",
        );
    });

    it("never cancels an in-flight release run on main", () => {
        const workflow = readFileSync(WORKFLOW_PATH, "utf8");
        const cancelLine = workflow.match(/^\s*cancel-in-progress:\s*(.+)$/m)?.[1]?.trim() ?? "";

        expect(cancelLine, "the workflow must declare a concurrency cancellation policy").not.toBe(
            "",
        );

        // The concurrency group keys on event and ref, so two merges to main share it exactly.
        // Under `cancel-in-progress: true` the second merge kills the first one's release
        // mid-flight -- and a cancelled run reports no failure, shows no red X and notifies nobody,
        // so the version it was publishing is simply never released and nothing says so. Measured:
        // v0.25.3's release run died this way. Cancelling a superseded pull-request run is still
        // wanted, so the policy has to discriminate on the ref rather than being switched off.
        expect(
            cancelLine,
            "a main-branch release run must never be cancelled by a later push",
        ).not.toBe("true");
        expect(
            cancelLine,
            "cancellation must be decided by the ref, so pull-request runs still supersede",
        ).toContain("refs/heads/main");
    });

    it("decides the release from whether this version shipped, not from the previous commit", () => {
        const releaseJob = extractJobBlock(readFileSync(WORKFLOW_PATH, "utf8"), "release");
        const gateBlock = extractStepBlock(
            releaseJob,
            "Check whether this version still needs releasing",
        );

        expect(gateBlock, "the release job must carry a version gate step").not.toBe("");

        // Assert against what the shell executes, never the prose around it. The comment inside
        // this step explains the HEAD~1 failure it replaced, and a raw text match would read that
        // explanation as the defect itself -- a false red that gets "fixed" by deleting the
        // reasoning. Dropping comment lines keeps the assertion pointed at the code.
        const gate = gateBlock
            .split("\n")
            .filter((line) => !line.trimStart().startsWith("#"))
            .join("\n");

        // Reading `package.json` at HEAD~1 asks "did THIS commit bump the version". No later run
        // can act on that answer: when the bumping commit's own run is cancelled or fails before
        // reaching this job, the bump is orphaned, every subsequent commit reports "unchanged", and
        // that version can never publish -- with no failure anywhere to say so. Measured on this
        // repository: 0.25.2 (e2e-full failed) and 0.25.3 (run cancelled) were both stranded
        // exactly this way, and main could not publish either one afterwards.
        expect(
            gate,
            "the release gate must not decide from the previous commit's package.json",
        ).not.toMatch(/HEAD~1/);

        // The replacement must be idempotent state rather than an event: the absence of the GitHub
        // Release for the CURRENT version, which is the last artifact this job creates.
        expect(
            gate,
            "the release gate must ask whether the current version already has a GitHub Release",
        ).toMatch(/gh release view "v\$CURRENT_VERSION"/);

        // Re-running is only safe because every publishing step guards itself. Remove one of these
        // guards and the self-healing gate above becomes a double-publish, so they are asserted
        // here, next to the gate whose safety depends on them, rather than trusted.
        expect(
            extractStepBlock(releaseJob, "Create git tag"),
            "tagging must be a no-op when the tag already exists",
        ).toMatch(/already exists, skipping/);
        expect(releaseJob, "a live marketplace version must not be published twice").toContain(
            "steps.publish-status.outputs.vsce_published != 'true'",
        );
        expect(releaseJob, "an existing GitHub Release must be updated, not recreated").toContain(
            "steps.github-release-check.outputs.release_exists != 'true'",
        );
    });

    it("installs Bun in the E2E image from a checksummed artifact, never a piped remote script", () => {
        const dockerfile = readFileSync(DOCKERFILE_PATH, "utf8");

        // Not an enumerated ban on the one line this finding was filed against: ANY instruction
        // that pipes a fetch into a shell reopens it, whichever host, flags, or version argument
        // it carries. Comment lines are excluded because the rationale above that layer quotes
        // the very form it is banning.
        const pipedToShell = dockerfile
            .split("\n")
            .filter((line) => !line.trimStart().startsWith("#"))
            .filter((line) => /\bcurl\b/.test(line) && /\|\s*(?:ba)?sh(?:\s|$)/.test(line));

        expect(pipedToShell).toEqual([]);
        expect(dockerfile, "the archive must be pinned by checksum").toMatch(
            /^ARG BUN_SHA256=[0-9a-f]{64}$/m,
        );
        expect(dockerfile, "the download URL must derive from BUN_VERSION").toMatch(
            /bun-v\$\{BUN_VERSION\}\/bun-linux-x64\.zip/,
        );
        expect(dockerfile, "the checksum must be verified, not merely declared").toMatch(
            /\|\s*sha256sum -c -/,
        );
        expect(dockerfile, "the extracted binary must be proven to be that version").toMatch(
            /\[ "\$\(bun --version\)" = "\$\{BUN_VERSION\}" \]/,
        );
    });

    it("keeps the E2E Dockerfile Bun version in agreement with the publish workflow", () => {
        const dockerfile = readFileSync(DOCKERFILE_PATH, "utf8");
        const workflow = readFileSync(WORKFLOW_PATH, "utf8");
        const dockerfileVersion = dockerfile.match(/^ARG BUN_VERSION=([^\s#]+)$/m)?.[1];
        const publishVersion = workflow.match(/^\s+BUN_VERSION:\s*["']?([^"'\s]+)["']?\s*$/m)?.[1];

        expect(dockerfileVersion, "Dockerfile must declare a Bun version ARG").toBeDefined();
        expect(publishVersion, "publish workflow must declare BUN_VERSION").toBeDefined();
        expect(dockerfileVersion).toBe(publishVersion);
    });

    it("exposes the manifest guard as a package script", () => {
        const packageJson = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8")) as {
            scripts?: Record<string, string>;
        };

        expect(packageJson.scripts?.["verify:manifest"]).toBe(
            "node scripts/verifyNoE2eManifestCommand.js",
        );
    });

    it("runs the manifest guard in the build job between architecture and localization checks", () => {
        const buildJob = extractJobBlock(readFileSync(WORKFLOW_PATH, "utf8"), "build");
        const architectureStep = extractStepBlock(buildJob, "Check architecture boundaries");
        const manifestStep = extractStepBlock(
            buildJob,
            "Check manifest does not expose E2E control commands",
        );
        const localizationStep = extractStepBlock(buildJob, "Validate localization catalogs");

        expect(architectureStep).not.toBe("");
        expect(manifestStep).not.toBe("");
        expect(localizationStep).not.toBe("");
        expect(manifestStep).toContain("run: bun run verify:manifest");
        expect(buildJob.indexOf(manifestStep)).toBeGreaterThan(buildJob.indexOf(architectureStep));
        expect(buildJob.indexOf(manifestStep)).toBeLessThan(buildJob.indexOf(localizationStep));
    });

    it("records a skipped E2E gate in the newly created GitHub Release", () => {
        const releaseJob = extractJobBlock(readFileSync(WORKFLOW_PATH, "utf8"), "release");
        const createReleaseStep = extractStepBlock(
            releaseJob,
            "Create GitHub Release and upload VSIX",
        );
        const overrideCondition = 'if [ "${{ needs.e2e-full.result }}" != "success" ]; then';
        const conditionStart = createReleaseStep.indexOf(overrideCondition);
        const conditionEnd = createReleaseStep.indexOf("\n                  fi", conditionStart);
        const notesFlag = createReleaseStep.indexOf("--notes", conditionStart);

        expect(createReleaseStep).not.toBe("");
        expect(conditionStart).toBeGreaterThanOrEqual(0);
        expect(conditionEnd).toBeGreaterThan(conditionStart);
        expect(notesFlag).toBeGreaterThan(conditionStart);
        expect(notesFlag).toBeLessThan(conditionEnd);
        expect(createReleaseStep).toContain("E2E gate override");
        expect(createReleaseStep).toContain("skip_e2e_gate");

        const updateReleaseStep = extractStepBlock(releaseJob, "Update GitHub Release asset");
        expect(updateReleaseStep).toContain(overrideCondition);
        expect(updateReleaseStep).toContain("gh release edit");
        expect(updateReleaseStep).toContain("E2E gate override");
    });

    it("reasserts every release prerequisite and limits the e2e override", () => {
        const releaseJob = extractJobBlock(readFileSync(WORKFLOW_PATH, "utf8"), "release");
        const releaseIf = releaseJob.match(/^\s+if:.*$/m)?.[0] ?? "";

        expect(releaseIf, "release must not publish after cancellation").toContain("!cancelled()");
        expect(releaseIf, "release must reassert build success").toContain(
            "needs.build.result == 'success'",
        );
        expect(releaseIf, "release must reassert visual success").toContain(
            "needs.visual.result == 'success'",
        );
        expect(releaseIf, "release must require e2e-full or the explicit override").toContain(
            "needs.e2e-full.result == 'success'",
        );
        expect(releaseIf, "only skip_e2e_gate may override e2e-full").toContain(
            "inputs.skip_e2e_gate == true",
        );
    });

    it("keeps force_publish independent from the e2e override", () => {
        const workflow = readFileSync(WORKFLOW_PATH, "utf8");

        expect(workflow).toContain(
            "FORCE_PUBLISH: ${{ github.event_name == 'workflow_dispatch' && inputs.force_publish == true }}",
        );
        expect(workflow).toMatch(/skip_e2e_gate:\n\s+description:.*\n\s+type: boolean/);
    });

    it("runs e2e-full only for main pushes and manual dispatches", () => {
        const e2eFullJob = extractJobBlock(readFileSync(WORKFLOW_PATH, "utf8"), "e2e-full");

        expect(e2eFullJob, "publish.yml must define e2e-full").not.toBe("");
        expect(e2eFullJob, "e2e-full must be guarded off pull_request").toContain(
            "if: github.ref == 'refs/heads/main' && (github.event_name == 'push' || github.event_name == 'workflow_dispatch')",
        );
    });

    it("keeps the scheduled nightly workflow non-gating", () => {
        const publishWorkflow = readFileSync(WORKFLOW_PATH, "utf8");
        const releaseJob = extractJobBlock(publishWorkflow, "release");
        const nightlyWorkflow = existsSync(NIGHTLY_WORKFLOW_PATH)
            ? readFileSync(NIGHTLY_WORKFLOW_PATH, "utf8")
            : "";

        expect(releaseJob, "release must not reference the nightly workflow").not.toMatch(
            /nightly/i,
        );
        expect(nightlyWorkflow, "nightly workflow must exist").not.toBe("");
        expect(nightlyWorkflow).toContain("issues: write");
        expect(nightlyWorkflow).toContain("shard: [1, 2, 3, 4]");
        expect(nightlyWorkflow).toContain("--shard=${{ matrix.shard }}/4");
        expect(nightlyWorkflow).toContain("gh issue create");
    });

    it("sets the VS Code version override only in the Insiders workflow", () => {
        const setters = new Set(
            readdirSync(WORKFLOWS_DIRECTORY)
                .filter((entry) => entry.endsWith(".yml") || entry.endsWith(".yaml"))
                .filter((entry) =>
                    readFileSync(resolve(WORKFLOWS_DIRECTORY, entry), "utf8").match(
                        /^\s+INTELLIGIT_VSCODE_VERSION\s*:/m,
                    ),
                ),
        );
        const insidersWorkflow = existsSync(INSIDERS_WORKFLOW_PATH)
            ? readFileSync(INSIDERS_WORKFLOW_PATH, "utf8")
            : "";

        expect(setters, "only e2e-insiders.yml may set the version override").toEqual(
            new Set(["e2e-insiders.yml"]),
        );
        expect(insidersWorkflow).toMatch(/^\s+INTELLIGIT_VSCODE_VERSION\s*:\s*insiders\s*$/m);
    });

    it("runs the non-gating Insiders flow shards without caching a daily build", () => {
        const insidersWorkflow = existsSync(INSIDERS_WORKFLOW_PATH)
            ? readFileSync(INSIDERS_WORKFLOW_PATH, "utf8")
            : "";
        const insidersJob = extractJobBlock(insidersWorkflow, "e2e-insiders");

        expect(insidersWorkflow).toContain("schedule:");
        expect(insidersWorkflow).toContain("workflow_dispatch:");
        expect(insidersWorkflow).toContain("expected to be red sometimes");
        expect(insidersJob, "Insiders workflow must define its matrix job").not.toBe("");
        expect(insidersJob).toContain("shard: [1, 2, 3, 4]");
        expect(insidersJob).toMatch(
            /run: \.\/tests\/e2e\/docker\/run\.sh .*bun run test:e2e -- --shard=/,
        );

        // Every cache key a workflow can build is derived from the repo, which does not change
        // daily -- and `actions/cache` never overwrites an existing key. So any key for a
        // daily-moving build restores something `@vscode/test-electron` immediately discards and
        // re-downloads. Naming the VS Code cache path rather than `actions/cache` keeps this
        // assertion about the build that must stay fresh, not about caching in general.
        expect(
            insidersJob,
            "the daily Insiders build must not be restored from a non-rotating cache key",
        ).not.toContain("intelligit-e2e-container/vscode");

        const releaseJob = extractJobBlock(readFileSync(WORKFLOW_PATH, "utf8"), "release");
        expect(releaseJob).not.toMatch(/insiders/i);
    });

    it("aggregates and reuses the Insiders failure issue without granting runner write access", () => {
        const insidersWorkflow = existsSync(INSIDERS_WORKFLOW_PATH)
            ? readFileSync(INSIDERS_WORKFLOW_PATH, "utf8")
            : "";
        const insidersJob = extractJobBlock(insidersWorkflow, "e2e-insiders");
        const reportJob = extractJobBlock(insidersWorkflow, "report-failure");

        expect(reportJob, "Insiders reporting must aggregate flows and host fixtures").toContain(
            "needs: [e2e-insiders, host-fixture-compare]",
        );
        expect(reportJob).toContain("gh issue list");
        expect(reportJob).toContain("gh issue comment");
        expect(reportJob).toContain("gh issue create");
        expect(reportJob).toContain('TITLE: "VS Code Insiders E2E flow suite is failing"');
        expect(insidersJob).not.toMatch(/^\s+issues: write\s*$/m);
    });

    it("runs the Insiders host-fixture comparison through Playwright without cache or runner write access", () => {
        const insidersWorkflow = existsSync(INSIDERS_WORKFLOW_PATH)
            ? readFileSync(INSIDERS_WORKFLOW_PATH, "utf8")
            : "";
        const comparisonJob = extractJobBlock(insidersWorkflow, "host-fixture-compare");

        expect(comparisonJob, "Insiders host-fixture comparison job must exist").not.toBe("");
        expect(comparisonJob).not.toContain("INTELLIGIT_VSCODE_VERSION");
        expect(comparisonJob).toContain("--config playwright.e2e.config.ts");
        expect(comparisonJob).toContain("tests/e2e/hostFixtures/compare.spec.ts");
        expect(comparisonJob).toContain("./tests/e2e/docker/run.sh");
        expect(comparisonJob).not.toContain("intelligit-e2e-container/vscode");
        expect(comparisonJob).not.toMatch(/^\s+issues: write\s*$/m);
    });

    it("gates the release on a job that actually runs the flow suite", () => {
        const e2eFullJob = extractJobBlock(readFileSync(WORKFLOW_PATH, "utf8"), "e2e-full");

        // Without this the gate is a shape rather than a check: swapping the command for `echo ok`
        // leaves every other assertion in this file green while `release` waits on a job that
        // exercises nothing.
        expect(
            e2eFullJob,
            "e2e-full must run the flow suite through the container wrapper",
        ).toMatch(/run: \.\/tests\/e2e\/docker\/run\.sh .*bun run test:e2e/);
    });

    it("runs the nightly shards through the same container wrapper", () => {
        expect(
            readNightlyWorkflow(),
            "the nightly must run the sharded flow suite through the wrapper",
        ).toMatch(/run: \.\/tests\/e2e\/docker\/run\.sh .*bun run test:e2e -- --shard=/);
    });

    it("runs the nightly host-fixture staleness sweep through the pinned container", () => {
        const nightlyWorkflow = readNightlyWorkflow();
        const stalenessJob = extractJobBlock(nightlyWorkflow, "host-fixture-staleness");

        expect(stalenessJob, "host-fixture staleness job must exist").not.toBe("");
        expect(stalenessJob).toContain("tests/e2e/hostFixtures/staleness.spec.ts");
        expect(stalenessJob).toContain("--config playwright.e2e.config.ts");
        expect(stalenessJob).toContain("./tests/e2e/docker/run.sh");
        expect(stalenessJob).not.toMatch(/^\s+issues: write\s*$/m);
        // A job with no `permissions:` block of its own inherits the workflow-level grant, so the
        // absence of `issues: write` inside the job body proves nothing on its own -- adding it at
        // the top of the file would hand this job the write scope while the assertion above stayed
        // green. The workflow-level block is the other half of the effective permission.
        expect(
            nightlyWorkflow.slice(0, nightlyWorkflow.indexOf("\njobs:")),
            "the workflow-level permissions must not grant issues: write to every job",
        ).not.toMatch(/^\s*issues: write\s*$/m);
    });

    it("leaves a trace in the release log when the e2e gate was overridden", () => {
        const releaseJob = extractJobBlock(readFileSync(WORKFLOW_PATH, "utf8"), "release");

        expect(releaseJob, "an override must not publish silently").toContain(
            "if: needs.e2e-full.result != 'success'",
        );
    });

    it("reports a failing nightly once per run and reuses the issue it already opened", () => {
        const nightlyWorkflow = readNightlyWorkflow();

        // Reporting per shard would file up to four issues a night, and a nightly that stays
        // broken would file four more every night after that -- noise, not early warning.
        expect(
            extractJobBlock(nightlyWorkflow, "report-failure"),
            "reporting must aggregate the shards",
        ).toContain("needs: [e2e-nightly, host-fixture-staleness]");
        expect(
            extractJobBlock(nightlyWorkflow, "host-fixture-staleness"),
            "reporting must aggregate the host-fixture staleness sweep",
        ).not.toBe("");
        // A job's `if` carries GitHub's implicit `success()` gate unless it contains a status-check
        // function, so rewriting this to a bare `needs.<job>.result == 'failure'` expression stops
        // the notifier from ever firing -- while still reading like it aggregates both jobs.
        expect(
            extractJobBlock(nightlyWorkflow, "report-failure"),
            "the reporting condition must use a status-check function, not a bare needs.* expression",
        ).toMatch(/^\s+if: (failure\(\)|.*\b(always|cancelled)\()/m);
        expect(nightlyWorkflow, "a standing failure must reuse its open issue").toContain(
            "gh issue comment",
        );
        // Anchored to a whole line so this asserts the YAML key and not the phrase: the job
        // comments discuss `issues: write` in prose, and a substring check cannot tell the two
        // apart.
        expect(
            extractJobBlock(nightlyWorkflow, "e2e-nightly"),
            "the jobs that execute the suite must not be granted issues: write",
        ).not.toMatch(/^\s+issues: write\s*$/m);
    });
});
