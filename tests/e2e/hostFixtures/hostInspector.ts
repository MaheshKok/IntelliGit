import { writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Bench-only probe of the extension host through its inspector (`--inspect-extensions`), so the
 * extension under test carries no probe code. Every 10 s it records heap, RSS and range-scan
 * counters; every 60 s it rotates a CPU profile. A request the host cannot answer is recorded as
 * an error with its timeout, which is itself the stall evidence.
 */
export async function attachHostInspector(port: number, extensionPath: string, output: string) {
    const deadline = Date.now() + 90_000;
    let url: string | undefined;
    while (!url) {
        try {
            const targets = (await (
                await fetch(`http://127.0.0.1:${port}/json/list`)
            ).json()) as { webSocketDebuggerUrl?: string }[];
            url = targets.find((target) => target.webSocketDebuggerUrl)?.webSocketDebuggerUrl;
        } catch {
            // The extension host has not opened its inspector yet.
        }
        if (url) break;
        if (Date.now() > deadline)
            throw new Error(`Extension host inspector on port ${port} never answered.`);
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
        socket.onopen = () => resolve();
        socket.onerror = () => reject(new Error("Extension host inspector socket failed."));
    });
    const replies = new Map<number, (message: { result?: unknown; error?: { message: string } }) => void>();
    const scripts: { scriptId: string; url: string }[] = [];
    socket.onmessage = (event) => {
        const message = JSON.parse(String(event.data));
        if (message.id !== undefined) replies.get(message.id)?.(message);
        else if (message.method === "Debugger.scriptParsed") scripts.push(message.params);
    };
    let nextId = 0;
    const send = <T>(method: string, params: object = {}, timeoutMs = 15_000) =>
        new Promise<T>((resolve, reject) => {
            const id = ++nextId;
            const timer = setTimeout(() => {
                replies.delete(id);
                reject(new Error(`${method} got no answer within ${timeoutMs} ms`));
            }, timeoutMs);
            replies.set(id, (message) => {
                clearTimeout(timer);
                replies.delete(id);
                if (message.error) reject(new Error(`${method}: ${message.error.message}`));
                else resolve(message.result as T);
            });
            socket.send(JSON.stringify({ id, method, params }));
        });

    // Counters through conditions that always return false: the host never pauses.
    // queued - passes = range-scan passes waiting behind the running one.
    await send("Debugger.enable");
    const bundlePath = path.join(extensionPath, "dist", "extension.js");
    const bundle = scripts.find((script) => script.url.endsWith(bundlePath));
    if (!bundle) throw new Error(`Inspector saw no script for ${bundlePath}.`);
    const { scriptSource } = await send<{ scriptSource: string }>("Debugger.getScriptSource", {
        scriptId: bundle.scriptId,
    });
    const markers = [
        ["queued", "this.pending.then(() => this.refresh("],
        ["passes", "const entries = await this.partial.indexEntries()"],
        ["opens", "const view = await this.partial.open(file)"],
    ] as const;
    let from = scriptSource.indexOf("reconcile(files, epoch) {");
    if (from < 0) throw new Error("ChangeRangeTracker.reconcile is not in the bundle.");
    const breakpoints: Record<string, { lineNumber: number }> = {};
    for (const [name, text] of markers) {
        const at = scriptSource.indexOf(text, from);
        if (at < 0) throw new Error(`Range-scan marker "${text}" is not in the bundle.`);
        from = at;
        // The bundle is not minified: each marker is a statement starting its own line.
        const lineNumber = scriptSource.slice(0, at).split("\n").length - 1;
        const placed = await send<{ actualLocation: { lineNumber: number } }>(
            "Debugger.setBreakpoint",
            {
                location: { scriptId: bundle.scriptId, lineNumber, columnNumber: 0 },
                condition: `((globalThis.__intelligitBench ??= { queued: 0, passes: 0, opens: 0 }).${name}++, false)`,
            },
        );
        if (placed.actualLocation.lineNumber !== lineNumber)
            throw new Error(`Marker "${name}" bound to line ${placed.actualLocation.lineNumber}, not ${lineNumber}.`);
        breakpoints[name] = { lineNumber };
    }

    const startedAtMs = Date.now();
    const samples: object[] = [];
    const profiles: object[] = [];
    const record = () =>
        writeFile(
            path.join(output, "host-inspector.json"),
            JSON.stringify({ port, startedAtMs, breakpoints, samples, profiles }),
        );
    let profileIndex = 0;
    let profileStartedAtMs = Date.now();
    await send("Profiler.enable");
    await send("Profiler.start");
    const rotate = async (restart: boolean) => {
        const index = profileIndex++;
        const from = profileStartedAtMs;
        const requestedAtMs = Date.now();
        try {
            const { profile } = await send<{ profile: unknown }>("Profiler.stop", {}, 45_000);
            const filename = `host-cpu-${String(index).padStart(2, "0")}.cpuprofile`;
            await writeFile(path.join(output, filename), JSON.stringify(profile));
            profiles.push({ filename, fromMs: from - startedAtMs, toMs: requestedAtMs - startedAtMs, answeredAfterMs: Date.now() - requestedAtMs });
        } catch (error) {
            profiles.push({ index, fromMs: from - startedAtMs, error: String(error) });
        }
        if (restart) {
            profileStartedAtMs = Date.now();
            await send("Profiler.start").catch((error) => profiles.push({ restartError: String(error) }));
        }
        await record();
    };
    const expression =
        "JSON.stringify({ counters: globalThis.__intelligitBench ?? null, memory: process.memoryUsage() })";
    let stopped = false;
    let sampling: Promise<void> = Promise.resolve();
    const sampleLoop = async () => {
        while (!stopped) {
            const atMs = Date.now();
            try {
                const { result } = await send<{ result: { value: string } }>(
                    "Runtime.evaluate",
                    { expression, returnByValue: true },
                    8_000,
                );
                samples.push({ elapsedMs: atMs - startedAtMs, answeredAfterMs: Date.now() - atMs, ...JSON.parse(result.value) });
            } catch (error) {
                samples.push({ elapsedMs: atMs - startedAtMs, error: String(error) });
            }
            if (Date.now() - profileStartedAtMs >= 60_000) await rotate(true);
            else await record();
            await new Promise((resolve) => setTimeout(resolve, Math.max(0, 10_000 - (Date.now() - atMs))));
        }
    };
    sampling = sampleLoop();

    return {
        /** Ends sampling and saves the last profile window; never throws. */
        stop: async () => {
            stopped = true;
            await sampling.catch(() => undefined);
            await rotate(false).catch(() => undefined);
            socket.close();
        },
    };
}
