// "Changed since last green" (PLAN.md §14, Phase 12): the newest first-parent ancestor inside
// the loaded commits where the selected job passed, matched by the §9 join, read from the
// caches only, and the files changed since, from a real repository.

import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitExecutor } from "../../../../src/git/executor";
import { GitOps } from "../../../../src/git/operations";
import {
    changedSinceGreen,
    rangeDiffSides,
    type ChangedSinceGreenDeps,
    type ChangedSinceGreenRequest,
    type LoadedCommit,
} from "../../../../src/services/commitChecks/changedSinceGreen";
import { CommitChecksCoordinator } from "../../../../src/services/commitChecks/coordinator";
import { CommitChecksService } from "../../../../src/services/commitChecks/service";
import type { CommitChecksProvider } from "../../../../src/services/commitChecks/types";
import { NO_CI_CAPABILITIES } from "../../../../src/shared/ci/capabilities";
import { logicalCheckId } from "../../../../src/shared/ci/identity";
import type {
    CommitCheckItem,
    CommitChecksSnapshot,
    CommitCiDetailData,
} from "../../../../src/types";
import { removeScratchDirectories } from "../../../helpers/scratchDirectories";

vi.mock("vscode", () => ({ l10n: { t: (text: string) => text } }));

let root: string;
let gitOps: GitOps;

function git(...args: string[]): string {
    return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

async function write(file: string, content: string): Promise<void> {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
}

/** Commits the working tree (adds and deletions) and returns the new commit. */
function commit(message: string): string {
    git("add", "-A");
    git("commit", "--allow-empty", "-q", "-m", message);
    return git("rev-parse", "HEAD");
}

/** The repository's commits as the Git Log loaded them, every one with its parents. */
function loadedAll(): LoadedCommit[] {
    return git("log", "--all", "--format=%H %P")
        .split("\n")
        .map((line) => {
            const [hash, ...parents] = line.split(" ").filter(Boolean);
            return { hash, parents };
        });
}

const unitIn = (scope: string): string => logicalCheckId({ kind: "job", scope, name: "unit" });
const CI = unitIn("CI");
const DEPLOY = unitIn("Deploy");

function item(state: CommitCheckItem["state"], logicalId?: string): CommitCheckItem {
    return {
        name: "unit",
        description: "",
        state,
        source: "check-run",
        ...(logicalId === undefined ? {} : { logicalId }),
    };
}

function snapshot(hash: string, items: CommitCheckItem[], partial = false): CommitChecksSnapshot {
    return {
        hash,
        state: items.some((i) => i.state === "failure") ? "failure" : "success",
        summary: "",
        items,
        ...(partial && { partial: true }),
    } as CommitChecksSnapshot;
}

/** The selected commit's detail: one failed `unit` job per workflow. */
function detail(hash: string, scopes: readonly string[] = ["CI"]): CommitCiDetailData {
    return {
        hash,
        provider: "github",
        complete: true,
        outcome: "failure",
        runs: scopes.map((scope, index) => ({
            id: String(index + 1),
            name: scope,
            state: "failure" as const,
            jobsCoverage: "full" as const,
            jobs: [
                {
                    id: String(100 + index),
                    logicalId: unitIn(scope),
                    name: "unit",
                    checkName: "unit",
                    state: "failure" as const,
                    steps: [],
                },
            ],
        })),
        runsCoverage: "full",
        otherChecks: [],
        otherChecksCoverage: "full",
    };
}

/** Cache stand-ins: what a test put there and nothing else, as the coordinator's cache would. */
function deps(
    snapshots: Record<string, CommitCheckItem[]>,
    selected: CommitCiDetailData | undefined,
    partial: readonly string[] = [],
): ChangedSinceGreenDeps & { diffs: [string, string][] } {
    const diffs: [string, string][] = [];
    return {
        diffs,
        cachedChecks: async (hash) =>
            snapshots[hash] && snapshot(hash, snapshots[hash], partial.includes(hash)),
        cachedDetail: async (hash) => (selected?.hash === hash ? selected : undefined),
        diffNameStatus: (from, to) => {
            diffs.push([from, to]);
            return gitOps.diffNameStatus(from, to);
        },
        diffNumstat: (from, to) => gitOps.diffNumstat(from, to),
    };
}

function request(
    hash: string,
    loaded: LoadedCommit[] = loadedAll(),
    logicalCheckId = CI,
): ChangedSinceGreenRequest {
    return { hash, logicalCheckId, scopeName: "CI", checkName: "unit", loaded };
}

beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "intelligit-changed-since-green-"));
    git("init", "-q", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    git("config", "commit.gpgsign", "false");
    gitOps = new GitOps(new GitExecutor(root));
});

