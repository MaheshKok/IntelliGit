import { test } from "../fixtureWorkspace";
import { FLOW_MATRIX, runFlow } from "./matrix";

for (const flow of FLOW_MATRIX) {
    test.describe(flow.id, () => {
        test.use({ scenario: flow.scenario });

        test(flow.id, async ({ fixtureWorkspace }) => {
            test.setTimeout(240_000);
            await runFlow(flow, fixtureWorkspace);
        });
    });
}
