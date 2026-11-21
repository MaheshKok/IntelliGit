import { mkdir, mkdtemp, realpath, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeScratchDirectories } from "../../../helpers/scratchDirectories";

const mocks = vi.hoisted(() => ({ getSession: vi.fn(), showTextDocument: vi.fn() }));

vi.mock("vscode", () => {
    class Position {
        constructor(
            readonly line: number,
            readonly character: number,
        ) {}
    }
    class Range {
        readonly start: Position;
        readonly end: Position;
        constructor(
            startLine: number,
            startCharacter: number,
            endLine: number,
            endCharacter: number,
        ) {
            this.start = new Position(startLine, startCharacter);
            this.end = new Position(endLine, endCharacter);
        }
    }
    class Diagnostic {
        source?: string;
        constructor(
            readonly range: Range,
            readonly message: string,
            readonly severity: number,
        ) {}
    }
    return {
        Range,
        Diagnostic,
        DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
        Uri: { file: (fsPath: string) => ({ fsPath, scheme: "file" }) },
        authentication: { getSession: mocks.getSession },
        window: { showTextDocument: mocks.showTextDocument },
        l10n: { t: (message: string) => message },
    };
});

import { NO_CI_CAPABILITIES } from "../../../../src/shared/ci/capabilities";
import { CiGenerations } from "../../../../src/services/commitChecks/ciGenerations";
import {
    CiDiagnostics,
    type CiDiagnosticsDeps,
} from "../../../../src/services/commitChecks/ciDiagnostics";
import { CiDetailPersistentCache } from "../../../../src/services/commitChecks/detailPersistentCache";
import { CommitCiDetailService } from "../../../../src/services/commitChecks/detailService";
import { GitHubProvider } from "../../../../src/services/commitChecks/githubProvider";
import {
    HttpError,
    type FetchJsonWithMeta,
    type FetchResponse,
} from "../../../../src/services/commitChecks/http";
import type {
    CiAnnotation,
    CiAnnotations,
    ProviderRepoRef,
} from "../../../../src/services/commitChecks/types";
import {
    HeadCiStatus,
    type HeadCiStatusDeps,
} from "../../../../src/services/commitChecks/headStatus";
import type { CiJob, CommitCiDetail, CommitCiDetailData } from "../../../../src/types";

const HASH = "a".repeat(40);
const NEXT_HASH = "b".repeat(40);
const CAPS = { ...NO_CI_CAPABILITIES, runs: true, jobs: true, annotations: true };

interface FakeDiagnostic {
    range: { start: { line: number; character: number }; end: { line: number; character: number } };
    message: string;
    severity: number;
    source?: string;
}

let root: string;
let outside: string;

beforeEach(async () => {
    vi.clearAllMocks();
    const scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), "intelligit-ci-diag-")));
    root = path.join(scratch, "repo");
    outside = path.join(scratch, "outside");
    await mkdir(path.join(root, "src"), { recursive: true });
    await mkdir(outside, { recursive: true });
    const tenLines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
    await writeFile(path.join(root, "src", "app.ts"), tenLines);
    await writeFile(path.join(root, "src", "other.ts"), "only\r\ntwo lines");
    await writeFile(path.join(outside, "secret.ts"), "secret\n");
    await symlink(path.join(outside, "secret.ts"), path.join(root, "link.ts"));
    mocks.getSession.mockResolvedValue({
        id: "session",
        accessToken: "gh-token",
        account: { id: "account", label: "GitHub User" },
        scopes: ["repo"],
    });
});

afterEach(async () => {
    await removeScratchDirectories(path.dirname(root));
});

function job(overrides: Partial<CiJob> = {}): CiJob {
    return {
        id: "1",
        logicalId: "ci/unit-tests",
        name: "unit-tests",
        checkName: "unit-tests",
        state: "failure",
        checkRunId: "11",
        annotationCount: 1,
        steps: [],
        ...overrides,
    };
}

function detailData(jobs: CiJob[], hash = HASH): CommitCiDetailData {
    const failed = jobs.some((j) => j.state === "failure");
    return {
        hash,
        provider: "github",
        complete: true,
        outcome: failed ? "failure" : "success",
        runs: [
            {
                id: "run-1",
                name: "CI",
                state: failed ? "failure" : "success",
                jobs,
                jobsCoverage: "full",
            },
        ],
        runsCoverage: "full",
        otherChecks: [],
        otherChecksCoverage: "full",
    };
}

