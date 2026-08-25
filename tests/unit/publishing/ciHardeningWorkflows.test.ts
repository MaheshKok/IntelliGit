import { existsSync, readFileSync } from "node:fs";
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
    return workflow.slice(
        bodyStart,
        nextJobOffset === -1 ? workflow.length : bodyStart + nextJobOffset,
    );
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

/**
 * Returns the pinned refs a workflow uses for one action path, in file order.
 *
 * Deliberately returns the refs rather than comparing them to an expected constant. An exact SHA
 * written into a test is a value that only Dependabot ever changes, and Dependabot cannot edit the
 * test in the same pull request -- so every action bump arrives permanently red, and the cheapest
 * way out is to stop bumping. That is the opposite of what pinning is for. `workflowActionPinning`
 * already proves every reference in the directory is a full commit SHA, without enumerating any of
 * them, so what is left worth asserting here is the RELATIONSHIP between refs.
 */
function pinnedRefsFor(workflow: string, actionPath: string): readonly string[] {
    // Escapes every regex metacharacter, not the two an action path happens to contain today.
    // The earlier `[/.]` class left `\` among others live, which CodeQL flagged as incomplete
    // sanitization -- and the practical failure is worse than a crash: an unescaped quantifier
    // silently matches a DIFFERENT action, so the helper answers confidently about a line the
    // workflow never had.
    const escapedPath = actionPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`uses:\\s*${escapedPath}@([0-9a-f]{40})\\b`, "g");
    return [...workflow.matchAll(pattern)].map((match) => match[1]);
}

/**
 * Extracts a top-level workflow mapping -- `on:`, `concurrency:` -- so an assertion about a trigger
 * cannot be satisfied by an identical string sitting inside a job.
 */
function extractTopLevelBlock(workflow: string, key: string): string {
    const header = `\n${key}:\n`;
    const start = workflow.indexOf(header);
    if (start === -1) return "";

    const bodyStart = start + header.length;
    const nextTopLevelOffset = workflow.slice(bodyStart).search(/^[a-z]/m);
    return workflow.slice(
        bodyStart,
        nextTopLevelOffset === -1 ? workflow.length : bodyStart + nextTopLevelOffset,
    );
}

/** Returns the complete job-local permission map as rendered in a workflow. */
function jobPermissionEntries(job: string): readonly string[] {
    const permissions = job.match(
        /^        permissions:\n((?:^            [a-z-]+: [a-z-]+\n)+)/m,
    )?.[1];
    return (
        permissions
            ?.trim()
            .split("\n")
            .map((line) => line.trim()) ?? []
    );
}

