/**
 * Measured viewer budgets.
 *
 * Host measurement command, run from the repository root:
 * `bun build scripts/measure-diff-budgets.ts --bundle --target=node --format=esm --outfile=/tmp/intelligit-measure-diff-budgets.mjs`
 * followed by `node --expose-gc /tmp/intelligit-measure-diff-budgets.mjs` on
 * macOS arm64, 2026-08-21. The
 * corpus uses real repository files for the accepted tiers and a 2% line edit
 * against each file; only the two pathological tiers are synthetic. The real
 * source bytes-per-line figure is 40.1942478007168, measured across the 200
 * largest `.ts`/`.tsx` files under `src/`. The table's line column uses
 * the production `countLines` convention, which excludes a trailing newline.
 *
 * Both the corpus rows and the bytes-per-line figure are measured against this
 * repository's own source, so they drift whenever `src/` changes; the numbers
 * below are pinned to the run recorded above, not to current HEAD. Re-derive
 * the constants only by re-running the script and restating the whole table
 * from that one run — a table mixing figures from two runs is not reproducible.
 *
 * | tier | source file | left/right bytes | left/right lines (`countLines`) | DP cells | compute ms | payload bytes | heap delta |
 * | small | src/diff/wordDiff.ts | 9,524 / 9,674 | 288 / 288 | 82,944 | 2.988 | 20,804 | 92,296 |
 * | typical | src/services/diffService.ts | 24,055 / 24,409 | 642 / 642 | 412,164 | 1.496 | 51,815 | 49,200 |
 * | large | src/views/CommitPanelViewProvider.ts | 103,835 / 105,047 | 2,312 / 2,312 | 5,345,344 | 14.128 | 219,524 | -46,448 |
 * | pathological-many-lines | synthetic 3,500-line corpus | 51,389 / 54,889 | 3,500 / 3,500 | 12,250,000 | 4.535 | 120,566 | 301,576 |
 * | pathological-long-lines | synthetic 2,048-byte-line corpus | 2,458,799 / 2,458,799 | 1,200 / 1,200 | 1,440,000 | 106.434 | 4,922,686 | 98,176 |
 *
 * Accepted-tier maxima are the large side (105,047 bytes), large line count
 * (2,312 using `countLines`), large DP estimate (5,345,344 cells), large
 * compute time (14.128 ms in the Node harness; 16.591 ms in the focused Vitest
 * gate), and largest accepted payload (219,524 bytes). The thresholds use 2x
 * headroom; bytes are `ceil(2 x 105,047) = 210,094`, lines are
 * `floor(210,094 / 40.1942478007168) = 5,226` so the byte and line caps
 * admit the same average-shaped file, and DP uses
 * `min(2 x 5,345,344, MAX_LCS_CELLS - 1,000,000) = 9,000,000` cells so it
 * remains below the engine's 10,000,000-cell fallback boundary. The focused
 * Vitest command `bun vitest run tests/unit/diff/diffBudgets.test.ts` measured
 * large-tier compute at 15.939, 16.141, 15.514, 16.123, and 16.591 ms across
 * five consecutive runs; the compute target keeps a conservative 3.5x
 * headroom: `ceil(3.5 x 16.591) = 59 ms`. The pathological tiers fail the
 * cell or byte gate before panel work.
 *
 * Webview render time is measured in the jsdom viewer integration test with:
 * `bun vitest run tests/integration/webviews/merge-editor-performance.integration.test.tsx`.
 * The accepted-tier maximum was 2,806.205 ms for the large viewer tier, so its
 * 2x target is `ceil(2 x 2,806.205) = 5,613 ms`. Heap delta is reported by the script only when
 * `node --expose-gc` provides forced collection; otherwise it is reported as
 * `"unmeasured"` and is never a unit-test gate.
 *
 * Both millisecond figures are single-host measurements, and are asserted only on runs that
 * resemble the host they were taken on; `tests/helpers/timingBudgets.ts` carries the mechanism
 * and `tests/unit/diff/timingBudgetGate.test.ts` pins both the default and the two invokers
 * that suspend it. Two independent things move these readings far enough to break them:
 *
 * - Instrumentation. Under `--coverage` on this same host the large tier measured 64.164 ms
 *   against the 16.591 ms recorded here -- 3.87x, more than the 3.5x headroom the compute
 *   target was built with -- and 209.875 ms on GitHub's x86 runner.
 * - The host by itself, with no instrumentation at all. An uninstrumented `bun run test` on
 *   `ubuntu-latest` measured the large viewer render at 6,555.914 ms against the 5,613 ms
 *   target above, while the macOS leg of that same matrix, on that same commit, passed. That
 *   second fact is what isolates the variable: coverage is one way to miss the calibration
 *   host, not the only way, and a gate suspended only for coverage still fails on a runner.
 *
 * Neither number describes the product, so raising the targets to admit them would only make
 * the gate unable to see a real regression. What still runs everywhere is the deterministic
 * half -- payload byte size, line counts, DP-cell and pathological rejection -- the
 * host-agnostic 15 s / 10 s bounds in `merge-editor-performance.integration.test.tsx`, which
 * exist to catch a quadratic re-render rather than to time one, and `MAX_DIFF_RENDER_GROWTH`
 * below, which catches the same thing far closer in by comparing two tiers of one run against
 * each other instead of against a clock. The render reading that used to sit here as an
 * absolute is the one number this paragraph has now outlived: it was suspended on every
 * runner and flaky on the host it was calibrated on.
 */

