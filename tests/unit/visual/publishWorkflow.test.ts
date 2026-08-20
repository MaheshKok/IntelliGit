import { spawnSync } from "node:child_process";
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { oracles } from "../../oracles";

const { sanitizedGitEnv } = oracles.get("gitEnv");

const REPOSITORY_ROOT = resolve(__dirname, "../../..");
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

/** Indent of a step's `run: |` body: `- name:` sits at 12, its keys at 14, the block scalar at 18. */
const RUN_BODY_INDENT = " ".repeat(18);

/**
 * Extracts a step's `run: |` script and dedents it, so a test can EXECUTE what CI executes
 * instead of pattern-matching the YAML around it. A regex over the workflow text can only ever
 * prove that some characters are present; it cannot prove the shell they form rejects anything.
 */
function extractRunScript(step: string): string {
    const marker = `\n${" ".repeat(14)}run: |\n`;
    const start = step.indexOf(marker);
    if (start === -1) {
        return "";
    }

    const script: string[] = [];
    for (const line of step.slice(start + marker.length).split("\n")) {
        if (line.trim() === "") {
            script.push("");
            continue;
        }
        if (!line.startsWith(RUN_BODY_INDENT)) {
            break;
        }
        script.push(line.slice(RUN_BODY_INDENT.length));
    }
    return script.join("\n");
}

/** The repository slug the stubbed steps are made to ask about, and asserted against. */
const STUB_REPOSITORY = "test-owner/test-repo";

/** What one execution of the version gate did: its exit status and what it appended to the outputs file. */
interface VersionGateRun {
    readonly status: number | null;
    readonly outputs: string;
    readonly stderr: string;
    /** Every argument the stubbed `gh` was invoked with, one per element. Empty when unstubbed. */
    readonly ghArgs: readonly string[];
}

/** How the stubbed `gh` should answer, when the gate is allowed to reach it. */
interface GhStub {
    readonly status: number;
    /**
     * What `gh api -i` writes to stdout: the HTTP status line first, then headers and body. The
     * step reads only that first line, so this is what decides the branch under test.
     */
    readonly stdout: string;
    /** gh's own prose, which the real binary writes to stderr alongside the response. */
    readonly stderr?: string;
}

interface VersionGateOptions {
    /** Defaults to true, taking the early-exit branch and never reaching `gh`. */
    readonly forcePublish?: boolean;
    readonly gh?: GhStub;
    /**
     * The version in `package.json` one commit back, which the step reads out of git.
     *
     * Defaults to `version`. An unchanged version is the orphaned-bump case the state gate exists
     * for, and it is the only shape the force-publish recovery branch accepts -- so it is also the
     * default that lets a caller say nothing and still exercise a coherent scenario.
     */
    readonly previousVersion?: string;
    /** Extra step inputs, for run scripts that read something other than package.json. */
    readonly env?: Readonly<Record<string, string>>;
}

/**
 * Runs one release-workflow shell step against a crafted repository, in a throwaway workspace.
 *
 * The step reads the previous version out of git rather than being told it, so the workspace is a
 * real two-commit repository: a fake cannot stand in for `git show HEAD~1:package.json`, and the
 * fallback that fires when git answers nothing is a different branch of the step. The whole thing
 * runs under `sanitizedGitEnv` for the reason spelled out in `runTagStep` -- an inherited `GIT_DIR`
 * outranks `cwd`, and the gate would then read a version out of whichever repository that names.
 *
 * `scripts/` is copied in rather than reached for through a relative path: the step runs with the
 * workspace as its working directory, exactly as it does on a runner checkout, so `node
 * scripts/verifyReleaseVersion.js` has to resolve from there or the validation silently never runs.
 *
 * `FORCE_PUBLISH=true` takes the early-exit branch, so the gate never reaches `gh` and the test
 * needs no network, no token, and no GitHub. That branch is also the strictest place to test input
 * validation from: it writes to `$GITHUB_OUTPUT` and exits before the release-state check, so a
 * validation placed anywhere later would not protect it.
 *
 * Passing `gh` instead puts a stub earlier on PATH than the real binary and lets the gate run all
 * the way through the release-state check, so the branch that decides whether to publish is
 * executed rather than pattern-matched. The stub answers exactly as gh 2.87.3 was measured to --
 * status line on stdout, prose on stderr -- because that split is the only thing separating "no
 * such release" from "the API is broken".
 */
