# Editable Diff Typing Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Make typing in the custom editable two-pane diff feel like VS Code's native editor while preserving the current appearance, immediate local draft, and one-second live re-diff.

**Architecture:** Keep the textarea-based editing island and the extension host's authoritative full diff payload. Remove whole-view invalidations from the keystroke path, memoize inactive segment shells, and reconcile unchanged host-echo segments by identity so only the edited hunk and genuinely shifted line-number models render again. Preserve the active textarea with an edit-session key that never depends on a replaced segment, and keep interaction callbacks stable while reading current host state from render-updated refs. Use deterministic render-count/identity tests for CI and a real VS Code Electron benchmark for the user-visible latency claim.

**Tech Stack:** TypeScript, React 18, VS Code custom text editor/webview, Vitest with jsdom and fake timers, Playwright against the Extension Development Host, Bun.

## Shape, verdict, and boundaries

This is Shape 3 escalated to the full planning round because the change crosses local React state, host echo reconciliation, and real VS Code runtime measurement.

**Verdict:** Do not replace the renderer, add Monaco, move diffing to a worker, or virtualize the document in this work package. The measured first bottleneck is webview invalidation and reconciliation, and the current one-second debounce already exists.

**Strongest interpretation:** “Match native” means ordinary typing stays within a frame of native Monaco on the same machine and file, while the custom two-pane view updates its visual diff after one second of inactivity without losing the active draft.

**Load-bearing assumptions:**

1. Most keystrokes do not change the active block's row count or exceed the diff's existing horizontal extent.
2. A one-second host echo normally changes one hunk and leaves exact prefix/suffix segments unchanged.
3. Native browser find, selection, copy, IME composition, and accessibility remain requirements; an optimization may not silently unmount off-screen text.

**Strongest objection:** Initial mount remains expensive because the custom view creates the full two-pane DOM. The changes below can make typing and echo near-native without proving native initial-open parity. If the final trace still shows initial mount as the dominant missed target, create a separate plan for progressive idle mounting or a measured automatic native fallback; do not smuggle virtualization into this plan.

## Confirmed baseline

Measured in this worktree before planning:

| Fixture | Initial render | Input p50 | Input p95/max | Host diff compute | Full echo render |
|---|---:|---:|---:|---:|---:|
| 1,200 lines / 201 segments | 819.6 ms | 8.5 ms | 12.78 ms | 30.1 ms | 64.4 ms |
| 2,300 lines / 385 segments | 1,732.0 ms | 13.1 ms | 19.27 ms | 86.1 ms | 108.1 ms |

Source evidence:

- src/webviews/react/diff-viewer/DiffViewerApp.tsx:423-438 already debounces the host post for 1,000 ms.
- src/webviews/react/diff-viewer/DiffViewerApp.tsx:571-587 creates a fresh parent layout object on every input.
- src/webviews/react/diff-viewer/DiffViewerApp.tsx:884-929 turns that object into whole-view vertical-layout work.
- src/webviews/react/diff-viewer/DiffViewerApp.tsx:1022-1036 scans every segment for horizontal extent whenever the layout object changes.
- src/webviews/react/diff-viewer/DiffViewerApp.tsx:1406-1412 replaces every host payload reference.
- src/views/EditableDiffEditorProvider.ts:281-400 recomputes and posts the authoritative full snapshot after an accepted edit.

## Acceptance contract

The implementation is complete only when all of these are true:

1. On the 2,300-line / approximately 385-segment fixture, ordinary same-row typing has Event Timing p95 no more than one measured display frame above native Monaco and no more than two measured display frames in absolute terms in the same foreground Extension Development Host run.
2. No long task over 50 ms is attributed to an ordinary keystroke. If Electron does not expose Long Tasks, collect equivalent Chromium trace evidence; unsupported telemetry is inconclusive, not a pass.
3. A same-row edit that stays inside the existing horizontal extent does not call buildVerticalLayout and does not render inactive segment shells.
4. A row-count change rebuilds vertical layout exactly once. Extending the longest line beyond the current horizontal extent updates the shared scrollbar within one animation frame.
5. Exactly one editText message is posted 1,000 ms after the last non-composition input; no message is posted during composition.
6. The host echo visibly re-diffs the panes, finishes inbound-payload-to-after-paint within 50 ms on the large fixture, and reaches the visible changed ribbon within 1,250 ms of the last input. It retains exact unchanged segment identities and the exact active textarea DOM node, focus, selection, draft, and IME composition state.
7. Existing IME, undo/redo, selection, caret placement, scroll sync, browser find, re-anchor, stale-delta rejection, newline, and auto-save contracts remain green.
8. Initial open is recorded in the same Electron artifact for the stop/go decision but is not a release claim of this work package. Native initial-open parity requires a separate follow-up plan if it remains outside the threshold below.

