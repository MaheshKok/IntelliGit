import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { removeScratchDirectories } from "../../helpers/scratchDirectories";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { expect, type ElectronApplication, type FrameLocator, type Page } from "@playwright/test";
import { createFixtureWorkspace, type FixtureWorkspace } from "../../fixtures/repo/harness";
import { runGit } from "../../fixtures/repo/gitRun";
import {
    assertCloneSupported,
    benchmarkProvenance,
    benchmarkStorage,
    cloneTree,
    extensionBuildIdentity,
    extensionCapabilities,
    freeBytes,
    type HostMetricsSnapshot,
    measureBenchmark,
    scenarioCost,
    seedBenchmarkRepository,
    summarizeGit,
    summarizeSamples,
} from "../../fixtures/changes/operationBenchmark";
import { E2eControlChannelClient } from "../controlChannelClient";
import { IntelliGitView } from "../pageObjects/intelliGitView";
import { dismissFirstRunDialogs, launchFixtureWorkspace } from "./electronLaunchHelpers";
import { resolveVSCodeExecutable } from "./resolveVSCodeExecutable";

interface BenchmarkOptions {
    files: number;
    lists: number;
    samples: number;
    warmups: number;
    mode: string;
    output: string;
    /** Harness checkout: VS Code runtime cache and harness provenance. */
    repoRoot: string;
    /** Extension build launched through --extensionDevelopmentPath. */
    extensionPath: string;
}
interface GitSample {
    kind: string;
    /** First non-option argument, for example `show` or `hash-object`. */
    command?: string;
    pid: number;
    startedAtMs: number;
    durationMs: number;
    exitCode: number | null;
}

/** Transparent timing only: every Git invocation runs immediately; no held or frozen reads. */
async function instrumentGit(workspace: FixtureWorkspace) {
    assert.notEqual(
        process.platform,
        "win32",
        "The current timing shim requires a POSIX fixture runtime.",
    );
    const realGit = execFileSync("which", ["git"], { env: workspace.env, encoding: "utf8" }).trim();
    const directory = path.join(path.dirname(workspace.profileDir), "benchmark-git");
    await mkdir(directory, { recursive: true });
    const log = path.join(directory, "processes.jsonl");
    await writeFile(log, "");
    const source = `#!/usr/bin/env node
const {spawn}=require("node:child_process");
const {appendFileSync}=require("node:fs");
const args=process.argv.slice(2);
const command=args.find((arg,i)=>!arg.startsWith("-")&&!["-c","-C","--git-dir","--work-tree"].includes(args[i-1]));
const startedAtMs=Date.now();const start=performance.now();
const child=spawn(${JSON.stringify(realGit)},args,{stdio:"inherit"});
for(const signal of ["SIGTERM","SIGINT"]) process.on(signal,()=>child.kill(signal));
child.on("error",()=>process.exit(127));
child.on("exit",(code,signal)=>{
appendFileSync(${JSON.stringify(log)},JSON.stringify({kind:args.includes("status")?"status":args.includes("--numstat")?"numstat":args.includes("diff")?"diff":"other",command,pid:process.pid,startedAtMs,durationMs:performance.now()-start,exitCode:code,signal})+"\\n");
if(signal){process.removeAllListeners(signal);process.kill(process.pid,signal);}else process.exit(code??1);
});
`;
    await writeFile(path.join(directory, "git"), source);
    await chmod(path.join(directory, "git"), 0o755);
    workspace.env.PATH = `${directory}${path.delimiter}${workspace.env.PATH ?? ""}`;
    workspace.env.INTELLIGIT_E2E_BENCHMARK = "1";
    return {
        log,
        source,
        read: async (): Promise<GitSample[]> =>
            (await readFile(log, "utf8"))
                .trim()
                .split("\n")
                .filter(Boolean)
                .map((line) => JSON.parse(line) as GitSample),
    };
}

/** Numeric host snapshot through the existing three-gated file channel, outside measured actions. */
async function hostMetrics(client: E2eControlChannelClient) {
    const result = await client.request({ store: "metrics", operation: "snapshot" });
    assert.ok(
        result.ok && result.result?.kind === "value",
        "E2E metrics snapshot must be available",
    );
    return result.result.value as HostMetricsSnapshot;
}

/** Measures the actual webview renderer when Chromium exposes its heap; no inferred host proxy. */
async function rendererHeap(frame: FrameLocator) {
    return frame.locator("body").evaluate(() => {
        const memory = (
            globalThis.performance as unknown as {
                memory?: {
                    usedJSHeapSize: number;
                    totalJSHeapSize: number;
                    jsHeapSizeLimit: number;
                };
            }
        ).memory;
        return memory
            ? {
                  usedJSHeapSize: memory.usedJSHeapSize,
                  totalJSHeapSize: memory.totalJSHeapSize,
                  jsHeapSizeLimit: memory.jsHeapSizeLimit,
              }
            : { unavailable: "Chromium performance.memory is absent" };
    });
}

