import { describe, expect, it, vi } from "vitest";
import {
    createCiTrace,
    formatCiTraceLine,
    type CiTraceChannel,
    type CiTraceEvent,
    type CiTraceReason,
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

        expect(line).toContain("url=https://pipelines.example.com status=403");
        expect(line).not.toContain("/o/r/logs");
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

    it("a reason is written only as a known code, so free text and bare tokens never reach the trace", () => {
        for (const reason of [
            "provider rejected a9c3ef48d6b01e72",
            "request failed: Authorization: Bearer secret-token",
            "token=secret-token expired",
            "bad credentials ghp_secrettoken123",
        ]) {
            const line = formatCiTraceLine(
                { kind: "detail", outcome: "failed", reason: reason as CiTraceReason },
                "op1",
            );
            expect(line, `${reason} -> ${line}`).toBe(
                "op=op1 kind=detail outcome=failed reason=other",
            );
        }
        expect(
            formatCiTraceLine({ kind: "detail", outcome: "failed", reason: "rate-limited" }, "op1"),
        ).toBe("op=op1 kind=detail outcome=failed reason=rate-limited");
    });

    it("a token in the repository key or a URL path never reaches the trace", () => {
        const event: CiTraceEvent = {
            kind: "log",
            outcome: "failed",
            repoKey: "gitlab:git.example.com:glpat-REPOTOKEN/o/r",
            url: "https://git.example.com/api/v4/glpat-PATHTOKEN/jobs/1",
        };
        const line = formatCiTraceLine(event, "op1");

        expect(line).not.toContain("REPOTOKEN");
        expect(line).not.toContain("PATHTOKEN");
        expect(line).not.toContain("/api");
        expect(line).toContain("url=https://git.example.com");
        expect(line).toMatch(/repoKey=[0-9a-f]{12} /);
        // The same repository always gets the same id, so lines still correlate.
        expect(formatCiTraceLine(event, "op2").split(" ")[3]).toBe(line.split(" ")[3]);
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
