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
        // Every wash reaches the block through `var(--diff-*-wash, transparent)` and never
        // as a literal colour. The fallback is what makes the palette recoverable: a token
        // that fails to resolve leaves the block bare and legible, where a literal would
        // keep painting under the glyphs with no way to turn it off per theme. It is also
        // the seam a theme gate is reinstated through if the contrast cost recorded in
        // knownFindings.json is ever judged too high -- declaring the tokens behind a
        // theme selector then restores the bare light themes with no rule change here.
        for (const [state, body] of stateRules(viewerCss)) {
            const background = propertyIn(body, "background");
            if (background === null) continue;
            expect(
                background,
                `${state} paints '${background}' as a literal; a background under a code glyph must come from a var() that falls back to \`transparent\`, or it can never be withdrawn per theme`,
            ).toMatch(/^var\(\s*--diff-[a-z-]+-wash\s*,\s*transparent\s*\)$/);
        }
    });

    it("mixes every wash from the merge surface's own hue at its own strength", () => {
        // "Same colours as the merge editor" is only auditable if the numbers are compared
        // rather than copied: a percentage typed into both files drifts the moment one is
        // tuned, and nothing here would notice, because both surfaces would still be
        // internally consistent. So each viewer strength is checked against the merge
        // token it mirrors, read out of merge-editor.css at run time.
        //
        // This replaces the theme gate that used to live here. The gate said no wash may
        // reach a light theme, because light themes have no contrast headroom for one --
        // still true, and still measured (see the ladder in diff-viewer.css). It was
        // dropped deliberately in favour of matching the merge surface everywhere, with
        // the resulting contrast findings recorded in knownFindings.json. That is what
        // makes this a decision with a cost rather than an oversight, and it is why the
        // baseline entries must never be treated as noise to be regenerated: a finding
        // beyond them is still a failure.
        const mergeCss = stripComments(readFileSync(MERGE_EDITOR_CSS, "utf8"));
        const percentOf = (source: string, token: string, where: string): number => {
            const declaration = declarationOf(source, token);
            expect(declaration, `${token} is not declared in ${where}`).toBeTruthy();
            const percent = /\)\s*(\d+(?:\.\d+)?)%/.exec(declaration ?? "");
            expect(
                percent,
                `${token} in ${where} is no longer a color-mix percentage, so the two surfaces can no longer be compared by this guard`,
            ).toBeTruthy();
            return Number(percent?.[1]);
        };
        // The hue half of the same comparison. A strength check alone would have let the
        // deleted state go red on one surface and stay grey on the other -- both files
        // internally consistent, both at 15%, and the product showing one state in two
        // colours. The token NAMES are compared with their surface prefix stripped, so
        // --diff-deleted-hue matches --merge-deleted-hue and a rename on one side that
        // is not mirrored on the other fails here rather than in a screenshot.
        const hueOf = (source: string, token: string, where: string): string => {
            const hue = /var\(\s*(--[a-z0-9-]+)/.exec(declarationOf(source, token) ?? "");
            expect(
                hue,
                `${token} in ${where} no longer mixes from a var() hue, so the two surfaces can no longer be compared by this guard`,
            ).toBeTruthy();
            return (hue?.[1] ?? "").replace(/^--(?:diff|merge|pycharm)-/, "");
        };

        const pairs: readonly (readonly [string, string])[] = [
            ["--diff-inserted-wash", "--merge-inserted-block-bg"],
            ["--diff-deleted-wash", "--merge-deleted-block-bg"],
            ["--diff-modified-wash", "--merge-modified-block-bg"],
            ["--diff-word-wash", "--pycharm-modified"],
        ];
        for (const [viewerToken, mergeToken] of pairs) {
            expect(
                percentOf(viewerCss, viewerToken, "diff-viewer.css"),
                `${viewerToken} no longer mixes at the same strength as ${mergeToken}, so the read-only viewer and the merge editor paint the same state two different shades`,
            ).toBe(percentOf(mergeCss, mergeToken, "merge-editor.css"));
            expect(
                hueOf(viewerCss, viewerToken, "diff-viewer.css"),
                `${viewerToken} no longer mixes the same hue as ${mergeToken}, so the two surfaces paint one state in two different colours`,
            ).toBe(hueOf(mergeCss, mergeToken, "merge-editor.css"));
        }
    });

    it("gives the deleted state a red of its own, apart from the conflict red and the muted text", () => {
        // Deletions went red at the user's request. Two collisions had to be avoided to do
        // it, and both are the shape a later simplification reaches for:
        //
        //   --merge-muted  is ALSO the secondary text hue (six `color:` rules in
        //                  merge-editor.css, the pane labels in diff-viewer.css, the
        //                  line-number blend in diff-core.css). Repointing it would have
        //                  turned every muted label red, so the deleted state needed a
        //                  token of its own before it could stop being grey.
        //   --merge-danger is the CONFLICT hue, and a merge can show a deleted hunk and a
        //                  conflict hunk in one scroll. Reading it here would make the two
        //                  states one colour -- and a second red theme token would not
        //                  help, because themes ship one red (Dark Modern: errorForeground
        //                  #f85149, charts-red #f14c4c).
        //
        // What separates them is the muted leg blended back in, which is why this asserts
        // the hue is a mix rather than only that it is a different name.
        const mergeSource = stripComments(readFileSync(MERGE_EDITOR_CSS, "utf8"));
        const declaration = declarationOf(mergeSource, "--merge-deleted-hue");
        expect(
            declaration,
            "--merge-deleted-hue is gone; the deleted state now reads whatever token replaced it, which is either the conflict red or the muted text hue",
        ).toBeTruthy();

        const read = [...(declaration ?? "").matchAll(/var\(\s*(--[a-z0-9-]+)/g)].map(
            (match) => match[1],
        );
        expect(
            read,
            `--merge-deleted-hue reads ${read.join(", ")}; reading --merge-danger makes a deleted hunk indistinguishable from a conflict`,
        ).not.toContain("--merge-danger");
        expect(
            read,
            "--merge-deleted-hue no longer blends the muted hue in, so nothing keeps it duller than the conflict red on a theme whose reds coincide",
        ).toContain("--merge-muted");

        for (const [file, source, hue, muted] of [
            ["merge-editor.css", mergeSource, "--merge-deleted-hue", "--merge-muted"],
            ["diff-core.css", css, "--diff-deleted-hue", "--diff-muted"],
        ] as const) {
            expect(
                declarationOf(source, hue),
                `${hue} is not declared in ${file}, so the deleted state falls back to whatever the other surface happens to define`,
            ).toBeTruthy();
            expect(
                declarationOf(source, hue),
                `${hue} in ${file} resolves to ${muted} outright, which is the grey it was split away from -- deletions would silently go back to looking unchanged-but-dimmed`,
            ).not.toMatch(new RegExp(`^\\s*var\\(\\s*${muted}\\s*\\)\\s*$`));
        }
    });

    it("marks a changed word fragment with a darker fill of the block's hue, and nothing else", () => {
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

        // The two-tone is the whole point of the request: the fragment must sit DARKER
        // than the block it is inside, the way merge-editor.css pairs its 15% block
        // background with a 30% --pycharm-* fragment. Unifying the two tokens would keep
        // every other assertion here green and make the changed word invisible.
        const mixPercent = (token: string): number => {
            const declaration = new RegExp(`${token}\\s*:\\s*([^;]*);`).exec(viewerCss);
            expect(
                declaration,
                `${token} is never declared, so the two-tone has no dark leg`,
            ).toBeTruthy();
            const percent = /\)\s*(\d+(?:\.\d+)?)%/.exec((declaration?.[1] ?? "") as string);
            expect(
                percent,
                `${token} is not a color-mix percentage this guard can compare`,
            ).toBeTruthy();
            return Number(percent?.[1]);
        };
        expect(
            mixPercent("--diff-word-wash"),
            "the changed fragment is no darker than the block around it, so the two-tone collapsed and the word-level marker disappeared into the hunk",
        ).toBeGreaterThan(mixPercent("--diff-modified-wash"));
    });

    it("re-mixes the word fragment from the block's own hue, on the element that owns it", () => {
        // The mark used to be a fixed --diff-info tint, which was correct while only a
        // two-sided hunk could carry one. A one-sided hunk carries them now, so a fixed
        // cyan fragment lands inside a green insertion or a red deletion -- the two-tone
        // reads as a different kind of change rather than as the changed words.
        //
        // WHERE the override sits is the whole substance of it, which is why this asserts
        // the rule body and not just the file. A var() inside a custom property is
        // substituted on the element that DECLARES it: the same declaration moved onto
        // `.diff-viewer` resolves --diff-segment-hue at the root, finds nothing, and every
        // mark silently falls back to one colour. That mutation changes no percentage, no
        // hue token and no selector this file otherwise checks -- it is invisible to every
        // other assertion here, and it is the shape a later tidy-up reaches for.
        const changed = stateRules(viewerCss).get(MARKER_CLASS) ?? "";
        const override = propertyIn(changed, "--diff-word-wash");
        expect(
            override,
            `.${MARKER_CLASS} does not re-declare --diff-word-wash, so the word mark keeps the root's fixed tint and a changed fragment inside a one-sided hunk is painted in another state's colour`,
        ).toBeTruthy();
        expect(
            hueIn(override),
            "the override no longer mixes from --diff-segment-hue, so it paints one colour for every state and the block-relative two-tone is gone",
        ).toBe("--diff-segment-hue");

        // Both legs of the two-tone have to move together. The block wash and the mark now
        // read the SAME hue, so a mark mixed at the block's own strength is not merely
        // faint inside it -- it is the identical colour, and invisible.
        const strengthOf = (value: string | null): number =>
            Number(/\)\s*(\d+(?:\.\d+)?)%/.exec(value ?? "")?.[1]);
        expect(
            strengthOf(override),
            "the override mixes its hue at the block's own strength, so a changed fragment is the exact colour of the block around it",
        ).toBeGreaterThan(strengthOf(declarationOf(viewerCss, "--diff-modified-wash")));
    });

    it("paints a two-sided modification red on the left and green on the editable right", () => {
        /** Returns the pane-specific modified-state rule body, failing if it is absent. */
        const paneRule = (pane: "left" | "right"): string => {
            const match = new RegExp(
                `\\.diff-viewer\\s+\\.diff-pane-${pane}\\s+\\.diff-segment-modified\\s*\\{([^}]*)\\}`,
            ).exec(viewerCss);
            expect(
                match,
                `the ${pane} pane has no presentation override for a two-sided modification, so both panes fall back to the same teal state even though the left represents removed text and the editable right represents added text`,
            ).toBeTruthy();
            return match?.[1] ?? "";
        };

        const left = paneRule("left");
        expect(hueIn(propertyIn(left, "--diff-segment-hue"))).toBe("--diff-deleted-hue");
        expect(propertyIn(left, "background")).toBe("var(--diff-deleted-wash, transparent)");

        const right = paneRule("right");
        expect(hueIn(propertyIn(right, "--diff-segment-hue"))).toBe("--diff-ok");
        expect(propertyIn(right, "background")).toBe("var(--diff-inserted-wash, transparent)");
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
});
