import { expect, test } from "./playwright/harnessPage";
import { collectOracleInputs } from "./playwright/collectOracleInputs";
import type { CollectedOracleInputs } from "./playwright/collectOracleInputs";
import { oracles } from "../oracles";
import type { ClippingInput } from "./oracles/geometry";

const { findClippingLosses } = oracles.get("geometry");

/**
 * Resolves one fixture's reported clipping axes, or `exempt` when the collector never measured
 * the element at all. Shared by both tests below, which need the same three-way verdict:
 * `exempt` (dropped before measurement), `[]` (measured, nothing lost), and a named axis.
 */
const axesForIn =
    (inputs: CollectedOracleInputs) =>
    (testId: string): readonly string[] => {
        const sample = inputs.clipping.find((entry) =>
            entry.id.includes(`[data-testid="${testId}"]`),
        );
        if (sample === undefined) {
            // Absent from the clipping list at all -- the collector exempted it outright.
            return ["exempt"];
        }
        return [
            ...new Set(findClippingLosses(sample.input as ClippingInput).map((loss) => loss.axis)),
        ].sort();
    };

/**
 * `text-overflow` is not an inherited property, so the collector's `textOverflow !== "ellipsis"`
 * check only exempts the element that carries the declaration. A `<span>` inside a truncating
 * block computes `text-overflow: clip` and is measured as clipped even though the block paints an
 * ellipsis for it -- the user sees the affordance, the oracle reports a defect.
 *
 * The affordance is what separates a defect from a deliberate truncation, and the affordance is
 * painted by the clipping ancestor, not by the text node. These cases pin where that line falls
 * so the exemption cannot quietly widen to cover text that is genuinely unreachable.
 *
 * The last three cases pin the other affordance the collector understands: a scrollable ancestor.
 * Content that overflows a scroller is reachable even when something above the scroller hides its
 * overflow, because scrolling moves the content into the scroller's own box -- which already sits
 * inside that outer clipper. `scrollerChild` and `noScrollerChild` are the same DOM with a single
 * `overflow-x` value flipped, so they fail in opposite directions if the exemption ever stops being
 * keyed on scrollability, and `scrollerVerticalClip` fails if it stops being per-axis.
 *
 * Known gap, deliberately encoded here rather than silently fixed: the element-level check drops
 * an element carrying the declaration from the clipping list *entirely*, both axes. Since
 * `text-overflow: ellipsis` needs `overflow: hidden`, which the shorthand applies to both axes,
 * such an element whose text wraps past a fixed height is clipped downward with no affordance and
 * is not reported. `ellipsisSelf` below asserts the current wholesale exemption, so tightening it
 * to the inline axis will turn this case red on purpose -- that is the signal to widen the
 * coverage, not a regression.
 */
const CASES = `
    <div data-testid="ellipsis-self"
         style="width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
        Long enough text to overflow its box
    </div>

    <div style="width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
        <span data-testid="ellipsis-child">Long enough text to overflow its box</span>
    </div>

    <div style="width:80px;overflow:hidden;white-space:nowrap">
        <span data-testid="no-ellipsis-child">Long enough text to overflow its box</span>
    </div>

    <div style="width:80px;height:12px;overflow:hidden;text-overflow:ellipsis">
        <span data-testid="vertical-clip">Long enough text to wrap onto several lines and overflow downward</span>
    </div>

    <div style="width:80px;overflow:hidden">
        <div style="width:80px;overflow-x:auto;white-space:nowrap">
            <span data-testid="scroller-child">Long enough text to overflow its box</span>
        </div>
    </div>

    <div style="width:80px;overflow:hidden">
        <div style="width:80px;overflow-x:hidden;white-space:nowrap">
            <span data-testid="no-scroller-child">Long enough text to overflow its box</span>
        </div>
    </div>

    <div style="width:80px;height:12px;overflow:hidden">
        <div style="width:80px;height:20px;overflow-x:auto;overflow-y:hidden;scrollbar-width:none;white-space:nowrap">
            <span data-testid="scroller-vertical-clip">Long enough text to overflow its box</span>
        </div>
    </div>
`;

const CLIP_CASES = `
    <div data-testid="clip-control" style="width:200px">Plain text carrying no clip at all</div>

    <span data-testid="sr-only-label"
          style="position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0, 0, 0, 0);white-space:nowrap;border:0">Loading commit details</span>

    <div style="width:80px;height:20px;overflow:hidden;position:relative">
        <span data-testid="partly-clipped"
              style="position:absolute;top:0;left:0;white-space:nowrap;clip:rect(0px, 40px, 20px, 0px)">Long enough text to overflow its box</span>
    </div>
`;