function detail(jobs: CiJob[] = [job()], hash = HASH): CommitCiDetail {
    return { ...detailData(jobs, hash), capabilities: CAPS, repoKey: root };
}

function annotation(overrides: Partial<CiAnnotation> = {}): CiAnnotation {
    return {
        path: "src/app.ts",
        startLine: 2,
        endLine: 2,
        level: "failure",
        message: "expected true to be false",
        ...overrides,
    };
}

function fakeCollection() {
    const entries = new Map<string, FakeDiagnostic[]>();
    return {
        entries,
        set: vi.fn((uri: { fsPath: string }, diagnostics: readonly FakeDiagnostic[]) => {
            entries.set(uri.fsPath, [...diagnostics]);
        }),
        clear: vi.fn(() => entries.clear()),
        /** Every Diagnostic the collection was ever given. */
        given(): FakeDiagnostic[] {
            return this.set.mock.calls.flatMap(([, diagnostics]) => [...diagnostics]);
        },
    };
}

interface Harness {
    diagnostics: CiDiagnostics;
    collection: ReturnType<typeof fakeCollection>;
    generations: CiGenerations;
    annotations: ReturnType<typeof vi.fn>;
    setHead(hash: string | undefined): void;
    setSwitch(read: () => boolean): void;
    setEnabled(value: boolean): void;
}

function harness(
    fetch: (checkRunId: string) => Promise<CiAnnotations> = async () => ({
        annotations: [annotation()],
        coverage: "full",
    }),
): Harness {
    let head: string | undefined = HASH;
    let switchOn: () => boolean = () => true;
    let enabled = true;
    const collection = fakeCollection();
    const generations = new CiGenerations();
    const annotations = vi.fn((_hash: string, checkRunId: string) => fetch(checkRunId));
    const deps: CiDiagnosticsDeps = {
        switchOn: () => switchOn(),
        enabled: () => enabled,
        repoKey: () => root,
        headHash: async () => head,
        generations,
        collection: collection as unknown as CiDiagnosticsDeps["collection"],
        annotations,
    };
    return {
        diagnostics: new CiDiagnostics(deps),
        collection,
        generations,
        annotations,
        setHead: (hash) => {
            head = hash;
        },
        setSwitch: (read) => {
            switchOn = read;
        },
        setEnabled: (value) => {
            enabled = value;
        },
    };
}

function target(h: Harness, d: CommitCiDetail = detail()) {
    return { repoKey: root, hash: d.hash, ctx: h.generations.capture(root), detail: d };
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
        resolve = r;
    });
    return { promise, resolve };
}

const appFile = () => path.join(root, "src", "app.ts");

