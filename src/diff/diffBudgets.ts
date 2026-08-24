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
 * half -- payload byte size, line counts, DP-cell and pathological rejection -- plus the
 * host-agnostic 15 s / 10 s bounds in `merge-editor-performance.integration.test.tsx`, which
 * exist to catch a quadratic re-render rather than to time one.
 */

/** Maximum bytes permitted for one diff side, derived as 2 x 105,047. */
export const MAX_DIFF_BYTES = 210_094;

/** Maximum lines permitted for one diff side, aligned to the measured source bytes-per-line. */
export const MAX_DIFF_LINES = 5_226;

/** Maximum estimated weighted-DP cells, capped below `MAX_LCS_CELLS`. */
export const MAX_DIFF_DP_CELLS = 9_000_000;

/** Maximum accepted-tier extension-host segment computation time, ceil(3.5 x 16.591). */
export const MAX_DIFF_COMPUTE_MS = 59;

/** Maximum accepted-tier serialized payload size, derived as 2 x 219,524. */
export const MAX_DIFF_PAYLOAD_BYTES = 439_048;

/** Maximum accepted-tier webview render time, derived as ceil(2 x 2,806.205). */
export const MAX_DIFF_RENDER_MS = 5_613;

/** Returns whether a loaded pair exceeds any viewer budget before panel computation. */
export function exceedsDiffBudget(
    left: { readonly bytes: Uint8Array; readonly lineCount: number },
    right: { readonly bytes: Uint8Array; readonly lineCount: number },
): boolean {
    return (
        left.bytes.byteLength > MAX_DIFF_BYTES ||
        right.bytes.byteLength > MAX_DIFF_BYTES ||
        left.lineCount > MAX_DIFF_LINES ||
        right.lineCount > MAX_DIFF_LINES ||
        left.lineCount * right.lineCount > MAX_DIFF_DP_CELLS
    );
}
