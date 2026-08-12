import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { FLOW_MATRIX } from "../../e2e/flows/matrix";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(__dirname, "../../..");
const NEGATIVE_CONFIG = "vitest.flow-negative.config.ts";
const NEGATIVE_SPEC = "tests/e2e/flows/negative/leg.negative.ts";
const LEG_IDS = ["local-git", "origin", "durable-state", "lock-residue"] as const;

interface SubprocessResult {
    readonly exitCode: number;
    readonly output: string;
}

/** Runs the explicit expected-failure spec in either control or one-leg-corruption mode. */
async function runNegativeSpec(leg: string, control = false): Promise<SubprocessResult> {
    const env = { ...process.env };
    env.FLOW_ORACLE_NEGATIVE_LEG = leg;
    if (control) env.FLOW_ORACLE_NEGATIVE_CONTROL = "1";
    else delete env.FLOW_ORACLE_NEGATIVE_CONTROL;
    try {
        const result = await execFileAsync(
            "bun",
            ["vitest", "run", "--config", NEGATIVE_CONFIG, NEGATIVE_SPEC],
            {
                cwd: REPO_ROOT,
                env,
                maxBuffer: 8 * 1024 * 1024,
            },
        );
        return { exitCode: 0, output: `${result.stdout}${result.stderr}` };
    } catch (error) {
        const failure = error as {
            readonly code?: number | string;
            readonly stdout?: string;
            readonly stderr?: string;
        };
        return {
            exitCode: typeof failure.code === "number" ? failure.code : 1,
            output: `${failure.stdout ?? ""}${failure.stderr ?? ""}`,
        };
    }
}

describe("four-way flow oracle known-bad subprocesses", () => {
    for (const leg of LEG_IDS) {
        it(`requires the ${leg} corruption to turn the spec red`, async () => {
            const control = await runNegativeSpec(leg, true);
            expect(control.exitCode, `control output:\n${control.output}`).toBe(0);

            const corrupted = await runNegativeSpec(leg);
            expect(corrupted.exitCode, `${leg} output:\n${corrupted.output}`).not.toBe(0);
            expect(corrupted.output, `${leg} output:\n${corrupted.output}`).toContain(
                `${leg} oracle failed`,
            );
            for (const flow of FLOW_MATRIX) {
                expect(corrupted.output, `${leg} output:\n${corrupted.output}`).toContain(
                    `${leg} oracle failed for row ${flow.id}`,
                );
            }
        }, 300_000);
    }
});
