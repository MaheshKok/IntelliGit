import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { SEGMENT_MARKERS } from "../../../src/webviews/react/diff-viewer/segmentMarkers";
import { STRIPE_TONES } from "../../../src/webviews/react/diff-viewer/changeStripe";

const DIFF_CORE_CSS = resolve(__dirname, "../../../src/webviews/react/diff-core/diff-core.css");
const DIFF_VIEWER_CSS = resolve(
    __dirname,
    "../../../src/webviews/react/diff-viewer/diff-viewer.css",
);
const MERGE_EDITOR_CSS = resolve(
    __dirname,
    "../../../src/webviews/react/merge-editor/merge-editor.css",
);
const SEGMENT_MARKERS_SOURCE = resolve(
    __dirname,
    "../../../src/webviews/react/diff-viewer/segmentMarkers.ts",
);

/** Semantic hues a diff surface is allowed to draw a change colour from. */
const HUE_TOKENS = ["--diff-ok", "--diff-danger", "--diff-info", "--diff-muted"] as const;

/**
 * The changed-segment state each stripe tone points at. The stripe exists so a reader can
 * see where the changes are without scrolling, which only works if following a mark lands
 * on a block of the same colour -- so the two are pinned to one hue apiece, in both
 * directions, rather than left to agree by memory.
 */
const STRIPE_TONE_STATES: Readonly<Record<string, string>> = {
    inserted: "diff-segment-inserted",
    deleted: "diff-segment-deleted",
    modified: "diff-segment-modified",
};

/**
 * The class every changed block carries alongside exactly one state class. It is a
 * marker for structure, not a paint target: a colour of its own lands underneath the
 * state's own and doubles it.
 */
const MARKER_CLASS = "diff-segment-changed";

/**
 * The states whose pane block holds no real code row. Each pane is sized from its own
 * line count, so these render zero pixels tall and any rule targeting them can never
 * paint: they are exempt from the marking requirement rather than styled differently.
 */
const ROWLESS_STATES: readonly string[] = ["diff-segment-empty"];

/**
 * Aliases a read-only two-pane diff must not grow back.
 *
 * The conflict pair is structural: a viewer has no conflicts, and the merge surface
 * declares its own conflict colours, so the only rule that could read a --diff-*
 * conflict alias is one painting a danger hue under an unrelated state.
 *
 * The three block washes are the contrast defect itself. Syntax tokens are coloured
 * for the plain editor background; VS Code's light themes give the number token
 * #098658, which measures 4.60:1 on white against a 4.5 floor, so a wash as faint as
 * a 4% mix measured 4.3-4.4 in light-modern and hc-light. No percentage is both
 * visible and legal, which makes re-declaring one a silent regression rather than a
 * tuning choice -- and the tuning is exactly what someone reaches for first.
 */
const FORBIDDEN_ALIASES = [
    "--diff-conflict-block-bg",
    "--diff-pycharm-conflict",
    "--diff-inserted-block-bg",
    "--diff-modified-block-bg",
    "--diff-deleted-block-bg",
] as const;

/** Rules whose selector is one `.diff-change-*` class, keyed by the suffix. */
function changeRules(css: string): Map<string, string> {
    const rules = new Map<string, string>();
    for (const match of css.matchAll(/\.diff-change-([a-z]+)\s*\{([^}]*)\}/g)) {
        rules.set(match[1] as string, `${rules.get(match[1] as string) ?? ""}${match[2]}`);
    }
    return rules;
}

/** The hue token a declaration draws from, or null when it names no --diff-* alias. */
function hueIn(value: string | null): string | null {
    const match = value === null ? null : /var\(\s*(--diff-[a-z0-9-]+)/.exec(value);
    return match ? (match[1] as string) : null;
}

/** Rules whose selector is one state class scoped to the viewer root. */
function stateRules(css: string): Map<string, string> {
    const rules = new Map<string, string>();
    for (const match of css.matchAll(/\.diff-viewer\s+\.(diff-segment-[a-z]+)\s*\{([^}]*)\}/g)) {
        rules.set(match[1] as string, `${rules.get(match[1] as string) ?? ""}${match[2]}`);
    }
    return rules;
}

/** The value of one declaration inside a rule body, or null when it is absent. */
function propertyIn(body: string, property: string): string | null {
    const match = new RegExp(`(?:^|;)\\s*${property}\\s*:([^;]*)`).exec(body);
    return match ? (match[1] as string).trim() : null;
}

/** Returns a custom property's full declaration value, spanning nested parentheses. */
function declarationOf(css: string, name: string): string | null {
    const marker = `${name}:`;
    const at = css.indexOf(marker);
    if (at === -1) return null;

    let depth = 0;
    for (let i = at + marker.length; i < css.length; i++) {
        const character = css[i];
        if (character === "(") depth += 1;
        else if (character === ")") depth -= 1;
        else if (character === ";" && depth === 0) {
            return css.slice(at + marker.length, i).trim();
        }
    }
    return null;
}

