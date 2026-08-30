import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ElectronApplication, FrameLocator, Locator, Page } from "@playwright/test";

import { buildEditableDiffPerformanceFixture } from "../helpers/editableDiffPerformanceFixture";
import { runGit } from "../fixtures/repo/gitRun";
import { waitForE2eChannelReady } from "./controlChannelClient";
import { expect, test, type FixtureWorkspaceFixture } from "./fixtureWorkspace";
import {
    dismissFirstRunDialogs,
    launchFixtureWorkspace,
} from "./hostFixtures/electronLaunchHelpers";
import { resolveVSCodeExecutable } from "./hostFixtures/resolveVSCodeExecutable";
import { ChangesPanel } from "./pageObjects/changesPanel";
import { IntelliGitView } from "./pageObjects/intelliGitView";

const REPO_ROOT = path.resolve(__dirname, "../..");
const PERFORMANCE_PATH = "src/editable-performance.ts";
const EDITABLE_LINE = "const value_6 = 6; // working tree";
const HEAD_LINE = "const value_6 = 6;";
const SENTINEL = "x".repeat(200);
const FRAME_INTERVAL_COUNT = 120;
const WARMUP_PAIRS = 10;
const SAMPLED_PAIRS_PER_BATCH = 13;
// Wall-clock equivalent of two 60 Hz frames. Deriving this from a ProMotion interval makes the
// double-rAF ceiling stricter than the measured native editor it is meant to benchmark against.
const MAX_EDITABLE_P95_MS = 1000 / 30;
const WORKBENCH_MODIFIER = process.platform === "darwin" ? "Meta" : "Control";
const PAIRED_ROUND_ORDERS = [
    ["native", "custom"],
    ["custom", "native"],
    ["native", "custom"],
    ["custom", "native"],
] as const;

type SurfaceName = "native" | "custom";
type Measurement = "event-timing" | "double-raf";
type LongTaskEvidence = "long-task" | "chromium-trace" | "unavailable";

interface EditorLatencyMetrics {
    readonly surface: SurfaceName;
    readonly measurement: Measurement;
    readonly frameIntervalMs: number;
    readonly samplesMs: readonly number[];
    readonly p50Ms: number;
    readonly p95Ms: number;
    readonly maxMs: number;
    readonly longTasksMs: readonly number[];
}

interface Surface {
    readonly name: SurfaceName;
    readonly page: Page;
    readonly input: Locator;
    readonly activateInput: () => Promise<void>;
    readonly assertValue: (expected: string) => Promise<void>;
    readonly close: () => Promise<void>;
}

interface TelemetrySupport {
    readonly eventTiming: boolean;
    readonly longTask: boolean;
}

interface SampledKeys {
    readonly doubleRafMs: readonly number[];
    readonly startTimesMs: readonly number[];
}

interface TraceEvidence {
    readonly supported: boolean;
    readonly taskDurationsMs: readonly number[];
    readonly events: readonly unknown[];
    readonly error?: string;
}

interface BatchEvidence {
    readonly surface: SurfaceName;
    readonly support: TelemetrySupport;
    readonly eventTimingMs: readonly number[];
    readonly doubleRafMs: readonly number[];
    readonly longTasksMs: readonly number[];
    readonly longTaskEvidence: LongTaskEvidence;
    readonly trace?: TraceEvidence;
}

interface NativeInputEvidence {
    readonly activeElementOuterHtml: string;
    readonly events: readonly {
        readonly type: "keydown" | "beforeinput" | "input";
        readonly tagName: string;
        readonly className: string;
        readonly role: string | null;
        readonly aria: string | null;
        readonly editorOwned: boolean;
        readonly editorFocused: boolean;
    }[];
    readonly target: {
        readonly tagName: string;
        readonly className: string;
        readonly role: string | null;
        readonly aria: string | null;
        readonly editorOwned: boolean;
        readonly editorFocused: boolean;
    } | null;
}

/** Seeds the same committed HEAD and dirty working-tree bytes used by both editor surfaces. */
async function seedLargeDocument(fixtureWorkspace: FixtureWorkspaceFixture): Promise<void> {
    const fixture = buildEditableDiffPerformanceFixture();
    const filePath = path.join(fixtureWorkspace.workspace.root, PERFORMANCE_PATH);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, fixture.leftText, "utf8");
    await runGit(
        fixtureWorkspace.workspace.root,
        ["add", "--", PERFORMANCE_PATH],
        fixtureWorkspace.workspace.env,
    );
    await runGit(
        fixtureWorkspace.workspace.root,
        ["commit", "-m", "Add editable diff performance fixture"],
        fixtureWorkspace.workspace.env,
    );
    await writeFile(filePath, fixture.rightText, "utf8");

    expect(fixture.leftText).toContain(SENTINEL);
    await expect.poll(() => readFile(filePath, "utf8")).toBe(fixture.rightText);
}

