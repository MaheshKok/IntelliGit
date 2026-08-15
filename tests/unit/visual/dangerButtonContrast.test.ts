/**
 * The destructive button's label must stay readable on its own red wash.
 *
 * This pins a defect that shipped for the life of the button and was invisible
 * to every gate: `danger` painted its label in `--intelligit-pycharm-deleted`
 * on a backdrop tinted with THAT SAME token. The two move together, so the
 * ratio cannot be fixed by choosing a better red -- measured here, every red
 * VS Code exposes fails on at least one of the four shipped themes.
 *
 * It stayed hidden because the only oracle that could see it -- the container
 * contrast sweep -- was baselined while an unrelated commit (4e2207b7) had
 * temporarily lightened `deleted`, so the failing cell was never recorded.
 *
 * The measurement is done here, in a unit test, rather than left to that sweep:
 * the sweep observes whichever buttons a scenario happens to render, while this
 * reads the variant definition itself and so cannot go quiet because a fixture
 * stopped showing the button.
 */

import { describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
    compositeOver,
    contrastRatio,
    readFixtureVariables,
    resolveColor,
    resolveRgba,
} from "../../helpers/cssColor";
import theme from "../../../src/webviews/react/commit-panel/theme";

const FIXTURE_DIR = join(process.cwd(), "tests/visual/fixtures/host");
const WCAG_AA_NORMAL_TEXT = 4.5;

/**
 * The panes a `danger` button is rendered in. The tint is translucent, so the
 * effective backdrop is the composite -- not the tint, and not the pane.
 */
const PANES = [
    { name: "editor", expression: "var(--vscode-editor-background, #1f1f1f)" },
    { name: "side bar", expression: "var(--vscode-sideBar-background, #181818)" },
] as const;

interface DangerStyle {
    bg: string;
    color: string;
    _hover?: { bg?: string };
}

type ThemeShape = {
    components?: { Button?: { variants?: Record<string, DangerStyle> } };
    styles?: { global?: Record<string, Record<string, string>> };
};

/**
 * Reads the variant straight off the theme object, so renaming or restructuring
 * it fails loudly here instead of silently skipping the assertions below.
 */
function dangerVariant(): DangerStyle {
    const danger = (theme as unknown as ThemeShape).components?.Button?.variants?.danger;
    if (!danger?.bg || !danger.color) {
        throw new Error(
            "the commit-panel theme no longer exposes a Button `danger` variant with `bg` and `color`",
        );
    }
    return danger;
}

/**
 * A host fixture only carries `--vscode-*`; the `--intelligit-pycharm-*` layer is
 * declared by the webview itself. This reads that layer out of the SAME object
 * Chakra emits into `:root`, rather than restating it here -- a copy would keep
 * measuring the old value for as long as it took anyone to notice the drift.
 */
function withWebviewTokens(variables: Map<string, string>): Map<string, string> {
    const rootTokens = (theme as unknown as ThemeShape).styles?.global?.[":root"];
    if (!rootTokens?.["--intelligit-pycharm-deleted"]) {
        throw new Error(
            "the commit-panel theme no longer publishes --intelligit-pycharm-* under styles.global[':root']",
        );
    }
    const seeded = new Map(variables);
    for (const [name, value] of Object.entries(rootTokens)) {
        // The webview's declarations lose to the host's, exactly as the cascade
        // resolves them: `:root` here is overridden by the host's own inline style.
        if (!seeded.has(name)) seeded.set(name, value);
    }
    return seeded;
}

const fixtureFiles = readdirSync(FIXTURE_DIR).filter((name) => name.endsWith(".json"));

describe("the danger button's label contrasts with its own tint", () => {
    it("finds the host fixtures to measure against", () => {
        // Without this the suite below would iterate an empty list and pass.
        expect(fixtureFiles.length, `no *.json fixtures in ${FIXTURE_DIR}`).toBeGreaterThanOrEqual(
            4,
        );
    });

    for (const fixtureName of fixtureFiles) {
        const themeName = fixtureName.replace(/\.json$/, "");

        for (const pane of PANES) {
            for (const state of ["rest", "hover"] as const) {
                it(`${themeName}: the label clears ${WCAG_AA_NORMAL_TEXT}:1 on the ${pane.name} at ${state}`, () => {
                    const variables = withWebviewTokens(
                        readFixtureVariables(join(FIXTURE_DIR, fixtureName)),
                    );
                    const danger = dangerVariant();

                    const tintExpression =
                        state === "hover" ? (danger._hover?.bg ?? danger.bg) : danger.bg;
                    const tint = resolveRgba(tintExpression, variables);

                    // A tint that resolved opaque would mean the composite below is
                    // measuring the pane for nothing, and every ratio would be the
                    // tint's own -- correct by accident on some themes, wrong on others.
                    expect(
                        tint.alpha,
                        `the ${state} tint resolved opaque; it is supposed to be a translucent wash over the pane`,
                    ).toBeLessThan(1);

                    const backdrop = compositeOver(tint, resolveColor(pane.expression, variables));
                    const label = resolveColor(danger.color, variables);
                    const ratio = contrastRatio(label, backdrop);

                    expect(
                        ratio,
                        `the danger label resolves to rgb(${label.join(", ")}) on rgb(${backdrop.join(", ")}) ` +
                            `in ${themeName} = ${ratio.toFixed(2)}:1. Note that the backdrop is tinted with ` +
                            `\`deleted\`, so colouring the label with any red moves BOTH sides together and ` +
                            `cannot be relied on -- see the note on the variant in commit-panel/theme.ts.`,
                    ).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
                });
            }
        }
    }
});