describe("CiDiagnostics", () => {
    it("maps levels and 1-based lines", async () => {
        const h = harness(async () => ({
            annotations: [
                annotation({ startLine: 2, endLine: 2, level: "failure", message: "boom" }),
                annotation({ startLine: 3, endLine: 4, level: "warning", message: "careful" }),
                annotation({ startLine: 5, endLine: 5, level: "notice", message: "fyi" }),
            ],
            coverage: "full",
        }));

        await h.diagnostics.show(target(h));

        const placed = h.collection.entries.get(appFile()) ?? [];
        expect(
            placed.map((d) => [d.severity, d.range.start.line, d.range.end.line, d.message]),
        ).toEqual([
            [0, 1, 1, "boom"],
            [1, 2, 3, "careful"],
            [2, 4, 4, "fyi"],
        ]);
        // The range covers the whole last line ("line 4" is 6 characters long).
        expect(placed[1].range.end.character).toBe(6);
        expect(h.diagnostics.viewFor(root, HASH)?.items).toEqual([
            { path: "src/app.ts", line: 2, level: "failure", message: "boom", job: "unit-tests" },
            {
                path: "src/app.ts",
                line: 3,
                level: "warning",
                message: "careful",
                job: "unit-tests",
            },
            { path: "src/app.ts", line: 5, level: "notice", message: "fyi", job: "unit-tests" },
        ]);
    });

    it("source is CI: <job>", async () => {
        const h = harness();

        await h.diagnostics.show(target(h, detail([job({ name: "lint-and-test" })])));

        expect(h.collection.entries.get(appFile())?.map((d) => d.source)).toEqual([
            "CI: lint-and-test",
        ]);
    });

    it("only HEAD, only failed runs with annotationCount > 0", async () => {
        const h = harness();
        const jobs = [
            job({ id: "1", checkRunId: "11", annotationCount: 2 }),
            job({ id: "2", checkRunId: "12", annotationCount: 3, state: "success" }),
            job({ id: "3", checkRunId: "13", annotationCount: 0 }),
            job({ id: "4", checkRunId: undefined, annotationCount: 4 }),
            job({ id: "5", checkRunId: "15", annotationCount: undefined }),
        ];

        await h.diagnostics.show(target(h, detail(jobs)));
        expect(h.annotations.mock.calls.map(([hash, id]) => [hash, id])).toEqual([[HASH, "11"]]);

        // A commit that is not HEAD gets no request and no entry.
        const other = harness();
        await other.diagnostics.show(target(other, detail([job()], NEXT_HASH)));
        expect(other.annotations).not.toHaveBeenCalled();
        expect(other.collection.given()).toEqual([]);

        // Nor does a HEAD whose CI is still running or has no annotations capability.
        const running = harness();
        await running.diagnostics.show(
            target(running, { ...detail(), complete: false, outcome: "pending" }),
        );
        await running.diagnostics.show(
            target(running, { ...detail(), capabilities: { ...CAPS, annotations: false } }),
        );
        expect(running.annotations).not.toHaveBeenCalled();
    });

    it("clears on HEAD move", async () => {
        const h = harness();
        let head: string = HASH;
        const monitor = new HeadCiStatus(monitorDeps(h, () => head));

        await monitor.onRepositoryChanged();
        await vi.waitFor(() => expect(h.collection.entries.get(appFile())).toHaveLength(1));

        // The new HEAD passed: nothing is published for it.
        head = NEXT_HASH;
        h.setHead(NEXT_HASH);
        await monitor.onRepositoryChanged();
        await settle();

        expect(h.collection.entries.size).toBe(0);
        expect(h.diagnostics.viewFor(root, HASH)).toBeUndefined();
        monitor.dispose();
    });

    it("clears when the HEAD monitor is disposed", async () => {
        const h = harness();
        const monitor = new HeadCiStatus(monitorDeps(h, () => HASH));

        await monitor.onRepositoryChanged();
        await vi.waitFor(() => expect(h.collection.entries.get(appFile())).toHaveLength(1));
        monitor.dispose();

        expect(h.collection.entries.size).toBe(0);
        expect(h.diagnostics.viewFor(root, HASH)).toBeUndefined();
    });

    it("discards a result that lands after HEAD moved", async () => {
        const reply = deferred<CiAnnotations>();
        const h = harness(() => reply.promise);

        const shown = h.diagnostics.show(target(h));
        await settle();
        h.setHead(NEXT_HASH);
        reply.resolve({ annotations: [annotation()], coverage: "full" });
        await shown;

        expect(h.collection.given()).toEqual([]);
        expect(h.diagnostics.viewFor(root, HASH)).toBeUndefined();
    });

    it("sign-out during the annotations fetch publishes nothing", async () => {
        const reply = deferred<CiAnnotations>();
        const h = harness(() => reply.promise);

        const shown = h.diagnostics.show(target(h));
        await settle();
        h.generations.bumpAuth();
        reply.resolve({ annotations: [annotation()], coverage: "full" });
        await shown;

        expect(h.collection.given()).toEqual([]);
        expect(h.diagnostics.viewFor(root, HASH)).toBeUndefined();
    });

    it("disable during the fetch publishes nothing", async () => {
        const reply = deferred<CiAnnotations>();
        const h = harness(() => reply.promise);

        const shown = h.diagnostics.show(target(h));
        await settle();
        // Turning a CI setting off bumps the lifecycle generation (repositoryMode.ts).
        h.generations.bumpLifecycle();
        reply.resolve({ annotations: [annotation()], coverage: "full" });
        await shown;

        expect(h.collection.given()).toEqual([]);
    });

    it("the setting turned off during the fetch publishes nothing", async () => {
        const reply = deferred<CiAnnotations>();
        const h = harness(() => reply.promise);

        const shown = h.diagnostics.show(target(h));
        await settle();
        h.setEnabled(false);
        reply.resolve({ annotations: [annotation()], coverage: "full" });
        await shown;

        expect(h.collection.given()).toEqual([]);
    });

    it("clear() during the fetch publishes nothing and empties the collection", async () => {
        const reply = deferred<CiAnnotations>();
        const h = harness(() => reply.promise);

        const shown = h.diagnostics.show(target(h));
        await settle();
        h.diagnostics.clear();
        reply.resolve({ annotations: [annotation()], coverage: "full" });
        await shown;

        expect(h.collection.given()).toEqual([]);
        expect(h.collection.clear).toHaveBeenCalled();
    });

    it("a settled detail cached before Phase 14 is a miss and annotations are fetched", async () => {
        const key = `github:${root}@${HASH}:-#detail`;
        const now = Date.now();
        // A failed HEAD saved under contract version 8: its jobs carry no annotationCount.
        const values = new Map<string, unknown>([
            [
                "intelligit.commitChecks.detailCache.v1",
                {
                    entries: [
                        {
                            key,
                            contractVersion: 8,
                            data: detailData([job({ annotationCount: undefined })]),
                            fetchedAt: now,
                            lastAccessedAt: now,
                        },
                    ],
                    unconfirmed: {},
                },
            ],
        ]);
        const memento = {
            get: <T>(k: string) => values.get(k) as T | undefined,
            update: async (k: string, value: unknown) => {
                values.set(k, value);
            },
        };
        const service = new CommitCiDetailService({
            persistentCache: new CiDetailPersistentCache(memento),
        });
        const fetchDetail = vi.fn(async () => detailData([job({ annotationCount: 2 })]));
        const served = await service.getOrFetch(key, fetchDetail, {
            repoKey: root,
            capabilities: CAPS,
        });
        const h = harness();

        await h.diagnostics.show(target(h, served));

        expect(fetchDetail).toHaveBeenCalledTimes(1);
        expect(h.annotations).toHaveBeenCalledTimes(1);
        expect(h.collection.entries.get(appFile())).toHaveLength(1);
    });

    it("annotation requests carry per_page=100", async () => {
        const urls: string[] = [];
        const provider = new GitHubProvider(
            undefined,
            undefined,
            fakeAnnotationsApi(urls, [[annotationJson()]]),
        );

        const read = await provider.getAnnotations(REF, "11");

        expect(urls).toHaveLength(1);
        const url = new URL(urls[0]);
        expect(url.pathname).toBe("/repos/microsoft/vscode/check-runs/11/annotations");
        expect(url.searchParams.get("per_page")).toBe("100");
        expect(read).toEqual({
            annotations: [
                {
                    path: "src/app.ts",
                    startLine: 2,
                    endLine: 3,
                    level: "failure",
                    message: "expected true to be false",
                },
            ],
            coverage: "full",
        });
    });

    it("second annotations page fails → nothing published, unavailable shown", async () => {
        const urls: string[] = [];
        const provider = new GitHubProvider(
            undefined,
            undefined,
            fakeAnnotationsApi(urls, [[annotationJson()], new Error("socket hang up")]),
        );
        const h = harness((checkRunId) => provider.getAnnotations(REF, checkRunId));

        await h.diagnostics.show(target(h));

        expect(urls).toHaveLength(2);
        expect(h.collection.given()).toEqual([]);
        expect(h.diagnostics.viewFor(root, HASH)).toEqual({
            items: [],
            rejected: 0,
            coverage: "full",
            unavailable: { reason: "socket hang up" },
        });
    });

    it("a failed read that lands after HEAD moved publishes no unavailable view", async () => {
        let fail!: (error: unknown) => void;
        const reply = new Promise<CiAnnotations>((_, reject) => {
            fail = reject;
        });
        const h = harness(() => reply);

        const shown = h.diagnostics.show(target(h));
        await settle();
        h.setHead(NEXT_HASH);
        fail(new Error("old HEAD request failed"));
        await shown;

        expect(h.diagnostics.viewFor(root, HASH)).toBeUndefined();
    });

    it("a failed read that lands after the Checks tab switch went off publishes nothing", async () => {
        let fail!: (error: unknown) => void;
        const reply = new Promise<CiAnnotations>((_, reject) => {
            fail = reject;
        });
        const h = harness(() => reply);
        let on = true;
        h.setSwitch(() => on);

        const shown = h.diagnostics.show(target(h));
        await settle();
        on = false;
        fail(new Error("request failed"));
        await shown;

        expect(h.diagnostics.viewFor(root, HASH)).toBeUndefined();
    });

    it("rejects absolute, traversal, drive-letter and symlink-escape paths but keeps valid ones", async () => {
        const h = harness(async () => ({
            annotations: [
                annotation({ path: "src/app.ts", startLine: 2, endLine: 2 }),
                annotation({ path: "src\\other.ts", startLine: 1, endLine: 1 }),
                annotation({ path: "/etc/passwd" }),
                annotation({ path: "\\Windows\\win.ini" }),
                annotation({ path: "C:/Windows/win.ini" }),
                annotation({ path: "c:relative.ts" }),
                annotation({ path: "\\\\server\\share\\x.ts" }),
                annotation({ path: "../outside/secret.ts" }),
                // Stays inside the repository once resolved, but names a parent segment.
                annotation({ path: "src/../src/app.ts", startLine: 3, endLine: 3 }),
                annotation({ path: "link.ts", startLine: 1, endLine: 1 }),
                annotation({ path: "missing.ts", startLine: 1, endLine: 1 }),
                annotation({ path: "src", startLine: 1, endLine: 1 }),
                annotation({ path: "" }),
            ],
            coverage: "full",
        }));

        await h.diagnostics.show(target(h));

        expect([...h.collection.entries.keys()].sort()).toEqual(
            [appFile(), path.join(root, "src", "other.ts")].sort(),
        );
        expect(h.collection.entries.get(appFile())?.map((d) => d.range.start.line)).toEqual([1]);
        expect(h.diagnostics.viewFor(root, HASH)?.rejected).toBe(11);
    });

    it("rejects end < start and non-integer lines", async () => {
        const h = harness(async () => ({
            annotations: [
                annotation({ startLine: 4, endLine: 4 }),
                annotation({ startLine: 3, endLine: 2 }),
                annotation({ startLine: 1.5, endLine: 2 }),
                annotation({ startLine: 1, endLine: 2.5 }),
                annotation({ startLine: undefined, endLine: 2 }),
                annotation({ startLine: 0, endLine: 1 }),
                annotation({ startLine: Number.NaN, endLine: 1 }),
                // Past the end of the 10-line file: clamped to its last line, not dropped.
                annotation({ startLine: 50, endLine: 60 }),
            ],
            coverage: "full",
        }));

        await h.diagnostics.show(target(h));

        expect(
            h.collection.entries.get(appFile())?.map((d) => [d.range.start.line, d.range.end.line]),
        ).toEqual([
            [3, 3],
            [9, 9],
        ]);
        expect(h.diagnostics.viewFor(root, HASH)?.rejected).toBe(6);
    });

    it("a check run past the page bound places the first 1 000 and reports the cut", async () => {
        const h = harness(async () => ({
            annotations: [annotation()],
            coverage: { reason: "pageBound", shown: 1000 },
        }));

        await h.diagnostics.show(target(h));

        expect(h.collection.entries.get(appFile())).toHaveLength(1);
        expect(h.diagnostics.viewFor(root, HASH)?.coverage).toEqual({
            reason: "pageBound",
            shown: 1000,
        });
    });

    it("a check run is fully read when its coverage is full", async () => {
        const h = harness();

        await h.diagnostics.show(target(h));

        expect(h.diagnostics.viewFor(root, HASH)?.coverage).toBe("full");
    });

    it("a refused continuation shows as rejectedNext, even beside a page-bound run", async () => {
        const coverages: CiAnnotations["coverage"][] = [
            { reason: "pageBound", shown: 1000 },
            { reason: "rejectedNext", shown: 1 },
        ];
        const h = harness(async (checkRunId) => ({
            annotations: [annotation()],
            coverage: coverages[Number(checkRunId) - 11],
        }));
        const jobs = [job({ checkRunId: "11" }), job({ id: "2", checkRunId: "12" })];

        await h.diagnostics.show(target(h, detail(jobs)));

        expect(h.diagnostics.viewFor(root, HASH)?.coverage).toEqual({
            reason: "rejectedNext",
            shown: 1,
        });
    });

    it("a next link to another host is refused: one request, no token sent there, rejectedNext", async () => {
        const requests: { url: string; headers: Record<string, string> }[] = [];
        const provider = new GitHubProvider(undefined, undefined, async (url, headers) => {
            requests.push({ url, headers });
            return {
                statusCode: 200,
                headers: {
                    link: '<https://evil.example/repos/microsoft/vscode/check-runs/11/annotations?page=2>; rel="next"',
                },
                body: [annotationJson()],
            };
        });
        const h = harness((id) => provider.getAnnotations(REF, id));

        await h.diagnostics.show(target(h));

        expect(requests.map((request) => new URL(request.url).host)).toEqual(["api.github.com"]);
        expect(h.diagnostics.viewFor(root, HASH)?.coverage).toEqual({
            reason: "rejectedNext",
            shown: 1,
        });
        expect(h.diagnostics.viewFor(root, HASH)?.items).toHaveLength(1);
    });

    it("annotation pages stop at ten: eleven pages offered, ten requested, 1 000 placed, pageBound", async () => {
        const urls: string[] = [];
        const provider = new GitHubProvider(undefined, undefined, async (url) => {
            urls.push(url);
            const next = new URL(url);
            next.searchParams.set("page", String(urls.length + 1));
            return {
                statusCode: 200,
                headers: { link: `<${next.toString()}>; rel="next"` },
                body: Array.from({ length: 100 }, annotationJson),
            };
        });
        const h = harness((id) => provider.getAnnotations(REF, id));

        await h.diagnostics.show(target(h));

        expect(urls).toHaveLength(10);
        expect(h.diagnostics.viewFor(root, HASH)?.items).toHaveLength(1000);
        expect(h.diagnostics.viewFor(root, HASH)?.coverage).toEqual({
            reason: "pageBound",
            shown: 1000,
        });
    });

    it("403 leaves Problems empty and reports unavailable", async () => {
        const h = harness(async () => {
            throw new HttpError(403, "HTTP 403", {});
        });

        await h.diagnostics.show(target(h));

        expect(h.collection.given()).toEqual([]);
        expect(h.collection.entries.size).toBe(0);
        expect(h.diagnostics.viewFor(root, HASH)?.unavailable).toEqual({ forbidden: true });
    });

    it("sends no annotations request while the Checks tab switch is off", async () => {
        const h = harness();
        h.setSwitch(() => false);

        // A settled failing HEAD handed straight to the diagnostics, not through HeadCiStatus.
        await h.diagnostics.show(target(h, detail([job({ annotationCount: 3 })])));

        expect(h.annotations).not.toHaveBeenCalled();
        expect(h.collection.given()).toEqual([]);
    });

    it("publishes no Problems entry while the Checks tab switch is off", async () => {
        const h = harness();
        // On when the request is checked, off by the time the result would be published.
        let reads = 0;
        h.setSwitch(() => {
            reads += 1;
            return reads === 1;
        });

        await h.diagnostics.show(target(h));

        expect(h.annotations).toHaveBeenCalledTimes(1);
        expect(h.collection.given()).toEqual([]);
        expect(h.diagnostics.viewFor(root, HASH)).toBeUndefined();
    });

    it("opens a placed annotation at its line, and nothing it did not place", async () => {
        const h = harness();
        await h.diagnostics.show(target(h));

        await h.diagnostics.open(root, HASH, "src/app.ts", 2);
        await h.diagnostics.open(root, HASH, "src/app.ts", 3);
        await h.diagnostics.open(root, HASH, "../outside/secret.ts", 1);
        await h.diagnostics.open(root, NEXT_HASH, "src/app.ts", 2);

        expect(mocks.showTextDocument).toHaveBeenCalledTimes(1);
        const [uri, options] = mocks.showTextDocument.mock.calls[0] as [
            { fsPath: string },
            { selection: FakeDiagnostic["range"] },
        ];
        expect(uri.fsPath).toBe(appFile());
        expect(options.selection.start.line).toBe(1);
    });

    it("a click opens nothing once the placed file became a symlink out of the repository", async () => {
        const h = harness();
        await h.diagnostics.show(target(h));
        await unlink(appFile());
        await symlink(path.join(outside, "secret.ts"), appFile());

        await h.diagnostics.open(root, HASH, "src/app.ts", 2);

        expect(mocks.showTextDocument).not.toHaveBeenCalled();
    });

    it("a click opens nothing once the placed file is gone", async () => {
        const h = harness();
        await h.diagnostics.show(target(h));
        await unlink(appFile());

        await h.diagnostics.open(root, HASH, "src/app.ts", 2);

        expect(mocks.showTextDocument).not.toHaveBeenCalled();
    });

    it("a click opens the file's real path when it is a symlink inside the repository", async () => {
        const h = harness();
        await h.diagnostics.show(target(h));
        await unlink(appFile());
        await symlink(path.join(root, "src", "other.ts"), appFile());

        await h.diagnostics.open(root, HASH, "src/app.ts", 2);

        const [uri] = mocks.showTextDocument.mock.calls[0] as [{ fsPath: string }];
        expect(uri.fsPath).toBe(path.join(root, "src", "other.ts"));
    });
});