/** Starts one isolated VS Code instance after the fixture's HEAD and dirty worktree are ready. */
async function launchWorkspace(fixtureWorkspace: FixtureWorkspaceFixture): Promise<{
    electronApp: ElectronApplication;
    page: Page;
    view: IntelliGitView;
    sidebar: FrameLocator;
}> {
    const executablePath = await resolveVSCodeExecutable(REPO_ROOT);
    const electronApp = await launchFixtureWorkspace({
        executablePath,
        repoRoot: REPO_ROOT,
        workspace: fixtureWorkspace.workspace,
        channelDir: fixtureWorkspace.channelDir,
        timeout: 60_000,
    });
    const page = await electronApp.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await dismissFirstRunDialogs(page);
    await waitForE2eChannelReady(fixtureWorkspace.channelDir);
    const view = new IntelliGitView(page);
    const sidebar = await view.reveal();
    return { electronApp, page, view, sidebar };
}

/** Proves a native text update from rendered editor bytes without including it in latency timing. */
async function expectNativeLine(page: Page, expected: string): Promise<void> {
    const normalizedExpected = expected.replaceAll(/\s+/g, "");
    await expect
        .poll(async () => {
            const lines = await page.locator(".monaco-editor .view-line").allTextContents();
            return lines.some((line) => line.replaceAll(/\s+/g, "") === normalizedExpected);
        })
        .toBe(true);
}

/**
 * Opens the native editor and stamps the actual focused, Monaco-owned input target observed during
 * one reversible capture-phase input probe. The stamp only identifies this real test-session node;
 * Chat or any detached/hidden editor target is rejected before telemetry is attached.
 */
async function openNative(
    page: Page,
): Promise<{ surface: Surface; evidence: NativeInputEvidence }> {
    await page.keyboard.press(`${WORKBENCH_MODIFIER}+P`);
    const quickOpenInput = page.locator(".quick-input-widget .quick-input-box input").first();
    await expect(quickOpenInput).toBeVisible();
    await quickOpenInput.fill(PERFORMANCE_PATH);
    await page
        .getByRole("option", { name: /^editable-performance\.ts src/ })
        .first()
        .click();
    await expect(quickOpenInput).toBeHidden();

    const targetLine = page
        .locator(".monaco-editor .view-line")
        .filter({ hasText: EDITABLE_LINE })
        .last();
    await expect(targetLine).toBeVisible();
    await targetLine.click();
    await page.keyboard.press("End");

    await page.evaluate(() => {
        type Captured = {
            type: "keydown" | "beforeinput" | "input";
            target: Element | null;
            tagName: string;
            className: string;
            role: string | null;
            aria: string | null;
            editorOwned: boolean;
            editorFocused: boolean;
        };
        const key = "__intelliGitNativeInputProbe";
        const global = window as Window & {
            [key]?: {
                events: Captured[];
                handler: (event: Event) => void;
                activeElementOuterHtml: string;
            };
        };
        const describe = (event: Event): Captured => {
            const target = event.target instanceof Element ? event.target : null;
            const editor = target?.closest(".monaco-editor") ?? null;
            return {
                type: event.type as Captured["type"],
                target,
                tagName: target?.tagName ?? "",
                className: target?.getAttribute("class") ?? "",
                role: target?.getAttribute("role") ?? null,
                aria: target?.getAttribute("aria-label") ?? null,
                editorOwned: editor !== null && editor.contains(target),
                editorFocused: editor?.classList.contains("focused") === true,
            };
        };
        const state = {
            events: [] as Captured[],
            handler: (event: Event) => state.events.push(describe(event)),
            activeElementOuterHtml: document.activeElement?.outerHTML ?? "",
        };
        global[key] = state;
        document.addEventListener("keydown", state.handler, true);
        document.addEventListener("beforeinput", state.handler, true);
        document.addEventListener("input", state.handler, true);
    });
    await page.keyboard.press("x");
    await expectNativeLine(page, `${EDITABLE_LINE}x`);
    await page.keyboard.press("Backspace");
    await expectNativeLine(page, EDITABLE_LINE);

    const targetId = "intelligit-native-performance-input";
    const evidence = await page.evaluate((id): NativeInputEvidence => {
        const key = "__intelliGitNativeInputProbe";
        const global = window as Window & {
            [key]?: {
                events: Array<{
                    type: "keydown" | "beforeinput" | "input";
                    target: Element | null;
                    tagName: string;
                    className: string;
                    role: string | null;
                    aria: string | null;
                    editorOwned: boolean;
                    editorFocused: boolean;
                }>;
                handler: (event: Event) => void;
                activeElementOuterHtml: string;
            };
        };
        const state = global[key];
        if (state === undefined) throw new Error("Native input probe was not installed.");
        document.removeEventListener("keydown", state.handler, true);
        document.removeEventListener("beforeinput", state.handler, true);
        document.removeEventListener("input", state.handler, true);
        delete global[key];

        const candidate =
            state.events.find(
                (event) => event.type === "input" && event.editorOwned && event.editorFocused,
            ) ??
            state.events.find(
                (event) => event.type === "beforeinput" && event.editorOwned && event.editorFocused,
            ) ??
            state.events.find(
                (event) => event.type === "keydown" && event.editorOwned && event.editorFocused,
            );
        const target = candidate?.target ?? null;
        if (target === null || !target.isConnected) {
            throw new Error(
                "No focused Monaco-owned native input target received the reversible probe.",
            );
        }
        const editor = target.closest(".monaco-editor");
        const rect = editor?.getBoundingClientRect();
        if (
            editor === null ||
            !editor.classList.contains("focused") ||
            rect === undefined ||
            rect.width === 0 ||
            rect.height === 0 ||
            !editor.contains(document.activeElement)
        ) {
            throw new Error(
                "The native input target was not inside the visible focused Monaco editor.",
            );
        }
        target.setAttribute("data-testid", id);
        return {
            activeElementOuterHtml: state.activeElementOuterHtml,
            events: state.events.map(({ target: _target, ...event }) => event),
            target: {
                tagName: target.tagName,
                className: target.getAttribute("class") ?? "",
                role: target.getAttribute("role"),
                aria: target.getAttribute("aria-label"),
                editorOwned: true,
                editorFocused: true,
            },
        };
    }, targetId);
    expect(
        evidence.target,
        "the native probe must identify an editor-owned event target",
    ).not.toBeNull();

    const input = page.getByTestId(targetId);
    await expect(input).toBeFocused();
    return {
        surface: {
            name: "native",
            page,
            input,
            activateInput: async () => {
                await targetLine.click();
                await page.keyboard.press("End");
                await expect(input).toBeFocused();
            },
            assertValue: (expected) => expectNativeLine(page, expected),
            close: async () => {
                await page.keyboard.press(`${WORKBENCH_MODIFIER}+W`);
                const save = page.getByRole("button", { name: "Save", exact: true });
                await save.waitFor({ state: "visible", timeout: 1_000 }).catch(() => undefined);
                if (await save.isVisible().catch(() => false)) {
                    await save.click();
                    await expect(save).toBeHidden();
                }
            },
        },
        evidence,
    };
}

