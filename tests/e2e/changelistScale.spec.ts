import { runChangelistBenchmark } from "./hostFixtures/changelistBenchmark";
import { parseBenchmarkArguments } from "../fixtures/changes/operationBenchmark";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FrameLocator, Page } from "@playwright/test";
import type { FixtureWorkspace } from "../fixtures/repo/harness";
import { Workbench } from "./pageObjects/workbench";
import { expect, test } from "./fixtureWorkspace";
import { runGitRaw as runGit } from "../fixtures/repo/gitRun";
import {
    dismissFirstRunDialogs,
    launchFixtureWorkspace,
} from "./hostFixtures/electronLaunchHelpers";
import { resolveVSCodeExecutable } from "./hostFixtures/resolveVSCodeExecutable";
import { IntelliGitView } from "./pageObjects/intelliGitView";

const REPO_ROOT = path.resolve(__dirname, "../..");
const FILE_COUNT = 520;
const SPLIT_INDEX = 260;
const TRACE_PREFIX = "[intelligit-e2e] working-file-stats";
const EXPERIMENT_EVIDENCE = path.resolve(
    REPO_ROOT,
    "test-results/task8/changelist-scale-evidence.json",
);

test.describe("large working tree statistics", () => {
    test.use({ scenario: "clean" });

    test("more than 512 held viewport requests all resolve terminal statistics", async ({
        fixtureWorkspace,
    }) => {
        test.setTimeout(180_000);
        const { workspace } = fixtureWorkspace;
        const names = Array.from({ length: FILE_COUNT }, (_, index) =>
            index === SPLIT_INDEX
                ? `stats-${String(index).padStart(4, "0")}-雪-😀.txt`
                : `stats-${String(index).padStart(4, "0")}.txt`,
        );
        await Promise.all(
            names.map((name) => writeFile(path.join(workspace.root, name), "baseline\n")),
        );
        await runGit(workspace.root, ["add", "--", ...names], workspace.env);
        await runGit(workspace.root, ["commit", "-m", "large status baseline"], workspace.env);
        await Promise.all(
            names.map((name, index) =>
                writeFile(path.join(workspace.root, name), `baseline\nchange ${index}\n`),
            ),
        );
        const splitPath = path.join(workspace.root, names[SPLIT_INDEX]!);
        await runGit(workspace.root, ["add", "--", names[SPLIT_INDEX]!], workspace.env);
        await writeFile(splitPath, `baseline\nchange ${SPLIT_INDEX}\nworktree change\n`);

        const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
        const wrapperDir = path.join(path.dirname(workspace.profileDir), "held-git");
        const wrapper = path.join(wrapperDir, "git");
        const requestLog = path.join(wrapperDir, "numstat-argv.log");
        const startedLog = path.join(wrapperDir, "numstat-started.log");
        const releaseFile = path.join(wrapperDir, "release");
        const heldProcessesDir = path.join(wrapperDir, "held-processes");
        const statusGate = path.join(wrapperDir, "status-gate");
        const statusRelease = path.join(wrapperDir, "status-release");
        const heldStatusDir = path.join(wrapperDir, "held-status");
        await mkdir(heldProcessesDir, { recursive: true });
        await mkdir(heldStatusDir, { recursive: true });
        await writeFile(
            wrapper,
            `#!/bin/sh
numstat=0
working_stats=0
status=0
for argument in "$@"; do
    if [ "$argument" = "status" ]; then status=1; fi
    if [ "$argument" = "--numstat" ]; then numstat=1; fi
    case "$argument" in stats-*.txt) working_stats=1 ;; esac
done
if [ "$status" = "1" ] && [ -f "${statusGate.replaceAll('"', '\\"')}" ] && [ ! -f "${statusRelease.replaceAll('"', '\\"')}" ]; then
    status_marker="${heldStatusDir.replaceAll('"', '\\"')}/$$"
    trap 'rm -f "$status_marker"' EXIT
    trap 'exit 143' TERM
    trap 'exit 130' INT
    printf '%s\\n' "$$" > "$status_marker"
    while [ ! -f "${statusRelease.replaceAll('"', '\\"')}" ]; do /bin/sleep 0.02; done
    rm -f "$status_marker"
    trap - EXIT TERM INT
fi
if [ "$numstat" = "1" ] && [ "$working_stats" = "1" ]; then
    # Initial status has reached the real viewport reader; hold later refreshes for this experiment.
    touch "${statusGate.replaceAll('"', '\\"')}"
    active_marker="${heldProcessesDir.replaceAll('"', '\\"')}/$$"
    trap 'rm -f "$active_marker"' EXIT
    trap 'exit 143' TERM
    trap 'exit 130' INT
    printf '%s\\n' "$$" > "$active_marker"
    for argument in "$@"; do printf '%s\\n' "$argument" >> "${requestLog.replaceAll('"', '\\"')}"; done
    printf '%s\\n' -- "---" >> "${requestLog.replaceAll('"', '\\"')}"
    printf '%s\\n' started >> "${startedLog.replaceAll('"', '\\"')}"
    while [ ! -f "${releaseFile.replaceAll('"', '\\"')}" ]; do /bin/sleep 0.02; done
    rm -f "$active_marker"
    trap - EXIT TERM INT
fi
exec "${realGit.replaceAll('"', '\\"')}" "$@"
`,
        );
        await chmod(wrapper, 0o755);
        workspace.env.PATH = `${wrapperDir}:${workspace.env.PATH ?? ""}`;
        workspace.env.INTELLIGIT_E2E_TRACE_WORKING_FILE_STATS = "1";

        const app = await launchFixtureWorkspace({
            executablePath: await resolveVSCodeExecutable(REPO_ROOT),
            repoRoot: REPO_ROOT,
            workspace,
            channelDir: fixtureWorkspace.channelDir,
            timeout: 60_000,
        });
        let released = false;
        let requestedUnique = 0;
        let terminalUnique = 0;
        let readyUnique = 0;
        let unavailableUnique = 0;
        let sweepRevision: number | undefined;
        let latestRevision: number | undefined;
        let activeTraceRevision: number | undefined;
        let selectedCompletion:
            | {
                  atMs: number;
                  revision: number;
                  latestRevision: number | undefined;
                  readyUnique: number;
                  terminalUnique: number;
                  unavailableUnique: number;
              }
            | undefined;
        const requestedHashes = new Set<string>();
        const tracedRevisions = new Set<number>();
        const trace: Array<{ atMs: number; line: string }> = [];
        const geometry: unknown[] = [];
        const evidence: Record<string, unknown> = {};
        const startedAt = Date.now();
        try {
            const page = await app.firstWindow();
            page.on("console", (message) => {
                const raw = message.text();
                const traceOffset = raw.indexOf(TRACE_PREFIX);
                if (traceOffset < 0) return;
                const fields =
                    /^ [a-z-]+#\d+\.\d+ (?:in requestWorkingFileStats revision=\d+ unique=\d+ hashes=[a-f0-9,]+|out workingFileStats revision=\d+ terminal=\d+ ready=\d+ unavailable=\d+)/.exec(
                        raw.slice(traceOffset + TRACE_PREFIX.length),
                    )?.[0];
                if (!fields) return;
                const line = TRACE_PREFIX + fields;
                const atMs = Date.now() - startedAt;
                trace.push({ atMs, line });
                const revision = /revision=(\d+)/.exec(line)?.[1];
                const requested = /requestWorkingFileStats revision=\d+ unique=(\d+)/.exec(
                    line,
                )?.[1];
                const terminal = /workingFileStats revision=\d+ terminal=(\d+)/.exec(line)?.[1];
                if (revision) {
                    const ordinal = Number(revision);
                    tracedRevisions.add(ordinal);
                    if (requested) latestRevision = ordinal;
                    if (sweepRevision !== undefined && ordinal !== sweepRevision) return;
                    if (sweepRevision === undefined && requested) {
                        // Startup can replace its initial status before the pane is ready.
                        // Retain only the latest revision's acknowledgments for the upcoming sweep.
                        if (ordinal !== activeTraceRevision) {
                            requestedHashes.clear();
                            requestedUnique = terminalUnique = readyUnique = unavailableUnique = 0;
                            activeTraceRevision = ordinal;
                        }
                    }
                }
                if (requested) requestedUnique = Math.max(requestedUnique, Number(requested));
                if (terminal) terminalUnique = Math.max(terminalUnique, Number(terminal));
                readyUnique = Math.max(readyUnique, Number(/ ready=(\d+)/.exec(line)?.[1] ?? 0));
                unavailableUnique = Math.max(
                    unavailableUnique,
                    Number(/ unavailable=(\d+)/.exec(line)?.[1] ?? 0),
                );
                for (const hash of / hashes=([a-f0-9,]+)/.exec(line)?.[1]?.split(",") ?? [])
                    requestedHashes.add(hash);
                if (
                    terminal &&
                    sweepRevision !== undefined &&
                    !selectedCompletion &&
                    readyUnique === FILE_COUNT &&
                    terminalUnique === FILE_COUNT
                ) {
                    // A refresh after completion must not change what was true at this event.
                    selectedCompletion = {
                        atMs,
                        revision: Number(revision),
                        latestRevision,
                        readyUnique,
                        terminalUnique,
                        unavailableUnique,
                    };
                    evidence.selectedCompletion = selectedCompletion;
                    evidence.terminalAtMs = atMs;
                }
            });
            await dismissFirstRunDialogs(page);
            const frame = await new IntelliGitView(page).reveal();
            const tree = frame.getByTestId("virtual-commit-tree");
            await expect(tree).toBeVisible();
            await expandLifecyclePane(page, frame);

            await expect.poll(() => latestRevision, { timeout: 5_000 }).toBeDefined();
            sweepRevision = latestRevision;
            evidence.sweepRevision = sweepRevision;
            const sampleRows = new Map<string, { path: string; offset: number }>();
            let nextOffset = 0;
            for (;;) {
                const viewport = await tree.evaluate(async (element, offset) => {
                    let parent = element.parentElement;
                    while (parent && !/auto|scroll/.test(getComputedStyle(parent).overflowY))
                        parent = parent.parentElement;
                    if (!parent) throw new Error("Commit tree scroll parent is unavailable.");
                    parent.scrollTop = offset;
                    parent.dispatchEvent(new Event("scroll"));
                    // Two rendering frames let the virtualizer mount the new window before measuring it.
                    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
                    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
                    let top = 0;
                    let bottom = window.innerHeight;
                    let left = 0;
                    let right = window.innerWidth;
                    for (
                        let ancestor: HTMLElement | null = parent;
                        ancestor;
                        ancestor = ancestor.parentElement
                    ) {
                        const style = getComputedStyle(ancestor);
                        const rect = ancestor.getBoundingClientRect();
                        if (/auto|scroll|hidden|clip/.test(style.overflowY)) {
                            top = Math.max(top, rect.top);
                            bottom = Math.min(bottom, rect.bottom);
                        }
                        if (/auto|scroll|hidden|clip/.test(style.overflowX)) {
                            left = Math.max(left, rect.left);
                            right = Math.min(right, rect.right);
                        }
                    }
                    const parentTop = parent.getBoundingClientRect().top;
                    const rows = [
                        ...parent.querySelectorAll<HTMLElement>('[title^="stats-"]'),
                    ].flatMap((row) => {
                        const rect = row.getBoundingClientRect();
                        return rect.bottom > top &&
                            rect.top < bottom &&
                            rect.right > left &&
                            rect.left < right
                            ? [
                                  {
                                      path: row.title,
                                      offset: rect.top - parentTop + parent.scrollTop,
                                      height: rect.height,
                                  },
                              ]
                            : [];
                    });
                    const rowHeight = rows[0]?.height ?? 0;
                    return {
                        scrollTop: parent.scrollTop,
                        maxScroll: parent.scrollHeight - parent.clientHeight,
                        clientHeight: parent.clientHeight,
                        top,
                        bottom,
                        left,
                        right,
                        rowHeight,
                        rows,
                    };
                }, nextOffset);
                const hashes = viewport.rows.map((row) =>
                    createHash("sha256").update(row.path).digest("hex"),
                );
                geometry.push({
                    ...viewport,
                    rows: viewport.rows.map((row, index) => ({ ...row, path: hashes[index] })),
                });
                expect(
                    viewport.rowHeight,
                    "a visible file row must have a measured height before the fit check",
                ).toBeGreaterThan(0);
                expect(
                    viewport.bottom - viewport.top,
                    "real clipped viewport must fit several rows",
                ).toBeGreaterThan(4 * viewport.rowHeight);
                expect(
                    viewport.rows.length,
                    "scroll step must expose real file rows",
                ).toBeGreaterThan(0);
                for (const row of viewport.rows) {
                    if ([names[0], names[SPLIT_INDEX], names.at(-1)].includes(row.path))
                        sampleRows.set(`${row.path}:${row.offset}`, {
                            path: row.path,
                            offset: row.offset,
                        });
                }
                await expect
                    .poll(() => hashes.filter((hash) => !requestedHashes.has(hash)), {
                        timeout: 1_500,
                        intervals: [10],
                        message: "every intersecting row reaches incoming IPC before the next step",
                    })
                    .toEqual([]);
                expect(
                    latestRevision,
                    "the selected status snapshot must not change during the sweep",
                ).toBe(sweepRevision);
                if (viewport.scrollTop >= viewport.maxScroll) break;
                nextOffset = Math.min(
                    viewport.maxScroll,
                    viewport.scrollTop + viewport.bottom - viewport.top - 2 * viewport.rowHeight,
                );
            }
            const expectedHashes = names.map((name) =>
                createHash("sha256").update(name).digest("hex"),
            );
            expect(
                [...requestedHashes].sort(),
                "all 520 known paths reached the actual host boundary",
            ).toEqual(expectedHashes.sort());
            expect(requestedUnique).toBe(FILE_COUNT);
            const heldAtMs = Date.now() - startedAt;
            const startsBeforeRelease = (await readFile(startedLog, "utf8"))
                .split("\n")
                .filter(Boolean).length;
            evidence.startsBeforeRelease = startsBeforeRelease;
            const heldProcessProbes: Array<{ pids: number[]; alive: boolean[] }> = [];
            evidence.heldProcessProbes = heldProcessProbes;
            await expect
                .poll(
                    async () => {
                        const pids = (await readdir(heldProcessesDir))
                            .map(Number)
                            .sort((a, b) => a - b);
                        const alive = pids.map((pid) => {
                            try {
                                process.kill(pid, 0);
                                return true;
                            } catch (error) {
                                if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
                                throw error;
                            }
                        });
                        heldProcessProbes.push({ pids, alive });
                        return alive;
                    },
                    {
                        timeout: 1_500,
                        intervals: [10],
                        message:
                            "exactly two live Git processes for the current snapshot remain held",
                    },
                )
                .toEqual([true, true]);
            // Exercise the status gate through the real control while both numstat readers wait.
            await frame.getByTestId("commit-tab").getByTestId("refresh-button").click();
            await expect
                .poll(
                    async () => {
                        const pids = await heldLifecyclePids(heldStatusDir);
                        evidence.statusHeldBeforeNumstatRelease = pids;
                        return pids.length;
                    },
                    {
                        timeout: 1_500,
                        intervals: [10],
                        message:
                            "real Commit Refresh reaches a live held status process before numstat release",
                    },
                )
                .toBeGreaterThan(0);
            expect(
                latestRevision,
                "all 520 requests must belong to the selected status snapshot",
            ).toBe(sweepRevision);
            expect(terminalUnique, "no path may become terminal before release").toBe(0);
            await expect(readFile(releaseFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

            await writeFile(releaseFile, "release\n");
            released = true;
            const releasedAtMs = Date.now() - startedAt;
            await expect.poll(() => selectedCompletion, { timeout: 15_000 }).toBeDefined();
            expect(
                selectedCompletion,
                "the selected revision must complete before any replacement",
            ).toMatchObject({
                revision: sweepRevision,
                latestRevision: sweepRevision,
                readyUnique: FILE_COUNT,
                terminalUnique: FILE_COUNT,
                unavailableUnique: 0,
            });

            // Polling may request another status while the selected revision drains. Keep real
            // status execution behind the gate, then prove every observed held process settles.
            const heldStatusPids = (await readdir(heldStatusDir)).map(Number).sort((a, b) => a - b);
            evidence.heldStatusPids = heldStatusPids;
            expect(liveLifecyclePids(heldStatusPids)).toEqual(heldStatusPids);
            evidence.statusReleasedAfterCompletion = true;
            await writeFile(statusRelease, "release\n");
            await expect
                .poll(() => liveLifecyclePids(heldStatusPids), {
                    message: "status processes held for the selected revision settle after release",
                })
                .toEqual([]);
            await expect.poll(async () => readdir(heldStatusDir)).toEqual([]);
            evidence.heldStatusProcessesSettled = true;

            for (const name of [names[0], names.at(-1)])
                expect(
                    [...sampleRows.values()].filter((row) => row.path === name),
                    "first and last rows must both be sampled",
                ).toHaveLength(1);
            expect(
                [...sampleRows.values()].filter((row) => row.path === names[SPLIT_INDEX]),
            ).toHaveLength(2);
            for (const checkpoint of sampleRows.values()) {
                await tree.evaluate((element, offset) => {
                    let parent = element.parentElement;
                    while (parent && !/auto|scroll/.test(getComputedStyle(parent).overflowY))
                        parent = parent.parentElement;
                    if (!parent) throw new Error("Commit tree scroll parent is unavailable.");
                    parent.scrollTop = Math.max(0, offset - parent.clientHeight / 2);
                    parent.dispatchEvent(new Event("scroll"));
                }, checkpoint.offset);
                await expect
                    .poll(
                        async () =>
                            frame.getByTitle(checkpoint.path, { exact: true }).evaluateAll((rows) =>
                                rows.some((row) => {
                                    let parent = row.parentElement;
                                    while (
                                        parent &&
                                        !/auto|scroll/.test(getComputedStyle(parent).overflowY)
                                    )
                                        parent = parent.parentElement;
                                    if (!parent) return false;
                                    const rect = row.getBoundingClientRect();
                                    const clip = parent.getBoundingClientRect();
                                    return (
                                        rect.bottom > clip.top &&
                                        rect.top < clip.bottom &&
                                        row.textContent?.includes("+1")
                                    );
                                }),
                            ),
                        { timeout: 5_000 },
                    )
                    .toBe(true);
            }

            const gitArgv = await readFile(requestLog, "utf8");
            for (const checkpoint of sampleRows.values())
                expect(gitArgv).toContain(checkpoint.path);
            const totalGitBatches = gitArgv.split("\n").filter((line) => line === "---").length;
            Object.assign(evidence, {
                startsBeforeRelease,
                totalGitBatches,
                heldAtMs,
                releasedAtMs,
                sampleRowCount: sampleRows.size,
                completedBeforeRelease: 0,
            });
        } finally {
            try {
                await mkdir(path.dirname(EXPERIMENT_EVIDENCE), { recursive: true });
                await writeFile(
                    EXPERIMENT_EVIDENCE,
                    JSON.stringify(
                        {
                            ...evidence,
                            released,
                            requestedUnique,
                            terminalUnique,
                            readyUnique,
                            unavailableUnique,
                            tracedRevisions: [...tracedRevisions],
                            geometry,
                            trace,
                        },
                        null,
                        2,
                    ),
                );
            } finally {
                try {
                    if (!released) await writeFile(releaseFile, "release\n");
                } finally {
                    try {
                        await writeFile(statusRelease, "release\n");
                    } finally {
                        await app.close();
                    }
                }
            }
        }
    });
});

/** Creates actual lazy status rows and holds captured Git output until an explicit release. */
async function prepareLifecycleStats(workspace: FixtureWorkspace) {
    const names = Array.from(
        { length: 240 },
        (_, index) => `lifecycle-${String(index).padStart(4, "0")}.txt`,
    );
    await Promise.all(
        names.map((name) => writeFile(path.join(workspace.root, name), "baseline\n")),
    );
    await runGit(workspace.root, ["add", "--", ...names], workspace.env);
    await runGit(workspace.root, ["commit", "-m", "lazy lifecycle baseline"], workspace.env);
    await Promise.all(
        names.map((name) => writeFile(path.join(workspace.root, name), "baseline\none\n")),
    );
    const directory = path.join(path.dirname(workspace.profileDir), "lifecycle-git");
    const held = path.join(directory, "held");
    const release = path.join(directory, "release");
    const fail = path.join(directory, "fail-first");
    const failures = path.join(directory, "failures");
    const calls = path.join(directory, "calls");
    await mkdir(held, { recursive: true });
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const wrapper = path.join(directory, "git");
    await writeFile(
        wrapper,
        `#!/bin/sh
numstat=0
fixture=0
first=0
for argument in "$@"; do
    if [ "$argument" = "--numstat" ]; then numstat=1; fi
    case "$argument" in lifecycle-*.txt) fixture=1 ;; esac
    if [ "$argument" = "${names[0]}" ]; then first=1; fi
done
if [ "$numstat" = "1" ] && [ "$fixture" = "1" ]; then
    marker="${held}/$$"
    output="${directory}/output-$$"
    errors="${directory}/errors-$$"
    trap 'rm -f "$marker" "$output" "$errors"' EXIT
    trap 'exit 143' TERM
    trap 'exit 130' INT
    printf '%s\n' "$*" >> "${calls}"
    "${realGit}" "$@" > "$output" 2> "$errors"
    result=$?
    printf '%s\n' "$$" > "$marker"
    while [ ! -f "${release}" ]; do /bin/sleep 0.02; done
    if [ "$first" = "1" ] && [ -f "${fail}" ]; then
        printf '%s\n' 73 >> "${failures}"
        printf '%s\n' 'Injected numstat subprocess failure' >&2
        exit 73
    fi
    cat "$output"
    cat "$errors" >&2
    exit "$result"
fi
exec "${realGit}" "$@"
`,
    );
    await chmod(wrapper, 0o755);
    workspace.env.PATH = `${directory}:${workspace.env.PATH ?? ""}`;
    workspace.env.INTELLIGIT_E2E_TRACE_WORKING_FILE_STATS = "1";
    return { names, held, release, fail, failures, calls };
}

/** Lists the fixture files each held numstat call read, in call order. */
async function lifecycleCalls(file: string, names: readonly string[]): Promise<string[][]> {
    return (await readFile(file, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split(" ").filter((argument) => names.includes(argument)));
}

/** Records every text the named row shows from now on, so a briefly shown count is not missed. */
async function watchLifecycleRow(frame: FrameLocator, name: string) {
    await frame.getByTestId("virtual-commit-tree").evaluate((tree, title) => {
        const seen: string[] = [];
        Object.assign(window, { lifecycleSeen: seen });
        const record = () => {
            const text = tree.querySelector(`[title="${title}"]`)?.textContent;
            if (text) seen.push(text);
        };
        new MutationObserver(record).observe(tree, {
            subtree: true,
            childList: true,
            characterData: true,
        });
        record();
    }, name);
    return () =>
        frame
            .getByTestId("virtual-commit-tree")
            .evaluate(() => (window as unknown as { lifecycleSeen: string[] }).lifecycleSeen);
}

/** Reads only the existing opted-in host trace; keys separate wrappers and status revisions. */
function collectLifecycleStats(page: Page) {
    const events: Array<{
        atMs: number;
        key: string;
        direction: string;
        line: string;
        terminal: number;
        ready: number;
        unavailable: number;
    }> = [];
    const started = Date.now();
    page.on("console", (message) => {
        const match =
            /\[intelligit-e2e\] working-file-stats ([a-z-]+#\d+)\.\d+ (in requestWorkingFileStats revision=(\d+) unique=\d+ hashes=[a-f0-9,]+|out workingFileStats revision=(\d+) terminal=(\d+) ready=(\d+) unavailable=(\d+))/.exec(
                message.text(),
            );
        if (!match) return;
        events.push({
            atMs: Date.now() - started,
            key: `${match[1]}:${match[3] ?? match[4]}`,
            direction: match[3] ? "in" : "out",
            line: match[0],
            terminal: Number(match[5] ?? 0),
            ready: Number(match[6] ?? 0),
            unavailable: Number(match[7] ?? 0),
        });
    });
    return {
        events,
        latest: (context: string) =>
            events.findLast(
                (event) => event.direction === "in" && event.key.startsWith(`${context}#`),
            )?.key,
        replies: (key: string) =>
            events.filter((event) => event.direction === "out" && event.key === key),
    };
}

/** Checks process existence independently of marker cleanup; unexpected OS errors remain failures. */
function liveLifecyclePids(pids: readonly number[]): number[] {
    return pids.filter((pid) => {
        try {
            process.kill(pid, 0);
            return true;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
            throw error;
        }
    });
}

/** Snapshots only wrappers that reached the hold point and still exist in the OS. */
async function heldLifecyclePids(directory: string): Promise<number[]> {
    return liveLifecyclePids((await readdir(directory)).map(Number)).sort((a, b) => a - b);
}

/** Gives the real docked Commit viewport space through native view controls. */
async function expandLifecyclePane(page: Page, frame: FrameLocator) {
    const graph = page
        .locator(".pane-header")
        .filter({ has: page.getByText("Graph", { exact: true }) });
    // The header's centre is its first toolbar action, so toggle through the title text instead.
    if ((await graph.getAttribute("aria-expanded")) === "true")
        await graph.getByText("Graph", { exact: true }).click();
    await expect(
        graph,
        "Graph pane must collapse so the Commit pane gets the sidebar height",
    ).toHaveAttribute("aria-expanded", "false");
    for (let index = 0; index < 8; index++)
        await frame.getByRole("separator", { exact: true }).press("ArrowDown");
}

/** Scrolls the actual overflow viewport to an edge so virtualization must render the sampled row. */
async function showLifecycleEdge(frame: FrameLocator, edge: "first" | "last", name: string) {
    await frame.getByTestId("virtual-commit-tree").evaluate((element, target) => {
        let parent = element.parentElement;
        while (parent && !/auto|scroll/.test(getComputedStyle(parent).overflowY))
            parent = parent.parentElement;
        if (!parent) throw new Error("Commit tree scroll parent is unavailable.");
        parent.scrollTop = target === "first" ? 0 : parent.scrollHeight - parent.clientHeight;
        parent.dispatchEvent(new Event("scroll"));
    }, edge);
    const row = frame.getByTitle(name, { exact: true });
    await expect(row).toBeVisible();
    return row;
}

test.describe("lazy statistics lifecycle", () => {
    test.use({ scenario: "clean" });

    test("reset and sidebar close-reopen discard held old revision results", async ({
        fixtureWorkspace,
    }, testInfo) => {
        const { workspace } = fixtureWorkspace;
        const fixture = await prepareLifecycleStats(workspace);
        const app = await launchFixtureWorkspace({
            executablePath: await resolveVSCodeExecutable(REPO_ROOT),
            repoRoot: REPO_ROOT,
            workspace,
            channelDir: fixtureWorkspace.channelDir,
            timeout: 60_000,
        });
        const page = await app.firstWindow();
        const trace = collectLifecycleStats(page);
        const evidence: Record<string, unknown> = {};
        try {
            await dismissFirstRunDialogs(page);
            const view = new IntelliGitView(page);
            let frame = await view.reveal();
            await expandLifecyclePane(page, frame);
            const first = fixture.names[0]!;
            await expect(
                (await showLifecycleEdge(frame, "first", first)).getByRole("status"),
            ).toHaveText("...");
            await expect.poll(() => trace.latest("commit-panel")).toBeDefined();
            let oldHeldPids: number[] = [];
            await expect
                .poll(async () => {
                    oldHeldPids = await heldLifecyclePids(fixture.held);
                    return oldHeldPids.length;
                })
                .toBe(2);
            const oldKey = trace.latest("commit-panel")!;
            evidence.oldKey = oldKey;
            evidence.oldHeldPids = oldHeldPids;
            const initiallyRead = new Set(
                (await lifecycleCalls(fixture.calls, fixture.names)).flat(),
            );
            evidence.initiallyRead = [...initiallyRead];
            await writeFile(path.join(workspace.root, first), "baseline\none\ntwo\nthree\n");
            await frame.getByTestId("commit-tab").getByTestId("refresh-button").click();
            await expect.poll(() => trace.latest("commit-panel")).not.toBe(oldKey);
            await page.getByRole("button", { name: /^Toggle Primary Side Bar/ }).click();
            frame = await view.reveal();
            await expect(
                (await showLifecycleEdge(frame, "first", first)).getByRole("status"),
            ).toHaveText("...");
            const currentKey = trace.latest("commit-panel")!;
            evidence.currentKeyBeforeRelease = currentKey;
            // The old read is allowed to finish: its unchanged counts are reused, not thrown away.
            const seenTexts = await watchLifecycleRow(frame, first);
            evidence.currentRepliesBeforeRelease = trace.replies(currentKey);
            expect(trace.replies(currentKey)).toEqual([]);
            const callsBeforeRelease = (await lifecycleCalls(fixture.calls, fixture.names)).length;
            await writeFile(fixture.release, "release\n");
            await expect(frame.getByTitle(first, { exact: true })).toContainText("+3");
            const seen = await seenTexts();
            evidence.firstRowTexts = seen;
            expect(seen.some((text) => text.includes("+3"))).toBe(true);
            expect(
                seen.filter((text) => text.includes("+1")),
                "the edited file never shows its old count",
            ).toEqual([]);
            await expect(
                await showLifecycleEdge(frame, "last", fixture.names.at(-1)!),
            ).toContainText("+1");
            expect(
                trace.replies(oldKey),
                "no observed terminal message is tagged with the retired status revision",
            ).toEqual([]);
            expect(trace.events.filter((event) => event.unavailable > 0)).toEqual([]);
            const reread = [
                ...new Set(
                    (await lifecycleCalls(fixture.calls, fixture.names))
                        .slice(callsBeforeRelease)
                        .flat()
                        .filter((name) => initiallyRead.has(name)),
                ),
            ];
            evidence.rereadAfterRelease = reread;
            expect(
                reread,
                "only the edited file is read again; unchanged counts are reused",
            ).toEqual([first]);
            evidence.firstCount = 3;
            evidence.lastCount = 1;
        } finally {
            try {
                await writeFile(
                    testInfo.outputPath("lifecycle-evidence.json"),
                    JSON.stringify({ ...evidence, events: trace.events }, null, 2),
                );
            } finally {
                try {
                    await writeFile(fixture.release, "release\n");
                } finally {
                    await app.close();
                }
            }
        }
    });

    test("failed numstat batch becomes unavailable while later visible files become ready", async ({
        fixtureWorkspace,
    }, testInfo) => {
        const { workspace } = fixtureWorkspace;
        const fixture = await prepareLifecycleStats(workspace);
        await writeFile(fixture.fail, "fail\n");
        const app = await launchFixtureWorkspace({
            executablePath: await resolveVSCodeExecutable(REPO_ROOT),
            repoRoot: REPO_ROOT,
            workspace,
            channelDir: fixtureWorkspace.channelDir,
            timeout: 60_000,
        });
        const page = await app.firstWindow();
        const trace = collectLifecycleStats(page);
        const evidence: Record<string, unknown> = {};
        try {
            await dismissFirstRunDialogs(page);
            const frame = await new IntelliGitView(page).reveal();
            await expandLifecyclePane(page, frame);
            const first = await showLifecycleEdge(frame, "first", fixture.names[0]!);
            await expect(first.getByRole("status")).toHaveText("...");
            await expect.poll(async () => (await readdir(fixture.held)).length).toBe(2);
            await writeFile(fixture.release, "release\n");
            await expect(
                first.getByRole("status"),
                "actual failed child process must render unavailable",
            ).toHaveText("-");
            const failedKey = trace.latest("commit-panel")!;
            await expect
                .poll(() => trace.replies(failedKey).some((event) => event.unavailable > 0))
                .toBe(true);
            await expect(
                await showLifecycleEdge(frame, "last", fixture.names.at(-1)!),
            ).toContainText("+1");
            expect(
                trace.replies(failedKey).some((event) => event.ready > 0),
                "the same revision must continue draining after a failed batch",
            ).toBe(true);
            evidence.failedKey = failedKey;
            evidence.injectedExitCodes = (await readFile(fixture.failures, "utf8"))
                .trim()
                .split("\n")
                .map(Number);
            expect(evidence.injectedExitCodes).toEqual(expect.arrayContaining([73]));
        } finally {
            try {
                await writeFile(
                    testInfo.outputPath("lifecycle-evidence.json"),
                    JSON.stringify({ ...evidence, events: trace.events }, null, 2),
                );
            } finally {
                try {
                    await writeFile(fixture.release, "release\n");
                } finally {
                    await app.close();
                }
            }
        }
    });

    test("repository switch discards held old repository results", async ({
        fixtureWorkspace,
    }, testInfo) => {
        const { workspace } = fixtureWorkspace;
        const fixture = await prepareLifecycleStats(workspace);
        const selectedRoot = path.join(workspace.root, "selected-repo");
        const exclude = path.join(workspace.root, ".git/info/exclude");
        await writeFile(exclude, `${await readFile(exclude, "utf8")}\nselected-repo/\n`);
        await runGit(
            workspace.root,
            ["clone", "--no-hardlinks", "--", workspace.root, selectedRoot],
            workspace.env,
        );
        const marker = "aaa-selected-only.txt";
        await writeFile(path.join(selectedRoot, marker), "baseline\n");
        await runGit(selectedRoot, ["add", "--", marker], workspace.env);
        await runGit(selectedRoot, ["commit", "-m", "selected repository marker"], workspace.env);
        await Promise.all(
            [...fixture.names, marker].map((name) =>
                writeFile(path.join(selectedRoot, name), "baseline\none\ntwo\nthree\nfour\n"),
            ),
        );
        const app = await launchFixtureWorkspace({
            executablePath: await resolveVSCodeExecutable(REPO_ROOT),
            repoRoot: REPO_ROOT,
            workspace,
            channelDir: fixtureWorkspace.channelDir,
            timeout: 60_000,
        });
        const page = await app.firstWindow();
        const trace = collectLifecycleStats(page);
        const evidence: Record<string, unknown> = {};
        try {
            await dismissFirstRunDialogs(page);
            const view = new IntelliGitView(page);
            const frame = await view.reveal();
            await expandLifecyclePane(page, frame);
            const first = fixture.names[0]!;
            await expect(
                (await showLifecycleEdge(frame, "first", first)).getByRole("status"),
            ).toHaveText("...");
            await expect(
                frame.getByTitle(marker, { exact: true }),
                "the panel starts on the nested clone, which sorts first by label",
            ).toBeVisible();
            await expect.poll(() => trace.latest("commit-panel")).toBeDefined();
            let oldHeldPids: number[] = [];
            await expect
                .poll(async () => {
                    oldHeldPids = await heldLifecyclePids(fixture.held);
                    return oldHeldPids.length;
                })
                .toBe(2);
            const oldKey = trace.latest("commit-panel")!;
            evidence.oldKey = oldKey;
            evidence.oldHeldPids = oldHeldPids;
            const rootLabel = path.basename(workspace.root);
            const workbench = new Workbench(page);
            await workbench.runCommand("IntelliGit: Select Repository");
            await page.locator(".quick-input-widget").getByText(rootLabel, { exact: true }).click();
            // Each repository keeps its own accordion section, so the switch shows in the picker, not the rows.
            await workbench.runCommand("IntelliGit: Select Repository");
            await expect(
                page
                    .getByRole("option")
                    .filter({ has: page.getByText(rootLabel, { exact: true }) }),
                "the workspace root is the active repository after the switch",
            ).toContainText("Active");
            await page.keyboard.press("Escape");
            await expect
                .poll(() => liveLifecyclePids(oldHeldPids), {
                    message:
                        "repository switch must settle the identified old Git processes before release",
                })
                .toEqual([]);
            evidence.oldProcessesSettledBeforeRelease = true;
            await writeFile(fixture.release, "release\n");
            await expect(
                await showLifecycleEdge(frame, "last", fixture.names.at(-1)!),
            ).toBeVisible();
            expect(
                trace.replies(oldKey),
                "no observed terminal message is tagged with the retired repository revision",
            ).toEqual([]);
            expect(trace.events.filter((event) => event.unavailable > 0)).toEqual([]);
        } finally {
            try {
                await writeFile(
                    testInfo.outputPath("lifecycle-evidence.json"),
                    JSON.stringify({ ...evidence, events: trace.events }, null, 2),
                );
            } finally {
                try {
                    await writeFile(fixture.release, "release\n");
                } finally {
                    await app.close();
                }
            }
        }
    });

    test("Commit undock and dock discard pending detached-view reads", async ({
        fixtureWorkspace,
    }, testInfo) => {
        const { workspace } = fixtureWorkspace;
        const fixture = await prepareLifecycleStats(workspace);
        const app = await launchFixtureWorkspace({
            executablePath: await resolveVSCodeExecutable(REPO_ROOT),
            repoRoot: REPO_ROOT,
            workspace,
            channelDir: fixtureWorkspace.channelDir,
            timeout: 60_000,
        });
        const page = await app.firstWindow();
        const trace = collectLifecycleStats(page);
        const evidence: Record<string, unknown> = {};
        try {
            await dismissFirstRunDialogs(page);
            const view = new IntelliGitView(page);
            const docked = await view.reveal();
            await expandLifecyclePane(page, docked);
            const first = fixture.names[0]!;
            await expect(
                (await showLifecycleEdge(docked, "first", first)).getByRole("status"),
            ).toHaveText("...");
            let baselineHeldPids: number[] = [];
            await expect
                .poll(async () => {
                    baselineHeldPids = await heldLifecyclePids(fixture.held);
                    return baselineHeldPids.length;
                })
                .toBe(2);
            evidence.baselineHeldPids = baselineHeldPids;
            const workbench = new Workbench(page);
            await workbench.runCommand("IntelliGit: Undock...");
            await page.getByRole("option", { name: /^Undock in Editor Tab/ }).click();
            const detached = await view.revealUndocked();
            const commitPane = detached.getByTestId("undocked-commit-panel-section");
            await expect(commitPane).toBeVisible();
            await expect(
                (await showLifecycleEdge(detached, "first", first)).getByRole("status"),
            ).toHaveText("...");
            await expect.poll(() => trace.latest("undocked")).toBeDefined();
            const detachedKey = trace.latest("undocked")!;
            evidence.detachedKey = detachedKey;
            let detachedHeldPids: number[] = [];
            await expect
                .poll(
                    async () => {
                        detachedHeldPids = (await heldLifecyclePids(fixture.held)).filter(
                            (pid) => !baselineHeldPids.includes(pid),
                        );
                        return detachedHeldPids.length;
                    },
                    { message: "the detached view must start two identifiable held Git processes" },
                )
                .toBe(2);
            evidence.detachedHeldPids = detachedHeldPids;
            await commitPane.getByRole("button", { name: "Dock IntelliGit", exact: true }).click();
            // In CI, the palette key pressed while this focused frame closed never returned.
            await expect(commitPane).toHaveCount(0);
            const restored = await view.reveal();
            await expect(
                (await showLifecycleEdge(restored, "first", first)).getByRole("status"),
            ).toHaveText("...");
            await expect
                .poll(() => liveLifecyclePids(detachedHeldPids), {
                    message:
                        "docking must settle the identified detached Git processes before release",
                })
                .toEqual([]);
            evidence.detachedProcessesSettledBeforeRelease = true;
            const restoredKey = trace.latest("commit-panel")!;
            evidence.restoredKey = restoredKey;
            evidence.restoredRepliesBeforeRelease = trace.replies(restoredKey);
            expect(trace.replies(restoredKey)).toEqual([]);
            await writeFile(fixture.release, "release\n");
            await expect(restored.getByTitle(first, { exact: true })).toContainText("+1");
            await expect(
                await showLifecycleEdge(restored, "last", fixture.names.at(-1)!),
            ).toContainText("+1");
            expect(
                trace.replies(detachedKey),
                "no observed terminal message is tagged with the retired detached-view revision",
            ).toEqual([]);
            const restoredReplies = trace.replies(restoredKey);
            expect(restoredReplies.some((event) => event.ready > 0)).toBe(true);
            expect(restoredReplies.filter((event) => event.unavailable > 0)).toEqual([]);
            evidence.restoredRepliesAfterSettlement = restoredReplies;
            evidence.restoredCount = 1;
        } finally {
            try {
                await writeFile(
                    testInfo.outputPath("lifecycle-evidence.json"),
                    JSON.stringify({ ...evidence, events: trace.events }, null, 2),
                );
            } finally {
                try {
                    await writeFile(fixture.release, "release\n");
                } finally {
                    await app.close();
                }
            }
        }
    });
});

test.describe("operation benchmark", () => {
    test.skip(
        process.env.INTELLIGIT_OPERATION_BENCHMARK !== "1",
        "Opt-in same-runtime measurement; correctness tests above remain separate.",
    );
    const settings = parseBenchmarkArguments([
        "--files",
        process.env.INTELLIGIT_BENCHMARK_FILES ?? "1000,10000",
        "--lists",
        process.env.INTELLIGIT_BENCHMARK_LISTS ?? "20,100",
        "--output",
        process.env.INTELLIGIT_BENCHMARK_OUTPUT ??
            path.join(REPO_ROOT, "test-results/operation-benchmark"),
        "--mode",
        process.env.INTELLIGIT_BENCHMARK_MODE ?? "full",
        ...(process.env.INTELLIGIT_BENCHMARK_SAMPLES
            ? ["--samples", process.env.INTELLIGIT_BENCHMARK_SAMPLES]
            : []),
        ...(process.env.INTELLIGIT_BENCHMARK_WARMUPS
            ? ["--warmups", process.env.INTELLIGIT_BENCHMARK_WARMUPS]
            : []),
    ]);
    // The same harness launches the baseline or candidate build; each run needs its own OUTPUT.
    const extensionPath = path.resolve(
        process.env.INTELLIGIT_BENCHMARK_EXTENSION_PATH ?? REPO_ROOT,
    );
    for (const files of settings.files)
        for (const lists of settings.lists)
            test(`${files} files / ${lists} lists`, async () => {
                test.setTimeout(24 * 60 * 60 * 1000);
                await runChangelistBenchmark({
                    files,
                    lists,
                    samples: settings.samples,
                    warmups: settings.warmups,
                    mode: settings.mode,
                    output: path.join(settings.output, `${files}-${lists}`),
                    repoRoot: REPO_ROOT,
                    extensionPath,
                });
            });
});
