import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    registerTextDocumentContentProvider: vi.fn(),
}));

vi.mock("vscode", () => ({
    workspace: { registerTextDocumentContentProvider: mocks.registerTextDocumentContentProvider },
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

    it("dispose stops listening to the store", async () => {
        const { store, provider, registration } = setup();
        const changed = vi.fn();
        provider.onDidChange?.(changed);
        await provide(provider, uriFor(`k=${keyFor("a")}`));
        registration.dispose();
        await store.load(keyFor("a"), sourceFor("a"));
        expect(changed).not.toHaveBeenCalled();
    });
});