afterEach(async () => {
    await removeScratchDirectories(root);
});

describe("changedSinceGreen", () => {
    it("lists diff from last green", async () => {
        await write("a.txt", "a\n");
        const green = commit("green");
        await write("b.txt", "b\n");
        const red = commit("red");
        await write("c.txt", "c\n");
        const selected = commit("selected");
        const cache = deps(
            { [red]: [item("failure", CI)], [green]: [item("success", CI)] },
            detail(selected),
        );

        const answer = await changedSinceGreen(cache, request(selected));

        expect(answer.lastGreen).toBe(green);
        // The frozen §14 contract is CommitFile[]: line counts ride with each file.
        expect(answer.files).toEqual([
            { path: "b.txt", status: "A", additions: 1, deletions: 0 },
            { path: "c.txt", status: "A", additions: 1, deletions: 0 },
        ]);
        expect(cache.diffs).toEqual([[green, selected]]);
    });

    it("no green → null, no files", async () => {
        const first = commit("red one");
        const second = commit("red two");
        const selected = commit("selected");
        const cache = deps(
            { [first]: [item("failure", CI)], [second]: [item("failure", CI)] },
            detail(selected),
        );

        await expect(changedSinceGreen(cache, request(selected))).resolves.toEqual({
            lastGreen: null,
            files: [],
        });
        expect(cache.diffs).toEqual([]);
    });

    it("stops at the first commit outside the loaded set", async () => {
        const green = commit("green, not loaded");
        const red = commit("red");
        const selected = commit("selected");
        const cache = deps(
            { [green]: [item("success", CI)], [red]: [item("failure", CI)] },
            detail(selected),
        );
        const loaded = loadedAll().filter((c) => c.hash !== green);

        await expect(changedSinceGreen(cache, request(selected, loaded))).resolves.toEqual({
            lastGreen: null,
            files: [],
        });
    });

    it("follows first parents only", async () => {
        const base = commit("base, red");
        git("checkout", "-q", "-b", "side");
        await write("side.txt", "side\n");
        const side = commit("side, green");
        git("checkout", "-q", "main");
        await write("main.txt", "main\n");
        const mainRed = commit("main, red");
        git("merge", "-q", "--no-ff", "-m", "merge", "side");
        const merge = git("rev-parse", "HEAD");
        const cache = deps(
            {
                [base]: [item("failure", CI)],
                [side]: [item("success", CI)],
                [mainRed]: [item("failure", CI)],
            },
            detail(merge),
        );

        await expect(changedSinceGreen(cache, request(merge))).resolves.toEqual({
            lastGreen: null,
            files: [],
        });
    });

    it("follows first parents past a merge deeper in the line", async () => {
        const base = commit("base, red");
        git("checkout", "-q", "-b", "side");
        const side = commit("side, green");
        git("checkout", "-q", "main");
        const mainRed = commit("main, red");
        git("merge", "-q", "--no-ff", "-m", "merge", "side");
        const merge = git("rev-parse", "HEAD");
        const selected = commit("selected");
        const cache = deps(
            {
                [merge]: [item("failure", CI)],
                [base]: [item("failure", CI)],
                [side]: [item("success", CI)],
                [mainRed]: [item("failure", CI)],
            },
            detail(selected),
        );

        await expect(changedSinceGreen(cache, request(selected))).resolves.toEqual({
            lastGreen: null,
            files: [],
        });
    });

    it("never hits the network", async () => {
        const green = commit("green, cached");
        const uncached = commit("not cached");
        const selected = commit("selected");
        const getChecks = vi.fn(
            async (_ref: unknown, hash: string): Promise<CommitChecksSnapshot> =>
                snapshot(hash, [item(hash === green ? "success" : "failure", CI)]),
        );
        const getDetail = vi.fn(async (_ref: unknown, hash: string) => detail(hash));
        const provider: CommitChecksProvider = {
            id: "github",
            capabilities: { ...NO_CI_CAPABILITIES, runs: true, jobs: true },
            match: () => ({ host: "github.com", owner: "o", repo: "r" }) as never,
            keyFor: () => "github:o/r",
            getChecks,
            getDetail,
        };
        const coordinator = new CommitChecksCoordinator(
            {
                getRemotes: async () => ["origin"],
                getRemoteUrl: async () => "https://github.com/o/r",
                diffNameStatus: (from: string, to: string) => gitOps.diffNameStatus(from, to),
                diffNumstat: (from: string, to: string) => gitOps.diffNumstat(from, to),
            } as never,
            [provider],
        );
        const ctx = { repoKey: root, authGeneration: 0, lifecycleGeneration: 0 };
        // The Git Log row badges and the Checks tab filled these two entries earlier.
        await coordinator.getChecks(green);
        await coordinator.getDetail(selected, {}, ctx);
        getChecks.mockClear();
        getDetail.mockClear();

        const answer = await coordinator.changedSinceGreen(request(selected), root);

        expect(answer?.lastGreen).toBe(green);
        expect(
            getChecks,
            `${uncached.slice(0, 7)} is not cached and must stay unasked`,
        ).not.toHaveBeenCalled();
        expect(getDetail).not.toHaveBeenCalled();
    });

    it("a cache-only miss cannot fail the badge request for the same commit", async () => {
        const green = commit("green, cached");
        const uncached = commit("not cached");
        const selected = commit("selected");
        const provider: CommitChecksProvider = {
            id: "github",
            capabilities: { ...NO_CI_CAPABILITIES, runs: true, jobs: true },
            match: () => ({ host: "github.com", owner: "o", repo: "r" }) as never,
            keyFor: () => "github:o/r",
            getChecks: async (_ref, hash) => snapshot(hash, [item("success", CI)]),
            getDetail: async (_ref, hash) => detail(hash),
        };
        const service = new CommitChecksService();
        const coordinator = new CommitChecksCoordinator(
            {
                getRemotes: async () => ["origin"],
                getRemoteUrl: async () => "https://github.com/o/r",
                diffNameStatus: (from: string, to: string) => gitOps.diffNameStatus(from, to),
                diffNumstat: (from: string, to: string) => gitOps.diffNumstat(from, to),
            } as never,
            [provider],
            {},
            { service },
        );
        const ctx = { repoKey: root, authGeneration: 0, lifecycleGeneration: 0 };
        await coordinator.getChecks(green);
        await coordinator.getDetail(selected, {}, ctx);
        // A badge request for the uncached commit arrives while the cache-only read is running.
        const read = service.getOrFetch.bind(service);
        let badge: Promise<CommitChecksSnapshot> | undefined;
        vi.spyOn(service, "getOrFetch").mockImplementation((key, fetch, ...rest) => {
            const own = read(key, fetch, ...rest);
            badge ??= read(key, async () => snapshot(uncached, [item("failure", CI)]));
            void badge.catch(() => undefined);
            return own;
        });

        await coordinator.changedSinceGreen(request(selected), root);

        const [settled] = await Promise.allSettled([badge]);
        expect(
            settled.status,
            "a cache miss must not install a rejecting fetch that real badge callers join",
        ).toBe("fulfilled");
    });

    it("cannot prove a name fallback unique in a partly listed current commit", async () => {
        const green = commit("green, an item without an identity");
        const selected = commit("selected");
        const snapshots = { [green]: [item("success")] };
        const whole = detail(selected);
        const partlyListed = { ...whole, runsCoverage: { reason: "pageBound" as const, shown: 1 } };

        // The same walk over a whole commit finds the name unique, so the green is taken.
        await expect(
            changedSinceGreen(deps(snapshots, whole), request(selected)),
        ).resolves.toMatchObject({ lastGreen: green });
        // A hidden workflow may hold another job of that name: the name proves nothing.
        await expect(
            changedSinceGreen(deps(snapshots, partlyListed), request(selected)),
        ).resolves.toEqual({ lastGreen: null, unknownReason: "ambiguous", files: [] });
    });

    it("a partly listed current commit stops at an unprovable red name match", async () => {
        const olderGreen = commit("older green, matched by identity");
        const red = commit("red, an item without an identity");
        const selected = commit("selected");
        const snapshots = { [olderGreen]: [item("success", CI)], [red]: [item("failure")] };
        const whole = detail(selected);
        const partlyListed = { ...whole, runsCoverage: { reason: "pageBound" as const, shown: 1 } };

        // Over a whole commit the red name match is plain history: the walk goes on to the green.
        await expect(
            changedSinceGreen(deps(snapshots, whole), request(selected)),
        ).resolves.toMatchObject({ lastGreen: olderGreen });
        // A hidden workflow may hold another job of that name, so the red may not be this job's
        // run: stepping over it to an older green would name the wrong commit.
        await expect(
            changedSinceGreen(deps(snapshots, partlyListed), request(selected)),
            "an ambiguous ancestor must stop the walk, even when its visible match is red",
        ).resolves.toEqual({ lastGreen: null, unknownReason: "ambiguous", files: [] });
    });

    it("add/delete/rename map to the right sides", async () => {
        const body = Array.from({ length: 20 }, (_, i) => `line ${i}\n`).join("");
        await write("kept.txt", "kept\n");
        await write("gone.txt", "gone\n");
        await write("old/name.txt", body);
        const green = commit("green");
        await write("added.txt", "added\n");
        await rm(path.join(root, "gone.txt"));
        await rm(path.join(root, "old/name.txt"));
        await write("new/name.txt", body);
        const selected = commit("selected");
        const cache = deps({ [green]: [item("success", CI)] }, detail(selected));
        // A user who turned rename detection off still gets the rename: the read asks for it.
        git("config", "diff.renames", "false");

        const answer = await changedSinceGreen(cache, request(selected));
        const byPath = Object.fromEntries(answer.files.map((f) => [f.path, f]));

        expect(answer.files).toHaveLength(3);
        expect(rangeDiffSides(byPath["added.txt"], green, selected)).toEqual({
            left: null,
            right: { path: "added.txt", rev: selected },
        });
        expect(rangeDiffSides(byPath["gone.txt"], green, selected)).toEqual({
            left: { path: "gone.txt", rev: green },
            right: null,
        });
        expect(byPath["new/name.txt"]).toMatchObject({
            status: "R",
            oldPath: "old/name.txt",
            additions: 0,
            deletions: 0,
        });
        expect(byPath["added.txt"]).toMatchObject({ additions: 1, deletions: 0 });
        expect(byPath["gone.txt"]).toMatchObject({ additions: 0, deletions: 1 });
        expect(rangeDiffSides(byPath["new/name.txt"], green, selected)).toEqual({
            left: { path: "old/name.txt", rev: green },
            right: { path: "new/name.txt", rev: selected },
        });
    });

    it("names with space, tab, newline, #, ?, leading -", async () => {
        const green = commit("green");
        const names = [
            "with space.txt",
            "with\ttab.txt",
            "with\nnewline.txt",
            "#hash?.txt",
            "-dash.txt",
        ];
        for (const name of names) {
            // react-doctor-disable-next-line react-doctor/async-await-in-loop
            await write(name, "one line\n");
        }
        const selected = commit("selected");
        const cache = deps({ [green]: [item("success", CI)] }, detail(selected));

        const answer = await changedSinceGreen(cache, request(selected));

        expect(answer.files.map((f) => f.path).sort()).toEqual([...names].sort());
        expect(answer.files.every((f) => f.status === "A")).toBe(true);
        // A tab or newline in a name must not shift the line counts onto the wrong file.
        expect(answer.files.every((f) => f.additions === 1 && f.deletions === 0)).toBe(true);
    });

    it("a binary file and an edited renamed file carry their counts", async () => {
        const body = Array.from({ length: 20 }, (_, i) => `line ${i}\n`).join("");
        await writeFile(path.join(root, "image.bin"), Buffer.from([0, 1, 2, 3]));
        await write("old.txt", body);
        const green = commit("green");
        await writeFile(path.join(root, "image.bin"), Buffer.from([0, 9, 8, 7, 6]));
        await rm(path.join(root, "old.txt"));
        await write("new.txt", `${body}extra\n`);
        const selected = commit("selected");
        const cache = deps({ [green]: [item("success", CI)] }, detail(selected));

        const answer = await changedSinceGreen(cache, request(selected));
        const byPath = Object.fromEntries(answer.files.map((f) => [f.path, f]));

        expect(byPath["image.bin"]).toMatchObject({ status: "M", additions: 0, deletions: 0 });
        expect(byPath["new.txt"]).toMatchObject({
            status: "R",
            oldPath: "old.txt",
            additions: 1,
            deletions: 0,
        });
    });

    it("same job name in two workflows with different last-green commits", async () => {
        await write("one.txt", "1\n");
        const bothGreen = commit("both green");
        await write("two.txt", "2\n");
        const deployGreen = commit("CI red, Deploy green");
        await write("three.txt", "3\n");
        const selected = commit("selected, both red");
        const cache = deps(
            {
                [deployGreen]: [item("failure", CI), item("success", DEPLOY)],
                [bothGreen]: [item("success", CI), item("success", DEPLOY)],
            },
            detail(selected, ["CI", "Deploy"]),
        );

        const ci = await changedSinceGreen(cache, request(selected, loadedAll(), CI));
        const deploy = await changedSinceGreen(cache, {
            ...request(selected, loadedAll(), DEPLOY),
            scopeName: "Deploy",
        });

        expect(ci.lastGreen).toBe(bothGreen);
        expect(ci.files.map((f) => f.path)).toEqual(["three.txt", "two.txt"].sort());
        expect(deploy.lastGreen).toBe(deployGreen);
        expect(deploy.files.map((f) => f.path)).toEqual(["three.txt"]);
    });

    it("same name, no logical ids on ancestors, two current workflows → ambiguous", async () => {
        const older = commit("older, green by name");
        const selected = commit("selected");
        const cache = deps({ [older]: [item("success")] }, detail(selected, ["CI", "Deploy"]));

        await expect(changedSinceGreen(cache, request(selected))).resolves.toEqual({
            lastGreen: null,
            unknownReason: "ambiguous",
            files: [],
        });
    });

    it("a unique name matches an ancestor without logical ids", async () => {
        const older = commit("older, green by name");
        const selected = commit("selected");
        const cache = deps({ [older]: [item("success")] }, detail(selected));

        await expect(changedSinceGreen(cache, request(selected))).resolves.toMatchObject({
            lastGreen: older,
        });
    });

    it("a partial ancestor list cannot prove a name match", async () => {
        const older = commit("older, green by name, read in part");
        const selected = commit("selected");
        const cache = deps({ [older]: [item("success")] }, detail(selected), [older]);

        await expect(changedSinceGreen(cache, request(selected))).resolves.toEqual({
            lastGreen: null,
            files: [],
        });
    });

    it("a git failure rejects", async () => {
        const green = commit("green");
        const selected = commit("selected");
        const cache = deps({ [green]: [item("success", CI)] }, detail(selected));
        cache.diffNameStatus = async () => {
            throw new Error("fatal: bad object");
        };

        await expect(changedSinceGreen(cache, request(selected))).rejects.toThrow("bad object");
    });
});
