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

    /**
     * The scanner matches literal token names. Every reference in this repository writes the name
     * out and interpolates only the FALLBACK (`var(--vscode-menu-border, ${...})`), so that holds
     * today -- but a token assembled from a variable would be invisible to the scan and would drop
     * out of the canary without any test noticing. This is that notice.
     */
    it("has no theme token whose NAME is built by interpolation", () => {
        const interpolated = [...tokens].filter((token) => token.includes("${"));
        expect(
            interpolated,
            "a token name assembled at runtime cannot be scanned, so it would silently leave the " +
                "comparison; write the name literally and interpolate only the fallback",
        ).toEqual([]);
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
