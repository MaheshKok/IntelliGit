// Three-gate activation check for the development-only E2E control channel. See
// PLAN.md Phase 1 step 10: "Three independent gates, all required: ExtensionMode.Development,
// INTELLIGIT_E2E=1, and a channel directory that exists and is writable." Missing any one
// gate must leave the channel inert -- this function is the single place that decision is
// made, so a test can assert on the real gate rather than a mock of it.

import { accessSync, constants, existsSync, statSync } from "node:fs";
import * as vscode from "vscode";

/**
 * The subset of `process.env` the E2E control channel gate reads. Carries an explicit index
 * signature (matching `NodeJS.ProcessEnv`'s own shape) so `process.env` itself satisfies this
 * type structurally -- without it, TypeScript's weak-type check rejects the assignment
 * because every named field here is optional.
 */
export interface E2eGateEnv {
    readonly INTELLIGIT_E2E?: string;
    readonly INTELLIGIT_E2E_CHANNEL_DIR?: string;
    readonly [key: string]: string | undefined;
}

/** Outcome of evaluating the three-gate check. */
export interface E2eGateResult {
    /** True only when every gate passed and the channel may activate. */
    readonly active: boolean;
    /** The validated channel directory. Present only when `active` is true. */
    readonly channelDir?: string;
    /** Human-readable reason the gate failed. Present only when `active` is false. */
    readonly reason?: string;
}

/**
 * Evaluates the three independent gates that must ALL pass before the E2E control channel
 * may activate. Performs only a read-only filesystem probe of the candidate directory as a
 * side effect, so it is safe to call unconditionally from `activate()` in every install --
 * production included -- without risk of creating files or starting a watcher itself.
 */
export function evaluateE2eGate(
    extensionMode: vscode.ExtensionMode,
    env: E2eGateEnv,
): E2eGateResult {
    if (extensionMode !== vscode.ExtensionMode.Development) {
        return { active: false, reason: "extensionMode is not ExtensionMode.Development" };
    }

    if (env.INTELLIGIT_E2E !== "1") {
        return { active: false, reason: 'INTELLIGIT_E2E is not set to "1"' };
    }

    const channelDir = env.INTELLIGIT_E2E_CHANNEL_DIR;
    if (!channelDir) {
        return { active: false, reason: "INTELLIGIT_E2E_CHANNEL_DIR is not set" };
    }

    if (!existsSync(channelDir) || !statSync(channelDir).isDirectory()) {
        return {
            active: false,
            reason: `INTELLIGIT_E2E_CHANNEL_DIR "${channelDir}" is not an existing directory`,
        };
    }

    try {
        accessSync(channelDir, constants.W_OK);
    } catch {
        return {
            active: false,
            reason: `INTELLIGIT_E2E_CHANNEL_DIR "${channelDir}" is not writable`,
        };
    }

    return { active: true, channelDir };
}