## Requirement-to-proof map

| Requirement | Primary proof |
|---|---|
| No whole layout on ordinary input | Deterministic Vitest spy on buildVerticalLayout |
| Only active shell renders while typing | Standalone memo-component test plus integration layout spy |
| Correct row/width geometry | Unit tests for effective layout equality plus existing editable pane geometry tests |
| One-second re-diff | Existing fake-timer integration contract plus real Electron round trip |
| Cheap echo reconciliation | Unit identity tests plus jsdom echo commit budget |
| Active node and callback freshness | Exact-node, selection, IME, and post-echo base-version integration assertions |
| Native-like latency | Opt-in Playwright Electron Event Timing benchmark alternating custom/native rounds |
| Editing correctness | Existing diff-viewer integration and provider suites |
| Visible/runtime correctness | Existing diff-viewer E2E flow and the new performance flow |

## Mandatory implementation workflow

- Before editing a production symbol, run GitNexus upstream impact for EditableDiffPane, App, and any helper being changed. Warn before proceeding if any result is HIGH or CRITICAL.
- Use one sequential writer at a time. At least one bounded executable slice must be delegated under subagent-tdd-workflow.
- For each behavior slice: committed RED, read the named failure, minimal GREEN, then mutation-prove the new assertion by restoring the old invalidation or disabling reuse and reading the named failure.
- Root reads the actual diff and runs every check reported below.
- No new dependency, protocol field, persisted format, user-facing string, or CSS redesign is authorized.

---

### Task 1: Commit a deterministic failing reproduction

**Files:**

- Create: tests/helpers/editableDiffPerformanceFixture.ts
- Create: tests/integration/webviews/editable-diff-performance.integration.test.tsx
- Reference: tests/integration/webviews/diff-viewer.integration.test.tsx:17-182
- Reference: tests/integration/webviews/merge-editor-performance.integration.test.tsx:93-166

- [ ] **Step 1: Add the shared large editable fixture**

Create a deterministic 2,300-line document alternating common ranges and one-line changes. Include one unchanged 200-character sentinel line so the benchmark can type ordinary characters without crossing the global horizontal extent. Return leftText, rightText, and DiffViewerData with the right pane editable. Do not commit a multi-thousand-line JSON fixture.

~~~ts
export interface EditableDiffPerformanceFixture {
    readonly leftText: string;
    readonly rightText: string;
    readonly data: DiffViewerData;
}

/** Builds the stable large editable-diff workload used by integration and E2E performance proofs. */
export function buildEditableDiffPerformanceFixture(): EditableDiffPerformanceFixture {
    const leftLines = Array.from({ length: 2_300 }, (_, index) => "const value_" + index + " = " + index + ";");
    leftLines[0] = "const horizontal_sentinel = \"" + "x".repeat(200) + "\";";
    const rightLines = leftLines.map((line, index) =>
        index % 12 === 6 ? line + " // working tree" : line,
    );
    const leftText = leftLines.join("\n") + "\n";
    const rightText = rightLines.join("\n") + "\n";
    return {
        leftText,
        rightText,
        data: {
            path: "src/editable-performance.ts",
            leftLabel: "HEAD",
            rightLabel: "Working tree",
            languageId: "typescript",
            ...computeDiffSegments(leftText, rightText),
            editablePane: "right",
            editableText: rightText,
            documentVersion: 1,
            editableReseedToken: 0,
            ignoreWhitespace: false,
        },
    };
}
~~~

- [ ] **Step 2: Mock the layout boundary before importing the app**

Wrap the real buildVerticalLayout with a hoisted Vitest spy so the test observes invalidation without replacing layout behavior.

~~~ts
const layoutCalls = vi.hoisted(() => vi.fn());