function runVersionGate(script: string, version: string, options: VersionGateOptions = {}) {
    const workspace = mkdtempSync(join(tmpdir(), "publish-version-gate-"));
    try {
        const outputPath = join(workspace, "github-output");
        const ghArgsPath = join(workspace, "gh-args");
        const packageJsonPath = join(workspace, "package.json");

        const gitEnv = sanitizedGitEnv({
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_SYSTEM: "/dev/null",
            HOME: workspace,
        });
        const git = (...args: readonly string[]) => {
            const result = spawnSync("git", args, {
                cwd: workspace,
                encoding: "utf8",
                env: gitEnv,
            });
            if (result.status !== 0) {
                throw new Error(
                    `git ${args.join(" ")} failed with status ${result.status}: ${result.stderr ?? ""}`,
                );
            }
        };
        git("init", "--initial-branch=main");
        git("config", "user.email", "test@example.invalid");
        git("config", "user.name", "Test");
        writeFileSync(
            packageJsonPath,
            JSON.stringify({ version: options.previousVersion ?? version }),
        );
        git("add", "package.json");
        git("commit", "-m", "previous");
        writeFileSync(packageJsonPath, JSON.stringify({ version }));
        git("add", "package.json");
        // `--allow-empty` because the default scenario is a version that did NOT change, which is
        // precisely the state the gate has to resolve over the API instead of from the diff.
        git("commit", "--allow-empty", "-m", "current");

        mkdirSync(join(workspace, "scripts"));
        for (const scriptName of ["verifyReleaseVersion.js", "verifyGhApiNotFound.js"]) {
            copyFileSync(
                join(REPOSITORY_ROOT, "scripts", scriptName),
                join(workspace, "scripts", scriptName),
            );
        }

        writeFileSync(join(workspace, "gate.sh"), script);
        writeFileSync(outputPath, "");

        const path = [process.env.PATH ?? ""];
        if (options.gh) {
            const binDir = join(workspace, "bin");
            mkdirSync(binDir);
            // Each stream gets its own file, so no amount of quoting in either can break the stub
            // and the split between them stays faithful to the real binary: measured on gh 2.87.3,
            // `-i` prints the status line on STDOUT for 200, 404 and 401 alike while gh's own
            // prose goes to stderr. Parsing one and logging the other is exactly what the step
            // under test relies on, so a stub that merged them would not exercise it.
            writeFileSync(join(binDir, "gh-stdout"), options.gh.stdout);
            writeFileSync(join(binDir, "gh-stderr"), options.gh.stderr ?? "");
            writeFileSync(ghArgsPath, "");
            writeFileSync(
                join(binDir, "gh"),
                `#!/usr/bin/env bash\n` +
                    // One argument per line, so a test can assert WHAT was asked rather than only
                    // what the canned answer produced. A step that queried the wrong tag -- a
                    // dropped "v" prefix, say -- satisfies every assertion about the outputs.
                    `printf '%s\\n' "$@" > "${ghArgsPath}"\n` +
                    `cat "${binDir}/gh-stdout"\n` +
                    `cat "${binDir}/gh-stderr" >&2\n` +
                    `exit ${options.gh.status}\n`,
                { mode: 0o755 },
            );
            path.unshift(binDir);
        }

        const result = spawnSync("bash", ["-e", join(workspace, "gate.sh")], {
            cwd: workspace,
            encoding: "utf8",
            env: {
                ...gitEnv,
                GITHUB_OUTPUT: outputPath,
                FORCE_PUBLISH: String(options.forcePublish ?? true),
                PATH: path.join(":"),
                ...options.env,
                // Last on purpose: the recorded arguments are asserted against this exact slug, so
                // neither a caller's overlay nor an ambient GITHUB_REPOSITORY may redirect it.
                GITHUB_REPOSITORY: STUB_REPOSITORY,
            },
        });

        return {
            status: result.status,
            outputs: readFileSync(outputPath, "utf8"),
            stderr: result.stderr ?? "",
            ghArgs: options.gh
                ? readFileSync(ghArgsPath, "utf8")
                      .split("\n")
                      .filter((argument) => argument !== "")
                : [],
        } satisfies VersionGateRun;
    } finally {
        rmSync(workspace, { recursive: true, force: true });
    }
}

/** The commit this release run publishes, and the one an earlier run's tag was left naming. */
const RELEASE_SHA = "1111111111111111111111111111111111111111";
const STRANDED_SHA = "2222222222222222222222222222222222222222";

/**
 * Runs the release tag step against a stubbed GitHub whose tag state the test chooses.
 *
 * The step reads and writes the LIVE tag over the API, not through git: the release job checks out
 * with `persist-credentials: false`, so a local `git push` has no credentials to push with and a
 * git fixture would be testing a mechanism the runner does not have. The API stub is therefore the
 * faithful stand-in, and it is stateful on purpose -- the create path re-reads the ref it just
 * wrote, so a stub that answered 404 twice would let a step that created nothing pass anyway.
 */