const REF = { host: "github.com", owner: "microsoft", repo: "vscode" } as ProviderRepoRef;

function annotationJson(): Record<string, unknown> {
    return {
        path: "src/app.ts",
        start_line: 2,
        end_line: 3,
        start_column: null,
        end_column: null,
        annotation_level: "failure",
        title: "unit-tests",
        message: "expected true to be false",
        raw_details: null,
    };
}

/** GitHub's annotations list, one array per page, each page linking the next; an Error fails it. */
function fakeAnnotationsApi(urls: string[], pages: (unknown[] | Error)[]): FetchJsonWithMeta {
    return async (url: string): Promise<FetchResponse> => {
        urls.push(url);
        const page = Number(new URL(url).searchParams.get("page") ?? "1");
        const body = pages[page - 1];
        if (body instanceof Error) throw body;
        const next = new URL(url);
        next.searchParams.set("page", String(page + 1));
        return {
            statusCode: 200,
            headers: page < pages.length ? { link: `<${next.toString()}>; rel="next"` } : {},
            body,
        };
    };
}

/** Lets awaited fakes and real file reads finish. */
async function settle(): Promise<void> {
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** A HEAD monitor that sees a settled failing HEAD and hands its detail to the diagnostics. */
function monitorDeps(h: Harness, head: () => string): HeadCiStatusDeps {
    // HEAD's first commit failed; any other commit passed.
    const snapshotOf = (hash: string) => {
        const state = hash === HASH ? ("failure" as const) : ("success" as const);
        return {
            hash,
            state,
            summary: state,
            items: [{ name: "unit-tests", description: "", state, source: "check-run" as const }],
        };
    };
    return {
        switchOn: () => true,
        enabled: () => true,
        settings: () => ({ statusBar: false, notifyOnSettle: false, problemsDiagnostics: true }),
        repoKey: () => root,
        headHash: async () => head(),
        isUnpushed: async () => false,
        capabilities: async () => CAPS,
        snapshot: async (hash) => snapshotOf(hash),
        detail: async (hash) => detail([job()], hash),
        invalidateDetail: async () => undefined,
        cooldownUntil: () => 0,
        isFenced: () => false,
        generations: h.generations,
        workspaceState: { get: () => undefined, update: async () => undefined },
        claimDir: path.join(root, "claims"),
        focused: () => true,
        createStatusBarItem: () => {
            throw new Error("the status bar is off");
        },
        showInformationMessage: async () => undefined,
        openChecks: async () => undefined,
        openLog: async () => undefined,
        rerunFailed: async () => undefined,
        diagnostics: h.diagnostics,
    };
}
