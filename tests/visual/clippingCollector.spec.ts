import { expect, test } from "./playwright/harnessPage";
import { collectOracleInputs } from "./playwright/collectOracleInputs";
import { oracles } from "../oracles";
import type { ClippingInput } from "./oracles/geometry";

const { findClippingLosses } = oracles.get("geometry");

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

        const axesFor = (testId: string): readonly string[] => {
            const sample = inputs.clipping.find((entry) =>
                entry.id.includes(`[data-testid="${testId}"]`),
            );
            if (sample === undefined) {
                // Absent from the clipping list at all -- the collector exempted it outright.
                return ["exempt"];
            }
            return [
                ...new Set(
                    findClippingLosses(sample.input as ClippingInput).map((loss) => loss.axis),
                ),
            ].sort();
        };

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
});
