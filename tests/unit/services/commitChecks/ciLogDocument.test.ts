import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    registerTextDocumentContentProvider: vi.fn(),
    closeListeners: [] as ((document: { uri: unknown }) => void)[],
    closeSubscription: { dispose: vi.fn() },
}));

vi.mock("vscode", () => ({
    workspace: {
        registerTextDocumentContentProvider: mocks.registerTextDocumentContentProvider,
        onDidCloseTextDocument: (listener: (document: { uri: unknown }) => void) => {
            mocks.closeListeners.push(listener);
            return mocks.closeSubscription;
        },
    },
    l10n: {
        t: (message: string, ...args: unknown[]) =>
            message.replace(/\{(\d+)\}/g, (_, index: string) => String(args[Number(index)])),
    },
}));

import type * as vscode from "vscode";

import {
    CI_LOG_SCHEME,
    registerCiLogDocumentProvider,
} from "../../../../src/services/commitChecks/ciLogDocument";
import {
    CiLogMemoryStore,
    ciLogKey,
    type CiLogSource,
} from "../../../../src/services/commitChecks/ciLogMemoryStore";

const NO_LONGER_LOADED =
    "[IntelliGit: this CI log is no longer loaded. Open it again from the Checks tab.]";
const NOT_VALID = "[IntelliGit: this CI log link is not valid.]";

function uriFor(query: string): vscode.Uri {
    const text = `${CI_LOG_SCHEME}:/unit-tests.log?${query}`;
    return { scheme: CI_LOG_SCHEME, query, toString: () => text } as unknown as vscode.Uri;
}

function sourceFor(jobId: string): CiLogSource {
    return { repoKey: "repo", provider: "github", runId: "run-1", jobId, attempt: 1 };
}

const keyFor = (jobId: string) => ciLogKey("github:o/r", "run-1", jobId, 1);

function setup(
    download = vi.fn(async (source: CiLogSource) => ({
        text: `${source.jobId} text`,
        truncated: false,
    })),
) {
    const store = new CiLogMemoryStore({ download });
    mocks.registerTextDocumentContentProvider.mockReturnValue({ dispose: vi.fn() });
    const registration = registerCiLogDocumentProvider(store);
    const provider = mocks.registerTextDocumentContentProvider.mock
        .calls[0][1] as vscode.TextDocumentContentProvider;
    return { store, download, provider, registration };
}

async function provide(provider: vscode.TextDocumentContentProvider, uri: vscode.Uri) {
    return provider.provideTextDocumentContent(uri, {} as vscode.CancellationToken);
}