/** Reveals the editable custom diff from the persistent sidebar frame, which may recreate its webview. */
async function openCustom(
    page: Page,
    view: IntelliGitView,
    sidebar: FrameLocator,
): Promise<Surface> {
    const changesPanel = new ChangesPanel(sidebar);
    const changedRow = changesPanel.changedFileRow(PERFORMANCE_PATH);
    await expect(changedRow).toBeVisible();
    await changedRow.click();
    const diffFrame = await view.revealDiffViewer();
    await expect(diffFrame.locator('[data-testid="diff-viewer-root"]')).toBeVisible();
    const block = diffFrame
        .locator('[data-testid="diff-pane-right"] .diff-editable-block')
        .filter({ hasText: EDITABLE_LINE })
        .first();
    await expect(block).toBeVisible();
    await diffFrame.locator('[data-testid="diff-viewer-root"]').evaluate((root) => {
        root.ownerDocument.getSelection()?.removeAllRanges();
    });
    await block.click();
    let input = diffFrame.locator('[data-testid="diff-pane-right-editable"]');
    await expect(input).toBeFocused();
    await expect(input).toHaveValue(EDITABLE_LINE);
    await input.press("End");
    const refreshInput = async (): Promise<Locator> => {
        const currentFrame = await view.revealDiffViewer();
        input = currentFrame.locator('[data-testid="diff-pane-right-editable"]');
        await expect(input).toBeVisible();
        return input;
    };
    return {
        name: "custom",
        page,
        get input() {
            return input;
        },
        activateInput: async () => {
            const currentInput = await refreshInput();
            await currentInput.focus();
            await currentInput.press("End");
        },
        assertValue: async (expected) => expect(await refreshInput()).toHaveValue(expected),
        close: async () => {
            await page.keyboard.press(`${WORKBENCH_MODIFIER}+W`);
        },
    };
}

