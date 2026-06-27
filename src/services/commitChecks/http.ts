// Provider-agnostic HTTPS GET helper for commit-check providers. Generalizes the
// former GitHub-only `githubGetJson`: callers pass a full URL and request headers,
// and the helper resolves parsed JSON or rejects on non-2xx / timeout / bad body.
// Injecting this `FetchJson` boundary keeps provider mapping logic unit-testable
// without module mocking.

import * as https from "https";

/** Network boundary used by providers; the only thing tests mock. */
export type FetchJson = (url: string, headers: Record<string, string>) => Promise<unknown>;

/** Performs an HTTPS GET with a 15s timeout, rejecting on any non-2xx status or invalid JSON. */
export const httpGetJson: FetchJson = (url, headers) => {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers }, (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer | string) => {
                chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
            });
            res.on("end", () => {
                req.setTimeout(0);
                const data = Buffer.concat(chunks).toString("utf8");
                const statusCode = res.statusCode ?? 0;
                if (statusCode < 200 || statusCode >= 300) {
                    reject(new Error(`HTTP ${statusCode}: ${data.slice(0, 200)}`));
                    return;
                }
                try {
                    resolve(data ? JSON.parse(data) : {});
                } catch {
                    reject(new Error("Invalid JSON response"));
                }
            });
        });
        req.on("error", reject);
        req.setTimeout(15000, () => {
            req.destroy(new Error("HTTP request timed out"));
        });
    });
};
