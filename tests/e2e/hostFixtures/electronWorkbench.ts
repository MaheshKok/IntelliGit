import { open, readdir } from "node:fs/promises";
import path from "node:path";
import type { ElectronApplication, Page, TestInfo } from "@playwright/test";

const WORKBENCH_SELECTOR = ".monaco-workbench .part.editor";
const LOG_LIMIT_BYTES = 256 * 1024;
const MAX_LOG_FILES = 20;
const MAX_LOG_DIRECTORIES = 64;
const CORE_LOG_NAMES = ["main.log", "renderer.log", "exthost.log"];

function isWorkbenchPage(page: Page): boolean {
    // Covers production and development workbench entry points; never accepts a splash,
    // about:blank, or an extension webview simply because Electron created it first.
    return /\/workbench(?:-dev)?(?:\.esm)?\.html(?:[?#]|$)/.test(page.url());
}

/**
 * Selects the actual VS Code workbench and waits for its editor shell to render. Electron's first
 * window and DOMContentLoaded are lifecycle events, not proof that the workbench is usable. Polling
 * the current windows also handles a page that navigates from about:blank after it was announced.
 * The deadline is shared across all windows; no launch or failed action is retried.
 */
export async function waitForWorkbench(
    app: ElectronApplication,
    timeoutMs = 30_000,
): Promise<Page> {
    return new Promise<Page>((resolve, reject) => {
        let finished = false;
        let poll: ReturnType<typeof setTimeout> | undefined;
        const observed = new Set<Page>();
        const checking = new Set<Page>();
        const child = app.process();
        const listeners: Array<() => void> = [];
        const finish = (error?: Error, page?: Page): void => {
            if (finished) return;
            finished = true;
            clearTimeout(deadline);
            clearTimeout(poll);
            app.removeListener("close", onClose);
            app.removeListener("window", observe);
            child.removeListener("exit", onExit);
            for (const remove of listeners) remove();
            if (error) reject(error);
            else resolve(page!);
        };
        const onClose = (): void => finish(new Error("Electron closed before workbench readiness"));
        const onExit = (code: number | null, signal: string | null): void =>
            finish(
                new Error(
                    `Electron exited before workbench readiness: code=${code}, signal=${signal}`,
                ),
            );
        const observe = (page: Page): void => {
            if (observed.has(page)) return;
            observed.add(page);
            const onCrash = (): void => {
                if (isWorkbenchPage(page)) {
                    finish(new Error(`Workbench renderer crashed before readiness: ${page.url()}`));
                }
            };
            const onPageClose = (): void => {
                if (isWorkbenchPage(page)) {
                    finish(new Error(`Workbench window closed before readiness: ${page.url()}`));
                }
            };
            page.on("crash", onCrash);
            page.on("close", onPageClose);
            listeners.push(() => {
                page.removeListener("crash", onCrash);
                page.removeListener("close", onPageClose);
            });
        };
        const deadline = setTimeout(() => {
            finish(
                new Error(
                    `VS Code workbench did not become ready within ${timeoutMs}ms ` +
                        `(expected visible ${WORKBENCH_SELECTOR}). Windows: ` +
                        JSON.stringify(app.windows().map((page) => page.url())),
                ),
            );
        }, timeoutMs);
        app.on("close", onClose);
        app.on("window", observe);
        child.on("exit", onExit);
        const check = (): void => {
            if (finished) return;
            if (child.exitCode !== null || child.signalCode !== null) {
                onExit(child.exitCode, child.signalCode);
                return;
            }
            for (const page of app.windows()) {
                observe(page);
                if (page.isClosed() || !isWorkbenchPage(page) || checking.has(page)) continue;
                checking.add(page);
                // One pending probe per window: a hung renderer cannot stall checks of other
                // windows or consume the shared deadline with a queue of duplicate RPCs.
                void page
                    .locator(WORKBENCH_SELECTOR)
                    .isVisible()
                    .then((ready) => {
                        if (ready && !page.isClosed() && isWorkbenchPage(page))
                            finish(undefined, page);
                    })
                    .catch(() => undefined)
                    .finally(() => checking.delete(page));
            }
            poll = setTimeout(check, 100);
        };
        check();
    });
}

/**
 * Reads only bounded tails of diagnostic .log files beneath the disposable profile's logs folder.
 * Symlinks and unrelated profile contents are excluded. Missing logs are normal for early failures.
 */
export async function readWorkbenchLogs(
    profileDir: string,
): Promise<Array<{ name: string; body: Buffer }>> {
    const logsRoot = path.join(profileDir, "logs");
    const directories = [logsRoot];
    const candidates: Array<{ filename: string; priority: number }> = [];
    // Keep discovery bounded too, while delaying file reads until core logs have had a chance
    // to displace lower-priority extension/output logs from the attachment budget.
    for (let index = 0; index < directories.length; index++) {
        const directory = directories[index];
        const entries = await readdir(directory, { withFileTypes: true }).catch(
            (error: NodeJS.ErrnoException) => {
                if (error.code === "ENOENT") return [];
                throw error;
            },
        );
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            const filename = path.join(directory, entry.name);
            if (entry.isDirectory() && directories.length < MAX_LOG_DIRECTORIES) {
                directories.push(filename);
            } else if (entry.isFile() && entry.name.endsWith(".log")) {
                const corePriority = CORE_LOG_NAMES.indexOf(entry.name);
                candidates.push({
                    filename,
                    priority: corePriority < 0 ? CORE_LOG_NAMES.length : corePriority,
                });
                candidates.sort(
                    (a, b) => a.priority - b.priority || a.filename.localeCompare(b.filename),
                );
                if (candidates.length > MAX_LOG_FILES) candidates.pop();
            }
        }
    }
    const logs: Array<{ name: string; body: Buffer }> = [];
    for (const { filename } of candidates) {
        const file = await open(filename, "r");
        try {
            const { size } = await file.stat();
            const body = Buffer.alloc(Math.min(size, LOG_LIMIT_BYTES));
            const { bytesRead } = await file.read(
                body,
                0,
                body.length,
                Math.max(0, size - body.length),
            );
            logs.push({
                name: `vscode-${path.relative(logsRoot, filename).split(path.sep).join("-")}`,
                body: body.subarray(0, bytesRead),
            });
        } finally {
            await file.close();
        }
    }
    return logs;
}

async function boundedDiagnostic<T>(operation: Promise<T>): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            operation,
            new Promise<never>((_, reject) => {
                timeout = setTimeout(
                    () => reject(new Error("Renderer diagnostic timed out after 3000ms")),
                    3_000,
                );
            }),
        ]);
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * Captures startup events as soon as launch yields an app. Profile logs cover the earlier launch
 * interval too. Call attach on failure before closing Electron or disposing its profile; diagnostics
 * are best-effort and must not replace the original test failure, even if a renderer is unresponsive.
 */