/** Maximum bytes permitted for one diff side, derived as 2 x 105,047. */
export const MAX_DIFF_BYTES = 210_094;

/** Maximum lines permitted for one diff side, aligned to the measured source bytes-per-line. */
export const MAX_DIFF_LINES = 5_226;

/** Maximum estimated weighted-DP cells, capped below `MAX_LCS_CELLS`. */
export const MAX_DIFF_DP_CELLS = 9_000_000;

/** Maximum accepted-tier extension-host segment computation time, ceil(3.5 x 16.591). */
export const MAX_DIFF_COMPUTE_MS = 59;

/**
 * Maximum accepted-tier serialized payload size, derived as 2 x 219,524.
 *
 * Enforced by `exceedsDiffBudget` against the approximation below, and separately asserted
 * against the real serialized payload for the accepted corpus in `diffBudgets.test.ts`.
 */
export const MAX_DIFF_PAYLOAD_BYTES = 439_048;

/**
 * Maximum ratio of large-tier to typical-tier webview render time, in one run.
 *
 * This replaces an absolute `MAX_DIFF_RENDER_MS = 5_613`, which could not tell a slow host
 * from a slow renderer and so gated nothing anywhere: `ubuntu-latest` read 6,555.914 ms
 * against it (see above), which is why the compatibility matrix suspends the wall-clock
 * budgets entirely -- and on the calibration host it failed under ordinary contention.
 * Measured here across 15 runs with the CPU saturated (load average 175 mean, 217 peak),
 * every large-tier reading exceeded 5,613 ms, and two runs tripped it on the TYPICAL tier
 * first, at 5,707.657 ms and 5,670.985 ms. Raising the number would have admitted a real
 * regression instead; the fault was measuring wall-clock at all.
 *
 * A same-run ratio removes the host. Across a 3.5x slowdown of the absolute readings, this
 * ratio moved 2%:
 *
 *     tier            quiet (n=15)              saturated (n=13)
 *     large, absolute mean 3,116 ms  cv 2.1%    mean 10,838 ms  cv 7.8%
 *     large / typical mean 2.05      cv 3.2%    mean 2.09       cv 5.4%
 *                     range 1.93-2.18           range 1.88-2.32
 *
 * `typical` is the denominator rather than `small` because the ratio has to divide by a
 * stable number: `small` renders in ~608 ms quiet, where the ~104 ms of fixed per-render
 * overhead is a sixth of the reading, and large/small is measurably noisier in both
 * conditions (cv 6.7% quiet, 10.4% saturated) despite cancelling the same host speed.
 *
 * The threshold still sees the regression it exists for. The tiers are 1,161 and 2,464 lines,
 * so a linear pipeline predicts 2.12 -- which is what is measured -- and `(2464/1161)^2 = 4.50`
 * is what a quadratic re-render approaches. It only approaches it: fixed per-render overhead
 * dilutes the ratio, and that overhead is ~150 ms idle but ~1.2 s under saturation, so
 * rebuilding each measured pair as a quadratic (`diffRenderGrowth.test.ts`) yields as little as
 * 3.76. A quadratic injected into `CodeBlock` for real -- each rendered line scanning its own
 * block -- measured lower still, 3.43x (2,977 ms against 10,200 ms), because a block-local n^2 sums
 * to less than the whole document's. The threshold has to clear the measured figure rather than
 * the ideal one, so 2.9 sits between the worst innocent reading (2.32) and that injected
 * quadratic: 1.25x above anything measured and 1.18x below a regression it caught. The margin
 * leans to the innocent side deliberately -- a false red is the failure being fixed here, and a
 * real quadratic clears the bar by more than contention ever did. Unlike the absolute it replaces,
 * this needs no suspension on CI, so the render path is gated on runners where it previously
 * was not gated at all.
 */
