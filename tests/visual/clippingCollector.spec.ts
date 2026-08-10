import { expect, test } from "./playwright/harnessPage";
import { collectOracleInputs } from "./playwright/collectOracleInputs";
import { findClippingLosses } from "./oracles/geometry";
import type { ClippingInput } from "./oracles/geometry";

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
        });
    });
});
