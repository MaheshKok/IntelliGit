// The scanner behind the Insiders comparison's narrowing. Every assertion here reads the REAL
// `src` tree rather than a fixture: the set's whole job is to track what the extension actually
// styles itself with, so a test that fed it hand-written input would prove the regex and nothing
// about the repository.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { readConsumedThemeTokens } from "../../e2e/hostFixtures/consumedThemeTokens";

const REPO_ROOT = resolve(__dirname, "..", "..", "..");

describe("readConsumedThemeTokens", () => {
    const tokens = readConsumedThemeTokens(REPO_ROOT);

    // Without this the assertions below are vacuous the day the webview sources move.
    it("finds the theme tokens this repository actually references", () => {
        expect(
            tokens.size,
            "the scan must find the ~81 tokens src references; a near-empty set would silently " +
                "switch the Insiders canary off rather than narrow it",
        ).toBeGreaterThan(40);
        expect(tokens.has("--vscode-editor-background")).toBe(true);
        expect(tokens.has("--vscode-sideBar-background")).toBe(true);
    });

    /**
     * The regression oracle, tied to a real failure rather than to a plausible one.
     *
     * Run 32615426982 (2026-08-23, `E2E Flow Suite - VS Code Insiders`) failed on every theme with
     * exactly these three tokens, on a commit that already ignored upstream ADDITIONS -- all three
     * were redefined, not added. None is named anywhere in `src`, so none can change how this
     * extension renders. If a future edit makes the scanner over-broad, this is what goes red.
     */
    it.each([
        "--vscode-agents-layout-floatingPanelGap",
        "--vscode-agentsPanel-border",
        "--vscode-surface-border",
    ])("excludes %s, which failed the 2026-08-23 Insiders run and nothing reads", (token) => {
        expect(tokens.has(token)).toBe(false);
    });

    it("scans the real src tree without tripping the interpolated-name guard", () => {
        expect(
            () => readConsumedThemeTokens(REPO_ROOT),
            "every reference in src must write the token name out and interpolate only the " +
                "FALLBACK, or the canary stops watching it",
        ).not.toThrow();
    });

    /**
     * The interpolation guard, asserted where it can actually fail.
     *
     * A previous version of this test filtered the RESULT set for `${` -- which is vacuous, because
     * `THEME_TOKEN_PATTERN` cannot match a `$` and so can never put an interpolated name INTO the
     * set. The construction has to be caught in the file contents at scan time, which is what these
     * two cases exercise. Both shapes fail, in different ways:
     *
     * - `--vscode-${x}` matches nothing and vanishes from the comparison silently;
     * - `--vscode-menu-${x}` matches the `--vscode-menu-` PREFIX and enters the set as a token that
     *   does not exist, so the real one is unwatched AND the filter carries a phantom.
     */
    it.each([
        ["a fully interpolated name", "`var(--vscode-${slot}-background)`"],
        ["a name interpolated after a literal prefix", "`var(--vscode-menu-${part})`"],
    ])("throws on %s rather than scanning past it", (_label, source) => {
        const root = mkdtempSync(join(tmpdir(), "intelligit-interpolated-token-"));
        mkdirSync(join(root, "src"));
        // Enough literal tokens to clear the 40-token floor, so a throw here proves the
        // interpolation guard fired rather than the fail-loud minimum.
        writeFileSync(
            join(root, "src", "plenty.ts"),
            Array.from({ length: 50 }, (_unused, index) => `// --vscode-token-${index}`).join("\n"),
            "utf8",
        );
        writeFileSync(
            join(root, "src", "interpolated.ts"),
            `export const css = ${source};\n`,
            "utf8",
        );

        expect(
            () => readConsumedThemeTokens(root),
            "a token name assembled at runtime cannot be scanned, so it would silently leave the " +
                "comparison; the scan must refuse rather than guess",
        ).toThrow(/builds a theme token NAME by interpolation/);
    });

    it("throws rather than returning a set too small to be a real filter", () => {
        const root = mkdtempSync(join(tmpdir(), "intelligit-consumed-tokens-"));
        mkdirSync(join(root, "src"));
        writeFileSync(join(root, "src", "empty.ts"), "export const nothing = 1;\n", "utf8");

        expect(
            () => readConsumedThemeTokens(root),
            "failing open here would compare zero tokens and pass every future theme change; " +
                "the canary must break loudly instead",
        ).toThrow(/found only 0 VS Code theme tokens/);
    });
});
