import type { HostFixtureThemeConfig } from "./types";

/**
 * The four built-in VS Code themes PLAN.md Phase 0 step 5 requires captured
 * -- each in a fresh profile with this exact `workbench.colorTheme` value
 * seeded explicitly, never "whatever theme happened to be active". The
 * high-contrast pair is required, not optional: Phase 3's non-pixel
 * high-contrast assertions have nothing to assert against without them.
 *
 * `colorThemeSetting` values are the theme contribution `id` fields VS Code
 * 1.132.0 ships in `extensions/theme-defaults/package.json` -- verified
 * directly against the pinned build (downloaded to the out-of-repo cache
 * `resolveVSCodeExecutable.ts` manages), not assumed:
 *
 * ```
 * Dark Modern              | vs-dark   | ./themes/dark_modern.json
 * Light Modern              | vs        | ./themes/light_modern.json
 * Default High Contrast     | hc-black  | ./themes/hc_black.json
 * Default High Contrast Light | hc-light | ./themes/hc_light.json
 * ```
 *
 * `workbench.colorTheme` matches against a theme's `id` when it contributes
 * one (all four built-ins above do), not its localized `label`.
 *
 * `expectedThemeKind` values are the exact strings VS Code's webview preload
 * writes to `document.body.dataset.vscodeThemeKind` --
 * `out/vs/workbench/contrib/webview/browser/pre/index.html`'s `applyStyles`,
 * also read directly out of the downloaded 1.132.0 build:
 *
 * ```js
 * body.classList.remove('vscode-light', 'vscode-dark', 'vscode-high-contrast', 'vscode-high-contrast-light', ...);
 * if (initData.activeTheme) {
 *     body.classList.add(initData.activeTheme);
 *     if (initData.activeTheme === 'vscode-high-contrast-light') {
 *         body.classList.add('vscode-high-contrast'); // backwards compatibility
 *     }
 * }
 * body.dataset.vscodeThemeKind = initData.activeTheme;
 * ```
 *
 * `capture.ts` reads this value back after launch and fails loudly if it
 * does not match -- the theme was requested but never verified applied is
 * exactly the silent-false-green PLAN.md's governing principle rules out.
 */
export const HOST_FIXTURE_THEMES: readonly HostFixtureThemeConfig[] = [
    {
        fixtureId: "dark-modern",
        colorThemeSetting: "Dark Modern",
        expectedThemeKind: "vscode-dark",
    },
    {
        fixtureId: "light-modern",
        colorThemeSetting: "Light Modern",
        expectedThemeKind: "vscode-light",
    },
    {
        fixtureId: "hc-black",
        colorThemeSetting: "Default High Contrast",
        expectedThemeKind: "vscode-high-contrast",
    },
    {
        fixtureId: "hc-light",
        colorThemeSetting: "Default High Contrast Light",
        expectedThemeKind: "vscode-high-contrast-light",
    },
] as const;
