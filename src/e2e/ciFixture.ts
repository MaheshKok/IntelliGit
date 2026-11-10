// E2E-only CI fixture. A spec seeds one CI detail into a globalState key the control channel
// allowlists, and every commit then reports it, so the Checks tab renders without a CI
// provider or network. Read only while the E2E control channel is active (its three-gate
// check), so a shipped install never serves it.

import type * as vscode from "vscode";
import { NO_CI_CAPABILITIES, type ProviderCiCapabilities } from "../shared/ci/capabilities";
import { isCommitCiDetailData } from "../shared/ci/persistedShape";
import type { CommitCiDetailData } from "../types";
import { isE2eControlChannelActive } from "./activationState";

/** The globalState key a spec seeds with `{ detail, capabilities }`. */
export const E2E_CI_FIXTURE_KEY = "intelligit.e2e.ciFixture";

/** A seeded CI detail, stamped with the commit it is served for. */
export interface E2eCiFixture {
    detail: CommitCiDetailData;
    capabilities: ProviderCiCapabilities;
}

/**
 * The seeded CI detail for a commit, or undefined outside an E2E run or when nothing is seeded.
 *
 * @param memento - The extension's globalState.
 * @param hash - The commit the caller asks about; the fixture is served for every commit.
 * @throws When a spec seeded something that is not a CI detail, or left out a capability flag,
 *   so the spec fails loudly.
 */
export function readE2eCiFixture(
    memento: Pick<vscode.Memento, "get">,
    hash: string,
): E2eCiFixture | undefined {
    if (!isE2eControlChannelActive()) return undefined;
    const seeded = memento.get<unknown>(E2E_CI_FIXTURE_KEY);
    if (seeded === undefined || seeded === null) return undefined;
    const { detail, capabilities } = seeded as { detail?: unknown; capabilities?: unknown };
    const stamped = typeof detail === "object" && detail !== null ? { ...detail, hash } : detail;
    if (!isCommitCiDetailData(stamped)) {
        throw new Error(`The seeded ${E2E_CI_FIXTURE_KEY} value is not a CI detail.`);
    }
    // Every flag must be seeded: a missing one would silently read as "off".
    const seededFlags = (typeof capabilities === "object" ? capabilities : null) as Record<
        string,
        unknown
    > | null;
    for (const flag of Object.keys(NO_CI_CAPABILITIES)) {
        if (typeof seededFlags?.[flag] !== "boolean") {
            throw new Error(
                `The seeded ${E2E_CI_FIXTURE_KEY} value has no boolean "${flag}" capability.`,
            );
        }
    }
    return {
        detail: stamped as CommitCiDetailData,
        capabilities: seededFlags as unknown as ProviderCiCapabilities,
    };
}
