import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    readWorkbenchLogs,
    waitForWorkbench,
    WorkbenchDiagnostics,
} from "../../e2e/hostFixtures/electronWorkbench";
import { removeScratchDirectories } from "../../helpers/scratchDirectories";

const WORKBENCH_URL =
    "vscode-file://vscode-app/out/vs/code/electron-browser/workbench/workbench.html";

class FakePage extends EventEmitter {
    public closed = false;
    public currentUrl: string;
    public isVisible = vi.fn(async () => false);
    public allInnerTexts = vi.fn(async () => [
        "Stash failed: full Git stderr beyond the clipped toast",
    ]);
    public locator = vi.fn(() => ({
        isVisible: this.isVisible,
        allInnerTexts: this.allInnerTexts,
    }));
    public screenshot = vi.fn(async () => Buffer.from("screenshot"));
    public constructor(url = WORKBENCH_URL) {
        super();
        this.currentUrl = url;
    }
    public url(): string {
        return this.currentUrl;
    }
    public isClosed(): boolean {
        return this.closed;
    }
    public asPage(): Page {
        return this as unknown as Page;
    }
}

class FakeApp extends EventEmitter {
    public pages: FakePage[] = [];
    public child = Object.assign(new EventEmitter(), {
        stderr: new EventEmitter(),
        pid: 123,
        exitCode: null as number | null,
        signalCode: null as string | null,
    });
    public windows(): Page[] {
        return this.pages.map((page) => page.asPage());
    }
    public process(): typeof this.child {
        return this.child;
    }
    public asApp(): ElectronApplication {
        return this as unknown as ElectronApplication;
    }
}

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("waitForWorkbench", () => {
    beforeEach(() => vi.useFakeTimers());

    it("ignores the first splash and chooses the rendered workbench without a load-state wait", async () => {
        const app = new FakeApp();
        const splash = new FakePage("about:blank");
        splash.isVisible.mockResolvedValue(true);
        const workbench = new FakePage();
        workbench.isVisible.mockResolvedValue(true);
        app.pages.push(splash, workbench);

        await expect(waitForWorkbench(app.asApp())).resolves.toBe(workbench);
        expect(splash.locator).not.toHaveBeenCalled();
        expect(workbench.locator).toHaveBeenCalledWith(".monaco-workbench .part.editor");
        expect(app.listenerCount("window")).toBe(0);
        expect(workbench.listenerCount("crash")).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("waits for a late window, navigation, and a visible editor shell", async () => {
        const app = new FakeApp();
        const ready = waitForWorkbench(app.asApp());
        const page = new FakePage("about:blank");
        app.pages.push(page);
        app.emit("window", page);
        await vi.advanceTimersByTimeAsync(100);
        expect(page.locator).not.toHaveBeenCalled();
        page.currentUrl = WORKBENCH_URL;
        await vi.advanceTimersByTimeAsync(100);
        expect(page.isVisible).toHaveBeenCalledTimes(1);
        page.isVisible.mockResolvedValue(true);
        await vi.advanceTimersByTimeAsync(100);
        await expect(ready).resolves.toBe(page);
    });

    it("does not let a hung candidate block a later usable workbench", async () => {
        const app = new FakeApp();
        const hung = new FakePage();
        hung.isVisible.mockImplementation(() => new Promise(() => undefined));
        app.pages.push(hung);
        const ready = waitForWorkbench(app.asApp());
        const page = new FakePage(WORKBENCH_URL.replace("workbench.html", "workbench-dev.html"));
        page.isVisible.mockResolvedValue(true);
        app.pages.push(page);
        app.emit("window", page);
        await vi.advanceTimersByTimeAsync(100);
        await expect(ready).resolves.toBe(page);
        expect(hung.isVisible).toHaveBeenCalledTimes(1);
    });

    it("keeps the original deadline even when renderer RPC never responds", async () => {
        const app = new FakeApp();
        const page = new FakePage();
        page.isVisible.mockImplementation(() => new Promise(() => undefined));
        app.pages.push(page);
        const failure = expect(waitForWorkbench(app.asApp(), 500)).rejects.toThrow(
            /did not become ready within 500ms.*workbench.html/,
        );
        await vi.advanceTimersByTimeAsync(500);
        await failure;
        expect(page.isVisible).toHaveBeenCalledTimes(1);
        expect(app.listenerCount("close")).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each(["crash", "close"] as const)(
        "fails immediately when the workbench emits %s",
        async (event) => {
            const app = new FakeApp();
            const page = new FakePage();
            app.pages.push(page);
            const failure = expect(waitForWorkbench(app.asApp())).rejects.toThrow(
                event === "crash" ? /renderer crashed/ : /window closed/,
            );
            page.emit(event);
            await failure;
            expect(vi.getTimerCount()).toBe(0);
        },
    );

    it("reports application termination rather than spending the readiness timeout", async () => {
        const app = new FakeApp();
        const failure = expect(waitForWorkbench(app.asApp())).rejects.toThrow(/Electron closed/);
        app.emit("close");
        await failure;
        expect(app.child.listenerCount("exit")).toBe(0);
    });

    it("reports an already-exited child and does not select a closed workbench", async () => {
        const app = new FakeApp();
        const page = new FakePage();
        page.closed = true;
        page.isVisible.mockResolvedValue(true);
        app.pages.push(page);
        const failure = expect(waitForWorkbench(app.asApp(), 100)).rejects.toThrow(
            /did not become ready/,
        );
        await vi.advanceTimersByTimeAsync(100);
        await failure;
        expect(page.locator).not.toHaveBeenCalled();
        app.child.exitCode = 1;
        await expect(waitForWorkbench(app.asApp())).rejects.toThrow(/code=1/);
    });
});

describe("workbench failure diagnostics", () => {
    let profile: string;
    beforeEach(async () => {
        profile = await mkdtemp(path.join(tmpdir(), "intelligit-workbench-log-"));
    });
    afterEach(async () => {
        await removeScratchDirectories(profile);
    });

    async function writeLog(relative: string, body: string): Promise<void> {
        const filename = path.join(profile, relative);
        await mkdir(path.dirname(filename), { recursive: true });
        await writeFile(filename, body);
    }

    it("reads main, renderer, and extension-host log tails but excludes unrelated profile data", async () => {
        await writeLog("logs/session/main.log", "main startup");
        await writeLog("logs/session/window1/renderer.log", "renderer startup");
        await writeLog(
            "logs/session/window1/exthost/exthost.log",
            "x".repeat(300 * 1024) + "latest error",
        );
        await writeLog("User/settings.json", "private settings");
        await writeLog("logs/session/other.json", "unrelated data");
        await symlink(
            path.join(profile, "User"),
            path.join(profile, "logs", "profile-link"),
            "junction",
        );
        const logs = await readWorkbenchLogs(profile);
        expect(logs.map((log) => log.name)).toEqual([
            "vscode-session-main.log",
            "vscode-session-window1-renderer.log",
            "vscode-session-window1-exthost-exthost.log",
        ]);
        expect(logs[2].body.length).toBe(256 * 1024);
        expect(logs[2].body.toString().endsWith("latest error")).toBe(true);
    });

    it("allows missing profile logs and caps the file count", async () => {
        expect(await readWorkbenchLogs(profile)).toEqual([]);
        for (let index = 0; index < 25; index++) await writeLog(`logs/${index}.log`, "log");
        expect(await readWorkbenchLogs(profile)).toHaveLength(20);
    });

    it("keeps core startup logs when extension output exceeds the attachment budget", async () => {
        for (let index = 0; index < 25; index++) {
            await writeLog(
                `logs/session/window1/exthost/output_logging/${index}.log`,
                "extension output",
            );
        }
        await writeLog("logs/session/main.log", "main startup");
        await writeLog("logs/session/window1/renderer.log", "renderer startup");
        await writeLog("logs/session/window1/exthost/exthost.log", "extension host startup");
        const logs = await readWorkbenchLogs(profile);
        expect(logs).toHaveLength(20);
        expect(logs.slice(0, 3).map((log) => log.name)).toEqual([
            "vscode-session-main.log",
            "vscode-session-window1-renderer.log",
            "vscode-session-window1-exthost-exthost.log",
        ]);
        expect(logs.slice(0, 3).map((log) => log.body.toString())).toEqual([
            "main startup",
            "renderer startup",
            "extension host startup",
        ]);
    });

    it("attaches lifecycle, renderer, child stderr, full notifications, screenshots, and profile logs", async () => {
        await writeLog("logs/session/main.log", "early launch output");
        const app = new FakeApp();
        const page = new FakePage();
        app.pages.push(page);
        const diagnostics = new WorkbenchDiagnostics(profile);
        diagnostics.observe(app.asApp());
        page.emit("pageerror", new Error("renderer failure"));
        page.emit("crash");
        page.emit("console", { type: () => "error", text: () => "console failure" });
        app.child.stderr.emit("data", Buffer.from("child stderr"));
        app.child.emit("exit", 9, null);
        const attachments = new Map<string, string>();
        const attach = vi.fn(async (name: string, options: { body?: string | Buffer }) => {
            attachments.set(name, String(options.body));
        });
        await diagnostics.attach({ attach });
        expect(attachments.get("electron-startup.log")).toContain("renderer failure");
        expect(attachments.get("electron-startup.log")).toContain("renderer crashed");
        expect(attachments.get("electron-startup.log")).toContain("console failure");
        expect(attachments.get("electron-startup.log")).toContain("code=9");
        expect(attachments.get("electron-stderr.log")).toBe("child stderr");
        expect(attachments.get("vscode-session-main.log")).toBe("early launch output");
        expect(attachments.get("electron-window-1-notifications.log")).toBe(
            "Stash failed: full Git stderr beyond the clipped toast",
        );
        expect(attachments.get("electron-window-1.png")).toBe("screenshot");
        expect(Array.from(attachments.keys()).indexOf("vscode-session-main.log")).toBeLessThan(
            Array.from(attachments.keys()).indexOf("electron-window-1.png"),
        );
        diagnostics.dispose();
        expect(app.listenerCount("window")).toBe(0);
        expect(page.listenerCount("pageerror")).toBe(0);
        expect(app.child.stderr.listenerCount("data")).toBe(0);
    });

    it("captures launch failures without an app and tolerates attachment failures", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const diagnostics = new WorkbenchDiagnostics(profile);
        const attach = vi.fn(async () => {
            throw new Error("attachment failed");
        });
        await expect(diagnostics.attach({ attach })).resolves.toBeUndefined();
        expect(attach).toHaveBeenCalledWith(
            "vscode-logs.log",
            expect.objectContaining({ body: "<no profile logs available>\n" }),
        );
        diagnostics.dispose();
    });

    it("bounds a hung notification read and retains screenshot failure details", async () => {
        const app = new FakeApp();
        const page = new FakePage();
        page.allInnerTexts.mockImplementation(() => new Promise(() => undefined));
        page.screenshot.mockRejectedValue(new Error("renderer unavailable"));
        app.pages.push(page);
        const diagnostics = new WorkbenchDiagnostics(profile);
        diagnostics.observe(app.asApp());
        const attach = vi.fn(async () => undefined);
        // Profile I/O is real; wait until renderer diagnostics start before advancing fake timers.
        vi.useFakeTimers();
        const collecting = diagnostics.attach({ attach });
        await vi.waitFor(() => expect(page.allInnerTexts).toHaveBeenCalled());
        await vi.advanceTimersByTimeAsync(3_000);
        await collecting;
        expect(attach).toHaveBeenCalledWith(
            "electron-window-1-notifications-error.log",
            expect.objectContaining({ body: expect.stringContaining("timed out") }),
        );
        expect(attach).toHaveBeenCalledWith(
            "electron-window-1-screenshot-error.log",
            expect.objectContaining({ body: expect.stringContaining("renderer unavailable") }),
        );
        diagnostics.dispose();
    });
});