vi.mock("../../../src/webviews/react/diff-core/mergeScrollLayout", async (importOriginal) => {
    const actual =
        await importOriginal<typeof import("../../../src/webviews/react/diff-core/mergeScrollLayout")>();
    return {
        ...actual,
        buildVerticalLayout: (...args: Parameters<typeof actual.buildVerticalLayout>) => {
            layoutCalls(args[0]);
            return actual.buildVerticalLayout(...args);
        },
    };
});
~~~

- [ ] **Step 3: Write the failing invalidation assertion**

Mount the large payload, open a changed right-side block, record layoutCalls.mock.calls.length, append a character without adding a row or exceeding the fixture's existing longest line, and assert the count is unchanged after React flushes.

Also assert:

- the textarea contains the new character immediately;
- the VS Code mock has not received editText before timers advance;
- after 999 ms there is still no editText;
- after the final 1 ms exactly one editText exists.

- [ ] **Step 4: Run RED and read the failure**

Run:

    bun vitest run tests/integration/webviews/editable-diff-performance.integration.test.tsx -t "keeps same-geometry typing out of the whole-view layout" --reporter=verbose

Expected RED:

    FAIL keeps same-geometry typing out of the whole-view layout
    expected buildVerticalLayout call count after input to equal the pre-input count

Reject a failure caused by import order, missing root, timeout, or a fixture with no editable block.

- [ ] **Step 5: Commit the reproduction before touching production code**

    git add tests/helpers/editableDiffPerformanceFixture.ts tests/integration/webviews/editable-diff-performance.integration.test.tsx
    git commit -m "test: reproduce editable diff render invalidation"

---

### Task 2: Keep same-effective geometry out of App state

**Files:**

- Create: src/webviews/react/diff-viewer/editableDraftLayout.ts
- Create: tests/unit/webviews/editableDraftLayout.test.ts
- Modify: src/webviews/react/diff-viewer/DiffViewerApp.tsx:171-190, 830-929, 1022-1036
- Test: tests/integration/webviews/editable-diff-performance.integration.test.tsx

- [ ] **Step 1: Write unit RED cases for effective layout equality**

Cover:

1. identical side, indices, rows, and effective width are equal;
2. a draft width change below the base diff width is equal;
3. crossing the base width is different;
4. row-count, side, index, null/open, and open/null changes are different.

Run:

    bun vitest run tests/unit/webviews/editableDraftLayout.test.ts --reporter=verbose

Expected RED: the module does not exist.

- [ ] **Step 2: Move the layout contract and add the pure comparator**

~~~ts
export interface EditableBlockLayout {
    readonly side: DiffPane;
    readonly indices: readonly number[];
    readonly rowCount: number;
    readonly maxLineLength: number;
}

/** Tests whether replacing one draft layout can affect visible whole-view geometry. */
export function sameEffectiveEditableBlockLayout(
    previous: EditableBlockLayout | null,
    next: EditableBlockLayout | null,
    baseMaxLineLength: number,
): boolean {
    if (previous === next) return true;
    if (previous === null || next === null) return false;
    return (
        previous.side === next.side &&
        previous.rowCount === next.rowCount &&
        sameIndices(previous.indices, next.indices) &&
        Math.max(baseMaxLineLength, previous.maxLineLength) ===
            Math.max(baseMaxLineLength, next.maxLineLength)
    );
}
~~~

Keep sameIndices as a short exact element comparison; do not stringify arrays.

- [ ] **Step 3: Separate base width from live draft width**

In App:

1. Compute baseMaxLineLength from segments only.
2. Keep latestEditingBlockRef updated for every local change.
3. Keep baseMaxLineLengthRef updated during render.
4. Keep handleDraftLayoutChange callback identity stable.
5. Call setEditingBlock only when sameEffectiveEditableBlockLayout returns false.
6. Derive final maxLineLength in O(1) from baseMaxLineLength and latestEditingBlockRef.current.

~~~ts
const baseMaxLineLength = useMemo(() => {
    let max = 1;
    for (const segment of segments) {
        max = Math.max(max, longestLine(segment.left), longestLine(segment.right));
    }
    return max;
}, [segments]);

baseMaxLineLengthRef.current = baseMaxLineLength;

const handleDraftLayoutChange = useCallback((layout: EditableBlockLayout | null) => {
    latestEditingBlockRef.current = layout;
    setEditingBlock((previous) =>
        sameEffectiveEditableBlockLayout(
            previous,
            layout,
            baseMaxLineLengthRef.current,
        )
            ? previous
            : layout,
    );
}, []);