/** Strips comments so a rule quoted in prose is never read as a rule. */
function stripComments(css: string): string {
    return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("diff-core palette", () => {
    const css = stripComments(readFileSync(DIFF_CORE_CSS, "utf8"));
    const viewerCss = stripComments(readFileSync(DIFF_VIEWER_CSS, "utf8"));

    /**
     * Every changed-segment state a viewer pane block can carry, read out of the
     * classifier's own source rather than from its exported inventory: a state the
     * function can return but the inventory forgot would otherwise be invisible here,
     * and the inventory is what the fixture-coverage oracle iterates.
     */
    const emittedStates = (): string[] => {
        const emitted = new Set(
            [...readFileSync(SEGMENT_MARKERS_SOURCE, "utf8").matchAll(/diff-segment-[a-z]+/g)].map(
                (match) => match[0],
            ),
        );
        expect(
            emitted.delete(MARKER_CLASS),
            `${MARKER_CLASS} is no longer emitted; it is the marker every changed block carries alongside exactly one state`,
        ).toBe(true);
        expect(emitted.size, "the viewer emits no changed-segment states at all").toBeGreaterThan(
            0,
        );
        return [...emitted].sort();
    };

    it("exports every state its classifier can return", () => {
        expect(
            [...SEGMENT_MARKERS].sort(),
            "SEGMENT_MARKERS no longer lists every state segmentMarker() can return; the fixture-coverage oracle iterates that inventory, so a state missing from it is a state nothing checks the recorded fixture for",
        ).toEqual(emittedStates());
    });

    it("declares every semantic hue a change colour is drawn from", () => {
        for (const hue of HUE_TOKENS) {
            expect(declarationOf(css, hue), `${hue} is not declared in diff-core.css`).toBeTruthy();
        }
    });

    it("leaves the word-fragment tint transparent for a surface that never imports the merge palette", () => {
        // The merge editor declares --pycharm-modified, so its first var() leg wins and
        // its fragment tint is untouched. The viewer has no such declaration, and the
        // fallback is where the palette decision lives: a colour here would put a
        // background behind code text, which is the one thing the 4.5 floor forbids.
        const declaration = declarationOf(css, "--diff-pycharm-modified");
        expect(
            declaration,
            "--diff-pycharm-modified is not declared in diff-core.css",
        ).toBeTruthy();
        expect(
            declaration,
            "--diff-pycharm-modified no longer falls back to `transparent`, so a viewer bundle paints a background behind changed code fragments and loses the contrast this palette was rebuilt to keep",
        ).toBe("var(--pycharm-modified, transparent)");
    });

    it("marks every changed-segment state that renders a row", () => {
        // Two-way, so a state added to the classifier without a rule fails and a rule kept
        // for a state the classifier no longer returns fails too; neither can rot into a
        // list of historical class names. The rowless states are excluded on both sides:
        // they are zero pixels tall, so a rule there is paint nothing can show, and
        // requiring one would pin dead CSS in place.
        const marked = [...stateRules(viewerCss)]
            .filter(
                ([, body]) =>
                    propertyIn(body, "box-shadow") !== null ||
                    propertyIn(body, "background") !== null,
            )
            .map(([state]) => state)
            .sort();

        expect(
            marked,
            `a changed-segment state with neither an edge bar nor a wash renders identically to unchanged code, ${MARKER_CLASS} must stay unmarked or its colour doubles the state's own, and a rowless state must carry no rule at all`,
        ).toEqual(emittedStates().filter((state) => !ROWLESS_STATES.includes(state)));
    });

    it("paints no background under any changed-segment block", () => {
        // The load-bearing assertion of this palette. A background under a code row is
        // measurable contrast loss no wash percentage escapes (4.3-4.4 at a 4% mix in
        // light-modern and hc-light, against a 4.5 floor), so the marker moved to the
        // block edge and no state kept a wash -- including the rowless counterpart of a
        // one-sided hunk, whose band could never render at zero height anyway.
        const painted = [...stateRules(viewerCss)]
            .filter(([, body]) => propertyIn(body, "background") !== null)
            .map(([state]) => state)
            .sort();

        expect(
            painted,
            "a changed-segment state painted a background; every glyph above it loses contrast, and the light themes have none to spare",
        ).toEqual([]);
    });

    it("underlines changed word fragments instead of tinting them", () => {
        const rule = /\.diff-viewer\s+\.word-diff-change\s*\{([^}]*)\}/.exec(viewerCss);
        expect(
            rule,
            "the viewer no longer styles .word-diff-change at all, so its word-highlight toggle renders nothing: the inherited tint resolves to `transparent` without the merge palette",
        ).toBeTruthy();

        const body = (rule?.[1] ?? "") as string;
        expect(
            propertyIn(body, "text-decoration-line"),
            "changed fragments lost their underline, which is the viewer's only per-word signal",
        ).toBe("underline");
        expect(
            propertyIn(body, "background"),
            "the viewer tinted changed fragments after all; a background behind a code glyph is the contrast defect the block wash was removed for",
        ).toBeNull();
    });

    it("fills the connector ribbon from a semantic hue, not a wash", () => {
        const rule = /\.diff-ribbon\s*\{([^}]*)\}/.exec(viewerCss);
        const fill = propertyIn((rule?.[1] ?? "") as string, "fill");
        expect(
            HUE_TOKENS.some((hue) => fill?.includes(`var(${hue})`)),
            `.diff-ribbon fills with ${fill ?? "nothing"}; drawn from a near-background wash the ribbon is erased by its own 0.18 opacity and the two panes lose their connectors`,
        ).toBe(true);
    });

    it("draws every stripe mark in the hue of the block it points at", () => {
        // The stripe's whole claim is that a mark predicts what is at that scroll
        // position. A tone whose colour drifts from its state's edge bar keeps pointing
        // at the right line in the wrong colour, which reads as a different kind of
        // change -- worse than no marker, and invisible to a pixel baseline that
        // rerecorded both together.
        const changes = changeRules(viewerCss);
        const states = stateRules(viewerCss);

        for (const tone of STRIPE_TONES) {
            const markHue = hueIn(propertyIn(changes.get(tone) ?? "", "background"));
            const blockHue = hueIn(
                propertyIn(states.get(STRIPE_TONE_STATES[tone] as string) ?? "", "box-shadow"),
            );
            expect(
                markHue,
                `.diff-change-${tone} paints with ${markHue ?? "no --diff-* hue"}, so the stripe mark for a ${tone} change is drawn from something the palette does not own`,
            ).not.toBeNull();
            expect(
                markHue,
                `.diff-change-${tone} is ${markHue} but ${STRIPE_TONE_STATES[tone]} is ${blockHue}; following that mark lands on a differently coloured block`,
            ).toBe(blockHue);
            expect(
                HUE_TOKENS.includes(markHue as (typeof HUE_TOKENS)[number]),
                `${markHue} is not a semantic hue`,
            ).toBe(true);
        }
    });

    it("paints no stripe mark in a tone the classifier cannot produce", () => {
        // The other direction: a leftover rule for a tone nothing emits is a colour
        // waiting to be reintroduced, the same failure the dead-alias check exists for.
        const painted = [...changeRules(viewerCss)]
            .filter(([, body]) => propertyIn(body, "background") !== null)
            .map(([tone]) => tone)
            .sort();

        expect(
            painted,
            "a .diff-change-* rule paints a tone buildStripeMarks never returns",
        ).toEqual([...STRIPE_TONES].sort());
    });

    it("declares no --diff-* alias that nothing reads", () => {
        // The check that caught this palette twice. Removing a rule is how an alias goes
        // dead, and a dead declaration reads exactly like a live one at the top of a
        // stylesheet -- so the next reader restores a wash "back to where it belongs".
        const sources = [css, viewerCss, stripComments(readFileSync(MERGE_EDITOR_CSS, "utf8"))];
        const declared = new Set(
            sources.flatMap((source) =>
                [...source.matchAll(/^\s*(--diff-[a-z0-9-]+)\s*:/gm)].map(
                    (match) => match[1] as string,
                ),
            ),
        );
        const read = new Set(
            sources.flatMap((source) =>
                [...source.matchAll(/var\(\s*(--diff-[a-z0-9-]+)/g)].map(
                    (match) => match[1] as string,
                ),
            ),
        );

        expect(
            [...declared].filter((name) => !read.has(name)).sort(),
            "these --diff-* aliases are declared and never read; a colour nobody paints with is an invitation to paint with it",
        ).toEqual([]);
    });

    it("forbids the aliases a read-only two-pane diff must not grow back", () => {
        for (const alias of FORBIDDEN_ALIASES) {
            expect(
                declarationOf(css, alias),
                `${alias} is back in diff-core.css. See FORBIDDEN_ALIASES: it is either a conflict colour on a surface with no conflicts, or a block wash under code text that no percentage makes legal`,
            ).toBeNull();
            expect(
                declarationOf(viewerCss, alias),
                `${alias} is back in diff-viewer.css. See FORBIDDEN_ALIASES: it is either a conflict colour on a surface with no conflicts, or a block wash under code text that no percentage makes legal`,
            ).toBeNull();
        }
    });

    it("keeps the merge overrides the sole source of the merge surface's own values", () => {
        // The merge editor still declares --merge-*/--pycharm-* itself, so its first
        // var() leg wins and the diff-core fallback above is never evaluated there.
        // That is what keeps merge rendering byte-identical while the viewer diverges.
        const mergeCss = readFileSync(MERGE_EDITOR_CSS, "utf8");
        for (const override of [
            "--merge-conflict-block-bg",
            "--merge-inserted-block-bg",
            "--merge-modified-block-bg",
            "--merge-deleted-block-bg",
            "--pycharm-conflict",
            "--pycharm-inserted",
            "--pycharm-modified",
            "--pycharm-deleted",
        ]) {
            expect(
                declarationOf(mergeCss, override),
                `${override} is no longer declared in merge-editor.css, so the merge surface would fall through to the diff-core defaults and its pixels would move`,
            ).toBeTruthy();
        }
    });
});
