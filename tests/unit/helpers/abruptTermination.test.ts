/**
 * Pins both platform branches of `describeAbruptTermination`, from whichever platform runs this.
 *
 * The Windows branch exists precisely because it cannot be exercised on a developer machine, so
 * without a supplied platform its first execution would be on CI, ~35 minutes after the mistake.
 */

import { describe, expect, it } from "vitest";

import { describeAbruptTermination } from "../../helpers/abruptTermination";

describe("describeAbruptTermination on Windows", () => {
    it("accepts the TerminateProcess shape Node reports for a killed process", () => {
        // What `process.kill(pid, "SIGKILL")` actually produces on Windows, and what the old
        // assertion rejected: a non-zero code and no signal at all.
        expect(describeAbruptTermination({ code: 1, signal: null }, "win32").abrupt).toBe(true);
    });

    it("rejects a clean exit", () => {
        // The property under test is "died without cleanup". A worker that ran to completion has
        // not crashed, and recovery would have nothing to resume.
        const verdict = describeAbruptTermination({ code: 0, signal: null }, "win32");
        expect(verdict.abrupt).toBe(false);
        expect(verdict.reason).toContain("exited cleanly");
    });

    it("rejects a signal, which Windows cannot deliver", () => {
        // Not a hypothetical: if a future Node did report a signal here, the Windows branch would
        // be the wrong branch to be in and this should say so rather than pass by accident.
        expect(describeAbruptTermination({ code: null, signal: "SIGKILL" }, "win32").abrupt).toBe(
            false,
        );
    });
});

describe("describeAbruptTermination on POSIX", () => {
    it("still requires SIGKILL exactly", () => {
        // The POSIX side loses nothing. It keeps the precise check the tests had before.
        expect(describeAbruptTermination({ code: null, signal: "SIGKILL" }, "linux").abrupt).toBe(
            true,
        );
    });

    it("rejects a non-zero exit with no signal, which on POSIX means it was not killed", () => {
        // The exact shape Windows accepts is the shape POSIX must refuse -- otherwise the helper
        // would quietly accept a worker that threw before reaching its checkpoint.
        const verdict = describeAbruptTermination({ code: 1, signal: null }, "darwin");
        expect(verdict.abrupt).toBe(false);
        expect(verdict.reason).toContain("SIGKILL");
    });

    it("rejects a different signal", () => {
        expect(describeAbruptTermination({ code: null, signal: "SIGTERM" }, "darwin").abrupt).toBe(
            false,
        );
    });

    it("rejects a clean exit", () => {
        expect(describeAbruptTermination({ code: 0, signal: null }, "darwin").abrupt).toBe(false);
    });
});

describe("describeAbruptTermination default platform", () => {
    it("uses the running platform", () => {
        // The default is what the production call sites use, so a seam correct only when a test
        // passes an argument would prove nothing about them.
        const outcome = { code: 1, signal: null } as const;
        expect(describeAbruptTermination(outcome).abrupt).toBe(
            describeAbruptTermination(outcome, process.platform).abrupt,
        );
    });
});