const maxLineLength = Math.max(
    baseMaxLineLength,
    latestEditingBlockRef.current?.maxLineLength ?? 0,
);
~~~

The ref is required: if a width change stays below the old base width and a later host echo lowers that base, the next render must still see the latest draft width.

- [ ] **Step 4: Run GREEN**

    bun vitest run tests/unit/webviews/editableDraftLayout.test.ts tests/integration/webviews/editable-diff-performance.integration.test.tsx --reporter=verbose

Expected: all tests pass; the focused integration test reports no extra buildVerticalLayout call for ordinary input.

- [ ] **Step 5: Mutation-prove both under- and over-invalidation**

Temporarily replace the functional setEditingBlock body with setEditingBlock(layout). Re-run the focused integration test.

Expected RED must name:

    keeps same-geometry typing out of the whole-view layout

Restore the comparator and rerun GREEN.

Then temporarily make sameEffectiveEditableBlockLayout always return true. Re-run the row-count and horizontal-extent cases.

Expected RED must name both:

    rebuilds layout when the active draft gains a row
    expands the shared horizontal extent when the draft crosses the base width

A comparator that merely suppresses all layout work is not a performance fix.

- [ ] **Step 6: Commit**

    git add src/webviews/react/diff-viewer/editableDraftLayout.ts src/webviews/react/diff-viewer/DiffViewerApp.tsx tests/unit/webviews/editableDraftLayout.test.ts tests/integration/webviews/editable-diff-performance.integration.test.tsx
    git commit -m "perf: isolate editable draft geometry"

---

### Task 3: Memoize inactive segment shells

**Files:**

- Create: src/webviews/react/diff-viewer/EditableSegmentBlock.tsx
- Create: tests/unit/webviews/editableSegmentBlock.test.tsx
- Modify: src/webviews/react/diff-viewer/DiffViewerApp.tsx:118-158, 328-650
- Modify: tests/integration/webviews/editable-diff-performance.integration.test.tsx

- [ ] **Step 1: Add a failing render-isolation assertion**

Mount EditableSegmentBlock under a parent with unrelated state. Spy on intrinsicSizeStyle at the module boundary as the render counter; do not add a production test hook.

Required assertion:

- the initial mount calls intrinsicSizeStyle once;
- an unrelated parent update with identical props does not call it again;
- a changed RenderedSegment prop calls it exactly once more.

Do not assert elapsed milliseconds in this deterministic test.

- [ ] **Step 2: Extract the inactive editable shell**

Keep the active textarea branch in EditableDiffPane. Export only the inactive block from EditableSegmentBlock.tsx as a memoized component with stable primitive/reference props:

~~~ts
const EditableSegmentBlock = React.memo(function EditableSegmentBlock({
    item,
    side,
    lineNumberSide,
    highlightWords,
    onStartEditing,
}: EditableSegmentBlockProps): React.ReactElement {
    const lines = item.segment[side];
    const compareLines = item.segment[side === "left" ? "right" : "left"];
    return (
        <div
            className={"segment diff-editable-block " + segmentClassName(item.segment, side)}
            style={intrinsicSizeStyle(item.paneLines[side])}
            onClick={(event) => {
                if (window.getSelection()?.isCollapsed === false) return;
                onStartEditing(item, caretOffsetWithinBlock(
                    event.currentTarget,
                    event.clientX,
                    event.clientY,
                ));
            }}
            onDoubleClick={() => onStartEditing(item, 0)}
            role="group"
            tabIndex={0}
            title={t("diff.editable.blockHint")}
            aria-label={t("diff.editable.blockHint")}
        >
            <CodeBlock
                lines={lines}
                lineCount={item.paneLines[side]}
                lineNumbers={item.lineNumbers[side]}
                lineNumberSide={lineNumberSide}
                wordHighlight={highlightWords}
                compareLines={compareLines}
            />
        </div>
    );
});
~~~

Preserve the existing Enter/F2 keyboard path in the extracted component; the abbreviated snippet above is not permission to remove it.

- [ ] **Step 3: Memoize the read-only shell**

Wrap DiffPaneBlock with React.memo. Its segment arrays and line-number model must remain reference-stable for the memo to pay off after Task 4.

