/**
 * Records the small `clean` fixture for the Phase 1 `diff-viewer` host context. The viewer is
 * intentionally exercised with texts supplied directly to `DiffViewerPanel.open()` because Phase 1
 * owns the panel protocol and rendering, while Phase 2 owns repository-side acquisition.
 */

import { isE2eControlChannelActive } from "../../../src/e2e/activationState";
import {
    getE2eWebviewCaptureSink,
    resetE2eWebviewCaptureSinkForTests,
    type WebviewContextId,
} from "../../../src/e2e/webviewCapture";
import { DiffViewerPanel, type DiffViewerPanelOptions } from "../../../src/views/DiffViewerPanel";
import type { PlaceholderRoots } from "../../fixtures/repo/placeholderCanonicalization";
import { canonicalizeCapturedMessages } from "./canonicalizeCapturedMessages";
import { createFakeExtensionUri } from "./commitInfoVscodeDouble";
import { buildWebviewFixture } from "./webviewFixtureFile";
import type { WebviewFixture } from "./webviewFixtureTypes";
import { getCreatedWebviewPanels, resetCreatedWebviewPanelsForTests } from "./webviewPanelDouble";

/** The resolved host context recorded by this module. */
const DIFF_VIEWER_CONTEXT_ID: WebviewContextId = "diff-viewer";

/** The existing repository scenario used for the read-only viewer fixture. */
export const DIFF_VIEWER_CLEAN_SCENARIO = "clean";

/**
 * Builds `count` distinct rows, so the differ never pairs one hunk's rows with another's.
 * The prefixes are abbreviated because the narrow harness project is 320px wide, which
 * leaves each pane about 18 monospace characters before `.code-lines` starts clipping --
 * and a clipped row is a finding in the geometry bucket, not a nicer-looking fixture.
 */
function rows(prefix: string, count: number): string[] {
    return Array.from({ length: count }, (_, index) => `const ${prefix}${index} = ${index};`);
}

/**
 * One hunk of every kind the viewer can paint, sized to fit inside the shortest harness
 * viewport (720px at 20px per row, less the toolbar and label rows).
 *
 * Fitting is deliberate, and it is not a lost opportunity to cover scrolling. A pixel
 * baseline screenshots the surface at rest, so a taller fixture cannot show a scrolled
 * state to any oracle here -- it only pushes rows past `.diff-viewport`'s clip, where
 * every one of them becomes a geometry finding for text that is merely offscreen. The
 * scroll invariants are asserted where they can actually be driven, in
 * `tests/integration/webviews/diff-viewer.integration.test.tsx`.
 *
 * What this fixture must carry instead is one instance of each marked state. The
 * deletion-only hunk precedes the insertion-only one, so the taller pane changes sides
 * and the ribbon geometry cannot be confused with the shared canonical span.
 *
 * The separator between the insertion-only rows and the two-sided hunk is what makes
 * that flip real rather than intended. Without a common anchor there the differ has no
 * reason to split them, and it does not: it emits one `changed` segment whose left side
 * is the modified rows and whose right side is the added rows followed by the modified
 * ones. Every pane block in the fixture then classifies as `diff-segment-modified`, and
 * the insertion marker -- the only one drawn in `--diff-ok` -- renders nowhere, so no
 * pixel baseline and no live-page oracle ever sees the hue.
 * `tests/unit/visual/diffViewerFixtureCoverage.test.ts` asserts the recorded segments
 * still classify to the full marker set, because that failure is invisible: the fixture
 * renders, screenshots cleanly, and simply omits a state.
 *
 * The two-sided hunk is what produces `.word-diff-change` spans at all -- `WordDiffLine`
 * returns a plain highlighted line when the compared line is empty
 * (src/webviews/react/diff-core/segments.tsx:158), so one-sided hunks render none of
 * them, and a marker no context renders is a marker no oracle can measure. Its first
 * row changes the keyword rather than the value, so the underline runs beneath the
 * darkest foreground token the viewer paints.
 */
