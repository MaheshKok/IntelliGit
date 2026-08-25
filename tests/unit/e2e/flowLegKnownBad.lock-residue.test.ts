// One leg per file so vitest's file-count `--shard` can spread the four subprocess runs across
// the Windows CI shards -- see flowLegKnownBadHarness.ts for the full story and the shared suite.
// This is the slow leg: every FLOW_MATRIX row waits out real 30s stale-lock detection, so the
// harness's 600s timeout is mostly for this file (measured 232s macOS / 282s Windows).
import { flowLegKnownBadSuite } from "./flowLegKnownBadHarness";

flowLegKnownBadSuite("lock-residue");