- [ ] **Step 4: Use a stable onStartEditing callback**

For local typing, pass startEditing directly and do not create a per-item callback in EditableDiffPane's map. Task 4C will make startEditing stable across host echoes while reading current text, version, token, and segments from refs. Do not use a memo comparator that ignores a changing callback, because that retains a stale closure.

- [ ] **Step 5: Run GREEN and mutation proof**

    bun vitest run tests/unit/webviews/editableSegmentBlock.test.tsx tests/integration/webviews/editable-diff-performance.integration.test.tsx tests/integration/webviews/diff-viewer.integration.test.tsx --reporter=verbose

Expected: all tests pass.

Mutation: remove React.memo from EditableSegmentBlock. The standalone parent-update assertion must fail because intrinsicSizeStyle ran again. Restore and rerun GREEN.

- [ ] **Step 6: Commit**

    git add src/webviews/react/diff-viewer/EditableSegmentBlock.tsx src/webviews/react/diff-viewer/DiffViewerApp.tsx tests/unit/webviews/editableSegmentBlock.test.tsx tests/integration/webviews/editable-diff-performance.integration.test.tsx
    git commit -m "perf: memoize editable diff segment shells"

---

### Task 4A: Reconcile exact unchanged segments at the host-message boundary

**Files:**

- Create: src/webviews/react/diff-viewer/reconcileDiffSegments.ts
- Create: tests/unit/webviews/reconcileDiffSegments.test.ts

- [ ] **Step 1: Write reconciliation RED cases**

reconcileDiffSegments must:

1. return new array ownership for a new payload;
2. reuse exact prefix and suffix DiffSegment objects when their type and both line arrays are equal;
3. replace the changed middle;
4. preserve suffix identity when one middle segment is inserted or deleted;
5. not reuse a segment when type, left lines, or right lines differ;
6. handle repeated equal segments without reusing one previous object twice.

The comparison is exact string equality. No hash and no JSON.stringify.

- [ ] **Step 2: Implement bounded prefix/suffix reconciliation**

~~~ts
/** Reuses exact unchanged edge segments while keeping the host snapshot authoritative. */
export function reconcileDiffSegments(
    previous: readonly DiffSegment[],
    next: readonly DiffSegment[],
): DiffSegment[] {
    const reconciled = [...next];
    let prefix = 0;
    while (
        prefix < previous.length &&
        prefix < next.length &&
        equalDiffSegment(previous[prefix], next[prefix])
    ) {
        reconciled[prefix] = previous[prefix];
        prefix += 1;
    }

    let previousSuffix = previous.length - 1;
    let nextSuffix = next.length - 1;
    while (
        previousSuffix >= prefix &&
        nextSuffix >= prefix &&
        equalDiffSegment(previous[previousSuffix], next[nextSuffix])
    ) {
        reconciled[nextSuffix] = previous[previousSuffix];
        previousSuffix -= 1;
        nextSuffix -= 1;
    }
    return reconciled;
}
~~~

Add reconcileDiffViewerData(previous, next) that preserves only exact segment objects and otherwise returns the new host fields unchanged.

- [ ] **Step 3: Run GREEN and mutation-prove changed content**

    bun vitest run tests/unit/webviews/reconcileDiffSegments.test.ts --reporter=verbose

Mutation: incorrectly reuse the old middle segment even when one right-side line differs. The visible-content identity assertion must fail by name. Restore and rerun GREEN.

- [ ] **Step 4: Commit the pure reconciliation slice**

    git add src/webviews/react/diff-viewer/reconcileDiffSegments.ts tests/unit/webviews/reconcileDiffSegments.test.ts
    git commit -m "perf: reconcile unchanged diff segments"

---

### Task 4B: Cache rendered models without retaining wrong line numbers

**Files:**

- Create: src/webviews/react/diff-viewer/renderedDiffSegments.ts
- Create: tests/unit/webviews/renderedDiffSegments.test.ts

- [ ] **Step 1: Write render-model cache RED cases**

The pure builder/cache must prove:

- same segment object, index, and left/right start line returns the same RenderedSegment object and renderKey;
- one replaced segment creates one new model when line counts do not shift;
- an insertion forces shifted suffix line-number models to refresh but preserves their renderKey;
- distinct equal segment objects receive distinct keys;
- the cache uses WeakMap so removed segment objects are not held by a strong map.

