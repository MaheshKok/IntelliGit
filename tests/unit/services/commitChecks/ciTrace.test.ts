import { describe, expect, it, vi } from "vitest";
import {
    createCiTrace,
    formatCiTraceLine,
    type CiTraceChannel,
    type CiTraceEvent,
} from "../../../../src/services/commitChecks/ciTrace";

function channel(): CiTraceChannel & {
    trace: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
} {
    return { trace: vi.fn(), info: vi.fn(), warn: vi.fn() };
}

describe("ciTrace", () => {
    it("no Authorization value, no query string, no log text", () => {
        const event = {
            kind: "log",
            outcome: "failed",
            repoKey: "github:github.com:o/r",
            provider: "github",
            hash: "0123456789abcdef0123456789abcdef01234567",
            status: 403,
            ms: 12,
            url: "https://pipelines.example.com/o/r/logs/1?X-Amz-Signature=SIGNED&token=QUERYTOKEN#frag",
            reason: "GET https://api.github.com/x?access_token=REASONTOKEN failed",
            // Fields a careless caller might pass through; none of them may be written.
            headers: { Authorization: "Bearer SECRETHEADER" },
            text: "LOGTEXT line 1",
            excerpt: "EXCERPTTEXT",
        } as unknown as CiTraceEvent;

        const line = formatCiTraceLine(event, "op1");

        expect(line).toContain("https://pipelines.example.com/o/r/logs/1");
        expect(line).toContain("https://api.github.com/x");
        for (const secret of [
            "SIGNED",
            "QUERYTOKEN",
            "frag",
            "REASONTOKEN",
            "SECRETHEADER",
            "Bearer",
            "LOGTEXT",
            "EXCERPTTEXT",
            "?",
        ]) {
            expect(line).not.toContain(secret);
        }
        expect(line).toContain("hash=0123456");
        expect(line).not.toContain("0123456789abcdef");
        expect(line).toContain("status=403");
    });

    it("a reason never carries credential text", () => {
        for (const reason of [
            "request failed: Authorization: Bearer secret-token",
            "rejected header authorization=Basic c2VjcmV0LXRva2Vu",
            "401 with bearer secret-token",
            "PRIVATE-TOKEN: secret-token was refused",
            "token=secret-token expired",
            "bad credentials ghp_secrettoken123 and glpat-secrettoken",
        ]) {
            const line = formatCiTraceLine({ kind: "detail", outcome: "failed", reason }, "op1");
            expect(line).toContain("reason=");
            for (const secret of ["secret-token", "c2VjcmV0", "secrettoken", "Bearer", "Basic"]) {
                expect(line, `${reason} -> ${line}`).not.toContain(secret);
            }
        }
    });

    it("uses trace for hits, warn for discards and info for fetches", () => {
        const sink = channel();
        const trace = createCiTrace(() => sink);
        trace({ kind: "detail", outcome: "hit-l1" });
        trace({ kind: "detail", outcome: "discarded-generation" });
        trace({ kind: "detail", outcome: "fetched" });
        expect(sink.trace).toHaveBeenCalledTimes(1);
        expect(sink.warn).toHaveBeenCalledTimes(1);
        expect(sink.info).toHaveBeenCalledTimes(1);
    });

    it("a failing channel never breaks the caller and is created lazily", () => {
        const getChannel = vi.fn((): CiTraceChannel => {
            throw new Error("no channel");
        });
        const trace = createCiTrace(getChannel);
        expect(getChannel).not.toHaveBeenCalled();
        expect(() => trace({ kind: "detail", outcome: "fetched" })).not.toThrow();
    });
});