const DIFF_VIEWER_SHARED_HEAD = rows("hd", 3);
const DIFF_VIEWER_REMOVED_ONLY = rows("rm", 3);
const DIFF_VIEWER_SHARED_MIDDLE = rows("md", 3);
const DIFF_VIEWER_ADDED_ONLY = rows("ad", 4);
const DIFF_VIEWER_SHARED_SEPARATOR = rows("sp", 2);
const DIFF_VIEWER_MODIFIED_LEFT = ["let ch0 = 0;", "const ch1 = 1;", "const ch2 = 2;"];
const DIFF_VIEWER_MODIFIED_RIGHT = ["const ch0 = 0;", "const ch1 = 11;", "const ch2 = 22;"];
const DIFF_VIEWER_SHARED_TAIL = rows("tl", 3);

const DIFF_VIEWER_LEFT_TEXT = `${[
    ...DIFF_VIEWER_SHARED_HEAD,
    ...DIFF_VIEWER_REMOVED_ONLY,
    ...DIFF_VIEWER_SHARED_MIDDLE,
    ...DIFF_VIEWER_SHARED_SEPARATOR,
    ...DIFF_VIEWER_MODIFIED_LEFT,
    ...DIFF_VIEWER_SHARED_TAIL,
].join("\n")}\n`;

const DIFF_VIEWER_RIGHT_TEXT = `${[
    ...DIFF_VIEWER_SHARED_HEAD,
    ...DIFF_VIEWER_SHARED_MIDDLE,
    ...DIFF_VIEWER_ADDED_ONLY,
    ...DIFF_VIEWER_SHARED_SEPARATOR,
    ...DIFF_VIEWER_MODIFIED_RIGHT,
    ...DIFF_VIEWER_SHARED_TAIL,
].join("\n")}\n`;

/** Inputs required to canonicalize a `diff-viewer` recording. */
export interface RecordDiffViewerWebviewFixtureOptions {
    /** Absolute path to the prepared scenario workspace. */
    readonly repoRoot: string;
    /** Placeholder roots used by the shared fixture canonicalizer. */
    readonly roots: PlaceholderRoots;
    /** Sanitized scenario environment, retained for recorder API parity. */
    readonly env: NodeJS.ProcessEnv;
}

/**
 * Records the `diff-viewer` / `clean` scenario and returns its canonicalized fixture. The supplied
 * texts are literals: they do not read from disk or invoke git.
 */
export async function recordDiffViewerWebviewFixture(
    options: RecordDiffViewerWebviewFixtureOptions,
): Promise<WebviewFixture> {
    void options.repoRoot;
    void options.env;

    if (!isE2eControlChannelActive()) {
        throw new Error(
            "recordDiffViewerWebviewFixture: the E2E control channel gate is inactive. " +
                "Activate it before recording so captureWebview can collect the panel payload.",
        );
    }

    resetE2eWebviewCaptureSinkForTests();
    resetCreatedWebviewPanelsForTests();

    const panelOptions: DiffViewerPanelOptions = {
        extensionUri: createFakeExtensionUri(),
        path: "diff-viewer.ts",
        leftLabel: "HEAD",
        rightLabel: "Working tree",
        languageId: "typescript",
        leftText: DIFF_VIEWER_LEFT_TEXT,
        rightText: DIFF_VIEWER_RIGHT_TEXT,
    };

    try {
        await DiffViewerPanel.open(panelOptions);

        const createdPanels = getCreatedWebviewPanels();
        if (createdPanels.length !== 1) {
            throw new Error(
                "recordDiffViewerWebviewFixture: expected DiffViewerPanel.open() to create " +
                    `exactly one panel, but ${createdPanels.length} were created.`,
            );
        }

        const sink = getE2eWebviewCaptureSink();
        if (!sink) {
            throw new Error(
                "recordDiffViewerWebviewFixture: the capture sink was not allocated after " +
                    "DiffViewerPanel.open().",
            );
        }

        const captured = sink
            .getMessages()
            .filter((message) => message.contextId === DIFF_VIEWER_CONTEXT_ID);
        return buildWebviewFixture(
            DIFF_VIEWER_CONTEXT_ID,
            DIFF_VIEWER_CLEAN_SCENARIO,
            canonicalizeCapturedMessages(captured, options.roots, []),
        );
    } finally {
        for (const created of getCreatedWebviewPanels()) created.dispose();
        resetCreatedWebviewPanelsForTests();
        resetE2eWebviewCaptureSinkForTests();
    }
}
