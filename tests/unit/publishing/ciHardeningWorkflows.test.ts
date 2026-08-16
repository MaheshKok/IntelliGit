import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const REPOSITORY_ROOT = resolve(__dirname, "../../..");

/** Reads a workflow or configuration file from the repository root. */
function readRepositoryFile(relativePath: string): string {
    return readFileSync(resolve(REPOSITORY_ROOT, relativePath), "utf8");
}

/**
 * Extracts a top-level GitHub Actions job, keeping assertions scoped to its own
 * configuration rather than allowing another job to satisfy them.
 */
function extractJobBlock(workflow: string, jobName: string): string {
    const header = `    ${jobName}:\n`;
    const start = workflow.indexOf(header);
    if (start === -1) return "";

    const bodyStart = start + header.length;
    const nextJobOffset = workflow.slice(bodyStart).search(/^    [a-z0-9-]+:\n/m);
    return workflow.slice(bodyStart, nextJobOffset === -1 ? workflow.length : bodyStart + nextJobOffset);
}

/** Extracts one named workflow step so its inputs cannot be supplied by a neighbouring step. */
function extractStepBlock(job: string, stepName: string): string {
    const header = `            - name: ${stepName}\n`;
    const start = job.indexOf(header);
    if (start === -1) return "";

    const bodyStart = start + header.length;
    const nextStepOffset = job.slice(bodyStart).search(/^            - name: /m);
    return job.slice(start, nextStepOffset === -1 ? job.length : bodyStart + nextStepOffset);
}

/** Returns the complete job-local permission map as rendered in a workflow. */
function jobPermissionEntries(job: string): readonly string[] {
    const permissions = job.match(/^        permissions:\n((?:^            [a-z-]+: [a-z-]+\n)+)/m)?.[1];
    return permissions?.trim().split("\n").map((line) => line.trim()) ?? [];
}

