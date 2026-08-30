import { describe, expect, it } from "vitest";

import { MAX_DIFF_RENDER_GROWTH, exceedsRenderGrowth } from "../../../src/diff/diffBudgets";

/**
 * The render gate's decision, asserted as a pure function rather than through the clock.
 *
 * `merge-editor-performance.integration.test.tsx` can only ever produce ONE reading per run, on
 * whatever host happens to be running it, so it cannot demonstrate the property that makes this
 * gate worth having: that a slow host and a slow renderer come out different. That needs two
 * populations measured under known conditions, which is what the fixtures below are.
 *
 * Every number here was measured on the calibration host by instrumenting the integration test
 * and running it 15 times per condition. Nothing is invented, and the saturated set is the
 * reported flake itself: at load average 175 (peak 217) every large-tier reading exceeded the
 * 5,613 ms absolute this gate replaces, and two runs tripped it on the TYPICAL tier first at
 * 5,707.657 ms and 5,670.985 ms -- the same tier and magnitude as the 5,643.250792 ms failure
 * that started this. Those runs aborted before the large tier was measured, which is why the
 * saturated set below has 13 pairs and not 15.
 */

/** `[typicalMs, largeMs]`, one entry per sampled run. */
type RenderPair = readonly [number, number];

/** Machine otherwise idle; load average 6.2-7.8. */
const QUIET: readonly RenderPair[] = [
    [1461.283, 3189.02],
    [1471.712, 3070.915],
    [1478.072, 3056.199],
    [1480.402, 3139.873],
    [1489.796, 3080.506],
    [1502.926, 3011.657],
    [1508.258, 3067.038],
    [1508.662, 3205.642],
    [1536.242, 3064.846],
    [1547.138, 3182.758],
    [1552.269, 3121.802],
    [1557.494, 3229.189],
    [1569.988, 3034.966],
    [1591.549, 3179.418],
    [1595.14, 3112.454],
];

/** 20 saturating processes; load average 85-217, absolute readings 3.5x the quiet set. */
const SATURATED: readonly RenderPair[] = [
    [4827.663, 9942.214],
    [4948.146, 10088.016],
    [4951.918, 10167.615],
    [4981.659, 10001.514],
    [5034.397, 10496.287],
    [5067.972, 10265.441],
    [5134.438, 10104.502],
    [5236.774, 11874.185],
    [5251.276, 12166.492],
    [5426.197, 11484.307],
    [5524.022, 12017.459],
    [5533.581, 10420.865],
    [5584.756, 11866.366],
];

/** Lines in the two tier sources, pinned against drift by the integration test that reads them. */
const TYPICAL_LINES = 1161;
const LARGE_LINES = 2464;

/**
 * Rebuilds the large-tier reading a quadratic renderer would have produced, from a real one.
 *
 * A measured pair fixes both halves of `time = fixed + perLine x lines`, so the fixed cost can
 * be held while the per-line term is replaced by a per-line-squared one calibrated to leave the
 * typical tier untouched. That keeps the mutation to the single thing under test -- how cost
 * scales with size -- rather than inventing a slow number and calling it a regression. The
 * result is lower than the 4.50 a pure `(2464/1161)^2` would give, because the ~150 ms of fixed
 * per-render overhead dilutes it; using the honest, diluted figure is the point.
 */
function quadraticLargeMs([typicalMs, largeMs]: RenderPair): number {
    const perLine = (largeMs - typicalMs) / (LARGE_LINES - TYPICAL_LINES);
    const fixed = typicalMs - perLine * TYPICAL_LINES;
    const perLineSquared = (typicalMs - fixed) / TYPICAL_LINES ** 2;
    return fixed + perLineSquared * LARGE_LINES ** 2;
}

const ratio = ([typicalMs, largeMs]: RenderPair): number => largeMs / typicalMs;