/** Installs renderer-local observers against the currently opened surface's actual input node. */
async function installTelemetry(input: Locator): Promise<TelemetrySupport> {
    return input.evaluate((target) => {
        type TimedEvent = { startTime: number; duration: number };
        const view = target.ownerDocument.defaultView;
        if (view === null) throw new Error("The editor input has no renderer window.");
        const global = view as Window & {
            __intelliGitPerformanceTelemetry?: {
                eventTimingMs: TimedEvent[];
                longTasksMs: number[];
                eventObserver?: PerformanceObserver;
                longTaskObserver?: PerformanceObserver;
            };
        };
        global.__intelliGitPerformanceTelemetry?.eventObserver?.disconnect();
        global.__intelliGitPerformanceTelemetry?.longTaskObserver?.disconnect();
        const telemetry: {
            eventTimingMs: TimedEvent[];
            longTasksMs: number[];
            eventObserver?: PerformanceObserver;
            longTaskObserver?: PerformanceObserver;
        } = { eventTimingMs: [], longTasksMs: [] };
        global.__intelliGitPerformanceTelemetry = telemetry;
        const supportedEntryTypes = view.PerformanceObserver?.supportedEntryTypes ?? [];

        let eventTiming = false;
        if (supportedEntryTypes.includes("event")) {
            try {
                const eventObserver = new view.PerformanceObserver((list) => {
                    for (const entry of list.getEntries()) {
                        const timing = entry as PerformanceEntry & { target?: EventTarget | null };
                        if (timing.name === "keydown" && timing.target === target) {
                            global.__intelliGitPerformanceTelemetry?.eventTimingMs.push({
                                startTime: timing.startTime,
                                duration: timing.duration,
                            });
                        }
                    }
                });
                eventObserver.observe({
                    type: "event",
                    buffered: true,
                    durationThreshold: 0,
                } as PerformanceObserverInit & {
                    durationThreshold: number;
                });
                telemetry.eventObserver = eventObserver;
                eventTiming = true;
            } catch {
                eventTiming = false;
            }
        }

        let longTask = false;
        if (supportedEntryTypes.includes("longtask")) {
            try {
                const longTaskObserver = new view.PerformanceObserver((list) => {
                    for (const entry of list.getEntries()) {
                        global.__intelliGitPerformanceTelemetry?.longTasksMs.push(entry.duration);
                    }
                });
                longTaskObserver.observe({ type: "longtask", buffered: false });
                telemetry.longTaskObserver = longTaskObserver;
                longTask = true;
            } catch {
                longTask = false;
            }
        }
        return { eventTiming, longTask };
    });
}

/** Clears only the current renderer realm's observer samples immediately before a measured batch. */
async function resetTelemetry(input: Locator): Promise<void> {
    await input.evaluate((target) => {
        const view = target.ownerDocument.defaultView as
            | (Window & {
                  __intelliGitPerformanceTelemetry?: {
                      eventTimingMs: unknown[];
                      longTasksMs: unknown[];
                  };
              })
            | null;
        if (view?.__intelliGitPerformanceTelemetry === undefined) {
            throw new Error("Telemetry must be installed after the current surface opens.");
        }
        view.__intelliGitPerformanceTelemetry.eventTimingMs.length = 0;
        view.__intelliGitPerformanceTelemetry.longTasksMs.length = 0;
    });
}

/** Disconnects the current realm's observers once its bounded sample batch has drained. */
async function stopTelemetry(input: Locator): Promise<void> {
    await input.evaluate((target) => {
        const view = target.ownerDocument.defaultView as
            | (Window & {
                  __intelliGitPerformanceTelemetry?: {
                      eventObserver?: PerformanceObserver;
                      longTaskObserver?: PerformanceObserver;
                  };
              })
            | null;
        view?.__intelliGitPerformanceTelemetry?.eventObserver?.disconnect();
        view?.__intelliGitPerformanceTelemetry?.longTaskObserver?.disconnect();
    });
}

/** Waits for two paints in the input's own renderer without mixing Playwright IPC into the interval. */
async function doubleRaf(input: Locator): Promise<void> {
    await input.evaluate(
        (target) =>
            new Promise<void>((resolve) => {
                const view = target.ownerDocument.defaultView;
                if (view === null) throw new Error("The editor input has no renderer window.");
                view.requestAnimationFrame(() => view.requestAnimationFrame(() => resolve()));
            }),
    );
}