describe("CI quality hardening workflows", () => {
    it("counts only the action it was asked about, whatever characters the path contains", () => {
        // `pinnedRefsFor` interpolates its argument into a regular expression, so any regex
        // metacharacter left unescaped stops being a literal. The dangerous direction is not the
        // crash -- it is the silent FALSE POSITIVE below, where `a+b` compiles to "one or more `a`
        // then `b`" and happily matches a `aaab` that no workflow ever mentioned. Every caller in
        // this file passes a literal today, so nothing is currently mis-measured; this pins the
        // helper's contract rather than today's luck, because the day someone asks it about an
        // action whose name carries a `.` or a `+`, a wrong answer here reads as a passing gate.
        // The two refs carry DIFFERENT shas deliberately. Sharing one would make matching the
        // decoy and matching the real line produce an identical array, and the case would pass
        // against the bug it is here to catch.
        const decoySha = "a".repeat(40);
        const realSha = "b".repeat(40);
        const workflow = `      - uses: aaab@${decoySha}\n      - uses: a+b@${realSha}\n`;

        expect(
            pinnedRefsFor(workflow, "a+b"),
            "a metacharacter in the requested path must match literally, not as a quantifier",
        ).toEqual([realSha]);

        // Backslash is asserted by name because it is the character the alert named, and the
        // escape above is an ENUMERATED class -- a later trim of it would go green on the `+`
        // case alone and quietly reopen the same finding. Unescaped, `a\b` is a word-boundary
        // assertion, so it matches the bare `a@...` decoy that follows no `b` at all.
        const boundaryDecoy = "c".repeat(40);
        const boundaryWorkflow = `      - uses: a@${boundaryDecoy}\n      - uses: a\\b@${realSha}\n`;

        expect(
            pinnedRefsFor(boundaryWorkflow, "a\\b"),
            "a backslash must match literally, not compile to a word-boundary assertion",
        ).toEqual([realSha]);
    });

    it("packages one verified VSIX and checksum before publishing the build artifact", () => {
        const buildJob = extractJobBlock(
            readRepositoryFile(".github/workflows/publish.yml"),
            "build",
        );
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
            (jobName) =>
                !extractJobBlock(publish, jobName).match(/^        timeout-minutes: \d+$/m),
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
        // let that through, taking the part that matters with it: the publishing credentials stay
        // in the release job, behind every gate above it.
        expect([...eligibilityJob.matchAll(/secrets\.([A-Z_]+)/g)].map(([, name]) => name)).toEqual(
            ["GITHUB_TOKEN"],
        );
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
        expect(attestJob).toContain(
            "subject-path: ${{ steps.release-artifact.outputs.vsix_path }}",
        );
        expect(releaseJob).toContain(
            "needs: [build, visual, e2e-full, package-smoke, release-eligibility, attest]",
        );
        // The publishing gates are the `if:` conditions and the jobs in `needs:`, all of which run
        // unattended. A deployment environment used to sit here too and is deliberately gone; the
        // ban and its reasoning live in `releaseNeverBlocksCi.test.ts`, which scans every job
        // rather than this one.
        expect(releaseJob).not.toMatch(/^\s+environment:/m);
        expect(releaseJob).toContain("needs.release-eligibility.outputs.version_changed == 'true'");
        expect(releaseJob).toContain("steps.release-artifact.outputs.vsix_path");
        expect(releaseJob).toContain("steps.release-artifact.outputs.checksum_path");
        expect(releaseJob).toContain("persist-credentials: false");
        expect(releaseJob).toContain("Refuse rebuilt-artifact recovery for a published version");
        expect(releaseJob).toContain(
            "A published version must be recovered from its original artifact",
        );
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
        const releaseJob = extractJobBlock(
            readRepositoryFile(".github/workflows/publish.yml"),
            "release",
        );
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
            expect(step).not.toMatch(
                /^\s+run:.*\$\{\{ steps\.release-artifact\.outputs\.vsix_path \}\}/m,
            );
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
        // `init` and `analyze` are two halves of one scan and share an on-disk database format.
        // Bumping one without the other is the realistic way this breaks -- and the one thing an
        // exact-SHA assertion could never catch, because it goes red for a correct bump and a split
        // bump alike. Asserting they MATCH catches the split and stays quiet for the bump.
        const initRefs = pinnedRefsFor(codeql, "github/codeql-action/init");
        const analyzeRefs = pinnedRefsFor(codeql, "github/codeql-action/analyze");
        expect(initRefs.length, "codeql.yml must run codeql-action/init").toBeGreaterThan(0);
        expect(analyzeRefs.length, "codeql.yml must run codeql-action/analyze").toBeGreaterThan(0);
        expect(
            [...new Set([...initRefs, ...analyzeRefs])].length,
            "codeql-action/init and /analyze must be pinned to the SAME commit; a split bump " +
                "pairs two versions of one scan against a shared database format",
        ).toBe(1);
        expect(codeql).toContain("build-mode: none");
        expect(codeql).not.toContain("build-mode: manual");
        expect(codeql).toMatch(/timeout-minutes: \d+/);
        expect(dependencyReview).toContain("pull_request:");
        expect(
            jobPermissionEntries(extractJobBlock(dependencyReview, "dependency-review")),
        ).toEqual(["contents: read"]);
        expect(
            pinnedRefsFor(dependencyReview, "actions/dependency-review-action").length,
            "dependency-review.yml must run dependency-review-action, SHA-pinned",
        ).toBe(1);
        expect(dependencyReview).toContain("fail-on-severity: high");
    });

    it("reports the portability legs on every pull request, so one of them can gate a merge", () => {
        const compatibility = readRepositoryFile(".github/workflows/compatibility.yml");
        const triggers = extractTopLevelBlock(compatibility, "on");

        // The reason the Windows leg was not a required status check was never a policy choice: the
        // workflow ran on a weekly schedule and on manual dispatch only, so it produced no check run
        // on a pull request at all. Requiring a context that never reports does not fail a merge, it
        // blocks one indefinitely, which is why the trigger has to land before the ruleset does.
        expect(
            triggers,
            "the portability workflow must run on pull requests, or its check cannot gate a merge",
        ).toMatch(/^ {4}pull_request:\n {8}branches:\n {12}- main\n/m);

        // Exact set equality, not an absence check per filter key. `paths:` is the one that bites
        // today, but `paths-ignore:` and `branches-ignore:` deadlock a required check in precisely
        // the same way, and an enumerated ban only ever covers the cases someone remembered. Any
        // new key under this trigger has to be justified against the deadlock before it is added.
        const pullRequestBlock =
            triggers.match(/^ {4}pull_request:\n((?: {8}.*\n| *\n)*)/m)?.[1] ?? "";
        expect(
            [...pullRequestBlock.matchAll(/^ {8}([a-z-]+):/gm)].map(([, key]) => key),
            "a filter here silences the workflow on the pull requests it excludes, and a required " +
                "check that stays silent blocks the merge instead of passing it",
        ).toEqual(["branches"]);

        // Three Windows shards and two POSIX legs run in parallel, so an uncancelled superseded
        // run holds five runners for a commit nobody will merge. The scheduled run is exempt by
        // the same reasoning inverted: exactly one is ever in flight, so cancelling it discards
        // that week's only result. Asserting the guard rather than a bare `true` is the point --
        // `cancel-in-progress: true` would typecheck as YAML and silently drop weekly results.
        expect(extractTopLevelBlock(compatibility, "concurrency")).toMatch(
            /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/,
        );

        // The required context is 'Installed package smoke (windows-latest)'. The Windows suite is
        // sharded, so no test job carries that name any more -- the verdict job does, and it
        // exists to fold "every shard succeeded" into the one context ruleset 12862467 watches. A
        // required context with no check run is the same deadlock as no trigger at all, arriving
        // by a different route, so the name has to survive every future reshape of the shards.
        expect(
            compatibility,
            "the required context is 'Installed package smoke (windows-latest)', which now only " +
                "exists while the verdict job keeps carrying that exact name",
        ).toContain("        name: Installed package smoke (windows-latest)\n");

        const verdict = extractJobBlock(compatibility, "windows-verdict");
        expect(
            verdict,
            "the verdict must wait on the shard job, or it reports before the tests it summarises",
        ).toMatch(/^        needs: windows$/m);

        // `always()` is what turns a failed shard into a FAILING verdict rather than a skipped
        // one. GitHub treats a skipped required check as satisfied, so without this line the gate
        // would pass in exactly the case it exists to block.
        expect(
            verdict,
            "a skipped required check counts as satisfied; the verdict must run unconditionally " +
                "and judge the shard result itself, not rely on implicit needs gating",
        ).toContain("if: always()");
        expect(
            verdict,
            "`always()` removed the implicit needs gating, so this explicit result test is the " +
                "entire verdict; nothing else fails this job",
        ).toMatch(/test "\$RESULT" = "success"/);
        expect(verdict).toContain("RESULT: ${{ needs.windows.result }}");

        // The shards must jointly cover the whole suite: `--shard` slices vitest's file list, and
        // the entries below partition it -- N slices of /N, each present exactly once.
        const windows = extractJobBlock(compatibility, "windows");
        expect(
            windows.match(/shard: \[(.*)\]/)?.[1],
            "the shard list must stay an exact partition of the suite",
        ).toBe("1/3, 2/3, 3/3");
        expect(
            windows,
            "every shard must pass its slice to vitest, or three jobs each run the full suite",
        ).toContain("bun run test --shard=${{ matrix.shard }}");
        expect(windows).toContain("runs-on: windows-latest");
    });

    it("keeps the Windows leg off the two costs that were measured, not guessed", () => {
        // Every assertion here guards a change that leaves the workflow GREEN and merely slow --
        // nothing in CI notices a cache that restores nothing, or an OS feature install nobody
        // needs. Both costs below were established by A/B on one commit rather than read off a
        // step name, because reading a duration and naming a cause is how the browser cache that
        // used to live here got written in the first place.
        const compatibility = readRepositoryFile(".github/workflows/compatibility.yml");
        const jobs = {
            compatibility: extractJobBlock(compatibility, "compatibility"),
            windows: extractJobBlock(compatibility, "windows"),
        };

        const stepOffsetIn = (job: string, jobId: string, stepName: string): number => {
            const offset = job.indexOf(`            - name: ${stepName}\n`);
            expect(
                offset,
                `the '${jobId}' job must still contain a step named '${stepName}'`,
            ).not.toBe(-1);
            return offset;
        };

        // Both jobs install and test the same way, so the invariants below hold for each of them;
        // the Windows job is where every cost was measured, but a regression in the POSIX job
        // would be the same mistake at a smaller price.
        for (const [jobId, job] of Object.entries(jobs)) {
            // Ordering is the whole mechanism. A cache step placed after the install it was meant
            // to accelerate restores into a directory that is already populated and saves what the
            // install just did anyway -- it costs time, saves none, and reads as configured in
            // every review. Measured on Windows: `bun install` 75s cold against 19s restored.
            expect(
                stepOffsetIn(job, jobId, "Restore the bun store"),
                `the cache in '${jobId}' must be restored before \`bun install\`, or it ` +
                    "accelerates nothing",
            ).toBeLessThan(stepOffsetIn(job, jobId, "Install dependencies"));

            const cacheStep = extractStepBlock(job, "Restore the bun store");
            expect(
                cacheStep,
                `the restore step in '${jobId}' must still be a real cache`,
            ).toContain("uses: actions/cache@");

            // `--with-deps` means two entirely different things by platform. On Linux it
            // apt-installs libraries Chromium cannot launch without. On Windows it runs DISM to
            // enable Media Foundation, a VIDEO CODEC pack, and that is the entire cost of the
            // step: 202s with the browser already restored from cache (run 32783641129 attempt 2)
            // against 200s with a cache miss and a fresh download (run 32785953517) -- the browser
            // is not what it spends its time on. Nothing in this repository records video, and the
            // only consumer takes screenshots. Making the flag unconditional again silently
            // returns ~190s per run to every shard that gates a merge, with no test failing.
            const playwrightRun =
                extractStepBlock(
                    job,
                    "Install the Playwright browser the comparator proof runs against",
                ).match(/^\s+run: (.+)$/m)?.[1] ?? "";
            expect(
                playwrightRun,
                `\`--with-deps\` in '${jobId}' must stay gated to Linux; on Windows it installs ` +
                    "video codecs that nothing here uses, and it is the whole cost of this step",
            ).toMatch(/runner\.os == 'Linux'.*--with-deps/);
            expect(
                playwrightRun,
                "the browser itself must still be installed on every platform",
            ).toContain("chromium");

            // The Playwright browser was cached here and has been removed: it changed this step's
            // cost by 2s while adding ~170MB to an archive Windows spends 73s untarring. Re-adding
            // it is a regression that looks like an optimisation, so the cache is pinned to the
            // bun store.
            expect(
                cacheStep.match(/^\s+path: (.+)$/m)?.[1],
                "the cache holds the bun store only; the browser measurably did not benefit from it",
            ).toBe("~/.bun/install/cache");

            // `hashFiles` returns an empty string for a path that matches nothing, so a typo here
            // does not fail -- it collapses the key to its bare prefix, and the first run to save
            // under that key owns it for every future run regardless of what the lockfile says
            // afterwards.
            const cacheKey = cacheStep.match(/^\s+key: (.+)$/m)?.[1] ?? "";
            const hashedFiles = [...cacheKey.matchAll(/hashFiles\('([^']+)'\)/g)].map(
                ([, file]) => file,
            );
            expect(hashedFiles, "the key must vary with the dependency set it caches").not.toEqual(
                [],
            );
            for (const file of hashedFiles) {
                expect(
                    existsSync(resolve(REPOSITORY_ROOT, file)),
                    `the key hashes '${file}', which does not exist -- hashFiles would return ` +
                        '"" and every run would collide on one permanently stale entry',
                ).toBe(true);
            }

            // A `restore-keys` prefix that is not a prefix of `key` matches nothing, so the
            // fallback silently stops existing and every dependency bump pays the full download
            // again.
            const restoreKey = (
                cacheStep.match(/restore-keys: \|\n((?:\s+\S.*\n)+)/)?.[1] ?? ""
            ).trim();
            expect(restoreKey, "a fallback prefix must be declared").not.toBe("");
            expect(
                cacheKey.slice(0, restoreKey.length),
                "restore-keys only ever matches a prefix of a saved key",
            ).toBe(restoreKey);
        }

        const defenderStepName =
            "Exclude the runner's working directories from Defender real-time scanning";
        const defender = extractStepBlock(jobs.windows, defenderStepName);

        // First step on purpose. Checkout alone writes tens of thousands of files, and an exclusion
        // added afterwards has already let Defender scan every one of them.
        expect(
            stepOffsetIn(jobs.windows, "windows", defenderStepName),
            "the exclusion must precede checkout, whose own writes are the first thing it covers",
        ).toBeLessThan(stepOffsetIn(jobs.windows, "windows", "Checkout code"));

        expect(
            defender,
            "`Add-MpPreference` does not exist off Windows, so the step must stay guarded",
        ).toContain("if: runner.os == 'Windows'");

        // This is the assertion with the worst consequence behind it. The Windows shards feed a
        // required status check: if a transient Defender failure fails this step, it fails the
        // shard and the verdict with it, and that blocks every merge in the repository to save
        // minutes on one of them. A skipped exclusion costs time and nothing else.
        expect(defender, "a required check must not be able to fail on an optimisation").toContain(
            "continue-on-error: true",
        );

        // `$env:TEMP` is not redundant with `RUNNER_TEMP`; it is the entry that matters most. The
        // fixture layer roots its work at `os.tmpdir()` -- `tests/fixtures/repo/harness.ts:126` for
        // the E2E workspaces, `runFixtureSetup.ts:46` for the template repository -- and on a
        // GitHub Actions Windows runner that resolves to `C:\Users\RUNNER~1\AppData\Local\Temp`,
        // documented at `tests/fixtures/repo/placeholderCanonicalization.ts:34`. `RUNNER_TEMP` is a
        // different directory on a different drive. Trimming the list to the two names that sound
        // like the right ones would leave every seeded Git repository scanned file by file.
        const requiredExclusions = [
            "$env:GITHUB_WORKSPACE",
            "$env:RUNNER_TEMP",
            "$env:TEMP",
            "$env:USERPROFILE\\.bun",
        ];
        for (const location of requiredExclusions) {
            expect(
                defender,
                `'${location}' is written to heavily by this job and must be excluded`,
            ).toContain(location);
        }
    });

    it("covers installed-package portability and makes Dependabot update both actionable ecosystems", () => {
        const compatibility = readRepositoryFile(".github/workflows/compatibility.yml");
        const dependabot = readRepositoryFile(".github/dependabot.yml");

        expect(compatibility).toContain("schedule:");
        expect(compatibility).toContain("workflow_dispatch:");
        expect(compatibility).toContain("timeout-minutes: 90");
        expect(compatibility).toContain("os: [ubuntu-latest, macos-latest]");
        expect(compatibility).toContain("runs-on: windows-latest");
        expect(compatibility).toContain("bun install --frozen-lockfile");
        expect(compatibility).toContain("bun run format:check");
        expect(compatibility).toContain("bun run lint");
        expect(compatibility).toContain("bun run typecheck");
        expect(compatibility).toContain("bun run build");
        expect(compatibility).toContain("bun run test");
        expect(compatibility).toContain("bun run package");
        expect(compatibility).toContain("xvfb-run -a bun run test:package-smoke");
        expect(compatibility).toMatch(
            /INTELLIGIT_VSCODE_VERSION=1\.132\.0 bun run test:package-smoke/,
        );
        expect(dependabot).toContain("package-ecosystem: github-actions");
        // A `dependency-type: development` assertion used to sit here and was pinning the defect in
        // place: it required the presence of a selector the `bun` ecosystem does not honour, so the
        // grouping it named silently matched nothing. Asserting a string is not asserting a
        // behaviour. `dependabotGroups.test.ts` now resolves the groups and checks which
        // dependencies each one actually claims, and bans that selector where it is ignored.
        expect(dependabot).toContain('update-types: ["minor", "patch"]');
        expect(dependabot).not.toContain("package-ecosystem: docker");

        // The JavaScript ecosystem is derived from the lockfile on disk rather than restated as a
        // constant, because the failure this guards against is the two DISAGREEING. Declaring `npm`
        // against a `bun.lock` produced five pull requests that each edited `package.json`, left the
        // lockfile untouched, and died on `bun install --frozen-lockfile` (asserted above) before a
        // single test ran. Pinning the string `bun` here would go green on that same repository the
        // day someone swapped the lockfile back; pairing them cannot.
        const lockfileEcosystems = [
            { lockfile: "bun.lock", ecosystem: "bun" },
            { lockfile: "package-lock.json", ecosystem: "npm" },
            { lockfile: "pnpm-lock.yaml", ecosystem: "pnpm" },
            { lockfile: "yarn.lock", ecosystem: "yarn" },
        ] as const;
        const present = lockfileEcosystems.filter((candidate) =>
            existsSync(resolve(REPOSITORY_ROOT, candidate.lockfile)),
        );
        expect(
            present.map((candidate) => candidate.lockfile),
            "exactly one JavaScript lockfile must exist; two would make the ecosystem ambiguous " +
                "and let Dependabot maintain the one CI does not install from",
        ).toHaveLength(1);
        const declared = [...dependabot.matchAll(/package-ecosystem:\s*(\S+)/g)].map(
            (match) => match[1],
        );
        expect(
            declared,
            `the repository installs from ${present[0]?.lockfile}, so Dependabot must update it via ` +
                `the '${present[0]?.ecosystem}' ecosystem; any other JavaScript ecosystem edits ` +
                "package.json without writing that lockfile and every proposal arrives unmergeable",
        ).toContain(present[0]?.ecosystem);
        expect(
            declared.filter((ecosystem) =>
                lockfileEcosystems.some(
                    (candidate) =>
                        candidate.ecosystem === ecosystem && ecosystem !== present[0]?.ecosystem,
                ),
            ),
            "no second JavaScript ecosystem may be declared alongside it",
        ).toEqual([]);
    });
});
