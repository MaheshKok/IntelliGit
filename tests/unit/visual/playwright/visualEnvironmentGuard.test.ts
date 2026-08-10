import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Browser } from "@playwright/test";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
    CONTAINMENT_MARKER,
    assertUpdateEnvironment,
    decideEnvironmentVerdict,
    environmentVerdict,
    planEnvironmentRun,
    prepareVisualEnvironment,
    probeContainment,
    readCommittedEnvironment,
    resetVisualEnvironmentGuardForTest,
} from "../../../visual/playwright/visualEnvironmentGuard";
import { BASELINE_PLATFORM } from "../../../visual/oracles/findingsBaselineFile";
import type { VisualEnvironment } from "../../../visual/oracles/visualEnvironment";

const validDigest = `repo@sha256:${"a".repeat(64)}`;
const baseEnvironment: VisualEnvironment = {
    baseImage: validDigest,
    browserVersion: "139.0.7258.5",
    platform: BASELINE_PLATFORM,
    osRelease: "6.12.0",
    fonts: ["Arial", "Noto Sans"],
};
// Deliberately partial: the guard only ever calls `version()`, so widening through `unknown`
// keeps the double honest about being a stub instead of pretending to implement `Browser`.
const stubBrowser = { version: async () => "139.0.7258.5" } as unknown as Browser;

function withTemporaryEnvironmentPath(
    run: (environmentPath: string, pinPath: string) => void | Promise<void>,
): void | Promise<void> {
    const directory = mkdtempSync(join(tmpdir(), "intelligit-visual-environment-"));
    const environmentPath = join(directory, "baselineEnvironment.json");
    const pinPath = join(directory, "base-image.txt");
    writeFileSync(pinPath, `# test pin\n\n${validDigest}\n`, "utf8");
    const cleanup = (): void => rmSync(directory, { recursive: true, force: true });
    try {
        const result = run(environmentPath, pinPath);
        if (result instanceof Promise) return result.finally(cleanup);
        cleanup();
    } catch (error) {
        cleanup();
        throw error;
    }
}

async function prepareWithUpdate(
    environmentPath: string,
    pinPath: string,
    workerCount: number,
    platform: string,
    baseImage = validDigest,
    captured: VisualEnvironment = baseEnvironment,
    inContainer = true,
): Promise<void> {
    vi.stubEnv("UPDATE_VISUAL_BASELINE", "1");
    vi.stubEnv("INTELLIGIT_BASE_IMAGE", baseImage);
    await prepareVisualEnvironment(
        stubBrowser,
        workerCount,
        environmentPath,
        pinPath,
        () => inContainer,
        platform,
        async () => captured,
    );
}

async function prepareForCompare(
    environmentPath: string,
    pinPath: string,
    captured: VisualEnvironment = baseEnvironment,
): Promise<void> {
    vi.unstubAllEnvs();
    delete process.env.UPDATE_VISUAL_BASELINE;
    vi.stubEnv("INTELLIGIT_BASE_IMAGE", validDigest);
    await prepareVisualEnvironment(
        stubBrowser,
        1,
        environmentPath,
        pinPath,
        () => false,
        BASELINE_PLATFORM,
        async () => captured,
    );
}

afterEach(() => {
    resetVisualEnvironmentGuardForTest();
    vi.unstubAllEnvs();
});