/** Measures from that input element's `keydown` event to its second following animation frame. */
async function inputToAfterPaint(
    surface: Surface,
    key: string,
): Promise<{ durationMs: number; eventStartTimeMs: number }> {
    await surface.activateInput();
    const input = surface.input;
    const token = await input.evaluate((target) => {
        const view = target.ownerDocument.defaultView;
        if (view === null) throw new Error("The editor input has no renderer window.");
        const global = view as Window & {
            __intelliGitInputTimers?: Map<
                string,
                Promise<{ durationMs: number; eventStartTimeMs: number }>
            >;
        };
        const timers = (global.__intelliGitInputTimers ??= new Map());
        const id = `input-${view.performance.now()}-${timers.size}`;
        const promise = new Promise<{ durationMs: number; eventStartTimeMs: number }>(
            (resolve, reject) => {
                const timeout = view.setTimeout(() => {
                    target.removeEventListener("keydown", onInput);
                    reject(
                        new Error(
                            `The sampled key did not emit a keydown event on ${target.tagName}.${target.className}.`,
                        ),
                    );
                }, 5_000);
                const onInput = (event: Event) => {
                    const handlerStartedAt = view.performance.now();
                    view.clearTimeout(timeout);
                    view.requestAnimationFrame(() =>
                        view.requestAnimationFrame(() =>
                            resolve({
                                durationMs: view.performance.now() - handlerStartedAt,
                                eventStartTimeMs: event.timeStamp,
                            }),
                        ),
                    );
                };
                target.addEventListener("keydown", onInput, { once: true });
            },
        );
        timers.set(id, promise);
        return id;
    });
    await surface.page.keyboard.press(key);
    return input.evaluate(async (target, id) => {
        const view = target.ownerDocument.defaultView as
            | (Window & {
                  __intelliGitInputTimers?: Map<
                      string,
                      Promise<{ durationMs: number; eventStartTimeMs: number }>
                  >;
              })
            | null;
        const promise = view?.__intelliGitInputTimers?.get(id);
        if (promise === undefined) throw new Error("The sampled input timer was detached.");
        try {
            return await promise;
        } finally {
            view?.__intelliGitInputTimers?.delete(id);
        }
    }, token);
}

/** Types reversible insertion/backspace pairs and validates bytes only after each renderer timer resolves. */
async function typePairs(
    surface: Surface,
    pairCount: number,
    sampled: boolean,
): Promise<SampledKeys> {
    const doubleRafMs: number[] = [];
    const startTimesMs: number[] = [];
    for (let index = 0; index < pairCount; index += 1) {
        const insertion = await inputToAfterPaint(surface, "x");
        if (sampled) {
            doubleRafMs.push(insertion.durationMs);
            startTimesMs.push(insertion.eventStartTimeMs);
        }
        await surface.assertValue(`${EDITABLE_LINE}x`);

        const deletion = await inputToAfterPaint(surface, "Backspace");
        if (sampled) {
            doubleRafMs.push(deletion.durationMs);
            startTimesMs.push(deletion.eventStartTimeMs);
        }
        await surface.assertValue(EDITABLE_LINE);
    }
    return { doubleRafMs, startTimesMs };
}

/** Reads target-matched Event Timing entries after a renderer drain, not during the double-rAF timer. */
async function eventTimingSamples(
    input: Locator,
    sampledStartTimesMs: readonly number[],
): Promise<number[]> {
    await doubleRaf(input);
    return input.evaluate((target, sampledStarts) => {
        const view = target.ownerDocument.defaultView as
            | (Window & {
                  __intelliGitPerformanceTelemetry?: {
                      eventTimingMs: Array<{ startTime: number; duration: number }>;
                  };
              })
            | null;
        const entries = view?.__intelliGitPerformanceTelemetry?.eventTimingMs ?? [];
        const used = new Set<number>();
        return sampledStarts.flatMap((sampledStart) => {
            const index = entries.findIndex(
                (entry, candidateIndex) =>
                    !used.has(candidateIndex) && Math.abs(entry.startTime - sampledStart) <= 4,
            );
            if (index < 0) return [];
            used.add(index);
            return [entries[index]!.duration];
        });
    }, sampledStartTimesMs);
}

/** Collects exactly the requested number of rAF intervals in the currently active renderer realm. */
async function frameIntervals(input: Locator): Promise<number[]> {
    return input.evaluate((target, count) => {
        const view = target.ownerDocument.defaultView;
        if (view === null) throw new Error("The editor input has no renderer window.");
        return new Promise<number[]>((resolve) => {
            const intervals: number[] = [];
            let previous = view.performance.now();
            const tick = (now: number) => {
                intervals.push(now - previous);
                previous = now;
                if (intervals.length >= count) resolve(intervals);
                else view.requestAnimationFrame(tick);
            };
            view.requestAnimationFrame(tick);
        });
    }, FRAME_INTERVAL_COUNT);
}

/** Starts a Chromium trace scoped to one sampled batch when Long Tasks cannot be observed. */
async function startChromiumTrace(
    page: Page,
): Promise<{ stop: () => Promise<TraceEvidence> } | undefined> {
    try {
        const session = await page.context().newCDPSession(page);
        const events: unknown[] = [];
        let finishTrace!: () => void;
        const completed = new Promise<void>((resolve) => {
            finishTrace = resolve;
        });
        session.on("Tracing.dataCollected", (payload: unknown) => {
            const value = (payload as { value?: unknown[] }).value;
            if (Array.isArray(value)) events.push(...value);
        });
        session.once("Tracing.tracingComplete", finishTrace);
        await session.send("Tracing.start", {
            categories: "devtools.timeline,toplevel,disabled-by-default-devtools.timeline",
            transferMode: "ReportEvents",
        });
        return {
            stop: async () => {
                try {
                    await session.send("Tracing.end");
                    await Promise.race([
                        completed,
                        new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
                    ]);
                    const taskDurationsMs = events.flatMap((event) => {
                        const trace = event as { name?: unknown; ph?: unknown; dur?: unknown };
                        return trace.ph === "X" &&
                            trace.name === "RunTask" &&
                            typeof trace.dur === "number"
                            ? [trace.dur / 1_000]
                            : [];
                    });
                    return {
                        supported: taskDurationsMs.length > 0,
                        taskDurationsMs,
                        events,
                        ...(taskDurationsMs.length === 0
                            ? { error: "Chromium trace returned no RunTask duration evidence." }
                            : {}),
                    };
                } finally {
                    await session.detach();
                }
            },
        };
    } catch (error) {
        return undefined;
    }
}

