// Shared types for the Phase 0 host-fixture capture (PLAN.md steps 4-5).
//
// A "host fixture" is a canonicalized snapshot of the theme state VS Code
// injects into a webview's active-frame document: the `--vscode-*` custom
// properties VS Code writes onto `documentElement.style`, plus the class
// lists and datasets it writes onto `documentElement` and `body`. Layer 1's
// visual harness (Phase 3) renders webview bundles against these fixtures
// instead of a live VS Code instance, so the fixture's shape has to capture
// everything a webview can branch on -- not just the CSS variables. See
// `src/webviews/react/merge-editor/shikiHighlighter.ts:68`, which branches
// on `document.body.classList.contains("vscode-dark")`: a fixture missing
// that class renders light syntax colours inside a dark baseline and the
// pixel diff still passes.

/** Bumped whenever the captured shape changes, so a stale committed fixture fails loudly instead of comparing against an incompatible shape. */
export const HOST_FIXTURE_SCHEMA_VERSION = 2;

/** The four built-in themes PLAN.md Phase 0 step 5 requires a fixture for. */
export type HostFixtureId = "dark-modern" | "light-modern" | "hc-black" | "hc-light";

/** One row of the theme matrix a capture run walks: which fixture id it produces, which built-in theme to seed, and the theme kind that seed must produce. */
export interface HostFixtureThemeConfig {
    readonly fixtureId: HostFixtureId;
    /** Exact `workbench.colorTheme` setting value -- the theme contribution's `id`, not its localized `label`. */
    readonly colorThemeSetting: string;
    /** Expected `document.body.dataset.vscodeThemeKind` once this theme is actually applied. Capture fails loudly if the observed value differs. */
    readonly expectedThemeKind: string;
}

/** Provenance recorded alongside every captured fixture, per PLAN.md step 4. */
interface HostFixtureProvenance {
    readonly captureSchemaVersion: number;
    readonly vscodeVersion: string;
    readonly vscodeCommit: string;
    /** `${process.platform}-${process.arch}`, e.g. `darwin-arm64`. */
    readonly platform: string;
    /**
     * The `data-vscode-theme-id` value actually OBSERVED after capture -- not
     * the value that was requested. Recording the request here would make this
     * field incapable of disagreeing with the seeded setting, and a field that
     * cannot disagree with what produced it is not evidence of anything.
     */
    readonly themeId: string;
    /** The `data-vscode-theme-name` value actually observed after capture. */
    readonly themeName: string;
    /**
     * The `workbench.colorTheme` value that was seeded. Kept alongside the
     * observed identity so a future reader can see both halves of the check
     * that passed, rather than having to trust that it ran.
     */
    readonly requestedTheme: string;
    /** The `data-vscode-theme-kind` value actually observed after capture. */
    readonly themeKind: string;
}

/** Canonicalized class-list-and-dataset snapshot of a single DOM element. */
interface HostFixtureElementSnapshot {
    /** Sorted, de-duplication not required -- `classList` never contains duplicates. */
    readonly classList: readonly string[];
    /** Keys sorted for stable JSON key order. */
    readonly dataset: Readonly<Record<string, string>>;
}

/** `documentElement` also carries the `--vscode-*` custom properties, which live nowhere else. */
interface HostFixtureDocumentElementSnapshot extends HostFixtureElementSnapshot {
    /** Canonicalized (sorted, normalized) rendering of `documentElement.style.cssText`, `--*` properties only. */
    readonly styleCssText: string;
}

/** One fully canonicalized, versioned host fixture -- the on-disk artifact. */
export interface HostFixture {
    readonly provenance: HostFixtureProvenance;
    readonly documentElement: HostFixtureDocumentElementSnapshot;
    readonly body: HostFixtureElementSnapshot;
}

/** Pre-canonicalization snapshot of a single element, as read directly out of the page. */
interface RawElementSnapshot {
    readonly classList: readonly string[];
    /** `DOMStringMap` values are typed `string | undefined`; canonicalization drops the `undefined` entries. */
    readonly dataset: Readonly<Record<string, string | undefined>>;
}

/** Pre-canonicalization snapshot read out of the active webview frame in one `evaluate` round trip. */
export interface RawHostSnapshot {
    /** `#root`'s child count -- `0` means the webview shell exists but React never mounted into it. */
    readonly childCount: number;
    readonly documentElement: RawElementSnapshot & { readonly styleCssText: string };
    readonly body: RawElementSnapshot;
}