- [ ] **Step 2: Move RenderedSegment and build logic into a cached pure helper**

Use one cache for the App lifetime:

~~~ts
export interface RenderedSegmentCache {
    readonly bySegment: WeakMap<DiffSegment, RenderedSegment>;
    nextKey: number;
}

export function createRenderedSegmentCache(): RenderedSegmentCache {
    return { bySegment: new WeakMap(), nextKey: 0 };
}
~~~

Each RenderedSegment gains:

- renderKey;
- sourceStartLine.left;
- sourceStartLine.right.

Reuse the whole RenderedSegment object only when segment identity, index, and both source starts match. If a reused segment shifted, rebuild its line numbers but keep its old renderKey.

- [ ] **Step 3: Run GREEN and mutation-prove shifted line numbers**

    bun vitest run tests/unit/webviews/renderedDiffSegments.test.ts --reporter=verbose

Mutation: force reuse of a shifted RenderedSegment object without rebuilding line numbers. The shifted-line-number assertion must fail by name. Restore and rerun GREEN.

- [ ] **Step 4: Commit the model-cache slice**

    git add src/webviews/react/diff-viewer/renderedDiffSegments.ts tests/unit/webviews/renderedDiffSegments.test.ts
    git commit -m "perf: cache rendered diff segment models"

---

### Task 4C: Wire reconciliation without remounting or staling the editor

**Files:**

- Modify: src/webviews/react/diff-viewer/DiffViewerApp.tsx:118-124, 328-500, 888-929, 1406-1412
- Modify: tests/integration/webviews/editable-diff-performance.integration.test.tsx
- Modify: tests/integration/webviews/diff-viewer.integration.test.tsx

- [ ] **Step 1: Make the activation callback stable and current**

Inside EditableDiffPane, update refs on every render for text, documentVersion, reseedToken, and renderedSegments. Make startEditing stable across host echoes and read those current values from the refs when the user activates a block.

Do not solve memoization with a comparator that ignores onStartEditing. Add an integration case that echoes a new documentVersion, then clicks an unchanged inactive block and proves the posted delta uses the new base version and new source text.

- [ ] **Step 2: Give the active textarea an edit-session identity**

Add an editSessionKey to EditableBlockDraft, minted only when startEditing begins a new session and preserved by every re-anchor. Use that key for the active editing branch.

Use renderKey only for inactive editable shells and read-only shells. Never key the active textarea from item.renderKey, item.index, documentVersion, or segment content.

- [ ] **Step 3: Reconcile at the message boundary**

Change only the setDiffData branch:

~~~ts
const nextData = event.data.data;
setError(nextData.loadError ?? null);
setIgnoreMode(nextData.ignoreWhitespace ? "whitespace" : "none");
setData((previous) => reconcileDiffViewerData(previous, nextData));
~~~

Build renderedSegments through the lifetime cache and apply these key rules:

- inactive editable block: item.renderKey;
- read-only block: item.renderKey plus pane prefix;
- active editing block: draft.editSessionKey.

Index remains the action/re-anchor coordinate; renderKey is inactive DOM identity only.

- [ ] **Step 4: Add exact active-editor and echo assertions**

After the one-second editText post:

1. dispatch a realistic next setDiffData payload with incremented documentVersion and one changed hunk;
2. save the original textarea node, selectionStart, selectionEnd, focus, and draft;
3. assert the exact same textarea node remains mounted, focused, selected, and unchanged after the echo;
4. assert a split/shift re-anchor also moves the same keyed node instead of remounting it;
5. dispatch a same-token echo during composition and prove the composition/draft is not destroyed;
6. assert inactive unchanged segment shells do not render;
7. when timingBudgetsApply is true, assert the echo commit is below 50 ms.

- [ ] **Step 5: Run GREEN and four-direction mutation proof**

    bun vitest run tests/unit/webviews/reconcileDiffSegments.test.ts tests/unit/webviews/renderedDiffSegments.test.ts tests/integration/webviews/editable-diff-performance.integration.test.tsx tests/integration/webviews/diff-viewer.integration.test.tsx --reporter=verbose

Mutation A: replace reconcileDiffViewerData with the raw next payload. The large echo assertion must name inactive shell renders.

