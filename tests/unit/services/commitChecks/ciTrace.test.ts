import { describe, expect, it, vi } from "vitest";
import {
    createCiTrace,
    formatCiTraceLine,
    type CiTraceChannel,
    type CiTraceEvent,
    type CiTraceReason,
} from "../../../../src/services/commitChecks/ciTrace";
import type { ProviderId } from "../../../../src/types";

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

        // Origin plus path; the query string and fragment are dropped, and a path that
        // matches no known API route is redacted whole.
        expect(line).toContain(
            "url=https://pipelines.example.com/[redacted]/[redacted]/[redacted]/[redacted] status=403",
        );
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
        expect(line).toContain(
            "url=https://git.example.com/[redacted]/[redacted]/[redacted]/[redacted]/[redacted]",
        );
        expect(line).toMatch(/repoKey=[0-9a-f]{12} /);
        // The same repository always gets the same id, so lines still correlate.
        expect(formatCiTraceLine(event, "op2").split(" ")[3]).toBe(line.split(" ")[3]);
    });

    it("a token of any shape in a URL path never reaches the trace", () => {
        for (const token of [
            "secret1234567890123",
            "lowercaseonlysecretvalue",
            "0123456789abcdef0123456789abcdef01234567",
            "12345678901234567890",
            "S3cr3t",
        ]) {
            const line = formatCiTraceLine(
                { kind: "log", outcome: "failed", url: `https://ci.example.com/logs/${token}` },
                "op1",
            );
            expect(line, token).not.toContain(token);
            expect(line, token).toContain("url=https://ci.example.com/[redacted]/[redacted]");
        }
    });

    it("a token equal to a route word in a variable segment never reaches the trace", () => {
        for (const [url, expected] of [
            [
                "https://ci.example.com/logs/commits",
                "url=https://ci.example.com/[redacted]/[redacted]",
            ],
            [
                "https://api.github.com/repos/commits/statuses/commits/jobs/check-runs",
                "url=https://api.github.com/repos/[redacted]/[redacted]/commits/[redacted]/check-runs",
            ],
            [
                "https://git.example.com/api/v4/projects/logs/jobs/trace/trace",
                "url=https://git.example.com/api/v4/projects/[redacted]/jobs/[redacted]/trace",
            ],
            // The route is matched at the end of the path: segments before it are redacted,
            // and a segment after a known route means no route matched.
            [
                "https://ghe.example.com/api/v3/repos/o/r/commits/abc/check-runs",
                "url=https://ghe.example.com/[redacted]/[redacted]/repos/[redacted]/[redacted]/commits/[redacted]/check-runs",
            ],
            [
                "https://api.github.com/repos/o/r/commits/abc/check-runs/SECRET",
                `url=https://api.github.com/${Array(7).fill("[redacted]").join("/")}`,
            ],
        ]) {
            const line = formatCiTraceLine({ kind: "log", outcome: "failed", url }, "op1");
            expect(line, url).toBe(`op=op1 kind=log outcome=failed ${expected}`);
        }
    });

    it("a provider is written only as a known id, so free text never reaches the trace", () => {
        for (const provider of ["github", "gitlab", "bitbucket-cloud", "bitbucket-server"]) {
            expect(
                formatCiTraceLine(
                    { kind: "detail", outcome: "fetched", provider: provider as ProviderId },
                    "op1",
                ),
            ).toBe(`op=op1 kind=detail outcome=fetched provider=${provider}`);
        }
        const line = formatCiTraceLine(
            {
                kind: "detail",
                outcome: "fetched",
                provider: "token=ghp_SECRETPROVIDER" as ProviderId,
            },
            "op1",
        );
        expect(line).toBe("op=op1 kind=detail outcome=fetched provider=other");
    });

    it("keeps known API route words, drops user info, and redacts every other segment", () => {
        const sha = "0123456789abcdef0123456789abcdef01234567";
        for (const [url, expected] of [
            [
                `https://api.github.com/repos/o/r/commits/${sha}/check-runs?per_page=100`,
                "url=https://api.github.com/repos/[redacted]/[redacted]/commits/[redacted]/check-runs",
            ],
            [
                "https://USERSECRET@bitbucket.org/2.0/repositories/ws/repo/pipelines/",
                "url=https://bitbucket.org/2.0/repositories/[redacted]/[redacted]/pipelines/",
            ],
            [
                `https://git.example.com/rest/build-status/1.0/commits/${sha}?start=0`,
                "url=https://git.example.com/rest/build-status/1.0/commits/[redacted]",
            ],
            [
                "https://api.github.com/x/ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/y",
                "url=https://api.github.com/[redacted]/[redacted]/[redacted]",
            ],
            [
                "https://ci.example.com/api/v4/projects/o%2Fr/jobs/42/trace",
                "url=https://ci.example.com/api/v4/projects/[redacted]/jobs/[redacted]/trace",
            ],
        ]) {
            const line = formatCiTraceLine({ kind: "log", outcome: "failed", url }, "op1");
            expect(line, url).toBe(`op=op1 kind=log outcome=failed ${expected}`);
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