export class WorkbenchDiagnostics {
    private readonly events: string[] = [];
    private readonly pages = new Set<Page>();
    private readonly removeListeners: Array<() => void> = [];
    private stderr = "";
    private app?: ElectronApplication;

    public constructor(private readonly profileDir: string) {}

    private record(message: string): void {
        this.events.push(`${new Date().toISOString()} ${message.slice(0, 4_096)}`);
        if (this.events.length > 200) this.events.shift();
    }

    /** Begins observing existing and future windows without awaiting renderer or main-process RPCs. */
    public observe(app: ElectronApplication): void {
        this.app = app;
        const observePage = (page: Page): void => {
            if (this.pages.has(page)) return;
            this.pages.add(page);
            const label = `window ${this.pages.size}`;
            this.record(`${label} observed: ${page.url()}`);
            const onConsole = (message: { type(): string; text(): string }): void =>
                this.record(`${label} console ${message.type()}: ${message.text()}`);
            const onError = (error: Error): void =>
                this.record(`${label} pageerror: ${error.stack ?? error.message}`);
            const onCrash = (): void => this.record(`${label} renderer crashed`);
            const onClose = (): void => this.record(`${label} closed`);
            const onNavigate = (): void => this.record(`${label} navigated: ${page.url()}`);
            const onDomReady = (): void => this.record(`${label} domcontentloaded: ${page.url()}`);
            page.on("console", onConsole);
            page.on("pageerror", onError);
            page.on("crash", onCrash);
            page.on("close", onClose);
            page.on("framenavigated", onNavigate);
            page.on("domcontentloaded", onDomReady);
            this.removeListeners.push(() => {
                page.removeListener("console", onConsole);
                page.removeListener("pageerror", onError);
                page.removeListener("crash", onCrash);
                page.removeListener("close", onClose);
                page.removeListener("framenavigated", onNavigate);
                page.removeListener("domcontentloaded", onDomReady);
            });
        };
        const onClose = (): void => this.record("Electron application closed");
        const child = app.process();
        const onStderr = (chunk: Buffer | string): void => {
            this.stderr = (this.stderr + chunk.toString()).slice(-LOG_LIMIT_BYTES);
        };
        const onExit = (code: number | null, signal: string | null): void =>
            this.record(`Electron process exited: code=${code}, signal=${signal}`);
        app.on("window", observePage);
        app.on("close", onClose);
        child.stderr?.on("data", onStderr);
        child.on("exit", onExit);
        this.record(
            `Electron process: pid=${child.pid}, exitCode=${child.exitCode}, signalCode=${child.signalCode}`,
        );
        this.removeListeners.push(() => {
            app.removeListener("window", observePage);
            app.removeListener("close", onClose);
            child.stderr?.removeListener("data", onStderr);
            child.removeListener("exit", onExit);
        });
        for (const page of app.windows()) observePage(page);
    }