test.describe("clipping collector truncation affordance", () => {
    test("reports the axes the ellipsis affordance does not cover", async ({
        mountHarness,
        page,
    }) => {
        await mountHarness("commit-graph-card");
        await page.locator("#root").evaluate((root, html) => {
            root.innerHTML = html;
        }, CASES);

        const inputs = await collectOracleInputs(page);

        const axesFor = axesForIn(inputs);

        expect({
            ellipsisSelf: axesFor("ellipsis-self"),
            ellipsisChild: axesFor("ellipsis-child"),
            noEllipsisChild: axesFor("no-ellipsis-child"),
            verticalClip: axesFor("vertical-clip"),
            scrollerChild: axesFor("scroller-child"),
            noScrollerChild: axesFor("no-scroller-child"),
            scrollerVerticalClip: axesFor("scroller-vertical-clip"),
        }).toEqual({
            // The declaration's own element: already exempt, and the control proving the
            // collector's existing check still works.
            ellipsisSelf: ["exempt"],
            // Truncated by an ancestor that paints an ellipsis for it -- same affordance the
            // user sees on `ellipsis-self`, so the same verdict.
            ellipsisChild: [],
            // Clipped horizontally with no ellipsis anywhere: unreachable text, a real defect.
            noEllipsisChild: ["horizontal"],
            // `text-overflow` does nothing on the block axis, so a vertically clipped element
            // has no affordance no matter what the ancestor declares.
            verticalClip: ["vertical"],
            // Overflows a scroller that is itself inside a `overflow:hidden` box. The outer
            // box bounds the SCROLLPORT, not its contents -- scrolling brings the text into
            // the scroller, which is already inside that box -- so nothing is unreachable.
            scrollerChild: [],
            // The mutation pair for the case above: byte-identical DOM with the scroller's
            // `overflow-x` flipped `auto` -> `hidden`. Same geometry, opposite verdict, which
            // is what proves the exemption keys on scrollability rather than swallowing every
            // clip that happens to sit under two nested boxes.
            noScrollerChild: ["horizontal"],
            // Scrolls on X, clips on Y, inside a shorter hidden box. The X exemption must not
            // leak across axes: the text is one scroll away horizontally and permanently cut
            // off vertically, so exactly one axis is reported.
            scrollerVerticalClip: ["vertical"],
        });
    });

    /**
     * The screen-reader-only idiom, copied from the production declaration it kept flagging
     * (`VISUALLY_HIDDEN_STYLE`, commit-info/CommitInfoPane.tsx:55-65): a 1x1 absolutely
     * positioned box whose paint area is collapsed to nothing, left `visible` and opaque on
     * purpose so assistive technology still announces it. Its text overflows that 1px box by
     * construction, so the collector measured every such label as unreachable text -- a defect
     * report naming a string no sighted user was ever meant to see.
     *
     * `clip` is paint-only: the element still generates a layout box and still returns client
     * rects, which is exactly why neither the `getClientRects()` check nor the `visibility` and
     * `opacity` checks above it caught this.
     *
     * The second fixture is the direction that keeps the exemption honest, and it is the reason
     * the check tests for a fully-collapsed rect rather than for the presence of `clip` at all:
     * an element clipped to a NON-empty rect is still painted, still partly readable, and still
     * has genuinely unreachable text when an ancestor cuts it off. Widening the exemption to any
     * clipped element turns this case red. The two fixtures fail in opposite directions, so no
     * single mistake can satisfy both.
     */
    test("exempts a collapsed clip rect without swallowing a partial one", async ({
        mountHarness,
        page,
    }) => {
        await mountHarness("commit-graph-card");
        await page.locator("#root").evaluate((root, html) => {
            root.innerHTML = html;
        }, CLIP_CASES);

        const axesFor = axesForIn(await collectOracleInputs(page));

        expect({
            clipControl: axesFor("clip-control"),
            srOnlyLabel: axesFor("sr-only-label"),
            partlyClipped: axesFor("partly-clipped"),
        }).toEqual({
            // Carries no `clip`, fits its box, and exists so this fixture always has at least
            // one candidate. Without it, a widened exemption drops BOTH remaining elements and
            // `assertNonEmptyCandidates` throws first -- the run still goes red, but on the
            // collector's own guard rather than on `partlyClipped`, so the assertion below is
            // never reached and proves nothing. Found by mutating, not by review.
            clipControl: [],
            // Never measured: the collector must drop it before it can be scored at all.
            srOnlyLabel: ["exempt"],
            // Clipped to a visible 40px window and cut off by an ancestor with no affordance.
            // Still a real defect, and still reported.
            partlyClipped: ["horizontal"],
        });
    });
});
