import path from "node:path";
import type { HostFixture, HostFixtureId } from "./types";

/**
 * Where captured host fixtures live, relative to the repo root.
 *
 * Chosen to match the naming convention PLAN.md step 11 already establishes
 * for Phase 2's recorded protocol payloads (`tests/visual/fixtures/<webview>/
 * <scenario>.json`) -- this is that same tree's `host/` sibling, one level
 * up from any particular webview, since host theme state is shared across
 * every webview a given VS Code instance hosts.
 */
export function hostFixtureOutputDir(repoRoot: string): string {
    return path.join(repoRoot, "tests", "visual", "fixtures", "host");
}

/** Canonical on-disk filename for a fixture id. */
function hostFixtureFileName(fixtureId: HostFixtureId): string {
    return `${fixtureId}.json`;
}

/** Absolute path for a fixture id's committed artifact. */
export function hostFixtureFilePath(repoRoot: string, fixtureId: HostFixtureId): string {
    return path.join(hostFixtureOutputDir(repoRoot), hostFixtureFileName(fixtureId));
}

/**
 * Serializes a host fixture to the exact bytes this capture writes to disk:
 * 4-space indented JSON (matching this repo's Prettier `tabWidth`), keys in
 * the fixed order the `HostFixture` type declares them in, one trailing
 * newline.
 *
 * This is the function PLAN.md's Phase 6 step 39 recapture-and-compare check
 * needs to call on a freshly recaptured fixture before byte-comparing it
 * against the committed file -- "canonical" means "this function's output",
 * not "however `JSON.stringify` happens to order things", which is why every
 * upstream canonicalization step (sorted class lists, sorted dataset keys,
 * sorted style properties -- see `canonicalizeHostFixture.ts`) already ran
 * before a `HostFixture` reaches here.
 */
export function serializeHostFixture(fixture: HostFixture): string {
    return `${JSON.stringify(fixture, null, 4)}\n`;
}
