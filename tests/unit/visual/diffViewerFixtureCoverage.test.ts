import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import type { DiffSegment, DiffViewerData } from "../../../src/webviews/protocol/diffViewerTypes";
import {
    DIFF_PANES,
    SEGMENT_MARKERS,
    segmentMarker,
} from "../../../src/webviews/react/diff-viewer/segmentMarkers";
import { HOST_CONTEXT_FIXTURES } from "../../visual/hostContextFixtures";

/**
 * Asserts the recorded `diff-viewer` fixture still exercises every marker state.
 *
 * This is the oracle for a failure with no symptom. The viewer's states are decided by
 * how the differ happens to segment two texts, and the differ merges adjacent hunks
 * that share no common anchor between them. The fixture as first recorded put its
 * insertion-only rows directly against its two-sided hunk, so they arrived as one
 * `changed` segment with both sides populated: every pane block classified as
 * `diff-segment-modified`, `diff-segment-inserted` rendered nowhere, and `--diff-ok`
 * was never painted by any project. Nothing failed. The pixel baselines recorded the
 * missing state as the expected picture, and the live-page oracles measured what was
 * on screen, which was consistent and simply incomplete.
 *
 * Reading the fixture the harness actually mounts, rather than a payload built here,
 * is the whole point: a synthetic input would classify correctly while the recorded
 * one stayed broken.
 */
const FIXTURE_PATH = resolve(
    __dirname,
    "../../visual/fixtures/diff-viewer",
    HOST_CONTEXT_FIXTURES["diff-viewer"],
);

interface RecordedFixture {
    readonly messages: readonly {
        readonly message: { readonly type: string; readonly data?: unknown };
    }[];
}

function recordedSegments(): readonly DiffSegment[] {
    const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as RecordedFixture;
    const payloads = fixture.messages
        .filter((entry) => entry.message.type === "setDiffData")
        .map((entry) => entry.message.data as DiffViewerData);

    expect(
        payloads.length,
        `${FIXTURE_PATH} carries no setDiffData message, so the harness mounts a viewer with no payload and every assertion below would pass vacuously`,
    ).toBe(1);

    const segments = (payloads[0] as DiffViewerData).segments;
    expect(segments.length, "the recorded payload carries no segments at all").toBeGreaterThan(0);
    return segments;
}

describe("diff-viewer visual fixture coverage", () => {
    it("renders one block of every marker state the classifier can return", () => {
        const observed = new Set<string>();
        for (const segment of recordedSegments()) {
            for (const side of DIFF_PANES) {
                const marker = segmentMarker(segment, side);
                if (marker !== null) observed.add(marker);
            }
        }

        expect(
            [...observed].sort(),
            "the recorded diff-viewer fixture no longer produces one block of every marker state; the states it omits are painted by no pixel baseline and measured by no live-page oracle, and the omission is silent because the fixture still renders. Adjacent hunks with no common line between them are merged into one changed segment, so a state usually goes missing by losing its separator rather than by anyone editing it away",
        ).toEqual([...SEGMENT_MARKERS].sort());
    });

    it("puts the deletion marker on the left pane and the insertion marker on the right", () => {
        // Two invariants in one map, because each covers the other's blind spot. That the
        // markers land on different panes is what makes the taller side flip, and a ribbon
        // reading one pane's offset for the other survives a fixture where it never does.
        // That each lands on the correct pane is what the set alone cannot see: swap the
        // two arms of the classifier and every state is still present, still one per side,
        // and insertions are drawn in the deletion hue for good.
        const sidesByMarker: Record<string, string[]> = {};
        for (const segment of recordedSegments()) {
            for (const side of DIFF_PANES) {
                const marker = segmentMarker(segment, side);
                if (marker === "diff-segment-deleted" || marker === "diff-segment-inserted") {
                    (sidesByMarker[marker] ??= []).push(side);
                }
            }
        }

        expect(
            sidesByMarker,
            "a one-sided hunk in the recorded fixture is classified on the wrong pane, or both now sit on the same one; the first paints insertions in the deletion hue, the second leaves the taller side fixed so a per-pane offset bug still renders correctly",
        ).toEqual({
            "diff-segment-deleted": ["left"],
            "diff-segment-inserted": ["right"],
        });
    });
});
