import { describe, expect, it } from "vitest";

import {
    oracleSelfTests,
    type OracleSelfTest,
    type VisualOracleId,
} from "../visual/oracleSelfTests";

const cases = Object.entries(oracleSelfTests) as [VisualOracleId, OracleSelfTest][];

describe("visual oracle self-tests", () => {
    it.each(cases)("%s flags its known-bad input", (oracleId, selfTest) => {
        const findings = selfTest.knownBad();

        expect(
            findings,
            `${oracleId}: known-bad input was not flagged; detects ${selfTest.detects}`,
        ).not.toHaveLength(0);
    });

    it.each(cases)("%s accepts its known-good input", (oracleId, selfTest) => {
        const findings = selfTest.knownGood();

        expect(
            findings,
            `${oracleId}: known-good input was flagged; detects ${selfTest.detects}`,
        ).toHaveLength(0);
    });
});
