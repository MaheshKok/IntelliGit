import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const WORKFLOW_PATH = resolve(__dirname, "../../../.github/workflows/publish.yml");

/**
 * The context values a concurrency group is allowed to read. Narrow on purpose: the evaluator
 * below rejects anything else rather than guessing, because a group these tests cannot evaluate is
 * a group they cannot vouch for.
 */
interface ConcurrencyRunContext {
    readonly event_name: string;
    readonly ref: string;
    readonly run_id: string;
}

function readConcurrencyContext(path: string, context: ConcurrencyRunContext): string {
    const field = path.slice("github.".length);
    if (field !== "event_name" && field !== "ref" && field !== "run_id") {
        throw new Error(`concurrency group reads an unsupported context value: ${path}`);
    }
    return context[field];
}

function evaluateConcurrencyExpression(body: string, context: ConcurrencyRunContext): string {
    const expression = body.trim();

    // `<ctx> == '<literal>' && <ctx> || '<literal>'` -- GitHub's ternary idiom.
    const ternary = expression.match(
        /^(github\.[a-z_]+) == '([^']*)' && (github\.[a-z_]+) \|\| '([^']*)'$/,
    );
    if (ternary) {
        const [, subject, expected, whenTrue, whenFalse] = ternary;
        return readConcurrencyContext(subject, context) === expected
            ? readConcurrencyContext(whenTrue, context)
            : whenFalse;
    }

    if (/^github\.[a-z_]+$/.test(expression)) {
        return readConcurrencyContext(expression, context);
    }

    throw new Error(`unsupported concurrency group expression: ${expression}`);
}

/**
 * Resolves a concurrency group template to the string GitHub would key a run on.
 *
 * These tests ask what a group RESOLVES TO rather than what it is spelled like. Asserting the
 * spelling pins today's expression and nothing else; the resolved value pins the only property
 * that decides whether one run waits on another -- whether two runs collide.
 */
function resolveConcurrencyGroup(template: string, context: ConcurrencyRunContext): string {
    return template.replace(/\$\{\{([^}]*)\}\}/g, (_match, body: string) =>
        evaluateConcurrencyExpression(body, context),
    );
}

/** Everything above `jobs:` is workflow scope, so a job-level key cannot answer for this one. */
function workflowConcurrencyGroup(workflow: string): string {
    const header = workflow.split(/^jobs:$/m)[0] ?? "";
    return header.match(/^ {4}group:\s*(.+)$/m)?.[1]?.trim() ?? "";
}

/** Extracts one top-level job so an assertion cannot be satisfied by a neighbouring job. */
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

function readWorkflow(): string {
    return readFileSync(WORKFLOW_PATH, "utf8");
}

const PUSH_TO_MAIN = { event_name: "push", ref: "refs/heads/main" } as const;
const PULL_REQUEST = { event_name: "pull_request", ref: "refs/pull/7/merge" } as const;

describe("publish.yml never queues its safety checks behind a release", () => {
    it("gives two merges to main separate concurrency groups", () => {
        // The failure this exists for: a `release` job that parks -- on an environment approval, on
        // a slow marketplace upload -- holds its whole run in the workflow's group, and because
        // main runs are deliberately never cancelled, every later merge queues behind it instead of
        // running. Measured 2026-08-17: an unapproved release from 07:45 held main's group for 13
        // hours; the merge behind it was silently CANCELLED when a third arrived, so #197's build,
        // visual and e2e-full never ran on main at all and #200's never started. Nothing anywhere
        // reported a failure. Serializing releases is still wanted -- it belongs on the release job.
        const template = workflowConcurrencyGroup(readWorkflow());

        expect(template, "the workflow must declare a concurrency group").not.toBe("");
        expect(
            resolveConcurrencyGroup(template, { ...PUSH_TO_MAIN, run_id: "1001" }),
            "two merges to main must not share a group, or the second waits on the first",
        ).not.toBe(resolveConcurrencyGroup(template, { ...PUSH_TO_MAIN, run_id: "1002" }));
    });

    it("keeps two pushes to one pull request in a single group so the older run supersedes", () => {
        // The guard against over-fixing the case above. Making every run unique would fix the
        // queueing and silently switch off pull-request superseding -- the one case where
        // cancelling is the point, since a superseded PR run is pure waste. A fix that buys the
        // first property by spending this one has to fail here.
        const template = workflowConcurrencyGroup(readWorkflow());

        expect(
            resolveConcurrencyGroup(template, { ...PULL_REQUEST, run_id: "1001" }),
            "two pushes to one pull request must share a group so the older run is cancelled",
        ).toBe(resolveConcurrencyGroup(template, { ...PULL_REQUEST, run_id: "1002" }));
    });

    it("serializes publishing on the release job itself", () => {
        // Two releases must never publish at once: the tag, both marketplace uploads and the
        // GitHub Release are version-keyed side effects. Holding that guarantee HERE means a queued
        // release delays only the next release, never the checks that gate it.
        const releaseJob = extractJobBlock(readWorkflow(), "release");
        const group = releaseJob.match(/^ {12}group:\s*(.+)$/m)?.[1]?.trim() ?? "";
        const cancel = releaseJob.match(/^ {12}cancel-in-progress:\s*(.+)$/m)?.[1]?.trim() ?? "";

        expect(group, "release must declare its own concurrency group").not.toBe("");
        expect(
            resolveConcurrencyGroup(group, { ...PUSH_TO_MAIN, run_id: "1001" }),
            "two releases must share one group so they publish one at a time",
        ).toBe(resolveConcurrencyGroup(group, { ...PUSH_TO_MAIN, run_id: "1002" }));
        expect(cancel, "a superseded release must queue, never be cancelled").toBe("false");
    });

    it("gates publishing on nothing a human has to click", () => {
        // A deployment environment is the only way an Actions job acquires a manual gate, so this
        // bans the mechanism rather than a phrase that resembles it: a job with no `environment:`
        // cannot be parked in `waiting` however the repository is configured. Scanned across every
        // job, because the next one to acquire a reviewer would not be `release` -- it would be
        // whichever job someone adds next.
        //
        // Nothing is lost by dropping it here: `marketplace-production` holds no secrets. VSCE_PAT
        // and OVSX_PAT are repository-scoped, so the environment never scoped the credentials, and
        // its branch policy is already asserted in YAML by the release job's own
        // `github.ref == 'refs/heads/main'` condition.
        expect(
            [...readWorkflow().matchAll(/^\s+environment:\s*(\S+)/gm)].map(([, name]) => name),
            "no job may sit behind a deployment environment: an approval rule parks the run",
        ).toEqual([]);
    });
});