function runTagStep(script: string, tagPlacement: "head" | "older" | "absent") {
    const workspace = mkdtempSync(join(tmpdir(), "publish-tag-step-"));
    try {
        const binDir = join(workspace, "bin");
        const statePath = join(workspace, "live-tag-sha");
        const ghArgsPath = join(workspace, "gh-args");
        mkdirSync(binDir);
        writeFileSync(ghArgsPath, "");
        writeFileSync(
            statePath,
            tagPlacement === "absent" ? "" : tagPlacement === "head" ? RELEASE_SHA : STRANDED_SHA,
        );
        writeFileSync(
            join(binDir, "gh"),
            `#!/usr/bin/env bash\n` +
                // Appended, not overwritten: the create path calls gh three times and every one of
                // them is evidence. A test that only saw the last call could not tell a step that
                // created the ref from one that merely read it twice.
                `printf '%s\\n' "$@" >> "${ghArgsPath}"\n` +
                `for argument in "$@"; do\n` +
                `  if [ "$argument" = "POST" ]; then\n` +
                `    for value in "$@"; do\n` +
                `      case "$value" in sha=*) printf '%s' "\${value#sha=}" > "${statePath}" ;; esac\n` +
                `    done\n` +
                `    echo '{}'\n` +
                `    exit 0\n` +
                `  fi\n` +
                `done\n` +
                // A read. The step passes `--jq`, so what it captures is the projected TSV rather
                // than the JSON body -- answering with JSON here would test a parser nobody runs.
                `if [ -s "${statePath}" ]; then\n` +
                `  printf 'commit\\t%s\\n' "$(cat "${statePath}")"\n` +
                `  exit 0\n` +
                `fi\n` +
                `echo 'gh: Not Found (HTTP 404)' >&2\n` +
                `exit 1\n`,
            { mode: 0o755 },
        );

        writeFileSync(join(workspace, "tag.sh"), script);
        const result = spawnSync("bash", ["-e", join(workspace, "tag.sh")], {
            cwd: workspace,
            encoding: "utf8",
            env: {
                ...process.env,
                PATH: `${binDir}:${process.env.PATH ?? ""}`,
                NEW_VERSION: "9.9.9",
                EXPECTED_SHA: RELEASE_SHA,
                GITHUB_REPOSITORY: STUB_REPOSITORY,
            },
        });

        return {
            status: result.status,
            stderr: result.stderr ?? "",
            /** What the tag names on GitHub afterwards -- "" when it was never created. */
            liveTagCommit: readFileSync(statePath, "utf8"),
            ghArgs: readFileSync(ghArgsPath, "utf8")
                .split("\n")
                .filter((argument) => argument !== ""),
            head: RELEASE_SHA,
            older: STRANDED_SHA,
        };
    } finally {
        rmSync(workspace, { recursive: true, force: true });
    }
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

    it("waits for every build, validation, eligibility, and attestation gate before release", () => {
        const releaseJob = extractJobBlock(readFileSync(WORKFLOW_PATH, "utf8"), "release");
        const needsLine = releaseJob.match(/^\s+needs:.*$/m)?.[0].trim() ?? "";

        expect(
            needsLine,
            "release must wait for build, validation, eligibility, and attestation",
        ).toBe("needs: [build, visual, e2e-full, package-smoke, release-eligibility, attest]");
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
        // The whole comparison, not its parts. `!= "true"` plus `contains "refs/heads/main"` is
        // satisfied by `github.ref == 'refs/heads/main'` -- the exact inversion, which cancels
        // release runs and never supersedes a pull-request run. Whitespace is normalized so the
        // assertion survives reformatting without loosening into that hole again.
        expect(
            cancelLine.replace(/\s+/g, ""),
            "cancellation must be `github.ref != refs/heads/main`: main runs survive, PR runs supersede",
        ).toContain("github.ref!='refs/heads/main'");
    });

    it("decides the release from whether this version shipped, not from the previous commit", () => {
        const workflow = readFileSync(WORKFLOW_PATH, "utf8");
        // The gate runs in its own job now, ahead of the one that publishes: `release` gates on
        // `release-eligibility.outputs.version_changed`, so the decision asserted here and the
        // steps guarded by it below are deliberately read out of two different jobs.
        const releaseJob = extractJobBlock(workflow, "release");
        const gateBlock = extractStepBlock(
            extractJobBlock(workflow, "release-eligibility"),
            "Check whether this version still needs releasing",
        );

        expect(gateBlock, "the eligibility job must carry a version gate step").not.toBe("");

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
        //
        // The previous version is still READ, because the transition it describes is still
        // validated: a release moves forward, or it is an explicit republish of the same version.
        // So the ban is on that comparison DECIDING anything, not on the value existing -- a flat
        // ban on `HEAD~1` would go red for the validation and get "fixed" by deleting it. What the
        // comparison may not do is write a step output, which is the entire shape of the old bug.
        const gateScript = extractRunScript(gateBlock).split("\n");
        const comparisonStart = gateScript.findIndex((line) =>
            // Either direction: the old bug spelled it `!=`, the mode selector spells it `=`.
            // Matching only one of them would read the other as "no comparison at all".
            /^if \[ "\$CURRENT_VERSION" [!=]?= "\$PREVIOUS_VERSION" \]/.test(line),
        );
        expect(
            comparisonStart,
            "the gate must still compare the two versions, to pick how it validates the transition",
        ).toBeGreaterThan(-1);
        // The block's own close, found by indentation: `extractRunScript` dedents the run body, so
        // only the top-level `fi` sits at column zero and a nested one cannot end the slice early.
        const comparisonEnd = gateScript.indexOf("fi", comparisonStart);
        expect(
            comparisonEnd,
            "the version comparison must be a closed if/fi block",
        ).toBeGreaterThan(comparisonStart);
        expect(
            gateScript.slice(comparisonStart, comparisonEnd + 1).join("\n"),
            "comparing this commit's version against the previous one must not decide the release",
        ).not.toMatch(/\$GITHUB_OUTPUT/);

        // The replacement must be idempotent state rather than an event: the absence of the GitHub
        // Release for the CURRENT version, which is the last artifact this job creates.
        expect(
            gate,
            "the release gate must ask whether the current version already has a GitHub Release",
        ).toMatch(/releases\/tags\/v\$CURRENT_VERSION/);

        // It used to ask that through `gh release view` and read the answer out of the message
        // text. That worked, and it made the release depend on prose GitHub is free to reword --
        // where the reworded case reads as "unknown state" and silently blocks every release,
        // which is the failure this whole job was rewritten to stop having. The executable cases
        // in "the release-state probe" prove what it does now; this pins what it must not go back
        // to, which no behavioural test can see because both forms behave identically today.
        expect(
            gate,
            "the release gate must not decide a release from a human-readable message",
        ).not.toMatch(/release not found/);

        // Re-running is only safe because every publishing step guards itself. Remove one of these
        // guards and the self-healing gate above becomes a double-publish, so they are asserted
        // here, next to the gate whose safety depends on them, rather than trusted.
        // Pinned to the guard rather than to its log line: what makes a re-run safe is that the
        // step compares the live tag against this run's commit. Both outcomes of that comparison
        // are executed in "the tag the release is published under" below.
        expect(
            extractStepBlock(releaseJob, "Validate and create release tag"),
            "tagging must decide from the commit the live tag names",
        ).toContain("$EXPECTED_SHA");

        // The other half of re-run safety, and no longer a create-vs-update switch: a version that
        // already reached a registry, or already has a Release, is REFUSED outright. What this run
        // holds is a fresh build of that version rather than the bytes that shipped, so replacing
        // the published artifact with it would silently change what "v<x>" means to anyone who
        // already downloaded it. The self-healing gate above is safe only while that refusal holds.
        const refusal = extractStepBlock(
            releaseJob,
            "Refuse rebuilt-artifact recovery for a published version",
        );
        expect(refusal, "the release job must refuse to republish a shipped version").not.toBe("");
        expect(refusal, "a live marketplace version must not be published twice").toContain(
            '[ "$VSCE_PUBLISHED" = "true" ] || [ "$OVSX_PUBLISHED" = "true" ]',
        );
        expect(
            refusal,
            "an existing GitHub Release must not have its assets replaced by rebuilt bytes",
        ).toMatch(/releases\/tags\/v\$NEW_VERSION/);
    });

    describe("the version gate's own input", () => {
        // `echo "k=$v" >> $GITHUB_OUTPUT` writes one LINE PER NEWLINE in the value. A version
        // carrying a newline therefore appends step outputs of its own choosing, including
        // `version_changed`, which every publishing step below reads. These run the gate's real
        // shell rather than matching its text: a regex can prove a validation is PRESENT, never
        // that it REJECTS anything, and the whole value of this guard is the rejection.
        function readVersionGateScript(): string {
            const eligibilityJob = extractJobBlock(
                readFileSync(WORKFLOW_PATH, "utf8"),
                "release-eligibility",
            );
            return extractRunScript(
                extractStepBlock(
                    eligibilityJob,
                    "Check whether this version still needs releasing",
                ),
            );
        }

        it("refuses a version whose newline would append extra step outputs", () => {
            const script = readVersionGateScript();
            expect(script, "the version gate step must carry a run script").not.toBe("");

            // `version_changed=false` rather than `=true`: the gate legitimately writes `=true` on
            // this branch, so an injected `=true` would be indistinguishable from correct output.
            // GitHub takes the LAST value for a repeated key, so this payload silently flips the
            // release decision -- a real consequence, and one the assertion can actually see.
            // The previous version is pinned to a clean value so the rejection can only be about
            // the injected one. Left at its default the two would be identical, and the validator
            // -- which parses the previous version first -- would report the same message for a
            // reason the test did not intend to be measuring.
            const run = runVersionGate(script, "9.9.9\nversion_changed=false", {
                previousVersion: "9.9.8",
            });

            expect(run.status, "a version that is not strict x.y.z must fail the step").not.toBe(0);
            expect(
                run.outputs,
                "a rejected version must reach $GITHUB_OUTPUT not at all, not merely quoted",
            ).toBe("");
            expect(
                run.stderr,
                "the failure must name the rule it broke, not die on a later step",
            ).toContain("must be a canonical stable SemVer");
        });

        it("still releases a well-formed version, so the guard is not rejecting everything", () => {
            const script = readVersionGateScript();
            expect(script, "the version gate step must carry a run script").not.toBe("");

            const run = runVersionGate(script, "9.9.9");

            expect(run.status, "a well-formed version must still pass the gate").toBe(0);
            // The exact line list, not a `toContain`: an injected third line is the entire defect,
            // and a containment check would pass with it present.
            expect(
                run.outputs.split("\n").filter((line) => line !== ""),
                "the gate must write exactly the two outputs it echoes",
            ).toEqual(["version_changed=true", "new_version=9.9.9"]);
        });

        it("validates before the first write, so no branch reaches $GITHUB_OUTPUT unchecked", () => {
            const eligibilityJob = extractJobBlock(
                readFileSync(WORKFLOW_PATH, "utf8"),
                "release-eligibility",
            );
            const gate = extractStepBlock(
                eligibilityJob,
                "Check whether this version still needs releasing",
            )
                .split("\n")
                .filter((line) => !line.trimStart().startsWith("#"))
                .join("\n");

            // The validation is a script the step shells out to, not an inline pattern: it rejects
            // anything that is not canonical stable SemVer, which is a superset of the newline case
            // the executable tests drive. What matters to the ORDER is unchanged either way -- some
            // check has to sit above every write, and this is the call that performs it.
            const validationOffset = gate.search(/node scripts\/verifyReleaseVersion\.js/);
            const firstWriteOffset = gate.indexOf('>> "$GITHUB_OUTPUT"');

            expect(validationOffset, "the gate must validate the version it read").toBeGreaterThan(
                -1,
            );
            expect(firstWriteOffset, "the gate must write step outputs").toBeGreaterThan(-1);
            // The two executable tests above can only drive the force_publish branch -- the
            // release-state branch needs a GitHub token and network. This is what ties the
            // validation to THAT branch's writes too, and to any branch added later above them.
            expect(
                validationOffset,
                "every $GITHUB_OUTPUT write must sit below the validation",
            ).toBeLessThan(firstWriteOffset);
        });

        it("quotes every $GITHUB_OUTPUT redirection in the workflow", () => {
            // Comment lines are stripped first: the gate's own comment quotes the unquoted form to
            // explain the defect, and a scan that counted prose would be red before the fix landed.
            const workflow = readFileSync(WORKFLOW_PATH, "utf8")
                .split("\n")
                .filter((line) => !line.trimStart().startsWith("#"))
                .join("\n");
            const redirections = workflow.match(/>>\s*"?\$GITHUB_OUTPUT"?/g) ?? [];

            expect(redirections.length, "the workflow must write step outputs").toBeGreaterThan(0);
            // The redirection target is a runner-controlled path, so leaving it bare relies on that
            // path never containing a space or a glob character. Scanned across the whole file
            // rather than the gate alone: this is the half of the hardening the executable tests
            // above cannot see, since they only ever run one step.
            expect(
                redirections.filter((redirection) => !redirection.includes('"$GITHUB_OUTPUT"')),
                "an unquoted redirection target word-splits and globs",
            ).toEqual([]);
        });
    });

    describe("the release-state probe", () => {
        // Measured against gh 2.87.3 on the release-by-tag endpoint. An absent release and a bad
        // token BOTH exit 1, so the exit code can never decide this; what separates them is the
        // status line, which `-i` prints as the first line of stdout in every case while gh's own
        // prose goes to stderr. Each case here answers exactly that way, so the step has to draw
        // the distinction itself rather than being handed it.
        const ABSENT: GhStub = {
            status: 1,
            stdout: 'HTTP/2.0 404 Not Found\r\n\r\n{"message":"Not Found","status":"404"}',
            stderr: "gh: Not Found (HTTP 404)",
        };
        const PRESENT: GhStub = {
            status: 0,
            stdout: 'HTTP/2.0 200 OK\r\n\r\n{"tag_name":"v9.9.9"}',
        };
        const BROKEN: GhStub = {
            status: 1,
            stdout: 'HTTP/2.0 401 Unauthorized\r\n\r\n{"message":"Bad credentials"}',
            stderr: "gh: Bad credentials (HTTP 401)",
        };
        // gh never reached the API at all -- no binary, no network, no token to send. There is no
        // status line to read, which the old message-matching form could not even express, and it
        // is the case that must never be mistaken for "this version has not shipped".
        const SILENT: GhStub = {
            status: 1,
            stdout: "",
            stderr: "gh: could not resolve host: api.github.com",
        };

        /**
         * Asserts what the step actually asked GitHub, not merely what it did with the answer.
         *
         * A step that queried the wrong tag -- the bare `9.9.9` rather than the `v9.9.9` every
         * release here is published under -- gets a 404 from a real GitHub and satisfies every
         * assertion about the outputs while deciding the release from a question nobody asked.
         */
        function expectQueriedTag(run: VersionGateRun, step: string) {
            expect(
                run.ghArgs,
                `${step} must ask over the API, where the answer is a status code`,
            ).toContain("api");
            expect(
                run.ghArgs,
                `${step} must query the v-prefixed tag on the release-by-tag endpoint`,
            ).toContain(`repos/${STUB_REPOSITORY}/releases/tags/v9.9.9`);
        }

        function runProbe(gh: GhStub) {
            const eligibilityJob = extractJobBlock(
                readFileSync(WORKFLOW_PATH, "utf8"),
                "release-eligibility",
            );
            const script = extractRunScript(
                extractStepBlock(
                    eligibilityJob,
                    "Check whether this version still needs releasing",
                ),
            );
            expect(script, "the version gate step must carry a run script").not.toBe("");
            // The previous version is left at its default, equal to this one: an unchanged version
            // is exactly the state a diff-based gate got wrong, so it is the state the probe has to
            // resolve. A bumped version would take the forward-transition branch and never ask.
            return runVersionGate(script, "9.9.9", { forcePublish: false, gh });
        }

        it("publishes when the release is genuinely absent", () => {
            const run = runProbe(ABSENT);

            expect(run.status, "an absent release is a normal, expected answer").toBe(0);
            expect(
                run.outputs.split("\n").filter((line) => line !== ""),
                "an absent release means publish",
            ).toEqual(["version_changed=true", "new_version=9.9.9"]);
            expectQueriedTag(run, "the version gate");
        });

        it("skips when the release already exists", () => {
            const run = runProbe(PRESENT);

            expect(run.status, "an existing release is a normal, expected answer").toBe(0);
            expect(
                run.outputs.split("\n").filter((line) => line !== ""),
                "an existing release means skip",
            ).toEqual(["version_changed=false", "new_version=9.9.9"]);
        });

        it("fails rather than treating an unreadable release state as never released", () => {
            const run = runProbe(BROKEN);

            // The failure direction is the point. Reading a 401 as "absent" republishes on a
            // transient blip and reports a broken token as "this version has not shipped" -- which
            // is the misdiagnosis that left 0.25.2 and 0.25.3 sitting on main unreleased.
            expect(run.status, "an unreadable release state must fail the step").not.toBe(0);
            expect(
                run.outputs,
                "an unreadable release state must not decide the release either way",
            ).toBe("");
            expect(run.stderr, "the failure must name the status it could not act on").toContain(
                "HTTP 401",
            );
        });

        // The adversarial case for a status-code gate: there is no status code. A gate that
        // defaults an unparseable answer to "absent" republishes every time gh cannot start,
        // which is the same misdiagnosis as the 401 arriving through a quieter door.
        it("fails when gh answered without a status line at all", () => {
            const run = runProbe(SILENT);

            expect(run.status, "an answer with no status is not an absent release").not.toBe(0);
            expect(run.outputs, "an unparseable answer must decide nothing").toBe("");
        });

        // The release job asks the same question a second time, for the opposite reason. The gate
        // above decides whether to publish AT ALL, from state that may be minutes stale by the time
        // the job below it starts; this one re-asks immediately before publishing and REFUSES if
        // anything already shipped. The bytes this run holds are a fresh build of the same version,
        // not the artifact that shipped, so replacing a published release with them would quietly
        // change what an already-downloaded `v<x>` means. Both directions are executed here: a
        // check that answered "absent" unconditionally would pass the eligibility tests above and
        // still let a re-run overwrite a live release.
        function runRecoveryRefusal(gh: GhStub, published?: Record<string, string>) {
            const releaseJob = extractJobBlock(readFileSync(WORKFLOW_PATH, "utf8"), "release");
            const script = extractRunScript(
                extractStepBlock(
                    releaseJob,
                    "Refuse rebuilt-artifact recovery for a published version",
                ),
            );
            expect(script, "the recovery refusal step must carry a run script").not.toBe("");
            return runVersionGate(script, "9.9.9", {
                gh,
                env: {
                    NEW_VERSION: "9.9.9",
                    VSCE_PUBLISHED: "false",
                    OVSX_PUBLISHED: "false",
                    ...published,
                },
            });
        }

        it("lets a genuinely unpublished version through to the publishing steps", () => {
            const run = runRecoveryRefusal(ABSENT);

            expect(run.status, "an absent release is a normal, expected answer").toBe(0);
            expectQueriedTag(run, "the recovery refusal");
        });

        // The other half of the decision this step exists to make. Without it the step could treat
        // every answer as "absent" and still pass every other test in this block -- and the run
        // would then republish over a release someone has already downloaded.
        it("refuses to replace the assets of a release that already exists", () => {
            const run = runRecoveryRefusal(PRESENT);

            expect(run.status, "an existing release must stop the republish").not.toBe(0);
            expect(run.stderr, "the failure must name what it refused to overwrite").toContain(
                "refusing to replace its assets",
            );
        });

        it("fails closed when the release state is unreadable", () => {
            const run = runRecoveryRefusal(BROKEN);

            // A 401 is not a 404. Reading it as "nothing published yet" is the same misdiagnosis
            // as in the gate above, arriving one job later and with worse consequences: there it
            // costs a skipped release, here it costs the published artifact.
            expect(run.status, "an unreadable release state must fail the step").not.toBe(0);
            expect(run.stderr, "the failure must say which way it erred").toContain(
                "failing closed",
            );
        });

        // The registry half, which no API answer can substitute for: a version can be live on the
        // Marketplace with no GitHub Release behind it. Stubbed with the answer that otherwise
        // PASSES, so the only thing that can stop this run is the registry check itself -- and the
        // empty argument list proves it stopped before spending an API call to find out.
        it("refuses a version already live on a registry, without asking GitHub at all", () => {
            const run = runRecoveryRefusal(ABSENT, { VSCE_PUBLISHED: "true" });

            expect(run.status, "a live marketplace version must stop the republish").not.toBe(0);
            expect(run.stderr, "the failure must name the artifact rule it enforced").toContain(
                "must be recovered from its original artifact",
            );
            expect(run.ghArgs, "the registry check must decide before any API call").toEqual([]);
        });
    });

    describe("the tag the release is published under", () => {
        function tagScript(): string {
            const releaseJob = extractJobBlock(readFileSync(WORKFLOW_PATH, "utf8"), "release");
            const script = extractRunScript(
                extractStepBlock(releaseJob, "Validate and create release tag"),
            );
            expect(script, "the tag step must carry a run script").not.toBe("");
            return script;
        }

        it("refuses to publish under a tag that names a different commit", () => {
            const run = runTagStep(tagScript(), "older");

            // The state gate asks whether the version has a Release, so a run that tagged and then
            // died before creating one leaves the next push saying "publish" with the tag still on
            // the older commit. Skipping silently there ships this build under that tag.
            expect(run.status, "a tag pointing elsewhere must stop the release").not.toBe(0);
            expect(run.stderr, "the failure must name both commits").toContain(run.older);
            expect(run.stderr, "the failure must name both commits").toContain(run.head);
            expect(run.liveTagCommit, "the mismatched tag must be left exactly where it was").toBe(
                run.older,
            );
            expect(
                run.ghArgs,
                "a mismatched tag must never be force-moved onto this run",
            ).not.toContain("POST");
        });

        it("reuses a tag that already names this commit, so a re-run can still recover", () => {
            const run = runTagStep(tagScript(), "head");

            expect(run.status, "re-running the same commit must not be treated as a mismatch").toBe(
                0,
            );
            expect(run.stderr, "a matching tag is not a failure").toBe("");
            // Exiting 0 says the step was happy; it does not say the step left the live ref alone.
            // A version that re-created or moved the tag on this path exits 0 too, and the damage
            // only shows up on the mismatch path, where the tag it was supposed to refuse has
            // already been overwritten.
            expect(run.liveTagCommit, "reuse must leave the live tag untouched").toBe(run.head);
            expect(run.ghArgs, "an already-correct tag must not be rewritten").not.toContain(
                "POST",
            );
        });

        it("creates the tag when none exists", () => {
            const run = runTagStep(tagScript(), "absent");

            expect(run.status, "the ordinary release path must still tag").toBe(0);
            expect(run.liveTagCommit, "the new tag must name this run's commit").toBe(run.head);
            // Without this, a step that only ever read the ref would pass the assertion above on
            // the strength of the stub's own bookkeeping rather than on anything it did.
            expect(run.ghArgs, "the absent tag must actually be created").toContain("POST");
        });
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
            "Create GitHub Release and upload artifacts",
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

        expect(
            extractStepBlock(releaseJob, "Update GitHub Release assets"),
            "recovery must not clobber an existing release with rebuilt bytes",
        ).toBe("");
        expect(releaseJob).not.toContain("gh release upload");
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

    // The hole this closes, measured: 0.25.4's push to main went red in `e2e-full` behind a pull
    // request that had been green, because the job carried
    // `if: github.ref == 'refs/heads/main' && (...)` and so reported `skipping` on every pull
    // request. A gate that first runs after the merge cannot stop the merge -- and no assertion in
    // this file noticed, because every one of them read the job's steps rather than when it runs.
    it("runs the release gate on pull requests against main, not only after the merge", () => {
        const workflow = readFileSync(WORKFLOW_PATH, "utf8");
        const e2eFullJob = extractJobBlock(workflow, "e2e-full");

        expect(e2eFullJob, "publish.yml must define e2e-full").not.toBe("");
        expect(workflow, "publish.yml must run on pull requests against main").toMatch(
            /\n {4}pull_request:\n {8}branches:\n {12}- main\n/,
        );
        // Job-level keys sit at eight spaces; a step's own `if: failure()` sits deeper. Matching
        // the shallow one keeps this about when the JOB runs, which is the whole finding.
        expect(
            e2eFullJob.match(/^ {8}if:.*$/m)?.[0] ?? "",
            "no condition on e2e-full may narrow it away from pull requests again",
        ).toBe("");
    });

    // The second half of the same guarantee. `e2e-full` gating pull requests is only worth
    // anything if the identical suite is not ALSO running as a second, non-gating job: that was
    // the arrangement this replaced, where a 45-minute container ran twice per push to main and
    // the green one nobody gated on sat next to the red one nobody saw before merging.
    it("runs the flow suite in exactly one workflow per event", () => {
        const unshardedRunners = readdirSync(WORKFLOWS_DIRECTORY)
            .filter((entry) => entry.endsWith(".yml") || entry.endsWith(".yaml"))
            .filter((entry) =>
                /run: \.\/tests\/e2e\/docker\/run\.sh .*bun run test:e2e(?! -- --shard=)/.test(
                    readFileSync(resolve(WORKFLOWS_DIRECTORY, entry), "utf8"),
                ),
            );

        expect(
            new Set(unshardedRunners),
            "a third workflow running the unsharded suite is a third answer to which one gates",
        ).toEqual(new Set(["publish.yml", "e2e.yml"]));

        const prTier = readFileSync(resolve(WORKFLOWS_DIRECTORY, "e2e.yml"), "utf8");
        expect(
            prTier,
            "the non-gating tier must exclude the base publish.yml already gates",
        ).toMatch(/\n {4}pull_request:\n {8}branches-ignore:\n {12}- main\n/);
        expect(
            prTier,
            "a push to main is already the gating run, so this tier must not repeat it",
        ).not.toMatch(/^ {4}push:/m);
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

/**
 * Every upload step in `publish.yml` that keeps a suite's evidence, derived from the workflow
 * rather than listed here -- a fixed list of three would pass while a fourth job uploaded nothing
 * anyone could read.
 */
function failureEvidenceUploadSteps(workflow: string): { name: string; body: string }[] {
    return (
        workflow
            .split(/^ {12}- name: /m)
            .slice(1)
            // Comment lines are dropped before anything is matched. These steps are commented with
            // the very path names the assertions look for -- prose explaining why
            // `playwright-report/` is absent contains `playwright-report/` -- so a check reading
            // the raw block fails on a correct workflow and would be "fixed" by deleting the
            // explanation. The subject here is the YAML.
            .map((chunk) => ({
                name: chunk.slice(0, chunk.indexOf("\n")),
                body: chunk.replace(/^\s*#.*$/gm, ""),
            }))
            .filter(
                (step) =>
                    step.body.includes("upload-artifact") && step.body.includes("if: failure()"),
            )
    );
}

/**
 * `playwright-report/` is the HTML reporter's output directory, and nothing in this repository
 * runs that reporter -- `playwright.e2e.config.ts` pins `list`, and `playwright.visual.config.ts`
 * names none, whose default is `list` (or `dot` under CI). Every failure upload nonetheless listed
 * it alongside `test-results/`, which is the failure this pins: an upload that names two kinds of
 * evidence and can only ever carry one reads, in review and in a downloaded artifact alike, as
 * though the missing half simply had nothing to report.
 *
 * The reporter check is the half that keeps this honest. Asserting the absent path alone would
 * turn into a false failure the day someone legitimately enables HTML reporting; asserting the
 * configuration too means that change fails HERE, with a message naming the upload steps it has
 * to update, rather than silently shipping a report no artifact carries.
 */
describe("failure artifact uploads", () => {
    it("keeps only evidence a reporter actually writes", () => {
        const workflow = readFileSync(WORKFLOW_PATH, "utf8");
        const steps = failureEvidenceUploadSteps(workflow);

        expect(
            steps.length,
            "publish.yml must upload evidence from its failing suites",
        ).toBeGreaterThan(0);
        for (const configPath of ["playwright.e2e.config.ts", "playwright.visual.config.ts"]) {
            expect(
                readFileSync(resolve(REPOSITORY_ROOT, configPath), "utf8"),
                `${configPath} enables the HTML reporter -- every failure upload in publish.yml ` +
                    "must start carrying playwright-report/ again, and this assertion inverted",
            ).not.toMatch(/["']html["']/);
        }
        for (const step of steps) {
            expect(
                step.body,
                `"${step.name}" uploads playwright-report/, which no reporter here writes`,
            ).not.toContain("playwright-report/");
            expect(step.body, `"${step.name}" must keep test-results/`).toContain("test-results/");
        }
    });

    // `ignore` suppresses the one outcome worth an annotation: a job that failed before its suite
    // produced anything, which is precisely when the missing artifact is the finding rather than
    // noise. `warn` surfaces it without failing the step, so the upload stays non-blocking.
    it("annotates a failure that produced no evidence at all", () => {
        const workflow = readFileSync(WORKFLOW_PATH, "utf8");

        for (const step of failureEvidenceUploadSteps(workflow)) {
            expect(
                step.body,
                `"${step.name}" silences the case where a failing job produced no artifacts`,
            ).toContain("if-no-files-found: warn");
        }
    });
});