describe("render growth budget", () => {
    it("passes every reading measured on an idle host", () => {
        for (const pair of QUIET) {
            expect(
                exceedsRenderGrowth(pair[1], pair[0]),
                `quiet run ${JSON.stringify(pair)} measured ${ratio(pair).toFixed(3)}x`,
            ).toBe(false);
        }
    });

    it("passes every reading measured under CPU saturation, which the absolute budget did not", () => {
        // The regression test for the flake. Each of these ran 3.5x slower than its quiet
        // counterpart and every one of them exceeded the 5,613 ms absolute this replaced.
        for (const pair of SATURATED) {
            expect(
                exceedsRenderGrowth(pair[1], pair[0]),
                `saturated run ${JSON.stringify(pair)} measured ${ratio(pair).toFixed(3)}x, ` +
                    `absolute large reading ${pair[1].toFixed(0)}ms`,
            ).toBe(false);
        }
    });

    it("returns the same verdict however fast the host is", () => {
        // The property the absolute could not have. Scaling both tiers together is what a
        // slower host does -- a different renderer is what changes their ratio -- so no
        // uniform scale factor may change an answer.
        for (const pair of [...QUIET, ...SATURATED]) {
            for (const scale of [0.25, 3.5, 10, 100]) {
                expect(
                    exceedsRenderGrowth(pair[1] * scale, pair[0] * scale),
                    `${JSON.stringify(pair)} scaled by ${scale} must keep its verdict`,
                ).toBe(exceedsRenderGrowth(pair[1], pair[0]));
            }
        }
    });

    it("fails a quadratic re-render rebuilt from those same readings", () => {
        for (const pair of [...QUIET, ...SATURATED]) {
            const quadratic: RenderPair = [pair[0], quadraticLargeMs(pair)];
            expect(
                exceedsRenderGrowth(quadratic[1], quadratic[0]),
                `quadratic rebuild of ${JSON.stringify(pair)} is ` +
                    `${ratio(quadratic).toFixed(3)}x and must be rejected`,
            ).toBe(true);
        }
    });

    it("leaves real headroom on both sides rather than sitting on top of one population", () => {
        // Anti-vacuity for the four tests above: they would all still pass with the threshold
        // resting a hair above the worst measurement, which is how a gate becomes a flake one
        // slow run later. This pins the separation itself.
        const worstMeasured = Math.max(...[...QUIET, ...SATURATED].map(ratio));
        const gentlestQuadratic = Math.min(
            ...[...QUIET, ...SATURATED].map((pair) => quadraticLargeMs(pair) / pair[0]),
        );
        expect(
            MAX_DIFF_RENDER_GROWTH / worstMeasured,
            `the threshold must clear the worst measurement (${worstMeasured.toFixed(3)}x) by a ` +
                `margin, not by a rounding error`,
        ).toBeGreaterThan(1.25);
        expect(
            gentlestQuadratic / MAX_DIFF_RENDER_GROWTH,
            `the gentlest quadratic rebuild (${gentlestQuadratic.toFixed(3)}x) must sit as far ` +
                `above the threshold as the worst measurement sits below it`,
        ).toBeGreaterThan(1.25);
    });

    it("refuses an unusable reading rather than guessing which way it should fail", () => {
        // Zero, negative, NaN and Infinity all mean the clock measured nothing. `true` would
        // blame the renderer for that and `false` would drop the gate without saying so, and
        // this function exists because a gate that drops silently is the bug being fixed.
        // NaN is listed on both sides deliberately: it is the reading a broken timer actually
        // produces, and it is the one a `ms <= 0` guard would wave through.
        for (const [large, typical] of [
            [0, 1500],
            [3000, 0],
            [-1, 1500],
            [Number.NaN, 1500],
            [3000, Number.NaN],
            [Number.POSITIVE_INFINITY, 1500],
        ]) {
            expect(() => exceedsRenderGrowth(large, typical)).toThrow(/positive finite readings/);
        }
    });
});
