import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const WORKFLOWS_DIRECTORY = path.resolve(__dirname, "../../../.github/workflows");

/** A pinned reference names an immutable commit; a tag or branch is whatever its owner points it at today. */
const PINNED_REFERENCE = /^[0-9a-f]{40}$/;

/** A job header sits one level under `jobs:`, which this repository writes at four spaces. */
const JOB_HEADER = /^ {4}([A-Za-z0-9_-]+):\s*$/;

/** Anything that writes back to the remote needs the credential the checkout leaves in `.git/config`. */
const GIT_WRITE = /\bgit\s+(?:push|tag)\b/;

interface StepReference {
    readonly file: string;
    readonly job: string;
    readonly line: number;
    readonly action: string;
    readonly reference: string;
    /** The rest of the step this `uses:` belongs to, so per-action inputs can be asserted. */
    readonly body: string;
    /** Whether the surrounding job pushes to the remote, which is what makes a credential necessary. */
    readonly jobWritesToRemote: boolean;
}

function workflowFiles(): readonly string[] {
    return readdirSync(WORKFLOWS_DIRECTORY)
        .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
        .sort();
}

/** Docker actions carry a registry host with its own `@`, so the LAST one separates the ref. */
function splitOnLastAt(target: string): readonly [string, string] {
    const separator = target.lastIndexOf("@");
    return separator === -1
        ? [target, ""]
        : [target.slice(0, separator), target.slice(separator + 1)];
}

/**
 * Collects every third-party action reference in every workflow, with the step and job it sits in.
 *
 * A step ends at the next list bullet at the same or shallower indentation, which is what separates
 * one step's inputs from the next one's. Reading the whole job instead would let a
 * `persist-credentials: false` written for one checkout vouch for a second checkout that never set
 * it -- the exact false pass this file exists to prevent.
 */
function actionReferences(): readonly StepReference[] {
    const references: StepReference[] = [];

    for (const file of workflowFiles()) {
        const lines = readFileSync(path.join(WORKFLOWS_DIRECTORY, file), "utf8").split("\n");

        const jobStarts = lines
            .map((line, index) => ({ index, name: JOB_HEADER.exec(line)?.[1] }))
            .filter((entry): entry is { index: number; name: string } => entry.name !== undefined);

        const jobAt = (lineIndex: number): { name: string; body: string } => {
            const startIndex = jobStarts.filter((job) => job.index <= lineIndex).pop();
            if (startIndex === undefined) return { name: "", body: "" };
            const next = jobStarts.find((job) => job.index > startIndex.index);
            return {
                name: startIndex.name,
                // Comments are stripped because `GIT_WRITE` is matched against this body to decide
                // whether the job legitimately needs a persisted credential. A prose line such as
                // `# this job does not git push` would otherwise mark the job as a pusher and
                // silently exempt EVERY checkout in it from `persist-credentials: false` -- the
                // guard would keep passing while enforcing nothing. Only whole-line comments and
                // ` # ` trailing comments are removed, so shell forms that carry a bare `#`
                // (`${VERSION#v}`) survive intact.
                body: lines
                    .slice(startIndex.index, next?.index ?? lines.length)
                    .filter((candidate) => !candidate.trimStart().startsWith("#"))
                    .map((candidate) => candidate.replace(/\s+#\s.*$/, ""))
                    .join("\n"),
            };
        };

        lines.forEach((line, index) => {
            const match = /^(\s*)-?\s*uses:\s*(\S+)/.exec(line);
            if (!match) return;

            const [, indent, target] = match;
            // A repo-local composite action lives in this checkout, so it is already pinned by the
            // commit under test and has no external owner who could move it.
            if (target.startsWith("./")) return;

            const bulletDepth = line.indexOf("-") === -1 ? indent.length : line.indexOf("-");
            const bodyEnd = lines.findIndex((candidate, candidateIndex) => {
                if (candidateIndex <= index) return false;
                const bullet = /^(\s*)-\s/.exec(candidate);
                return bullet !== null && bullet[1].length <= bulletDepth;
            });

            const [action, reference] = splitOnLastAt(target);
            const job = jobAt(index);
            references.push({
                file,
                job: job.name,
                line: index + 1,
                action,
                reference,
                body: lines.slice(index, bodyEnd === -1 ? lines.length : bodyEnd).join("\n"),
                jobWritesToRemote: GIT_WRITE.test(job.body),
            });
        });
    }

    return references;
}

describe("workflow action pinning", () => {
    it("pins every third-party action to a full commit SHA", () => {
        const references = actionReferences();

        // Not an enumerated list of the workflows or actions that exist today: a new job in a new
        // file is exactly how an unpinned reference arrives, and an enumeration would have welcomed
        // it. Every reference the directory holds is checked, whatever it is called.
        const floating = references
            .filter(({ reference }) => !PINNED_REFERENCE.test(reference))
            .map(({ file, line, action, reference }) => `${file}:${line} ${action}@${reference}`);

        expect(floating).toEqual([]);
    });

    it("leaves the workflow token on disk only where the job pushes to the remote", () => {
        const checkouts = actionReferences().filter(({ action }) => action === "actions/checkout");

        // `persist-credentials: true` is the action's default, so a checkout that says nothing
        // leaves a credential in `.git/config` that every later step -- including anything the
        // container runs -- can read. Silence is the defect, which is why the assertion is on the
        // step body rather than on the absence of an explicit `true`.
        //
        // The release job is exempted by what it does, not by its name: it runs `git push` for the
        // version tag, so the credential is the point. Deriving the exemption from the job body
        // means a job that stops pushing stops being exempt, and a new pushing job never has to be
        // remembered and added here.
        const persisting = checkouts
            .filter(({ jobWritesToRemote }) => !jobWritesToRemote)
            .filter(({ body }) => !/^\s+persist-credentials:\s*false\s*$/m.test(body))
            .map(({ file, line, job }) => `${file}:${line} (${job})`);

        expect(persisting).toEqual([]);
    });

    it("can fail: the sweep reads workflows, actions, jobs, and checkout steps", () => {
        // Every assertion above is `toEqual([])`, which a sweep that found nothing satisfies
        // perfectly. A renamed directory, a changed extension, or a parser that stopped matching
        // `uses:` would turn this file into a guard that passes because it is blind. The exemption
        // needs the same treatment: a job matcher that never matched would exempt every checkout.
        const references = actionReferences();
        const checkouts = references.filter(({ action }) => action === "actions/checkout");

        expect(workflowFiles().length).toBeGreaterThan(0);
        expect(references.length).toBeGreaterThan(0);
        expect(checkouts.length).toBeGreaterThan(0);
        expect(references.every(({ job }) => job !== "")).toBe(true);
        expect(checkouts.some(({ jobWritesToRemote }) => jobWritesToRemote)).toBe(true);
        expect(checkouts.some(({ jobWritesToRemote }) => !jobWritesToRemote)).toBe(true);
    });
});
