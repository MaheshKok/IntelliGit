/**
 * Durable VS Code state seam (PLAN.md step 9's reference to step 10). Memento, SecretStorage, and
 * per-webview `setState` all live inside a *running* extension host, reachable only through the
 * E2E control channel at `src/e2e/` (read for context, never modified here). `snapshotWorkspace`
 * runs in the plain test process, where no host exists, so this module's only job is the
 * two-armed contract: call the caller's provider when one is given, or return an explicit
 * `not-captured` marker with a reason -- never an empty object, never a silently omitted field.
 *
 * Wiring a real provider against the control channel is step 24's job, not this one's.
 */

import type { DurableStateProvider, DurableStateSnapshot, Section } from "./snapshotTypes";
import { captured, notCaptured } from "./snapshotTypes";

const NO_PROVIDER_REASON =
    "no durable-state provider was supplied: Memento/SecretStorage/webview state require a " +
    "running extension host reachable only through the E2E control channel (src/e2e/), which " +
    "does not run inside the snapshotWorkspace() test process";

export async function snapshotDurableState(
    provider: DurableStateProvider | undefined,
): Promise<Section<DurableStateSnapshot>> {
    if (!provider) return notCaptured(NO_PROVIDER_REASON);
    return captured(await provider.snapshotDurableState());
}