Mutation B: key the active branch from item.renderKey. The exact-node or composition assertion must fail by name.

Mutation C: restore the old dependency-bound startEditing callback, then bypass its identity in the memo comparator. The post-echo base-version assertion must fail by name.

Mutation D: make reconciliation retain a changed segment. The visible changed-content assertion must fail by name.

Restore all mutations and rerun GREEN.

- [ ] **Step 6: Commit the React integration slice**

    git add src/webviews/react/diff-viewer/DiffViewerApp.tsx tests/integration/webviews/editable-diff-performance.integration.test.tsx tests/integration/webviews/diff-viewer.integration.test.tsx
    git commit -m "perf: retain editable diff identity across echoes"

---

### Task 5: Prove native-relative latency in a real VS Code window

**Files:**

- Create: tests/e2e/diffViewer.performance.spec.ts
- Modify: tests/e2e/diffViewer.spec.ts only if a shared open helper is extracted
- Modify: package.json
- Reference: tests/e2e/diffViewer.spec.ts:30-156

- [ ] **Step 1: Add an opt-in performance script**

Add:

    "test:e2e:diff-viewer:perf": "playwright test --config playwright.e2e.config.ts tests/e2e/diffViewer.performance.spec.ts"

Keep this outside the ordinary unit suite because machine timing is not deterministic. Deterministic invalidation and identity tests remain the CI regression gate.

- [ ] **Step 2: Seed the same large file for native and custom surfaces**

Use buildEditableDiffPerformanceFixture, including one unchanged 200-character sentinel line so the sampled edit never becomes the global horizontal extent. Write the file into the fixture workspace before launch and establish a HEAD version and a working-tree edit through the existing fixture Git helpers.

Run at least four rounds and alternate the order:

1. native Monaco then IntelliGit editable diff;
2. IntelliGit editable diff then native Monaco.

Use insertion/backspace pairs on the same short target line so each sample returns the document to identical bytes. Assert those bytes before switching surfaces. Do not compare different documents, dirty states, or Electron launches.

- [ ] **Step 3: Measure input-to-next-paint and long tasks in renderer context**

Measure the display frame interval from at least 120 requestAnimationFrame deltas in the foreground window. Warm each surface with ten insertion/backspace pairs, then collect at least fifty pairs.

Use PerformanceObserver event entries as the primary input-to-next-paint signal in both renderer realms; PerformanceEventTiming duration includes processing and presentation delay. Match entries to the sampled input targets and discard warm-up entries. Do not call a single requestAnimationFrame callback “paint” because the callback runs before paint.

Install PerformanceObserver for longtask before the sample when Electron exposes it. If event timing is unavailable, use one identical DOM/value-confirmation plus double-rAF fallback for both surfaces and calibrate its separate ceiling from the measured refresh interval; do not mix Event Timing samples from one surface with fallback samples from the other.

Write the metrics to testInfo.attach as JSON:

~~~ts
interface EditorLatencyMetrics {
    readonly surface: "native" | "custom";
    readonly measurement: "event-timing" | "double-raf";
    readonly frameIntervalMs: number;
    readonly samplesMs: readonly number[];
    readonly p50Ms: number;
    readonly p95Ms: number;
    readonly maxMs: number;
    readonly longTasksMs: readonly number[];
}
~~~

The test must assert:

- custom p95 is no more than one measured frame interval above native p95;
- custom p95 is no more than two measured frame intervals in absolute terms;
- no custom typing long task exceeds 50 ms.

If Long Tasks is unavailable, collect equivalent Chromium trace evidence. If neither source is available, mark the long-task criterion inconclusive and do not claim native parity complete.

- [ ] **Step 4: Measure the one-second echo separately**

Keep exact editText debounce timing in the fake-timer integration test, where the VS Code API is observable. The Electron test cannot intercept the module-private cached postMessage API without production instrumentation.

In Electron, install a message listener inside the webview before typing, type a hunk replacement that changes the ribbon count, and measure:

- last input to visible ribbon-count change;
- inbound setDiffData timestamp to the same after-paint helper used above;
- focus and draft after echo.

Assert the visible ribbon count changes within 1,250 ms of the last input and inbound-to-after-paint is at or below 50 ms. Attach initial custom-open and native-open measurements for the stop/go decision, but do not claim a before/after regression percentage from one revision.