describe("CI quality hardening workflows", () => {
    it("packages one verified VSIX and checksum before publishing the build artifact", () => {
        const buildJob = extractJobBlock(readRepositoryFile(".github/workflows/publish.yml"), "build");
        const packageStep = extractStepBlock(buildJob, "Package extension");
        const uploadStep = extractStepBlock(buildJob, "Upload release artifacts");

        expect(buildJob).toMatch(/^        timeout-minutes: \d+$/m);
        expect(packageStep).toContain("run: bun run package");
        expect(buildJob).toContain("sha256sum");
        expect(uploadStep).toContain("extension-vsix");
        expect(uploadStep).toContain("*.vsix");
        expect(uploadStep).toContain("*.vsix.sha256");
        expect(uploadStep).toContain("if-no-files-found: error");
        expect(uploadStep).toMatch(/retention-days: \d+/);

        const publish = readRepositoryFile(".github/workflows/publish.yml");
        const jobsSection = publish.slice(publish.indexOf("\njobs:\n") + "\njobs:\n".length);
        const jobNames = [...jobsSection.matchAll(/^    ([a-z0-9-]+):$/gm)].map(([, name]) => name);
        const jobsMissingTimeouts = jobNames.filter(
            (jobName) => !extractJobBlock(publish, jobName).match(/^        timeout-minutes: \d+$/m),
        );
        expect(jobsMissingTimeouts).toEqual([]);
    });

    it("gates release through a compatibility-tested package, eligibility, and provenance attestation", () => {
        const publish = readRepositoryFile(".github/workflows/publish.yml");
        const packageSmokeJob = extractJobBlock(publish, "package-smoke");
        const eligibilityJob = extractJobBlock(publish, "release-eligibility");
        const attestJob = extractJobBlock(publish, "attest");
        const releaseJob = extractJobBlock(publish, "release");

        expect(packageSmokeJob).toContain("needs: build");
        expect(packageSmokeJob).toContain('vscode_version: ["1.96.0", "1.132.0"]');
        expect(packageSmokeJob).toContain("actions/download-artifact@");
        expect(packageSmokeJob).toContain("actions/cache@");
        expect(packageSmokeJob).toContain(
            "key: ${{ runner.os }}-package-smoke-vscode-${{ matrix.vscode_version }}",
        );
        expect(packageSmokeJob).toMatch(
            /INTELLIGIT_VSCODE_VERSION=\$\{\{ matrix\.vscode_version \}\} xvfb-run -a bun run test:package-smoke/,
        );
        expect(packageSmokeJob).toContain(
            "bun install --frozen-lockfile && bun run build && INTELLIGIT_VSCODE_VERSION=${{ matrix.vscode_version }} xvfb-run -a bun run test:package-smoke",
        );
        expect(eligibilityJob).toContain("version_changed");
        expect(eligibilityJob).toContain("new_version");
        expect(eligibilityJob).toContain("FORCE_PUBLISH");
        expect(eligibilityJob).not.toMatch(/^\s+(environment|secrets):/m);
        // Eligibility reads the release state over the API, so it needs the automatic per-run
        // token -- and nothing else. A blanket "no secrets." ban would have to be deleted whole to
        // let that through, taking the part that matters with it: the publishing credentials and
        // the marketplace environment stay in the release job, behind every gate above it.
        expect([...eligibilityJob.matchAll(/secrets\.([A-Z_]+)/g)].map(([, name]) => name)).toEqual([
            "GITHUB_TOKEN",
        ]);
        expect(attestJob).toContain("needs: [build, release-eligibility]");
        expect(jobPermissionEntries(attestJob)).toEqual([
            "contents: read",
            "id-token: write",
            "attestations: write",
        ]);
        expect(attestJob).toContain(
            "actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6 # v4.2.2",
        );
        expect(attestJob).not.toContain("attest-build-provenance");
        expect(attestJob).toContain("subject-path: ${{ steps.release-artifact.outputs.vsix_path }}");
        expect(releaseJob).toContain(
            "needs: [build, visual, e2e-full, package-smoke, release-eligibility, attest]",
        );
        expect(releaseJob).toContain("environment: marketplace-production");
        expect(releaseJob).toContain(
            "needs.release-eligibility.outputs.version_changed == 'true'",
        );
        expect(releaseJob).toContain("steps.release-artifact.outputs.vsix_path");
        expect(releaseJob).toContain("steps.release-artifact.outputs.checksum_path");
        expect(releaseJob).toContain("persist-credentials: false");
        expect(releaseJob).toContain("Refuse rebuilt-artifact recovery for a published version");
        expect(releaseJob).toContain("A published version must be recovered from its original artifact");
        const recoveryStep = extractStepBlock(
            releaseJob,
            "Refuse rebuilt-artifact recovery for a published version",
        );
        expect(recoveryStep).toContain("node scripts/verifyGhApiNotFound.js");
        expect(recoveryStep).toContain("Unable to determine whether the GitHub release exists");
        expect(releaseJob).not.toContain("Skip VS Code Marketplace publish");
        expect(releaseJob).not.toContain("Skip Open VSX publish");
        expect(releaseJob).not.toContain("git push origin");
        const tagStep = extractStepBlock(releaseJob, "Validate and create release tag");
        const marketplaceStep = extractStepBlock(releaseJob, "Publish to VS Code Marketplace");
        expect(tagStep).toContain("github.sha");
        expect(tagStep).toContain("gh api");
        expect(tagStep).toContain("git/ref/tags/");
        expect(tagStep).toContain(".object.type");
        expect(tagStep).toContain(".object.sha");
        expect(releaseJob.indexOf(tagStep)).toBeLessThan(releaseJob.indexOf(marketplaceStep));
        expect(eligibilityJob).toContain("node scripts/verifyReleaseVersion.js");
        expect(eligibilityJob).toContain("github.event.before");
        expect(eligibilityJob).toContain("--require-equal");
        expect(eligibilityJob).toContain("fetch-depth: 0");
        // These two lines used to assert that an unchanged version decides `version_changed=false`.
        // Both strings still appear in the step -- the comparison now only picks which validation
        // mode to run, and the `false` write now belongs to the HTTP 200 branch -- so pinning them
        // would keep passing while meaning something else entirely. What the job must actually do
        // is decide from the release state, so that is what is asserted.
        expect(eligibilityJob).toMatch(/releases\/tags\/v\$CURRENT_VERSION/);
        expect(
            eligibilityJob,
            "eligibility must not decide publication from a version comparison",
        ).not.toMatch(/if \[ "\$CURRENT_VERSION" != "\$PREVIOUS_VERSION" \]/);
        expect(releaseJob).not.toMatch(/\bls\b[^\n]*\.vsix/);
        expect(releaseJob).not.toMatch(/(?:vsce|ovsx) publish[^\n]*\*\.vsix/);
        expect(releaseJob).not.toMatch(/gh release (?:create|upload)[^\n]*\*\.vsix/);
    });

    it("passes the verified VSIX path through each marketplace step environment", () => {
        const releaseJob = extractJobBlock(readRepositoryFile(".github/workflows/publish.yml"), "release");
        const marketplaceContracts = [
            {
                name: "Publish to VS Code Marketplace",
                command: 'run: bunx vsce publish --packagePath "$VSIX_PATH" -p "$VSCE_PAT"',
                token: "VSCE_PAT: ${{ secrets.VSCE_PAT }}",
            },
            {
                name: "Publish to Open VSX",
                command: 'run: bunx ovsx publish -p "$OVSX_PAT" "$VSIX_PATH"',
                token: "OVSX_PAT: ${{ secrets.OVSX_PAT }}",
            },
        ];

        for (const contract of marketplaceContracts) {
            const step = extractStepBlock(releaseJob, contract.name);
            expect(step, `${contract.name} step must exist`).not.toBe("");
            expect(step).toContain("VSIX_PATH: ${{ steps.release-artifact.outputs.vsix_path }}");
            expect(step).toContain(contract.command);
            expect(step).toContain(contract.token);
            expect(step).not.toMatch(/^\s+run:.*\$\{\{ steps\.release-artifact\.outputs\.vsix_path \}\}/m);
        }
    });

    it("keeps the static analysis and dependency-review grants narrowly scoped", () => {
        const codeql = readRepositoryFile(".github/workflows/codeql.yml");
        const dependencyReview = readRepositoryFile(".github/workflows/dependency-review.yml");

        expect(codeql).toContain("pull_request:");
        expect(codeql).toContain("schedule:");
        expect(jobPermissionEntries(extractJobBlock(codeql, "codeql"))).toEqual([
            "contents: read",
            "security-events: write",
        ]);
        expect(codeql).toContain("github/codeql-action/init@bb16b9baa2ec4010b29f5c606d57d01190139edd # v4.37.1");
        expect(codeql).toContain("github/codeql-action/analyze@bb16b9baa2ec4010b29f5c606d57d01190139edd # v4.37.1");
        expect(codeql).toContain("build-mode: none");
        expect(codeql).not.toContain("build-mode: manual");
        expect(codeql).toMatch(/timeout-minutes: \d+/);
        expect(dependencyReview).toContain("pull_request:");
        expect(jobPermissionEntries(extractJobBlock(dependencyReview, "dependency-review"))).toEqual([
            "contents: read",
        ]);
        expect(dependencyReview).toContain(
            "actions/dependency-review-action@a1d282b36b6f3519aa1f3fc636f609c47dddb294 # v5.0.0",
        );
        expect(dependencyReview).toContain("fail-on-severity: high");
    });

    it("covers installed-package portability and makes Dependabot update both actionable ecosystems", () => {
        const compatibility = readRepositoryFile(".github/workflows/compatibility.yml");
        const dependabot = readRepositoryFile(".github/dependabot.yml");

        expect(compatibility).toContain("schedule:");
        expect(compatibility).toContain("workflow_dispatch:");
        expect(compatibility).toContain("timeout-minutes: 90");
        expect(compatibility).toContain("os: [ubuntu-latest, macos-latest, windows-latest]");
        expect(compatibility).toContain("bun install --frozen-lockfile");
        expect(compatibility).toContain("bun run format:check");
        expect(compatibility).toContain("bun run lint");
        expect(compatibility).toContain("bun run typecheck");
        expect(compatibility).toContain("bun run build");
        expect(compatibility).toContain("bun run test");
        expect(compatibility).toContain("bun run package");
        expect(compatibility).toContain("xvfb-run -a bun run test:package-smoke");
        expect(compatibility).toMatch(/INTELLIGIT_VSCODE_VERSION=1\.132\.0 bun run test:package-smoke/);
        expect(dependabot).toContain("package-ecosystem: github-actions");
        expect(dependabot).toContain("package-ecosystem: npm");
        expect(dependabot).toContain("dependency-type: development");
        expect(dependabot).toContain('update-types: ["minor", "patch"]');
        expect(dependabot).not.toContain("package-ecosystem: docker");
    });
});
