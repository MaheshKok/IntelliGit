/**
 * The committed host fixtures under tests/visual/fixtures/host/ are evidence,
 * not configuration: later phases replay each fixture's `styleCssText` as the
 * harness page's `<html style>`, so every pixel baseline, clipping oracle and
 * truncation oracle downstream inherits whatever these files happen to say.
 *
 * That makes their failure mode invisible by construction. A comparison bug
 * announces itself on its first run; a replay bug never does, because the suite
 * stays perfectly self-consistent while measuring a machine that does not
 * exist. Nothing inside the visual suite can catch it -- the fixture is the
 * suite's own definition of reality.
 *
 * So the two facts a fixture silently depends on are asserted here, against
 * their real sources rather than against the fixture's own contents.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = process.cwd();
const HOST_FIXTURE_DIR = path.join(REPO_ROOT, "tests/visual/fixtures/host");
const RUN_SH_PATH = path.join(REPO_ROOT, "tests/e2e/docker/run.sh");
const WEBVIEW_SRC_DIR = path.join(REPO_ROOT, "src/webviews");

/**
 * Docker's platform vocabulary and Node's `${process.platform}-${process.arch}`
 * are different namespaces for the same machine, so translating between them
 * needs a map. The map is the only literal here on purpose: the platform itself
 * is READ from run.sh, so flipping the container to arm64 turns this red
 * instead of leaving four fixtures quietly describing a host nobody runs.
 */
const DOCKER_PLATFORM_TO_NODE_PLATFORM: Readonly<Record<string, string>> = {
    "linux/amd64": "linux-x64",
    "linux/arm64": "linux-arm64",
};

/** Anything that would make Chakra's color mode observable in a rendered webview. */
const CHAKRA_COLOR_MODE_CONSUMERS = [
    "useColorMode",
    "useColorModeValue",
    "ColorModeScript",
    "colorModeManager",
    "semanticTokens",
    "_dark:",
    "_light:",
] as const;

function readHostFixtures(): readonly { name: string; provenance: { platform: string } }[] {
    return readdirSync(HOST_FIXTURE_DIR)
        .filter((name) => name.endsWith(".json"))
        .map((name) => ({
            name,
            ...JSON.parse(readFileSync(path.join(HOST_FIXTURE_DIR, name), "utf8")),
        }));
}

describe("host fixture contract", () => {
    it("captures every fixture on the same platform the pinned container runs", () => {
        // Derived from run.sh rather than restated, because a fixture recorded
        // on a different platform is not a comparison failure that shows up on
        // the next run -- it is a replay that keeps passing. The macOS captures
        // this replaced differed from the container in exactly four values
        // (platform, --vscode-font-family, --vscode-editor-font-family,
        // --vscode-editor-font-size), and those four silently redefined the
        // font metrics every downstream layout assertion measures against.
        const runSh = readFileSync(RUN_SH_PATH, "utf8");
        const platformMatch = /^readonly PLATFORM="([^"]+)"$/m.exec(runSh);
        expect(platformMatch, `no 'readonly PLATFORM="…"' line in ${RUN_SH_PATH}`).not.toBeNull();

        const dockerPlatform = platformMatch![1];
        const expectedPlatform = DOCKER_PLATFORM_TO_NODE_PLATFORM[dockerPlatform];
        expect(
            expectedPlatform,
            `run.sh pins the container to "${dockerPlatform}", which this test has no Node ` +
                "platform-arch translation for. Add one rather than loosening the assertion.",
        ).toBeDefined();

        // Read off disk, never from a hardcoded list: a fifth theme added later
        // must be covered by this the moment it lands, and a renamed one must
        // not silently drop out of the check.
        const fixtures = readHostFixtures();
        expect(fixtures.length, `no host fixtures found in ${HOST_FIXTURE_DIR}`).toBeGreaterThan(0);

        expect(fixtures.map((fixture) => `${fixture.name}: ${fixture.provenance.platform}`)).toEqual(
            fixtures.map((fixture) => `${fixture.name}: ${expectedPlatform}`),
        );
    });

    it("keeps `chakra-ui-light` in the dark fixtures a recorded fact rather than a stale one", () => {
        // Every fixture -- including both dark-kind captures -- records
        // `chakra-ui-light` on `body` and `data-theme="light"` on
        // `documentElement`. That reads like a bug, and it is not one today:
        // Chakra's provider writes those from `useSystemColorMode` whether or
        // not anything reads them back, and no webview component resolves a
        // colour through the color mode -- they all resolve through
        // `--vscode-*` custom properties, which the fixture also records.
        //
        // The reason that justification lives in a test instead of a comment is
        // that a comment cannot notice when it stops being true. The day a
        // component starts reading the color mode, these committed captures
        // become wrong evidence -- still well-formed, still green -- and this
        // is what says so.
        const sourceFiles = readdirSync(WEBVIEW_SRC_DIR, { recursive: true })
            .map(String)
            .filter((relativePath) => /\.(ts|tsx)$/.test(relativePath));
        expect(sourceFiles.length, `no sources found under ${WEBVIEW_SRC_DIR}`).toBeGreaterThan(0);

        const offenders = sourceFiles.flatMap((relativePath) => {
            const contents = readFileSync(path.join(WEBVIEW_SRC_DIR, relativePath), "utf8");
            return CHAKRA_COLOR_MODE_CONSUMERS.filter((token) => contents.includes(token)).map(
                (token) => `${relativePath}: ${token}`,
            );
        });

        expect(
            offenders,
            "A webview source now consumes Chakra's color mode, so `chakra-ui-light` in the " +
                "dark-kind host fixtures is no longer inert. Recapture the fixtures " +
                "(`bun run capture:host-fixtures` in the pinned container) and re-verify the " +
                "downstream baselines -- do not delete this assertion.",
        ).toEqual([]);
    });
});