    /** Attaches logs and bounded screenshots while the app and profile still exist. Never throws. */
    public async attach(testInfo: Pick<TestInfo, "attach">): Promise<void> {
        const attach = async (
            name: string,
            body: string | Buffer,
            contentType = "text/plain",
        ): Promise<void> => {
            try {
                await testInfo.attach(name, { body, contentType });
            } catch (error) {
                console.warn(`Cannot attach ${name}:`, error);
            }
        };
        // Persist cheap, renderer-independent evidence first, before any potentially broken RPC.
        const child = this.app?.process();
        await attach(
            "electron-startup.log",
            [
                ...this.events,
                `Process state: exitCode=${child?.exitCode}, signalCode=${child?.signalCode}`,
                ...Array.from(
                    this.pages,
                    (page, index) =>
                        `window ${index + 1}: closed=${page.isClosed()}, url=${page.url()}`,
                ),
            ].join("\n"),
        );
        await attach("electron-stderr.log", this.stderr || "<no stderr captured after launch>\n");
        try {
            const logs = await readWorkbenchLogs(this.profileDir);
            for (const log of logs) await attach(log.name, log.body);
            if (logs.length === 0) await attach("vscode-logs.log", "<no profile logs available>\n");
        } catch (error) {
            await attach("vscode-log-collection-error.log", String(error));
        }
        await Promise.all(
            Array.from(this.pages).map(async (page, index) => {
                if (page.isClosed()) return;
                const notifications = (async () => {
                    try {
                        const messages = await boundedDiagnostic(
                            page
                                .locator(".notifications-toasts, .notifications-center")
                                .allInnerTexts(),
                        );
                        await attach(
                            `electron-window-${index + 1}-notifications.log`,
                            messages.join("\n\n") || "<no notifications>\n",
                        );
                    } catch (error) {
                        await attach(
                            `electron-window-${index + 1}-notifications-error.log`,
                            String(error),
                        );
                    }
                })();
                try {
                    const screenshot = await page.screenshot({ timeout: 3_000 });
                    await attach(`electron-window-${index + 1}.png`, screenshot, "image/png");
                } catch (error) {
                    await attach(
                        `electron-window-${index + 1}-screenshot-error.log`,
                        String(error),
                    );
                }
                await notifications;
            }),
        );
    }

    /** Removes only this collector's listeners once failure evidence has been saved. */
    public dispose(): void {
        for (const remove of this.removeListeners) remove();
        this.removeListeners.length = 0;
    }
}