/** Bounds Long Task or trace evidence to a single sampled typing batch. */
async function collectSampleBatch(
    page: Page,
    surface: Surface,
    support: TelemetrySupport,
): Promise<BatchEvidence> {
    await resetTelemetry(surface.input);
    const trace = support.longTask ? undefined : await startChromiumTrace(page);
    const sampledKeys = await typePairs(surface, SAMPLED_PAIRS_PER_BATCH, true);
    const traceEvidence = trace === undefined ? undefined : await trace.stop();
    await doubleRaf(surface.input);
    const longTasksMs = await surface.input.evaluate((target) => {
        const view = target.ownerDocument.defaultView as
            | (Window & {
                  __intelliGitPerformanceTelemetry?: { longTasksMs: number[] };
              })
            | null;
        return view?.__intelliGitPerformanceTelemetry?.longTasksMs ?? [];
    });
    const eventTimingMs = await eventTimingSamples(surface.input, sampledKeys.startTimesMs);
    await stopTelemetry(surface.input);
    return {
        surface: surface.name,
        support,
        eventTimingMs,
        doubleRafMs: sampledKeys.doubleRafMs,
        longTasksMs: support.longTask ? longTasksMs : (traceEvidence?.taskDurationsMs ?? []),
        longTaskEvidence: support.longTask
            ? "long-task"
            : traceEvidence?.supported === true
              ? "chromium-trace"
              : "unavailable",
        trace: traceEvidence,
    };
}

/** Returns a nearest-rank percentile, retaining the complete raw samples in the attached artifact. */
function percentile(samples: readonly number[], percentileValue: number): number {
    expect(samples.length, "performance samples must not be empty").toBeGreaterThan(0);
    const ordered = [...samples].sort((left, right) => left - right);
    return ordered[Math.ceil((percentileValue / 100) * ordered.length) - 1]!;
}

/** Creates the plan's portable metric shape after both surfaces complete the same workload. */
function metricsFor(
    surface: SurfaceName,
    measurement: Measurement,
    frameIntervalMs: number,
    samplesMs: readonly number[],
    longTasksMs: readonly number[],
): EditorLatencyMetrics {
    return {
        surface,
        measurement,
        frameIntervalMs,
        samplesMs,
        p50Ms: percentile(samplesMs, 50),
        p95Ms: percentile(samplesMs, 95),
        maxMs: Math.max(...samplesMs),
        longTasksMs,
    };
}

/** Arms the host-echo observer before editing so inbound data and its first two paints are timestamped. */
async function armHostEchoObserver(input: Locator, ribbonsBefore: number): Promise<void> {
    await input.evaluate((target, previousRibbonCount) => {
        const view = target.ownerDocument.defaultView;
        if (view === null) throw new Error("The editable input has no renderer window.");
        const root = target.closest('[data-testid="diff-viewer-root"]');
        const ribbonLayer = root?.querySelector(".diff-ribbon-layer");
        if (ribbonLayer === null || ribbonLayer === undefined) {
            throw new Error("The editable input has no visible ribbon layer.");
        }
        const global = view as Window & {
            __intelliGitHostEcho?: Promise<{
                inputAtMs: number;
                inboundAtMs: number;
                afterPaintAtMs: number;
            }>;
        };
        global.__intelliGitHostEcho = new Promise((resolve, reject) => {
            let inputAtMs: number | undefined;
            let inboundAtMs: number | undefined;
            let settling = false;
            let observer: MutationObserver;
            const timeout = view.setTimeout(() => {
                cleanup();
                reject(
                    new Error(
                        "No visible ribbon-count change arrived after the host setDiffData echo.",
                    ),
                );
            }, 5_000);
            const cleanup = () => {
                view.clearTimeout(timeout);
                target.removeEventListener("input", onInput);
                view.removeEventListener("message", onMessage);
                observer.disconnect();
            };
            const resolveAfterVisiblePaint = () => {
                if (
                    settling ||
                    inputAtMs === undefined ||
                    inboundAtMs === undefined ||
                    ribbonLayer.querySelectorAll(".diff-ribbon").length >= previousRibbonCount
                ) {
                    return;
                }
                settling = true;
                const startedAtMs = inputAtMs;
                const receivedAtMs = inboundAtMs;
                view.requestAnimationFrame(() =>
                    view.requestAnimationFrame(() => {
                        cleanup();
                        resolve({
                            inputAtMs: startedAtMs,
                            inboundAtMs: receivedAtMs,
                            afterPaintAtMs: view.performance.now(),
                        });
                    }),
                );
            };
            const onInput = () => {
                inputAtMs ??= view.performance.now();
                resolveAfterVisiblePaint();
            };
            const onMessage = (event: MessageEvent<unknown>) => {
                const data = event.data as { type?: unknown } | null;
                if (inputAtMs === undefined || data?.type !== "setDiffData") return;
                inboundAtMs = view.performance.now();
                resolveAfterVisiblePaint();
            };
            observer = new view.MutationObserver(resolveAfterVisiblePaint);
            target.addEventListener("input", onInput, { once: true });
            view.addEventListener("message", onMessage);
            observer.observe(ribbonLayer, { childList: true, subtree: true });
        });
    }, ribbonsBefore);
}

