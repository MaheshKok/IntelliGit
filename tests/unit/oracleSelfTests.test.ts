import { afterAll, describe, expect, it } from "vitest";

import {
    disposeSelfTestWorkspaces,
    oracleSelfTests,
    type OracleSelfTest,
} from "../oracleSelfTests";
import type { OracleId } from "../oracles";

const cases = Object.entries(oracleSelfTests) as [OracleId, OracleSelfTest][];

describe("visual oracle self-tests", () => {
    afterAll(async () => {
        await disposeSelfTestWorkspaces();
    });

    it.each(cases)("%s flags its known-bad input", async (oracleId, selfTest) => {
        const findings = await selfTest.knownBad();

        expect(
            findings,
            `${oracleId}: known-bad input was not flagged; detects ${selfTest.detects}`,
        ).not.toHaveLength(0);
    });

    it.each(cases)("%s accepts its known-good input", async (oracleId, selfTest) => {
        const findings = await selfTest.knownGood();

        expect(
            findings,
            `${oracleId}: known-good input was flagged; detects ${selfTest.detects}`,
        ).toHaveLength(0);
    });
});