describe("visual environment guard", () => {
    describe("planEnvironmentRun", () => {
        it("returns compare without requiring update-only guards", () => {
            expect(
                planEnvironmentRun({
                    updateRequested: false,
                    platform: "darwin-arm64",
                    workerCount: 8,
                    baseImage: undefined,
                    pinnedBaseImage: validDigest,
                    inContainer: false,
                }),
            ).toBe("compare");
        });

        it("returns update after every update guard passes", () => {
            expect(
                planEnvironmentRun({
                    updateRequested: true,
                    platform: BASELINE_PLATFORM,
                    workerCount: 1,
                    baseImage: validDigest,
                    pinnedBaseImage: validDigest,
                    inContainer: true,
                }),
            ).toBe("update");
        });
    });

    describe("prepareVisualEnvironment call-site guards", () => {
        it("rejects when the update platform guard fails", async () => {
            await withTemporaryEnvironmentPath(async (environmentPath, pinPath) => {
                await expect(
                    prepareWithUpdate(environmentPath, pinPath, 1, "darwin-arm64"),
                ).rejects.toThrow("may only write the baseline on linux-x64");
            });
        });

        it("rejects when the single-worker guard fails", async () => {
            await withTemporaryEnvironmentPath(async (environmentPath, pinPath) => {
                await expect(
                    prepareWithUpdate(environmentPath, pinPath, 2, BASELINE_PLATFORM),
                ).rejects.toThrow("must run single-threaded");
            });
        });

        it("rejects when the base-image provenance guard fails", async () => {
            await withTemporaryEnvironmentPath(async (environmentPath, pinPath) => {
                await expect(
                    prepareWithUpdate(
                        environmentPath,
                        pinPath,
                        1,
                        BASELINE_PLATFORM,
                        "not-a-digest",
                    ),
                ).rejects.toThrow("shape check failed");
            });
        });

        it("rejects an update that captures an empty font manifest", async () => {
            await withTemporaryEnvironmentPath(async (environmentPath, pinPath) => {
                await expect(
                    prepareWithUpdate(environmentPath, pinPath, 1, BASELINE_PLATFORM, validDigest, {
                        ...baseEnvironment,
                        fonts: [],
                    }),
                ).rejects.toThrow("empty font manifest");
            });
        });

        it("rejects an update when the captured platform is not the baseline platform", async () => {
            await withTemporaryEnvironmentPath(async (environmentPath, pinPath) => {
                await expect(
                    prepareWithUpdate(environmentPath, pinPath, 1, BASELINE_PLATFORM, validDigest, {
                        ...baseEnvironment,
                        platform: "darwin-arm64",
                    }),
                ).rejects.toThrow(
                    "Visual environment write rejected: platform darwin-arm64 is not linux-x64",
                );
            });
        });

        it("rejects an update when the captured base image is not the pinned image", async () => {
            await withTemporaryEnvironmentPath(async (environmentPath, pinPath) => {
                await expect(
                    prepareWithUpdate(environmentPath, pinPath, 1, BASELINE_PLATFORM, validDigest, {
                        ...baseEnvironment,
                        baseImage: `repo@sha256:${"b".repeat(64)}`,
                    }),
                ).rejects.toThrow(
                    "Visual environment write rejected: base image does not equal the pinned digest.",
                );
            });
        });
    });

    describe("prepareVisualEnvironment compare path", () => {
        it("completes with a no-baseline verdict when the artifact is absent", async () => {
            await withTemporaryEnvironmentPath(async (environmentPath, pinPath) => {
                await prepareForCompare(environmentPath, pinPath);

                expect(environmentVerdict()).toEqual({ kind: "no-baseline" });
            });
        });

        it("completes with a match verdict when the artifact matches", async () => {
            await withTemporaryEnvironmentPath(async (environmentPath, pinPath) => {
                writeFileSync(environmentPath, JSON.stringify(baseEnvironment), "utf8");

                await prepareForCompare(environmentPath, pinPath);

                expect(environmentVerdict()).toEqual({ kind: "match" });
            });
        });

        it("completes with a drift verdict naming the differing field", async () => {
            await withTemporaryEnvironmentPath(async (environmentPath, pinPath) => {
                writeFileSync(
                    environmentPath,
                    JSON.stringify({ ...baseEnvironment, browserVersion: "140.0.7339.1" }),
                    "utf8",
                );

                await prepareForCompare(environmentPath, pinPath);

                const verdict = environmentVerdict();
                expect(verdict.kind).toBe("drift");
                if (verdict.kind === "drift") expect(verdict.message).toContain("browserVersion");
            });
        });

        it("completes with an unreadable verdict when the artifact is corrupt", async () => {
            await withTemporaryEnvironmentPath(async (environmentPath, pinPath) => {
                writeFileSync(environmentPath, "{not json", "utf8");

                await prepareForCompare(environmentPath, pinPath);

                expect(environmentVerdict()).toEqual({
                    kind: "unreadable",
                    message: expect.stringContaining("malformed JSON"),
                });
            });
        });
    });

    describe("prepareVisualEnvironment update path", () => {
        it("writes the captured environment and reports a match", async () => {
            await withTemporaryEnvironmentPath(async (environmentPath, pinPath) => {
                await prepareWithUpdate(environmentPath, pinPath, 1, BASELINE_PLATFORM);

                expect(environmentVerdict()).toEqual({ kind: "match" });
                expect(JSON.parse(readFileSync(environmentPath, "utf8"))).toEqual(baseEnvironment);
            });
        });
    });

    describe("decideEnvironmentVerdict", () => {
        it("distinguishes an absent baseline from a match", () => {
            const verdict = decideEnvironmentVerdict({ kind: "absent" }, baseEnvironment);

            expect(verdict.kind).toBe("no-baseline");
            expect(verdict.kind).not.toBe("match");
        });

        it("reports an unreadable baseline distinctly", () => {
            expect(
                decideEnvironmentVerdict(
                    { kind: "unreadable", reason: "malformed JSON" },
                    baseEnvironment,
                ),
            ).toEqual({
                kind: "unreadable",
                message: expect.stringContaining("malformed JSON"),
            });
        });

        it("matches deeply equal environments", () => {
            expect(
                decideEnvironmentVerdict(
                    { kind: "environment", value: baseEnvironment },
                    baseEnvironment,
                ),
            ).toEqual({ kind: "match" });
        });

        it("reports the differing field and regeneration command", () => {
            const verdict = decideEnvironmentVerdict(
                { kind: "environment", value: baseEnvironment },
                {
                    ...baseEnvironment,
                    browserVersion: "140.0.7339.1",
                },
            );

            expect(verdict.kind).toBe("drift");
            if (verdict.kind === "drift") {
                expect(verdict.message).toContain("browserVersion");
                expect(verdict.message).toContain(
                    "./tests/e2e/docker/run.sh 'bun install --frozen-lockfile && bun run build && UPDATE_VISUAL_BASELINE=1 npx playwright test --config playwright.visual.config.ts --workers=1'",
                );
            }
        });

        it("matches equal font sets regardless of order and duplicates", () => {
            expect(
                decideEnvironmentVerdict(
                    {
                        kind: "environment",
                        value: { ...baseEnvironment, fonts: ["Noto Sans", "Arial", "Noto Sans"] },
                    },
                    { ...baseEnvironment, fonts: ["Arial", "Noto Sans"] },
                ),
            ).toEqual({ kind: "match" });
        });
    });

    describe("readCommittedEnvironment", () => {
        it("returns absent for a missing path", () => {
            withTemporaryEnvironmentPath((environmentPath) => {
                expect(readCommittedEnvironment(environmentPath)).toEqual({ kind: "absent" });
            });
        });

        it("returns unreadable for an empty baseline object", () => {
            withTemporaryEnvironmentPath((environmentPath) => {
                writeFileSync(environmentPath, "{}\n", "utf8");

                const result = readCommittedEnvironment(environmentPath);
                expect(result.kind).toBe("unreadable");
                if (result.kind === "unreadable") expect(result.reason).toContain("baseImage");
            });
        });

        it("returns unreadable for malformed JSON", () => {
            withTemporaryEnvironmentPath((environmentPath) => {
                writeFileSync(environmentPath, '{"baseImage":', "utf8");

                const result = readCommittedEnvironment(environmentPath);
                expect(result.kind).toBe("unreadable");
                if (result.kind === "unreadable") expect(result.reason).toContain("JSON");
            });
        });

        it("returns unreadable when a field has the wrong type", () => {
            withTemporaryEnvironmentPath((environmentPath) => {
                writeFileSync(
                    environmentPath,
                    JSON.stringify({ ...baseEnvironment, fonts: [1, 2] }),
                    "utf8",
                );

                const result = readCommittedEnvironment(environmentPath);
                expect(result.kind).toBe("unreadable");
                if (result.kind === "unreadable") expect(result.reason).toContain("fonts");
            });
        });

        it("returns unreadable when the artifact has an unknown key", () => {
            withTemporaryEnvironmentPath((environmentPath) => {
                writeFileSync(
                    environmentPath,
                    JSON.stringify({ ...baseEnvironment, unexpected: true }),
                    "utf8",
                );

                const result = readCommittedEnvironment(environmentPath);
                expect(result.kind).toBe("unreadable");
                if (result.kind === "unreadable") expect(result.reason).toContain("unexpected");
            });
        });

        it.each(["baseImage", "browserVersion", "platform", "osRelease"] as const)(
            "returns unreadable when the artifact is missing scalar field %s",
            (field) => {
                withTemporaryEnvironmentPath((environmentPath) => {
                    const artifact = Object.fromEntries(
                        Object.entries(baseEnvironment).filter(([key]) => key !== field),
                    );
                    writeFileSync(environmentPath, JSON.stringify(artifact), "utf8");

                    const result = readCommittedEnvironment(environmentPath);
                    expect(result.kind).toBe("unreadable");
                    if (result.kind === "unreadable") expect(result.reason).toContain(field);
                });
            },
        );

        it("normalizes fonts from a valid committed environment", () => {
            withTemporaryEnvironmentPath((environmentPath) => {
                const rawEnvironment = {
                    ...baseEnvironment,
                    fonts: ["Noto Sans", "Arial", "Noto Sans"],
                };
                writeFileSync(environmentPath, JSON.stringify(rawEnvironment), "utf8");

                expect(readCommittedEnvironment(environmentPath)).toEqual({
                    kind: "environment",
                    value: { ...baseEnvironment, fonts: ["Arial", "Noto Sans"] },
                });
                expect(readFileSync(environmentPath, "utf8")).toBe(JSON.stringify(rawEnvironment));
            });
        });
    });

    describe("assertUpdateEnvironment", () => {
        it("requires a digest-shaped base image for an update", () => {
            expect(() => assertUpdateEnvironment(true, "whatever", validDigest, true)).toThrow(
                "shape check failed",
            );
        });

        it("requires the pinned identity for an update", () => {
            expect(() =>
                assertUpdateEnvironment(true, `repo@sha256:${"b".repeat(64)}`, validDigest, true),
            ).toThrow("identity check failed");
        });

        it("requires container containment for an update", () => {
            expect(() => assertUpdateEnvironment(true, validDigest, validDigest, false)).toThrow(
                "containment check failed",
            );
        });

        it("does not require provenance during comparison", () => {
            expect(() =>
                assertUpdateEnvironment(false, undefined, validDigest, false),
            ).not.toThrow();
        });
    });

    describe("probeContainment", () => {
        it("reports containment only when the marker file is present", () => {
            withTemporaryEnvironmentPath((markerPath) => {
                expect(probeContainment(markerPath)).toBe(false);

                writeFileSync(markerPath, "", "utf8");

                expect(probeContainment(markerPath)).toBe(true);
            });
        });

        it("defaults to the marker Docker creates inside every container", () => {
            expect(CONTAINMENT_MARKER).toBe("/.dockerenv");
        });
    });

    describe("environmentVerdict", () => {
        it("throws when requested before worker capture completes", () => {
            expect(() => environmentVerdict()).toThrow(
                "Visual environment verdict requested before worker capture completed.",
            );
        });
    });
});