/** Returns clipped visible file geometry and terminal states, excluding virtualizer overscan. */
async function viewport(frame: FrameLocator, offset?: number) {
    return frame.getByTestId("commit-tab").evaluate(async (element, next) => {
        let parent = element.querySelector<HTMLElement>('[title^="bench-"]')?.parentElement;
        while (parent && !/auto|scroll/.test(getComputedStyle(parent).overflowY))
            parent = parent.parentElement;
        if (!parent) throw new Error("Commit viewport is unavailable");
        if (next !== undefined) {
            parent.scrollTop = next;
            parent.dispatchEvent(new Event("scroll"));
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
        let top = 0,
            bottom = innerHeight;
        for (
            let ancestor: HTMLElement | null = parent;
            ancestor;
            ancestor = ancestor.parentElement
        ) {
            const rect = ancestor.getBoundingClientRect();
            if (/auto|scroll|hidden|clip/.test(getComputedStyle(ancestor).overflowY)) {
                top = Math.max(top, rect.top);
                bottom = Math.min(bottom, rect.bottom);
            }
        }
        const parentTop = parent.getBoundingClientRect().top;
        const rows = [...parent.querySelectorAll<HTMLElement>('[title^="bench-"]')].flatMap(
            (row) => {
                const rect = row.getBoundingClientRect();
                return rect.bottom > top && rect.top < bottom
                    ? [
                          {
                              path: row.title,
                              offset: rect.top - parentTop + parent!.scrollTop,
                              pending: [...row.querySelectorAll('[role="status"]')].some(
                                  (status) => status.textContent?.trim() === "...",
                              ),
                          },
                      ]
                    : [];
            },
        );
        return {
            offset: parent.scrollTop,
            maximum: parent.scrollHeight - parent.clientHeight,
            height: bottom - top,
            rows,
        };
    }, offset);
}

/** Waits for every actually visible row to reach a terminal statistic, including unavailable results. */
async function settle(
    frame: FrameLocator,
    observe?: (view: Awaited<ReturnType<typeof viewport>>) => Promise<void>,
) {
    await expect
        .poll(
            async () => {
                const view = await viewport(frame);
                await observe?.(view);
                return view.rows.length > 0 && view.rows.every((row) => !row.pending);
            },
            {
                timeout: process.env.INTELLIGIT_BENCHMARK_DIAGNOSTIC === "1" ? 5_000 : 60_000,
                intervals: [10],
            },
        )
        .toBe(true);
}

/** Switches actual repository accordions, leaving one expanded Commit viewport to measure. */
async function selectRepository(frame: FrameLocator, root: string) {
    const target = frame.locator(
        `[data-testid="repository-accordion"][data-repository-root=${JSON.stringify(root)}]`,
    );
    const targetHeader = target.getByTestId("repository-accordion-header");
    const open = frame.getByTestId("repository-accordion-header");
    // The webview can reload once during startup ("Frame was detached"); redo the whole pass.
    await expect(async () => {
        for (const header of await open.all()) {
            const same = await header.evaluate(
                (element, targetRoot) =>
                    element.parentElement?.getAttribute("data-repository-root") === targetRoot,
                root,
            );
            if (!same && (await header.getAttribute("aria-expanded")) === "true")
                await header.click();
        }
        if ((await targetHeader.getAttribute("aria-expanded")) !== "true")
            await targetHeader.click();
        await expect(targetHeader).toHaveAttribute("aria-expanded", "true", { timeout: 5_000 });
    }).toPass({ timeout: 60_000 });
}

/** Gives the real Commit viewport enough space using existing native view controls. */
async function expandPane(page: Page, frame: FrameLocator) {
    const graph = page
        .locator(".pane-header")
        .filter({ has: page.getByText("Graph", { exact: true }) });
    if ((await graph.getAttribute("aria-expanded")) === "true") await graph.click();
    for (let i = 0; i < 8; i++)
        await frame.getByRole("separator", { exact: true }).press("ArrowDown");
}

/**
 * Waits until the panel shows every fixture list and its first list's checkbox is enabled (the
 * changelist host is no longer busy), so both builds measure the same grouped view after the same
 * first load. A panel that still shows another list count is reloaded once per quiet window. The
 * wait and reloads are untimed setup and are reported.
 */
async function showAllLists(page: Page, frame: FrameLocator, root: string, lists: number) {
    const started = performance.now();
    const groups = frame.locator(
        `[data-changelist-id][data-repository-root=${JSON.stringify(root)}]`,
    );
    const include = groups.first().getByRole("checkbox", { name: /^Include .+ in commit$/ });
    let reloads = 0;
    for (;;) {
        const windowStarted = performance.now();
        let count = await groups.count();
        while (performance.now() - windowStarted < 120_000) {
            count = await groups.count();
            if (count === lists && (await include.isEnabled({ timeout: 1_000 }).catch(() => false)))
                return { waitMs: performance.now() - started, reloads };
            await new Promise((resolve) => setTimeout(resolve, 1_000));
        }
        if (performance.now() - started > 3_600_000)
            throw new Error(`${count} of ${lists} lists shown after ${reloads} webview reloads`);
        // The right count with a disabled checkbox is a host still loading: keep waiting.
        if (count === lists) continue;
        await (await paletteOption(page, "Developer: Reload Webviews")).click();
        reloads++;
        await expect(async () => {
            await selectRepository(frame, root);
            await expect(frame.getByRole("separator", { exact: true })).toHaveCount(1, {
                timeout: 2_000,
            });
        }).toPass({ timeout: 60_000 });
        await expandPane(page, frame);
    }
}

/** Sweeps every viewport without sampling the dataset, proving first, final and Unicode rows exist. */
async function sweep(
    frame: FrameLocator,
    paths: readonly string[],
    observe: (view: Awaited<ReturnType<typeof viewport>>) => Promise<void>,
) {
    const offsets = new Map<string, number>();
    const windows = [];
    let next = 0;
    for (;;) {
        await observe(await viewport(frame, next));
        await settle(frame, observe);
        const view = await viewport(frame);
        windows.push(view);
        for (const row of view.rows) offsets.set(row.path, row.offset);
        if (view.offset >= view.maximum) break;
        assert.ok(view.height > 0);
        next = Math.min(view.maximum, view.offset + Math.max(1, view.height - 32));
    }
    assert.deepEqual(
        [...offsets.keys()].sort(),
        [...paths].sort(),
        "every requested file must be rendered and terminal during the full sweep",
    );
    return { offsets, windows };
}

const QUICK_INPUT = ".quick-input-widget .quick-input-box input";
/** Host prompt texts; both builds ship them as l10n keys, the destination prompts only in candidates. */
const REPOSITORY_PROMPT = "Select a repository for shelf changes";
const SHELF_PROMPT = "Select a shelf to unshelve";
const TARGET_PROMPT = "Select a destination changelist";

/** Opens the palette filtered to one command; clicking the returned option starts the action. */
async function paletteOption(page: Page, title: string) {
    const modifier = process.platform === "darwin" ? "Meta" : "Control";
    const input = page.getByPlaceholder("Type the name of a command to run.", { exact: true });
    const option = page.getByRole("option", { name: title }).first();
    for (let attempt = 1; ; attempt++) {
        try {
            await page.keyboard.press(`${modifier}+Shift+P`);
            await input.waitFor({ state: "visible", timeout: 3_000 });
            await input.fill(`>${title}`, { timeout: 3_000 });
            await option.waitFor({ state: "visible", timeout: 3_000 });
            return option;
        } catch (error) {
            if (attempt === 5) throw error;
            await page.keyboard.press("Escape");
        }
    }
}

/** Waits for one host prompt, then clicks its first (optionally filtered) item. */
async function acceptPrompt(page: Page, placeholder: string, filter?: string) {
    const input = page.locator(QUICK_INPUT);
    const options = page.locator(".quick-input-widget").getByRole("option");
    await expect(input).toHaveAttribute("placeholder", placeholder, { timeout: 60_000 });
    if (filter !== undefined) {
        await input.fill(filter);
        await expect(options).toHaveCount(1);
    }
    // A click selects explicitly; Enter after filtering can close the picker with no selection.
    await options.first().click();
}

/** Reads the visible Shelf tab count of one repository accordion; no count means zero. */
async function shelfCount(frame: FrameLocator, root: string) {
    const text = await frame
        .locator(
            `[data-testid="repository-accordion"][data-repository-root=${JSON.stringify(root)}]`,
        )
        .getByRole("tab", { name: /^Shelf/ })
        .textContent();
    return Number(/\((\d+)\)/.exec(text ?? "")?.[1] ?? 0);
}

const TOASTS = ".notifications-toasts .notification-list-item-message";
/** Success texts both builds show once a shelf mutation has finished on disk. */
const SAVED_TOAST = "Changes saved to shelf.";
const SHELVED_TOAST = "Changes shelved.";
const UNSHELVED_TOAST = "Shelf unshelved.";
/** How long a finished mutation may take to appear in the view before it is recorded as not shown. */
const VISIBLE_TIMEOUT_MS = 120_000;

/** Clears old toasts so the next success toast belongs to the next action. */
async function clearToasts(page: Page) {
    await (await paletteOption(page, "Notifications: Clear All Notifications")).click();
    await expect(page.locator(TOASTS)).toHaveCount(0);
}

/** The host never confirmed a shelf mutation within the bound: a measured outcome, not a harness fault. */
class HostConfirmationTimeout extends Error {}

/** Waits for the host's own success toast, failing at once on a failure toast. */
async function waitForToast(page: Page, success: string) {
    const toasts = page.locator(TOASTS);
    const deadline = Date.now() + 600_000;
    const logged = new Set<string>();
    for (;;) {
        const texts = await toasts.allTextContents();
        if (texts.includes(success)) return;
        // A line-count warning is not the shelf's result: log it once and keep waiting for the shelf toast.
        const statsWarnings = texts.filter((text) => /change stats may be unavailable/i.test(text));
        for (const text of statsWarnings) {
            if (!logged.has(text)) console.log(`[benchmark] ${success} wait saw: ${text}`);
            logged.add(text);
        }
        const failures = texts.filter(
            (text) => !statsWarnings.includes(text) && /fail|error|unavailable|no git/i.test(text),
        );
        if (failures.length > 0) throw new Error(`Shelf command failed: ${failures.join(" | ")}`);
        if (Date.now() > deadline)
            throw new HostConfirmationTimeout(
                `No "${success}" within 600 s; visible notifications: ${texts.join(" | ") || "none"}`,
            );
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

/** Polls a view condition for at most `timeoutMs`; null means the view never showed it. */
async function visibleWithin(check: () => Promise<boolean>, timeoutMs: number) {
    const start = performance.now();
    do {
        if (await check()) return performance.now() - start;
        await new Promise((resolve) => setTimeout(resolve, 10));
    } while (performance.now() - start < timeoutMs);
    return null;
}

/** Saves screenshots and frame HTML of a failed session before it closes. */
async function captureFailure(app: ElectronApplication, output: string, label: string) {
    const page = await app.firstWindow();
    await page.screenshot({ path: path.join(output, `failed-${label}.png`) });
    return Promise.all(
        page.frames().map(async (frame, index) => {
            const filename = `failed-${label}-frame-${index}.html`;
            await writeFile(
                path.join(output, filename),
                await frame.content().catch(() => "unreachable"),
            );
            return { url: frame.url(), filename };
        }),
    );
}

type GitTiming = Awaited<ReturnType<typeof instrumentGit>>;
interface Session {
    app?: ElectronApplication;
    timing?: GitTiming;
}

/** Launches one isolated session and measures its open; `session` keeps handles for teardown. */
async function openSession(
    options: BenchmarkOptions,
    executablePath: string,
    workspace: FixtureWorkspace,
    baseEnv: NodeJS.ProcessEnv,
    primaryRoot: string,
    session: Session,
) {
    const sessionWorkspace = { ...workspace, env: { ...baseEnv } };
    const channelDir = path.join(path.dirname(workspace.profileDir), "benchmark-channel");
    await mkdir(channelDir, { recursive: true });
    const timing = await instrumentGit(sessionWorkspace);
    session.timing = timing;
    const start = performance.now();
    const app = await launchFixtureWorkspace({
        executablePath,
        repoRoot: options.extensionPath,
        workspace: sessionWorkspace,
        channelDir,
        timeout: 90_000,
    });
    session.app = app;
    const page = await app.firstWindow();
    const client = new E2eControlChannelClient(channelDir);
    const hostBeforeReveal = await hostMetrics(client);
    // DOM snapshots of a 1000-row list made a single trace exceed 512 MB; screenshots suffice.
    await app.context().tracing.start({ screenshots: true, snapshots: false, sources: true });
    await dismissFirstRunDialogs(page);
    const revealStarted = performance.now();
    const frame = await new IntelliGitView(page).reveal(180_000);
    const revealMs = performance.now() - revealStarted;
    // A late webview reload can re-expand the other repository; reselect until one Commit viewport remains.
    await expect(async () => {
        await selectRepository(frame, primaryRoot);
        await expect(frame.getByRole("separator", { exact: true })).toHaveCount(1, {
            timeout: 2_000,
        });
    }).toPass({ timeout: 60_000 });
    await frame.locator('[title^="bench-"]').first().waitFor();
    const firstRowsMs = performance.now() - start;
    await expandPane(page, frame);
    await settle(frame);
    const settledMs = performance.now() - start;
    const runtime = await app.evaluate(({ app }) => ({
        vscode: app.getVersion(),
        versions: process.versions,
        appPath: app.getAppPath(),
    }));
    const product = JSON.parse(
        await readFile(path.join(runtime.appPath, "product.json"), "utf8"),
    ) as { commit?: string };
    const gitProcesses = await timing.read();
    const record = {
        firstRowsMs,
        settledMs,
        reveal: { elapsedMs: revealMs, exceeded30s: revealMs > 30_000 },
        runtime: { ...runtime, commit: product.commit ?? null },
        hostBeforeReveal,
        host: await hostMetrics(client),
        renderer: await rendererHeap(frame),
        layout: {
            changelistGroups: await frame.locator("[data-changelist-id]").count(),
            virtualTrees: await frame.getByTestId("virtual-commit-tree").count(),
            renderedFileRows: await frame.locator('[title^="bench-"]').count(),
        },
        git: summarizeGit(gitProcesses),
        gitProcesses,
    };
    return { app, page, frame, client, timing, record };
}

/**
 * Prepares one fixture, then gives every cold sample and the warm session an APFS clone of it
 * plus a fresh profile. All latency scenarios use each build's own native commands.
 */
export async function runChangelistBenchmark(options: BenchmarkOptions) {
    assert.ok(
        !existsSync(path.join(options.output, "runtime.json")),
        `${options.output} already holds results; choose a fresh output directory`,
    );
    await mkdir(options.output, { recursive: true });
    const diskRoot = os.tmpdir();
    const freeBeforeBytes = await freeBytes(diskRoot);
    let minFreeBytes = freeBeforeBytes;
    const observeDisk = async () => {
        minFreeBytes = Math.min(minFreeBytes, await freeBytes(diskRoot));
    };
    const executablePath = await resolveVSCodeExecutable(options.repoRoot);
    const capabilities = await extensionCapabilities(options.extensionPath);
    const cold: number[] = [];
    const coldWarmups: number[] = [];
    const firstRows: number[] = [];
    const firstRowsWarmups: number[] = [];
    const coldRecords: Record<string, unknown>[] = [];
    const viewportObservations: unknown[] = [];
    const scenarios: Record<string, unknown> = {};
    const result: Record<string, unknown> = {
        kind: "real-vscode-operation-benchmark",
        diagnosticOnly: process.env.INTELLIGIT_BENCHMARK_DIAGNOSTIC === "1",
        options,
        executablePath,
        extensionBuild: await extensionBuildIdentity(options.extensionPath),
        capabilities,
        harnessProvenance: await benchmarkProvenance(options.repoRoot),
        coldDefinition:
            "Each cold sample is a new VS Code process on a fresh APFS clone of the prepared fixture owner directory: clean repositories with schema3 metadata (so cold open includes migration), an empty user-data and extensions directory, and a fresh scratch HOME/TMPDIR. No extension state or cache survives between samples. Not cold: the OS file cache, because clones share the template's data blocks, and the VS Code binary/page cache, identical for both builds.",
        scenarios,
        coldRecords,
        viewportObservations,
        measurementNotes: [
            "Git child duration/counts use an immediate forwarding Node shim; wrapper startup overhead remains in user-action latency and is identical for both builds.",
            "IPC counts/bytes are UTF-8 JSON.stringify(protocolValue) at the webview proxy, excluding Electron framing; scenario cost windows include warmups.",
            "Chromium performance.memory is a renderer estimate; no forced renderer GC. Cold timing includes launch, one numeric host snapshot probe, first-run dismissal, native view reveal and selecting the primary repository accordion.",
            "Fixture preparation runs once per dataset and is excluded from timing. A clone resets file ctimes and inodes, so the first git status refreshes index stat data; the original freshly written fixture refreshed it too, and both builds see the same clone.",
            "Warm scenarios run in one dedicated session after the cold samples, each with its own warmups and samples, in this order: coverage sweep, refresh, scroll, repository switch, capture, target pick/cancel, restore.",
            "Capture is the shared palette command Save to Shelf (whole repository, local changes kept). Restore is measured from the Unshelve command to settled visible rows; its unmeasured setup is Shelve Silently, which removes every local change into a fresh shelf. After the first restore, every restored file belongs to the chosen destination list (candidate: first picker entry; baseline: the active list).",
            "Palette latency starts at the command click and includes answering the repository picker by typing its label.",
            "Thin mode is harness calibration only; it is not comparison or p95 evidence.",
            "Before the warm scenarios, untimed setup waits until the panel shows every fixture list with the changelist host idle, reloading the webview when it shows another list count (listGate records the wait and reloads). Without it the baseline webview could keep an empty first state and measure one ungrouped list.",
        ],
        unavailable: capabilities.targetPicker
            ? {}
            : {
                  targetPickOpen:
                      "this build has no changelist destination picker: its l10n bundle lacks 'Select a destination changelist' and Unshelve applies directly after shelf selection",
                  targetPickCancel: "same reason as targetPickOpen",
              },
    };
    const workspace = await createFixtureWorkspace({ scenario: "clean" });
    const ownRoot = path.dirname(workspace.profileDir);
    const template = `${ownRoot}.template`;
    const baseEnv = { ...workspace.env };
    let keepFiles = false;
    try {
        const fixture = await seedBenchmarkRepository(
            workspace.root,
            workspace.env,
            options.files,
            options.lists,
        );
        const secondary = path.join(workspace.root, "benchmark-secondary");
        const exclude = path.join(workspace.root, ".git/info/exclude");
        await writeFile(exclude, (await readFile(exclude, "utf8")) + "\nbenchmark-secondary/\n");
        await runGit(
            workspace.root,
            ["clone", "--no-hardlinks", "--", workspace.root, secondary],
            workspace.env,
        );
        const secondaryFixture = await seedBenchmarkRepository(
            secondary,
            workspace.env,
            options.files,
            options.lists,
        );
        const primaryRoot = await realpath(workspace.root);
        const secondaryRoot = await realpath(secondary);
        result.fixture = {
            seed: fixture.seed,
            distributionHash: fixture.distributionHash,
            legacyBytes: fixture.legacyBytes,
            files: options.files,
            lists: options.lists,
            secondaryControlRows: 0,
        };
        result.fixturePreparation = {
            primary: {
                preparationMs: fixture.preparationMs,
                snapshotPreparationMs: fixture.snapshotPreparationMs,
                snapshotProducer: fixture.snapshotProducer,
            },
            secondary: {
                preparationMs: secondaryFixture.preparationMs,
                snapshotPreparationMs: secondaryFixture.snapshotPreparationMs,
                snapshotProducer: secondaryFixture.snapshotProducer,
            },
            excludedFromMeasuredCold: true,
            migrationDeferredUntilColdOpen: true,
        };
        await observeDisk();
        const probe = await assertCloneSupported(path.dirname(ownRoot));
        const templateStarted = performance.now();
        await cloneTree(ownRoot, template);
        result.clone = { probe, templateMs: performance.now() - templateStarted, template };
        await observeDisk();

        /** Replaces the owner directory with a fresh clone; returns the clone time. */
        const freshClone = async () => {
            await removeScratchDirectories(ownRoot);
            const started = performance.now();
            await cloneTree(template, ownRoot);
            return performance.now() - started;
        };
        /** Stops tracing (kept only when asked) and closes the session, even after a failure. */
        const closeSession = async (session: Session, trace?: string) => {
            if (!session.app) return;
            await session.app
                .context()
                .tracing.stop(trace ? { path: path.join(options.output, trace) } : {})
                .catch(() => undefined);
            await session.app.close();
        };

        const total = options.samples + options.warmups;
        for (let iteration = 0; iteration < total; iteration++) {
            const sampleStarted = performance.now();
            const cloneMs = await freshClone();
            const session: Session = {};
            let record: Record<string, unknown>;
            try {
                const opened = await openSession(
                    options,
                    executablePath,
                    workspace,
                    baseEnv,
                    primaryRoot,
                    session,
                );
                await observeDisk();
                const warmup = iteration < options.warmups;
                (warmup ? coldWarmups : cold).push(opened.record.settledMs);
                (warmup ? firstRowsWarmups : firstRows).push(opened.record.firstRowsMs);
                record = { iteration, warmup, cloneMs, ...opened.record };
            } catch (error) {
                keepFiles = true;
                result.failedGitProcesses = session.timing ? await session.timing.read() : [];
                if (session.app)
                    result.failedFrames = await captureFailure(
                        session.app,
                        options.output,
                        `cold-${iteration}`,
                    );
                await closeSession(session, `cold-${iteration}.zip`);
                throw error;
            }
            await closeSession(session, iteration === total - 1 ? "cold-last.zip" : undefined);
            coldRecords.push({ ...record, wallMs: performance.now() - sampleStarted });
        }
        scenarios.coldOpen = summarizeSamples(cold, coldWarmups);
        scenarios.coldFirstRows = summarizeSamples(firstRows, firstRowsWarmups);

        const warmStarted = performance.now();
        const cloneMs = await freshClone();
        const session: Session = {};
        try {
            const { page, frame, client, timing, record } = await openSession(
                options,
                executablePath,
                workspace,
                baseEnv,
                primaryRoot,
                session,
            );
            result.warmSessionOpen = { cloneMs, ...record };
            result.runtime = record.runtime;
            result.beforeRepeated = { host: record.host, renderer: record.renderer };
            /** Runs one scenario and records its IPC, heap and Git cost window. */
            const costed = async (
                name: string,
                run: () => Promise<ReturnType<typeof summarizeSamples>>,
            ) => {
                const host = await hostMetrics(client);
                const renderer = await rendererHeap(frame);
                const since = Date.now();
                const latency = await run();
                const git = (await timing.read()).filter((sample) => sample.startedAtMs >= since);
                scenarios[name] = {
                    ...latency,
                    cost: scenarioCost(
                        host,
                        await hostMetrics(client),
                        git,
                        options.samples + options.warmups,
                    ),
                    renderer: { before: renderer, after: await rendererHeap(frame) },
                };
                await observeDisk();
            };

            result.listGate = await showAllLists(page, frame, primaryRoot, options.lists);
            const coverageStarted = performance.now();
            await frame
                .getByTestId("commit-tab")
                .getByRole("button", { name: "Expand All", exact: true })
                .click();
            const diagnostic = await sweep(
                frame,
                fixture.rows.map((row) => row.path),
                async (view) => {
                    const metadata =
                        process.env.INTELLIGIT_BENCHMARK_DIAGNOSTIC === "1"
                            ? (JSON.parse(
                                  await readFile(
                                      path.join(
                                          primaryRoot,
                                          ".git/intelligit/changelists/state.json",
                                      ),
                                      "utf8",
                                  ),
                              ) as { schemaVersion: number; state: { revision: number } })
                            : undefined;
                    viewportObservations.push({
                        elapsedMs: performance.now() - coverageStarted,
                        schemaVersion: metadata?.schemaVersion,
                        metadataRevision: metadata?.state.revision,
                        ...view,
                    });
                },
            );
            result.viewportSweep = diagnostic.windows;
            result.coverage = {
                completionMs: performance.now() - coverageStarted,
                includesExpandAll: true,
                uniquePaths: diagnostic.offsets.size,
                rawVisibleRowObservations: diagnostic.windows.reduce(
                    (count, window) => count + window.rows.length,
                    0,
                ),
                mode: "expanded-grouped",
                changelistGroups: await frame.locator("[data-changelist-id]").count(),
                virtualTrees: await frame.getByTestId("virtual-commit-tree").count(),
            };
            if (process.env.INTELLIGIT_BENCHMARK_DIAGNOSTIC === "1") {
                result.diagnosticTerminalSample = true;
                return result;
            }

            const refresh = frame.getByTestId("commit-tab").getByTestId("refresh-button");
            await costed("warmRefresh", () =>
                measureBenchmark(options.samples, options.warmups, async () => {
                    const start = Date.now();
                    await refresh.click();
                    await expect
                        .poll(
                            async () =>
                                (await timing.read()).some(
                                    (sample) =>
                                        sample.kind === "status" &&
                                        sample.startedAtMs >= start &&
                                        sample.exitCode === 0,
                                ),
                            { timeout: 60_000, intervals: [10] },
                        )
                        .toBe(true);
                    await expect(refresh).not.toHaveAttribute("data-refreshing", "true", {
                        timeout: 60_000,
                    });
                    await settle(frame);
                }),
            );
            const targets = [fixture.rows[0].path, fixture.rows.at(-1)!.path];
            await costed("viewportScroll", () =>
                measureBenchmark(options.samples, options.warmups, async (i) => {
                    const target = targets[i % 2];
                    await viewport(frame, Math.max(0, diagnostic.offsets.get(target)! - 40));
                    await expect(frame.getByTitle(target, { exact: true }).first()).toBeVisible();
                    await settle(frame);
                }),
            );
            result.beforeRepositorySwitch = {
                host: await hostMetrics(client),
                renderer: await rendererHeap(frame),
            };
            await costed("repositorySwitch", () =>
                measureBenchmark(options.samples, options.warmups, async (i) => {
                    const root = i % 2 === 0 ? secondaryRoot : primaryRoot;
                    await selectRepository(frame, root);
                    await viewport(frame, 0);
                    await expect(frame.getByTestId("repository-accordion-content")).toHaveAttribute(
                        "data-repository-root",
                        root,
                    );
                    await settle(frame);
                }),
            );
            await selectRepository(frame, primaryRoot);
            await settle(frame);

            const repositoryLabel = path.basename(primaryRoot);
            const input = page.locator(QUICK_INPUT);
            // Latency ends at the host's success toast (mutation durable); whether and when the
            // view shows it is recorded separately, so a view that never catches up is a result.
            const worktreeChanges = async () =>
                (await runGit(primaryRoot, ["status", "--porcelain=v1"], baseEnv))
                    .split("\n")
                    .filter(Boolean).length;
            let blockedBy: string | undefined;
            /** Runs one shelf scenario; a host that never confirms is recorded, and later ones skipped. */
            const shelfScenario = async (
                name: string,
                details: () => Record<string, unknown>,
                run: () => Promise<void>,
            ) => {
                if (blockedBy !== undefined) {
                    scenarios[name] = {
                        notRun: `an earlier shelf scenario did not finish: ${blockedBy}`,
                    };
                    return;
                }
                try {
                    await run();
                    scenarios[name] = { ...(scenarios[name] as object), ...details() };
                } catch (error) {
                    if (!(error instanceof HostConfirmationTimeout)) throw error;
                    blockedBy = error.message;
                    scenarios[name] = { incomplete: true, reason: error.message, ...details() };
                }
            };
            const initialShelves = await shelfCount(frame, primaryRoot);
            const captureDurable: number[] = [];
            const captureVisible: (number | null)[] = [];
            let viewStalled = false;
            await shelfScenario(
                "capture",
                () => ({
                    latencyEndsAt: `host toast "${SAVED_TOAST}"`,
                    durableMsIncludingWarmups: captureDurable,
                    shelfCountVisibleMs: captureVisible,
                    visibleTimeoutMs: VISIBLE_TIMEOUT_MS,
                    visibleNote:
                        "null = the Shelf count did not show the new shelf within the timeout; after the first null later samples are checked once, not awaited.",
                }),
                () =>
                    costed("capture", () =>
                        measureBenchmark(options.samples, options.warmups, async (i, start) => {
                            await clearToasts(page);
                            const option = await paletteOption(page, capabilities.saveToShelf);
                            start();
                            const started = performance.now();
                            await option.click();
                            await acceptPrompt(page, REPOSITORY_PROMPT, repositoryLabel);
                            await waitForToast(page, SAVED_TOAST);
                            const durable = performance.now() - started;
                            captureDurable.push(durable);
                            const shown = await visibleWithin(
                                async () =>
                                    (await shelfCount(frame, primaryRoot)) >=
                                    initialShelves + i + 1,
                                viewStalled ? 0 : VISIBLE_TIMEOUT_MS,
                            );
                            viewStalled ||= shown === null;
                            captureVisible.push(shown === null ? null : durable + shown);
                        }),
                    ),
            );
            if (capabilities.targetPicker && blockedBy !== undefined)
                scenarios.targetPickOpen = {
                    notRun: `an earlier shelf scenario did not finish: ${blockedBy}`,
                };
            else if (capabilities.targetPicker) {
                const opens: number[] = [];
                const cancels: number[] = [];
                const cancelGit: number[] = [];
                const host = await hostMetrics(client);
                const since = Date.now();
                for (let i = 0; i < total; i++) {
                    const before = await shelfCount(frame, primaryRoot);
                    const option = await paletteOption(page, capabilities.unshelve);
                    await option.click();
                    await acceptPrompt(page, REPOSITORY_PROMPT, repositoryLabel);
                    // A busy host can take longer than the 5 s default to list shelves.
                    await expect(input).toHaveAttribute("placeholder", SHELF_PROMPT, {
                        timeout: 60_000,
                    });
                    const opened = performance.now();
                    await page.locator(".quick-input-widget").getByRole("option").first().click();
                    await expect(input).toHaveAttribute("placeholder", TARGET_PROMPT, {
                        timeout: 60_000,
                    });
                    opens.push(performance.now() - opened);
                    const cancelSince = Date.now();
                    const cancelled = performance.now();
                    await input.press("Escape");
                    await expect(input).toBeHidden();
                    cancels.push(performance.now() - cancelled);
                    cancelGit.push(
                        (await timing.read()).filter((sample) => sample.startedAtMs >= cancelSince)
                            .length,
                    );
                    expect(await shelfCount(frame, primaryRoot)).toBe(before);
                }
                const split = (values: number[]) =>
                    summarizeSamples(
                        values.slice(options.warmups),
                        values.slice(0, options.warmups),
                    );
                const cost = scenarioCost(
                    host,
                    await hostMetrics(client),
                    (await timing.read()).filter((sample) => sample.startedAtMs >= since),
                    total,
                );
                scenarios.targetPickOpen = { ...split(opens), cost };
                scenarios.targetPickCancel = {
                    ...split(cancels),
                    gitProcessesStartedAfterCancel: cancelGit,
                };
            }
            const rows = frame.locator('[title^="bench-"]');
            const restoreDurable: number[] = [];
            const restoreVisible: (number | null)[] = [];
            viewStalled = false;
            await shelfScenario(
                "restore",
                () => ({
                    latencyEndsAt: `host toast "${UNSHELVED_TOAST}" with the worktree change count restored on disk`,
                    durableMsIncludingWarmups: restoreDurable,
                    rowsVisibleMs: restoreVisible,
                    visibleTimeoutMs: VISIBLE_TIMEOUT_MS,
                    visibleNote:
                        "null = the view did not clear the shelved rows or did not show the restored rows within the timeout.",
                }),
                () =>
                    costed("restore", () =>
                        measureBenchmark(options.samples, options.warmups, async (_i, start) => {
                            const changed = await worktreeChanges();
                            await clearToasts(page);
                            const shelve = await paletteOption(page, capabilities.shelveSilently);
                            await shelve.click();
                            await acceptPrompt(page, REPOSITORY_PROMPT, repositoryLabel);
                            await waitForToast(page, SHELVED_TOAST);
                            expect(await worktreeChanges()).toBeLessThan(changed);
                            // Restored rows only prove anything once the view has dropped them.
                            const cleared = await visibleWithin(
                                async () => (await rows.count()) === 0,
                                viewStalled ? 0 : VISIBLE_TIMEOUT_MS,
                            );
                            viewStalled ||= cleared === null;
                            await clearToasts(page);
                            const option = await paletteOption(page, capabilities.unshelve);
                            start();
                            const started = performance.now();
                            await option.click();
                            await acceptPrompt(page, REPOSITORY_PROMPT, repositoryLabel);
                            await acceptPrompt(page, SHELF_PROMPT);
                            if (capabilities.targetPicker) await acceptPrompt(page, TARGET_PROMPT);
                            await waitForToast(page, UNSHELVED_TOAST);
                            const durable = performance.now() - started;
                            restoreDurable.push(durable);
                            expect(await worktreeChanges()).toBe(changed);
                            const shown = viewStalled
                                ? null
                                : await visibleWithin(
                                      async () => (await rows.count()) > 0,
                                      VISIBLE_TIMEOUT_MS,
                                  );
                            viewStalled ||= shown === null;
                            restoreVisible.push(shown === null ? null : durable + shown);
                            if (shown !== null) await settle(frame);
                        }),
                    ),
            );
            result.afterRepeated = {
                host: await hostMetrics(client),
                renderer: await rendererHeap(frame),
            };
            result.storage = await benchmarkStorage(path.join(primaryRoot, ".git"));
            result.gitProcesses = await timing.read();
            await page.screenshot({ path: path.join(options.output, "settled.png") });
            result.warmSessionWallMs = performance.now() - warmStarted;
        } catch (error) {
            keepFiles = true;
            result.failedGitProcesses = session.timing ? await session.timing.read() : [];
            if (session.app)
                result.failedFrames = await captureFailure(session.app, options.output, "warm");
            throw error;
        } finally {
            await closeSession(session, "warm.zip");
        }
    } catch (error) {
        keepFiles = true;
        result.failedWorkspace = { root: workspace.root, profile: workspace.profileDir, template };
        // Host logs (IntelliGit output, exthost) survive TMPDIR cleanup only inside the output.
        await cp(
            path.join(workspace.profileDir, "logs"),
            path.join(options.output, "failed-logs"),
            {
                recursive: true,
            },
        ).catch(() => undefined);
        result.failure = error instanceof Error ? error.message : String(error);
        throw error;
    } finally {
        await observeDisk();
        result.disk = {
            volume: diskRoot,
            freeBeforeBytes,
            minFreeBytes,
            peakUseBytes: freeBeforeBytes - minFreeBytes,
            note: "Volume-wide free-space delta sampled at preparation, after every session open and scenario; includes concurrent writers.",
        };
        await writeFile(path.join(options.output, "runtime.json"), JSON.stringify(result, null, 2));
        if (!keepFiles) {
            await workspace.dispose();
            await removeScratchDirectories(template);
        }
    }
    return result;
}