describe("ciLogDocument", () => {
    beforeEach(() => {
        mocks.registerTextDocumentContentProvider.mockReset();
        mocks.closeListeners.length = 0;
        mocks.closeSubscription.dispose.mockClear();
    });

    it("a closed tab never gets onDidChange; a tab still open does", async () => {
        const { store, provider } = setup();
        const changed = vi.fn();
        provider.onDidChange?.(changed);
        const closed = uriFor(`k=${keyFor("a")}`);
        const open = uriFor(`k=${keyFor("a")}&tab=2`);
        await expect(provide(provider, closed)).resolves.toBe(NO_LONGER_LOADED);
        await expect(provide(provider, open)).resolves.toBe(NO_LONGER_LOADED);
        // A close for another scheme with the same text must not touch the registry.
        for (const listener of mocks.closeListeners) {
            listener({ uri: { ...open, scheme: "file" } });
            listener({ uri: closed });
        }
        await store.load(keyFor("a"), sourceFor("a"));
        expect(changed, "only the open tab is refreshed").toHaveBeenCalledTimes(1);
        expect(changed).toHaveBeenCalledWith(open);
    });

    it("a tab reopened after its close is refreshed again", async () => {
        const { store, provider } = setup();
        const changed = vi.fn();
        provider.onDidChange?.(changed);
        const uri = uriFor(`k=${keyFor("a")}`);
        await provide(provider, uri);
        for (const listener of mocks.closeListeners) listener({ uri });
        // No behaviour shows an empty bucket, so read the registry itself.
        const registry = (provider as unknown as { stale: Map<string, unknown> }).stale;
        expect(registry.has(keyFor("a")), "an empty key bucket must be deleted").toBe(false);
        await expect(provide(provider, uri)).resolves.toBe(NO_LONGER_LOADED);
        await store.load(keyFor("a"), sourceFor("a"));
        expect(changed).toHaveBeenCalledTimes(1);
        expect(changed).toHaveBeenCalledWith(uri);
    });

    // A download that waits for the test, so a tab can close or the provider be disposed mid-read.
    function pendingSetup() {
        const downloads: { reject: (error: Error) => void }[] = [];
        let blocked = false;
        const download = vi.fn(async (source: CiLogSource) => {
            if (!blocked) return { text: `${source.jobId} text`, truncated: false };
            return new Promise<{ text: string; truncated: boolean }>((_, reject) =>
                downloads.push({ reject }),
            );
        });
        const context = setup(download);
        const block = async () => {
            // Record the source, then empty the store so the tab's read downloads again.
            await context.store.load(keyFor("a"), sourceFor("a"));
            context.store.clear();
            blocked = true;
        };
        const unblock = () => {
            blocked = false;
        };
        return { ...context, downloads, block, unblock };
    }

    it("a tab closed while its load is pending is not refreshed when that load fails (K19)", async () => {
        const { store, provider, downloads, block, unblock } = pendingSetup();
        await block();
        const changed = vi.fn();
        provider.onDidChange?.(changed);
        const uri = uriFor(`k=${keyFor("a")}`);
        const read = provide(provider, uri);
        for (const listener of mocks.closeListeners) listener({ uri });
        downloads[0].reject(new Error("connection lost"));
        await expect(read).resolves.toContain("could not load");
        unblock();
        await store.load(keyFor("a"), sourceFor("a"));
        expect(
            changed,
            "a tab closed while loading must never be refreshed",
        ).not.toHaveBeenCalled();
    });

    it("a tab closed and reopened while a load is pending is still refreshed after it fails", async () => {
        const { store, provider, downloads, block, unblock } = pendingSetup();
        await block();
        const changed = vi.fn();
        provider.onDidChange?.(changed);
        const uri = uriFor(`k=${keyFor("a")}`);
        const closedRead = provide(provider, uri);
        for (const listener of mocks.closeListeners) listener({ uri });
        const reopenedRead = provide(provider, uri);
        downloads[0].reject(new Error("connection lost"));
        await closedRead;
        await expect(reopenedRead).resolves.toContain("could not load");
        unblock();
        await store.load(keyFor("a"), sourceFor("a"));
        expect(changed, "the reopened tab must recover").toHaveBeenCalledWith(uri);
    });

    it("a load that fails after dispose leaves the refresh registry empty", async () => {
        const { provider, registration, downloads, block } = pendingSetup();
        await block();
        const read = provide(provider, uriFor(`k=${keyFor("a")}`));
        registration.dispose();
        downloads[0].reject(new Error("late failure"));
        await read;
        // No behaviour shows a disposed provider's registry, so read it itself.
        const registry = (provider as unknown as { stale: Map<string, unknown> }).stale;
        expect(registry.size, "a disposed provider must keep no tabs").toBe(0);
    });

    it("registers the intelligit-ci-log scheme and unregisters on dispose", () => {
        const { registration } = setup();
        expect(CI_LOG_SCHEME).toBe("intelligit-ci-log");
        expect(mocks.registerTextDocumentContentProvider).toHaveBeenCalledWith(
            "intelligit-ci-log",
            expect.anything(),
        );
        const inner = mocks.registerTextDocumentContentProvider.mock.results[0].value as {
            dispose: ReturnType<typeof vi.fn>;
        };
        registration.dispose();
        expect(inner.dispose).toHaveBeenCalled();
    });

    it("rejects ../ and non-hex keys", async () => {
        const { store, download, provider } = setup();
        // A real stored log, so a guard that only falls through to a miss would still be caught.
        await store.load(keyFor("a"), sourceFor("a"));
        download.mockClear();
        const hex = keyFor("a");
        for (const query of [
            "k=../../etc/passwd",
            `k=${hex.toUpperCase()}`,
            `k=${hex.slice(1)}`,
            `k=${hex}0`,
            `k=${hex}%0A`,
            `k=../${hex}`,
            "",
        ]) {
            await expect(provide(provider, uriFor(query))).resolves.toBe(NOT_VALID);
        }
        expect(download).not.toHaveBeenCalled();
    });

    it("serves a stored log", async () => {
        const { store, provider } = setup();
        await store.load(keyFor("a"), sourceFor("a"));
        await expect(provide(provider, uriFor(`k=${keyFor("a")}`))).resolves.toBe("a text");
    });

    it("miss with a source downloads again", async () => {
        const { store, download, provider } = setup();
        for (const job of ["a", "b", "c", "d"]) await store.load(keyFor(job), sourceFor(job));
        expect(store.get(keyFor("a"))).toBeUndefined();
        await expect(provide(provider, uriFor(`k=${keyFor("a")}`))).resolves.toBe("a text");
        expect(download.mock.calls.filter(([source]) => source.jobId === "a")).toHaveLength(2);
    });

    it("miss without a source returns the no-longer-loaded line and sends nothing", async () => {
        const { download, provider } = setup();
        await expect(provide(provider, uriFor(`k=${keyFor("a")}`))).resolves.toBe(NO_LONGER_LOADED);
        expect(download).not.toHaveBeenCalled();
    });

    it("a failed download shows the reason as a line", async () => {
        const download = vi.fn(async () => {
            throw new Error("HTTP 500");
        });
        const { store, provider } = setup(download);
        for (const job of ["a"]) await store.load(keyFor(job), sourceFor(job)).catch(() => {});
        await expect(provide(provider, uriFor(`k=${keyFor("a")}`))).resolves.toBe(
            "[IntelliGit: could not load this CI log: HTTP 500]",
        );
    });

    it("a load that replaces placeholder text fires onDidChange for that URI", async () => {
        const { store, provider } = setup();
        const changed = vi.fn();
        provider.onDidChange?.(changed);
        const placeholder = uriFor(`k=${keyFor("a")}`);
        const other = uriFor(`k=${keyFor("b")}`);
        await expect(provide(provider, placeholder)).resolves.toBe(NO_LONGER_LOADED);
        await provide(provider, other);
        await store.load(keyFor("a"), sourceFor("a"));
        expect(changed).toHaveBeenCalledTimes(1);
        expect(changed).toHaveBeenCalledWith(placeholder);
        await expect(provide(provider, placeholder)).resolves.toBe("a text");
        // Once the tab shows the log, a later load of the same key fires nothing more.
        await store.load(keyFor("a"), sourceFor("a"));
        expect(changed).toHaveBeenCalledTimes(1);
    });

    it("a load after an error line fires onDidChange for that URI", async () => {
        let fail = true;
        const download = vi.fn(async (source: CiLogSource) => {
            if (fail) throw new Error("timeout");
            return { text: `${source.jobId} text`, truncated: false };
        });
        const { store, provider } = setup(download);
        const changed = vi.fn();
        provider.onDidChange?.(changed);
        await store.load(keyFor("a"), sourceFor("a")).catch(() => {});
        const uri = uriFor(`k=${keyFor("a")}`);
        await expect(provide(provider, uri)).resolves.toContain("could not load");
        fail = false;
        await store.load(keyFor("a"), sourceFor("a"));
        expect(changed).toHaveBeenCalledWith(uri);
    });

    it.each(["reject", "resolve"])(
        "a stale document read cannot leave an error tab stuck after a newer same-key load succeeds (stale download %ss)",
        async (settle) => {
            const downloads: {
                resolve: (value: { text: string; truncated: boolean }) => void;
                reject: (error: Error) => void;
            }[] = [];
            const download = vi.fn(
                () =>
                    new Promise<{ text: string; truncated: boolean }>((resolve, reject) =>
                        downloads.push({ resolve, reject }),
                    ),
            );
            const { store, provider } = setup(download);
            // Record the source, then empty the store so the tab's read downloads again.
            const seeded = store.load(keyFor("a"), sourceFor("a"));
            downloads[0].resolve({ text: "seed", truncated: false });
            await seeded;
            store.clear();
            const changed = vi.fn();
            provider.onDidChange?.(changed);
            const uri = uriFor(`k=${keyFor("a")}`);
            const staleRead = provide(provider, uri);
            // A clear (settings or token change) aborts that read's download; a newer load wins.
            store.clear();
            const freshLoad = store.load(keyFor("a"), sourceFor("a"));
            downloads[2].resolve({ text: "fresh", truncated: false });
            await freshLoad;
            if (settle === "reject") {
                const abort = new Error("aborted");
                abort.name = "AbortError";
                downloads[1].reject(abort);
            } else {
                downloads[1].resolve({ text: "stale", truncated: false });
            }
            const staleText = await staleRead;
            // A later Checks-tab click is a cache hit and emits no load event, so the tab must
            // already show the log, or have been told to refresh after the read settled.
            changed.mockClear();
            expect((await store.load(keyFor("a"), sourceFor("a"))).text).toBe("fresh");
            expect(
                staleText === "fresh" || changed.mock.calls.some(([target]) => target === uri),
                `the error tab must recover on the later successful load (tab shows ${JSON.stringify(staleText)})`,
            ).toBe(true);
        },
    );

    it("dispose stops listening to the store", async () => {
        const { store, provider, registration } = setup();
        const changed = vi.fn();
        provider.onDidChange?.(changed);
        await provide(provider, uriFor(`k=${keyFor("a")}`));
        registration.dispose();
        expect(
            mocks.closeSubscription.dispose,
            "dispose must stop listening for closed documents",
        ).toHaveBeenCalled();
        await store.load(keyFor("a"), sourceFor("a"));
        expect(changed).not.toHaveBeenCalled();
    });
});
