import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const WORKFLOW_PATH = resolve(__dirname, "../../../.github/workflows/publish.yml");
const DOCKERFILE_PATH = resolve(__dirname, "../../../tests/e2e/docker/Dockerfile");
const PACKAGE_JSON_PATH = resolve(__dirname, "../../../package.json");

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
});