/** Resolves the already armed echo observation after a real host message returns to the webview. */
async function hostEchoObservation(
    input: Locator,
): Promise<{ inputAtMs: number; inboundAtMs: number; afterPaintAtMs: number }> {
    return input.evaluate(async (target) => {
        const view = target.ownerDocument.defaultView as
            | (Window & {
                  __intelliGitHostEcho?: Promise<{
                      inputAtMs: number;
                      inboundAtMs: number;
                      afterPaintAtMs: number;
                  }>;
              })
            | null;
        const observation = view?.__intelliGitHostEcho;
        if (observation === undefined) throw new Error("Host echo observer was not armed.");
        try {
            return await observation;
        } finally {
            delete view?.__intelliGitHostEcho;
        }
    });
}

test.describe("editable diff viewer performance", () => {
    test.use({ scenario: "dirty" });

    test("keeps the native-relative editable-diff budget in one Electron session", async ({
        fixtureWorkspace,
    }, testInfo) => {
        test.setTimeout(180_000);
        await seedLargeDocument(fixtureWorkspace);
        const { electronApp, page, view, sidebar } = await launchWorkspace(fixtureWorkspace);
        const batches: Record<SurfaceName, BatchEvidence[]> = { native: [], custom: [] };
        const frameSamples: Record<SurfaceName, number[]> = { native: [], custom: [] };
        const initialOpenMs: Record<SurfaceName, number | null> = { native: null, custom: null };
        const nativeInputEvidence: NativeInputEvidence[] = [];

        try {
            for (const order of PAIRED_ROUND_ORDERS) {
                for (const surfaceName of order) {
                    const openStartedAt = Date.now();
                    const opened =
                        surfaceName === "native"
                            ? await openNative(page)
                            : {
                                  surface: await openCustom(page, view, sidebar),
                                  evidence: undefined,
                              };
                    initialOpenMs[surfaceName] ??= Date.now() - openStartedAt;
                    const surface = opened.surface;
                    if (opened.evidence !== undefined) {
                        nativeInputEvidence.push(opened.evidence);
                        await testInfo.attach(
                            `native-input-probe-${nativeInputEvidence.length}.json`,
                            {
                                body: JSON.stringify(opened.evidence, null, 2),
                                contentType: "application/json",
                            },
                        );
                    }
                    if (frameSamples[surfaceName].length === 0) {
                        frameSamples[surfaceName] = await frameIntervals(surface.input);
                    }
                    await typePairs(surface, WARMUP_PAIRS, false);
                    const support = await installTelemetry(surface.input);
                    batches[surfaceName].push(await collectSampleBatch(page, surface, support));
                    await expect
                        .poll(() =>
                            readFile(
                                path.join(fixtureWorkspace.workspace.root, PERFORMANCE_PATH),
                                "utf8",
                            ),
                        )
                        .toBe(buildEditableDiffPerformanceFixture().rightText);
                    await surface.close();
                }
            }

            const sampledPairsPerSurface = SAMPLED_PAIRS_PER_BATCH * PAIRED_ROUND_ORDERS.length;
            expect(sampledPairsPerSurface).toBeGreaterThanOrEqual(50);
            expect(frameSamples.native).toHaveLength(FRAME_INTERVAL_COUNT);
            expect(frameSamples.custom).toHaveLength(FRAME_INTERVAL_COUNT);
            expect(initialOpenMs.native).not.toBeNull();
            expect(initialOpenMs.custom).not.toBeNull();

            const allBatches = [...batches.native, ...batches.custom];
            const expectedKeySamples = sampledPairsPerSurface * 2;
            const useEventTiming = allBatches.every(
                (batch) =>
                    batch.support.eventTiming &&
                    batch.eventTimingMs.length >= expectedKeySamples / 4,
            );
            const measurement: Measurement = useEventTiming ? "event-timing" : "double-raf";
            const metrics = (["native", "custom"] as const).map((surface) => {
                const surfaceBatches = batches[surface];
                const samplesMs = surfaceBatches.flatMap((batch) =>
                    measurement === "event-timing" ? batch.eventTimingMs : batch.doubleRafMs,
                );
                return metricsFor(
                    surface,
                    measurement,
                    percentile(frameSamples[surface], 50),
                    samplesMs,
                    surfaceBatches.flatMap((batch) => batch.longTasksMs),
                );
            });
            const nativeMetrics = metrics.find((metric) => metric.surface === "native")!;
            const customMetrics = metrics.find((metric) => metric.surface === "custom")!;

            const echoSurface = await openCustom(page, view, sidebar);
            const ribbons = (await view.revealDiffViewer()).locator(
                ".diff-ribbon-layer .diff-ribbon",
            );
            const ribbonsBefore = await ribbons.count();
            await echoSurface.input.evaluate((target) => {
                const view = target.ownerDocument.defaultView as
                    | (Window & { __intelliGitEchoInput?: Element })
                    | null;
                if (view === null) throw new Error("The echo input has no renderer window.");
                view.__intelliGitEchoInput = target;
            });
            await armHostEchoObserver(echoSurface.input, ribbonsBefore);
            await echoSurface.input.fill(HEAD_LINE);
            const echo = await hostEchoObservation(echoSurface.input);
            expect(await ribbons.count()).toBeLessThan(ribbonsBefore);
            await expect(echoSurface.input).toBeFocused();
            const echoedDraft = await echoSurface.input.inputValue();
            expect(echoedDraft).toContain(HEAD_LINE);
            expect(echoedDraft).not.toContain(EDITABLE_LINE);
            const sameInputNode = await echoSurface.input.evaluate((target) => {
                const view = target.ownerDocument.defaultView as
                    | (Window & { __intelliGitEchoInput?: Element })
                    | null;
                const same = view?.__intelliGitEchoInput === target;
                delete view?.__intelliGitEchoInput;
                return same;
            });
            expect(sameInputNode).toBe(true);
            const hostEcho = {
                totalVisibleMs: echo.afterPaintAtMs - echo.inputAtMs,
                inboundToAfterPaintMs: echo.afterPaintAtMs - echo.inboundAtMs,
                focusAndDraftPreserved: sameInputNode,
            };

            const telemetry = {
                eventTimingAvailableForEveryBatch: useEventTiming,
                longTaskEvidence: Object.fromEntries(
                    (["native", "custom"] as const).map((surface) => [
                        surface,
                        batches[surface].map((batch) => batch.longTaskEvidence),
                    ]),
                ),
            };
            const artifact = {
                pairedRoundOrders: PAIRED_ROUND_ORDERS,
                warmupPairsPerSurfacePerRound: WARMUP_PAIRS,
                sampledPairsPerSurface,
                initialOpenMs,
                telemetry,
                nativeInputEvidence,
                hostEcho,
                metrics,
            };
            const metricsPath = testInfo.outputPath("diff-viewer-performance-metrics.json");
            await writeFile(metricsPath, JSON.stringify(artifact, null, 2), "utf8");
            await testInfo.attach("diff-viewer-performance-metrics.json", {
                path: metricsPath,
                contentType: "application/json",
            });
            for (const [surface, surfaceBatches] of Object.entries(batches) as [
                SurfaceName,
                BatchEvidence[],
            ][]) {
                for (const [index, batch] of surfaceBatches.entries()) {
                    if (batch.trace?.supported === true) {
                        await testInfo.attach(`${surface}-sample-batch-${index + 1}-trace.json`, {
                            body: JSON.stringify(batch.trace),
                            contentType: "application/json",
                        });
                    }
                }
            }

            expect(
                allBatches.filter((batch) => batch.longTaskEvidence === "unavailable"),
                "Long Task or a non-empty Chromium trace is required for every sampled batch.",
            ).toEqual([]);
            expect(customMetrics.p95Ms).toBeLessThanOrEqual(
                nativeMetrics.p95Ms + nativeMetrics.frameIntervalMs,
            );
            expect(customMetrics.p95Ms).toBeLessThanOrEqual(MAX_EDITABLE_P95_MS);
            expect(customMetrics.longTasksMs.filter((duration) => duration > 50)).toEqual([]);
            expect(hostEcho.totalVisibleMs).toBeLessThanOrEqual(1_250);
            expect(hostEcho.inboundToAfterPaintMs).toBeLessThanOrEqual(50);
        } finally {
            await electronApp.close();
        }
    });
});
