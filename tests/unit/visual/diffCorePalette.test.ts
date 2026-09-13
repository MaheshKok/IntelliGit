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

/**
 * Semantic hues a diff surface is allowed to draw a change colour from.
 *
 * Neither --diff-muted nor --diff-danger is one of them. --diff-muted was the deleted
 * state's hue and is still the secondary TEXT hue, so leaving it here would let deleted
 * quietly go back to grey while every guard stayed green. --diff-danger was the second
 * red: the merge surface's conflict hue, borrowed by the viewer for deletions before
 * --diff-deleted-hue was split out. One token per job, in both directions.
 */
const HUE_TOKENS = ["--diff-ok", "--diff-info", "--diff-deleted-hue"] as const;

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
 * The three block washes are a second name for a colour `--diff-*-wash` already owns.
 * Two names for one wash is how the surface ends up painting a block twice at two
 * strengths, and it is the shape someone reaches for when copying a rule across from
 * merge-editor.css, which really does call them `--merge-*-block-bg`. The viewer reads
 * the strength from those merge tokens instead (see the strength guard above), so a
 * local alias would be a value that agrees with the merge surface only by luck.
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

    it("washes a changed-segment block only through a token that degrades to nothing", () => {
        // Every state reaches its fixed fill through a named token, and a missing token
        // still degrades to a legible unpainted row rather than CSS `initial`.
        for (const [state, body] of stateRules(viewerCss)) {
            const background = propertyIn(body, "background");
            if (background === null) continue;
            expect(
                background,
                `${state} paints '${background}' as a literal; a background under a code glyph must come from a var() that falls back to \`transparent\`, or it can never be withdrawn per theme`,
            ).toMatch(/^var\(\s*--diff-[a-z-]+-wash\s*,\s*transparent\s*\)$/);
        }
    });

    it("pins the approved editor and change fills on both surfaces", () => {
        const mergeCss = stripComments(readFileSync(MERGE_EDITOR_CSS, "utf8"));
        for (const [source, token, value] of [
            [
                css,
                "--diff-editor-bg",
                "var(--merge-editor-bg, var(--vscode-editor-background, #313845))",
            ],
            [css, "--diff-editor-fg", "var(--merge-editor-fg, #abb2bf)"],
            [viewerCss, "--diff-inserted-wash", "#264b33"],
            [viewerCss, "--diff-deleted-wash", "#3b2a32"],
            [viewerCss, "--diff-modified-wash", "#3b2a32"],
            [viewerCss, "--diff-word-wash", "#4b1515"],
            [mergeCss, "--merge-editor-bg", "var(--vscode-editor-background, #313845)"],
            [mergeCss, "--merge-editor-fg", "#abb2bf"],
            [mergeCss, "--merge-conflict-block-bg", "#3b2a32"],
            [mergeCss, "--merge-conflict-ribbon-bg", "#4b1515"],
            [mergeCss, "--merge-inserted-block-bg", "#264b33"],
            [mergeCss, "--pycharm-inserted", "#315f3c"],
        ] as const) {
            expect(declarationOf(source, token), `${token} drifted from the fixed palette`).toBe(
                value,
            );
        }
    });

    it("keeps deletion on the approved strong red instead of muted text", () => {
        const mergeSource = stripComments(readFileSync(MERGE_EDITOR_CSS, "utf8"));
        expect(declarationOf(mergeSource, "--merge-deleted-hue")).toBe("#4b1515");
        expect(declarationOf(css, "--diff-deleted-hue")).toBe("var(--merge-deleted-hue, #4b1515)");
    });

    it("marks a changed word fragment with the fixed strong fill and nothing else", () => {
        const rule = /\.diff-viewer\s+\.word-diff-change\s*\{([^}]*)\}/.exec(viewerCss);
        expect(
            rule,
            "the viewer no longer styles .word-diff-change at all, so its word-highlight toggle renders nothing: the inherited tint resolves to `transparent` without the merge palette",
        ).toBeTruthy();

        const body = (rule?.[1] ?? "") as string;
        const background = propertyIn(body, "background");
        expect(
            background,
            "changed fragments have no fill, so on a theme that can pay for one there is no per-word marker at all",
        ).toMatch(/^var\(\s*--diff-word-wash\s*,\s*transparent\s*\)$/);

        // The underline this replaced is not a style preference to restore: the fill is
        // the merge editor's own marker, and two markers for one fragment read as two
        // different kinds of change.
        expect(
            propertyIn(body, "text-decoration-line"),
            "changed fragments underline again; the fill is the marker, and the surface this one mirrors draws no underline",
        ).toBeNull();

        expect(declarationOf(viewerCss, "--diff-word-wash")).toBe("#4b1515");
        expect(declarationOf(viewerCss, "--diff-modified-wash")).toBe("#3b2a32");
    });

    it("keeps the strong red word fill on the changed segment that owns it", () => {
        const changed = stateRules(viewerCss).get(MARKER_CLASS) ?? "";
        const override = propertyIn(changed, "--diff-word-wash");
        expect(override).toBe("#4b1515");
    });

    it("keeps modified areas and word highlights red on both panes", () => {
        const modified = stateRules(viewerCss).get("diff-segment-modified") ?? "";
        expect(hueIn(propertyIn(modified, "--diff-segment-hue"))).toBe("--diff-info");
        expect(propertyIn(modified, "background")).toBe("var(--diff-modified-wash, transparent)");

        /** Returns the pane-specific modified-word rule body, failing if it is absent. */
        const paneRule = (pane: "left" | "right"): string => {
            const match = new RegExp(
                `\\.diff-viewer\\s+\\.diff-pane-${pane}\\s+\\.diff-segment-modified\\s*\\{([^}]*)\\}`,
            ).exec(viewerCss);
            expect(
                match,
                `the ${pane} pane has no word-level override for a two-sided modification`,
            ).toBeTruthy();
            return match?.[1] ?? "";
        };

        const left = paneRule("left");
        expect(propertyIn(left, "--diff-segment-hue")).toBeNull();
        expect(propertyIn(left, "--diff-modified-wash")).toBeNull();
        expect(propertyIn(left, "--diff-word-wash")).toBe("#4b1515");
        expect(propertyIn(left, "background")).toBeNull();

        const right = paneRule("right");
        expect(propertyIn(right, "--diff-segment-hue")).toBeNull();
        expect(propertyIn(right, "--diff-modified-wash")).toBeNull();
        expect(propertyIn(right, "--diff-word-wash")).toBe("#4b1515");
        expect(propertyIn(right, "background")).toBeNull();
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
            // Read the hue from --diff-segment-hue, not box-shadow: the block's shadow is
            // one shared --diff-segment-shadow for every state, and the state's own colour
            // is the custom property that shadow resolves through.
            const blockHue = hueIn(
                propertyIn(
                    states.get(STRIPE_TONE_STATES[tone] as string) ?? "",
                    "--diff-segment-hue",
                ),
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

    it("brackets a changed hunk above and below, not only at its leading edge", () => {
        // The merge editor's hunk layout is a rule at the top AND the bottom of the block
        // (merge-editor.css:588-590). Only the pixel baselines would otherwise notice one
        // going missing, and those run in the review container -- so a bracket dropped
        // while editing the shadow list would reach a local green with nothing said.
        // Split on top-level commas so the commas inside color-mix() do not read as
        // separate shadows.
        const shadow = declarationOf(viewerCss, "--diff-segment-shadow");
        expect(
            shadow,
            "--diff-segment-shadow is no longer declared; every changed-segment rule reads it, so their box-shadow becomes invalid and the blocks lose both the edge bar and the bracket",
        ).toBeTruthy();

        const parts = (shadow ?? "").split(/,(?![^()]*\))/).map((part) => part.trim());
        const edge = parts.filter((part) => /^inset\s+[\d.]+px\s+0/.test(part));
        const above = parts.filter((part) => /^inset\s+0\s+[\d.]+px/.test(part));
        const below = parts.filter((part) => /^inset\s+0\s+(?:-[\d.]+px|calc\(\s*-)/.test(part));

        expect(
            { edge: edge.length, above: above.length, below: below.length },
            `--diff-segment-shadow draws ${parts.length} shadows (${parts.join(" | ")}); a changed hunk needs its leading edge bar plus one rule above and one below, or it stops reading as a bounded block the way the merge editor's hunks do`,
        ).toEqual({ edge: 1, above: 1, below: 1 });
    });

    it("draws a connector in a different hue for every state a segment can classify to", () => {
        // The base .diff-ribbon rule above is one fill, and a state with no rule of its own
        // inherits it silently: that is how every connector came to be drawn in --diff-info
        // while the blocks they joined were green, grey and cyan. Counting DISTINCT fills
        // rather than checking each rule exists is what makes that failure visible -- a
        // state added later with no rule collides with the base fill and drops the count.
        const base = /\.diff-ribbon\s*\{([^}]*)\}/.exec(viewerCss);
        const baseFill = propertyIn((base?.[1] ?? "") as string, "fill");
        expect(baseFill, ".diff-ribbon declares no fill at all").toBeTruthy();

        const overrides = new Map(
            [...viewerCss.matchAll(/\.diff-ribbon\.(diff-segment-[a-z]+)\s*\{([^}]*)\}/g)].map(
                ([, state, body]) => [state as string, propertyIn(body as string, "fill")],
            ),
        );
        const states = emittedStates().filter((state) => !ROWLESS_STATES.includes(state));
        const fills = states.map((state) => overrides.get(state) ?? baseFill);

        expect(
            new Set(fills).size,
            `the connector renders ${new Set(fills).size} hues for ${states.length} states (${states.map((state, at) => `${state}->${fills[at]}`).join(", ")}); a state with no .diff-ribbon rule of its own takes the base fill, so its band leads to a block painted in a different colour`,
        ).toBe(states.length);
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

    it("pins the conflict block and word fills to the approved reds", () => {
        const mergeCss = stripComments(readFileSync(MERGE_EDITOR_CSS, "utf8"));
        expect(declarationOf(mergeCss, "--merge-conflict-hue")).toBe("#4b1515");
        expect(declarationOf(mergeCss, "--merge-conflict-block-bg")).toBe("#3b2a32");
        expect(declarationOf(mergeCss, "--pycharm-conflict")).toBe("#4b1515");
    });
});