export const MAX_DIFF_RENDER_GROWTH = 2.9;

/**
 * Reports whether render time grew faster with input size than a linear pipeline would.
 *
 * Throws rather than answering on a reading that is not a positive finite number -- zero,
 * negative, NaN and Infinity all mean the clock produced nothing usable. `!Number.isFinite(ms)`
 * rather than the `ms <= 0` a lint rule suggests: `NaN <= 0` is false, so that rewrite would
 * quietly admit the one reading most likely to appear when timing breaks.
 *
 * Both answers would be wrong on such a reading:
 * `true` blames the renderer for a clock that measured nothing, and `false` drops the gate
 * silently, which is the failure this function was written to end.
 */
export function exceedsRenderGrowth(largeMs: number, typicalMs: number): boolean {
    const unusable = (ms: number): boolean => !Number.isFinite(ms) || ms <= 0;
    if (unusable(largeMs) || unusable(typicalMs)) {
        throw new Error(
            `render growth needs two positive finite readings, got large=${largeMs}ms typical=${typicalMs}ms`,
        );
    }
    return largeMs / typicalMs > MAX_DIFF_RENDER_GROWTH;
}

/**
 * Approximates the serialized payload from the two decoded sides, before segments exist.
 *
 * The payload the panel posts is dominated by the same text re-emitted as JSON string arrays,
 * so escaping -- not raw byte count -- is what sets its size, and escaping is content-dependent:
 * measured on this corpus, the same 420,168 content bytes serialize to 493,536 bytes as minified
 * source and to 2,521,304 as control characters. That is why the per-side `MAX_DIFF_BYTES` cap
 * cannot stand in for this one; two sides that each pass it carry up to 420,188 bytes into a
 * 439,048-byte payload budget, leaving nothing for escaping or structure.
 *
 * `JSON.stringify` on each side's text is the exact escaped size, and the only term it omits is
 * the per-line quoting the segment split adds. So this UNDERSTATES the real payload, measured at
 * 0.87x it in the worst case (5,200 short lines) and 0.94-1.00x across every other tier. It is
 * used as a rejection gate only, where understating means the gate is conservative about
 * rejecting rather than about accepting: no measured accepted tier comes near the budget (the
 * largest sits at 0.504x it), so the shortfall cannot turn an accepted tier away, and a pair
 * that trips this is over budget by more than the shortfall could explain.
 */
function approximatePayloadBytes(leftText: string, rightText: string): number {
    return (
        Buffer.byteLength(JSON.stringify(leftText), "utf8") +
        Buffer.byteLength(JSON.stringify(rightText), "utf8")
    );
}

/** Returns whether a loaded pair exceeds any viewer budget before panel computation. */
export function exceedsDiffBudget(
    left: { readonly bytes: Uint8Array; readonly lineCount: number; readonly text: string },
    right: { readonly bytes: Uint8Array; readonly lineCount: number; readonly text: string },
): boolean {
    return (
        left.bytes.byteLength > MAX_DIFF_BYTES ||
        right.bytes.byteLength > MAX_DIFF_BYTES ||
        left.lineCount > MAX_DIFF_LINES ||
        right.lineCount > MAX_DIFF_LINES ||
        left.lineCount * right.lineCount > MAX_DIFF_DP_CELLS ||
        approximatePayloadBytes(left.text, right.text) > MAX_DIFF_PAYLOAD_BYTES
    );
}
