/**
 * Whether wall-clock budget assertions are meaningful in the current run.
 *
 * `@vitest/coverage-v8` attaches through the inspector from the parent process, so a
 * worker cannot detect instrumentation on its own: `process.argv`, `process.env`, and
 * `process.execArgv` are byte-identical with and without `--coverage` (checked against
 * vitest 4.1.10). The invoker has to say so, which is what the `test:coverage` script
 * does by exporting `INTELLIGIT_SKIP_TIMING_BUDGETS=1`.
 *
 * Measured on the large tier of `src/diff/diffBudgets.ts`, same host, same tree:
 * 16.591 ms uninstrumented against 64.164 ms under `--coverage` -- 3.87x, which on its
 * own exceeds the 3.5x headroom `MAX_DIFF_COMPUTE_MS` was derived with. GitHub's x86
 * runner measured 209.875 ms for the same assertion, so an instrumented gate reports the
 * instrument rather than the product.
 *
 * The default is deliberately "assert". An invocation path added later keeps the gate and
 * goes red, instead of silently dropping it.
 */
export const timingBudgetsApply = process.env.INTELLIGIT_SKIP_TIMING_BUDGETS !== "1";