- [ ] **Step 5: Run the real runtime proof**

    bun run build
    bun run test:e2e:diff-viewer:perf
    bun run test:e2e:diff-viewer

Expected: the performance attachment contains alternating native and custom samples, measured refresh cadence, telemetry support state, long-task/trace evidence, visible re-diff latency, inbound echo paint, and initial-open observations from one launch; all acceptance assertions pass; the existing re-diff and auto-save E2E cases remain green.

- [ ] **Step 6: Run the affected-path UI detector**

    npx --yes impeccable detect src/webviews/react/diff-viewer

Review findings against VS Code theme variables and existing design. Fix only valid issues introduced by this work; record waived unrelated findings.

- [ ] **Step 7: Commit**

    git add tests/e2e/diffViewer.performance.spec.ts tests/e2e/diffViewer.spec.ts package.json
    git commit -m "test: benchmark editable diff against native editor"

---

### Task 6: Integrated verification and stop/go decision

**Files:**

- Modify: CHANGELOG.md with one concise performance entry; no user-facing runtime string is added
- Review: every file changed by Tasks 1-5

- [ ] **Step 1: Run focused proof from root**

    bun vitest run tests/unit/webviews/editableDraftLayout.test.ts tests/unit/webviews/editableSegmentBlock.test.tsx tests/unit/webviews/reconcileDiffSegments.test.ts tests/unit/webviews/renderedDiffSegments.test.ts tests/unit/webviews/editablePaneGeometry.test.ts tests/integration/webviews/editable-diff-performance.integration.test.tsx tests/integration/webviews/diff-viewer.integration.test.tsx tests/unit/views/editableDiffEditorProvider.test.ts --reporter=verbose

Report exact files, tests, duration, and each mutation's named red assertion.

- [ ] **Step 2: Run standard repository gates**

    bun run format:check
    bun run lint
    bun run lint:strict
    bun run architecture:check
    bun run react-doctor
    bun run typecheck
    bun run build
    bun run test

Do not run publish. No localization pipeline is required unless implementation introduces or changes an English UI string, which this plan forbids.

- [ ] **Step 3: Re-run runtime evidence after the final build**

    bun run test:e2e:diff-viewer:perf
    bun run test:e2e:diff-viewer
    npx --yes impeccable detect src/webviews/react/diff-viewer

This is the final run whose numbers may be reported.

- [ ] **Step 4: Inspect the actual diff and change graph**

Run:

    git diff --check
    git status --short
    git diff --stat

Then run GitNexus detect_changes against main. Confirm only the editable diff view, its performance helpers/tests, package script, and changelog are affected.

- [ ] **Step 5: Apply the stop/go gate**

Ship this work package if typing and echo acceptance pass.

Create a new, separate architecture plan only if one of these remains true in the final trace:

- initial open exceeds 250 ms and is more than 1.5 times native;
- echo render remains above 50 ms after identity reuse;
- extension-host diff compute causes an observed responsiveness stall.

The follow-up candidates, in order of evidence required, are:

1. progressive idle mounting that preserves browser find by completing before idle ends;
2. an explicit measured-size native fallback using the existing vscode.diff path;
3. worker-thread diff computation only when extension-host tracing identifies compute as the remaining stall.

Do not introduce CRDT/rope storage, Monaco inside the webview, GPU rendering, a new diff algorithm, or a delta protocol without a new spec and measurements proving the simpler path failed.

- [ ] **Step 6: Final commit**

    git add CHANGELOG.md
    git commit -m "docs: note editable diff performance improvements"

## Final Gate 5 report template

Use this exact calibration in the implementation handoff:

- **Verified:** focused test count and command; standard gate results including lint:strict; measurement method and frame interval; alternating native/custom p50, p95, max, and long-task or trace evidence; exact one-second post count; inbound echo paint and total visible re-diff; active node/focus/selection/IME preservation; Impeccable result; GitNexus affected symbols/flows.
- **Mutation proof:** named assertions that went red for unconditional layout invalidation, always-equal layout suppression, removed shell memoization, changed-segment over-reuse, shifted-line-number over-reuse, active-key remount, and stale post-echo callback.
- **Assumed:** only facts the runtime could not expose, with the reason. Do not call native parity complete if the Electron comparison could not run.
- **Deferred:** initial-mount architecture only if its measured stop/go threshold remains missed.
