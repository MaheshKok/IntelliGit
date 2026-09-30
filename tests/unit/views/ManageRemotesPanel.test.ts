import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitOps } from "../../../src/git/operations";

const mocks = vi.hoisted(() => ({
    panels: [] as Array<{
        messages: unknown[];
        receive: (message: unknown) => Promise<void>;
        close: () => void;
        reveal: ReturnType<typeof vi.fn>;
    }>,
    warning: vi.fn(),
}));

vi.mock("vscode", () => ({
    ViewColumn: { Active: -1 },
    Uri: { joinPath: (base: unknown) => base },
    l10n: {
        t: (text: string, args?: Record<string, unknown>) =>
            Object.entries(args ?? {}).reduce(
                (s, [key, value]) => s.replace(`{${key}}`, String(value)),
                text,
            ),
    },
    window: {
        createWebviewPanel: () => {
            const state = {
                messages: [] as unknown[],
                receive: async (_message: unknown) => {},
                close: () => {},
                reveal: vi.fn(),
            };
            mocks.panels.push(state);
            return {
                reveal: state.reveal,
                dispose: () => state.close(),
                onDidDispose: (callback: () => void) => {
                    state.close = callback;
                    return { dispose() {} };
                },
                webview: {
                    html: "",
                    onDidReceiveMessage: (callback: typeof state.receive) => {
                        state.receive = callback;
                        return { dispose() {} };
                    },
                    postMessage: async (message: unknown) => {
                        state.messages.push(message);
                        return true;
                    },
                },
            };
        },
        showWarningMessage: mocks.warning,
    },
}));
vi.mock("../../../src/views/webviewHtml", () => ({ buildWebviewShellHtml: () => "html" }));
vi.mock("../../../src/e2e/webviewCapture", () => ({ captureWebview: (panel: unknown) => panel }));

import { ManageRemotesPanel } from "../../../src/views/ManageRemotesPanel";

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((finish) => {
        resolve = finish;
    });
    return { promise, resolve };
}

function fixture(root = "/repo-b") {
    const state = new Map<string, string[]>([["origin", ["../one.git"]]]);
    const ops = {
        getRemoteNames: vi.fn(async () => [...state.keys()]),
        getConfiguredRemoteUrls: vi.fn(async (name: string) => [...(state.get(name) ?? [])]),
        addRemote: vi.fn(async (name: string, url: string) => {
            state.set(name, [url]);
        }),
        removeRemote: vi.fn(async (name: string) => {
            state.delete(name);
        }),
        renameRemote: vi.fn(async (oldName: string, name: string) => {
            state.set(name, state.get(oldName)!);
            state.delete(oldName);
        }),
        setRemoteUrl: vi.fn(async (name: string, _oldUrl: string | undefined, url: string) => {
            const urls = state.get(name) ?? [];
            urls[0] = url;
            state.set(name, urls);
        }),
    };
    const refresh = vi.fn(async (_repoRoot: string) => undefined);
    ManageRemotesPanel.open({} as never, ops as unknown as GitOps, root, refresh);
    const panel = mocks.panels.at(-1)!;
    return { state, ops, refresh, panel };
}

async function ready(panel: ReturnType<typeof fixture>["panel"]) {
    await panel.receive({ type: "ready" });
    return panel.messages.at(-1) as {
        type: string;
        revision: number;
        remotes: unknown[];
        error?: string;
    };
}

beforeEach(() => {
    mocks.warning.mockReset();
});
afterEach(() => {
    mocks.panels.forEach((panel) => panel.close());
    mocks.panels.length = 0;
});

describe("Manage Remotes host boundary", () => {
    it("keeps clicked B and separate C panels after active repository changes", async () => {
        const b = fixture();
        const initial = await ready(b.panel);
        expect(initial.remotes).toEqual([
            { name: "origin", url: "../one.git", additionalUrlCount: 0 },
        ]);
        const c = fixture("/repo-c");
        expect(mocks.panels).toHaveLength(2);
        fixture();
        expect(mocks.panels).toHaveLength(2);
        expect(b.panel.reveal).toHaveBeenCalledOnce();
        await b.panel.receive({ type: "add", name: "upstream", url: "../two.git" });
        expect(b.ops.addRemote).toHaveBeenCalledWith("upstream", "../two.git");
        expect(c.ops.addRemote).not.toHaveBeenCalled();
        expect(b.refresh).toHaveBeenCalledWith("/repo-b");
    });

    it("rejects malformed, path-bearing, stale and invalid requests without writes", async () => {
        const { ops, panel } = fixture();
        const snapshot = await ready(panel);
        await panel.receive({ type: "add", name: 4, url: "../two.git" });
        await panel.receive({ type: "add", name: "other", url: "../two.git", repoRoot: "/repo-a" });
        await panel.receive({
            type: "edit",
            revision: snapshot.revision - 1,
            originalName: "origin",
            name: "new",
            url: "../new.git",
        });
        await panel.receive({
            type: "edit",
            revision: snapshot.revision,
            originalName: "unknown",
            name: "new",
            url: "../new.git",
        });
        await panel.receive({ type: "add", name: "bad/name", url: "../new.git" });
        await panel.receive({ type: "add", name: "valid\n", url: "../new.git" });
        await panel.receive({ type: "add", name: "valid", url: "\n" });
        expect(ops.addRemote).not.toHaveBeenCalled();
        expect(ops.renameRemote).not.toHaveBeenCalled();
        expect(ops.setRemoteUrl).not.toHaveBeenCalled();
    });

    it("rejects a second Save while the first mutation is pending", async () => {
        const { ops, panel } = fixture();
        const pending = deferred<void>();
        ops.addRemote.mockImplementationOnce(async () => pending.promise);
        await ready(panel);
        const first = panel.receive({ type: "add", name: "one", url: "../one" });
        await vi.waitFor(() => expect(ops.addRemote).toHaveBeenCalledTimes(1));
        await panel.receive({ type: "add", name: "two", url: "../two" });
        expect(ops.addRemote).toHaveBeenCalledTimes(1);
        pending.resolve();
        await first;
    });

    it("does not remove when confirmation is canceled", async () => {
        const { ops, panel } = fixture();
        const snapshot = await ready(panel);
        mocks.warning.mockResolvedValue(undefined);
        await panel.receive({ type: "remove", revision: snapshot.revision, name: "origin" });
        expect(ops.removeRemote).not.toHaveBeenCalled();
        expect(mocks.warning).toHaveBeenCalledWith(
            expect.stringContaining("origin"),
            expect.anything(),
            expect.anything(),
        );
    });

    it.each([
        { direction: "increases", before: ["../one.git"], after: ["../one.git", "../two.git"] },
        { direction: "decreases", before: ["../one.git", "../two.git"], after: ["../one.git"] },
    ])(
        "rejects removal when a remote's configured URL count $direction during confirmation",
        async ({ before, after }) => {
            const { state, ops, panel, refresh } = fixture();
            state.set("origin", before);
            const snapshot = await ready(panel);
            mocks.warning.mockImplementation(async () => {
                state.set("origin", after);
                return "Remove";
            });

            await panel.receive({ type: "remove", revision: snapshot.revision, name: "origin" });

            expect(ops.removeRemote).not.toHaveBeenCalled();
            expect(refresh).not.toHaveBeenCalled();
            expect(panel.messages.at(-1)).toMatchObject({
                error: "Remote data changed. Reload and try again.",
                remotes: [
                    { name: "origin", url: "../one.git", additionalUrlCount: after.length - 1 },
                ],
            });
        },
    );

    it("reports the actual renamed remote after the URL step fails", async () => {
        const { ops, panel, refresh } = fixture();
        const snapshot = await ready(panel);
        ops.setRemoteUrl.mockRejectedValueOnce(new Error("multiple values"));
        await panel.receive({
            type: "edit",
            revision: snapshot.revision,
            originalName: "origin",
            name: "upstream",
            url: "../new.git",
        });
        const final = panel.messages.at(-1) as {
            remotes: Array<{ name: string; url: string }>;
            error: string;
        };
        expect(final.remotes).toEqual([
            { name: "upstream", url: "../one.git", additionalUrlCount: 0 },
        ]);
        expect(final.error).toMatch(/rename.*upstream.*multiple values/i);
        expect(refresh).toHaveBeenCalledWith("/repo-b");
    });

    it("stops before the URL write when Git rejects rename", async () => {
        const { ops, state, panel } = fixture();
        const snapshot = await ready(panel);
        ops.renameRemote.mockRejectedValueOnce(new Error("name collision"));
        await panel.receive({
            type: "edit",
            revision: snapshot.revision,
            originalName: "origin",
            name: "upstream",
            url: "../new.git",
        });
        expect(ops.setRemoteUrl).not.toHaveBeenCalled();
        expect(state.has("origin")).toBe(true);
        expect(state.has("upstream")).toBe(false);
        expect(panel.messages.at(-1)).toMatchObject({ type: "error", message: "name collision" });
    });

    it("rejects external URL changes and refreshes the actual value before any edit", async () => {
        const { ops, state, panel } = fixture();
        const snapshot = await ready(panel);
        state.set("origin", ["../external.git"]);
        await panel.receive({
            type: "edit",
            revision: snapshot.revision,
            originalName: "origin",
            name: "upstream",
            url: "../mine.git",
        });
        expect(ops.renameRemote).not.toHaveBeenCalled();
        expect(ops.setRemoteUrl).not.toHaveBeenCalled();
        expect(panel.messages.at(-1)).toMatchObject({
            type: "snapshot",
            error: expect.stringContaining("changed"),
            remotes: [{ name: "origin", url: "../external.git", additionalUrlCount: 0 }],
        });
    });

    it("rejects an external zero-URL to empty-value transition", async () => {
        const { ops, state, panel } = fixture();
        state.set("origin", []);
        const snapshot = await ready(panel);
        state.set("origin", [""]);
        await panel.receive({
            type: "edit",
            revision: snapshot.revision,
            originalName: "origin",
            name: "origin",
            url: "../mine.git",
        });
        expect(ops.setRemoteUrl).not.toHaveBeenCalled();
        expect(panel.messages.at(-1)).toMatchObject({
            type: "snapshot",
            error: expect.stringContaining("changed"),
        });
    });

    it("allows an existing remote with zero fetch URLs to receive its first URL", async () => {
        const { ops, state, panel } = fixture();
        state.set("origin", []);
        const snapshot = await ready(panel);
        await panel.receive({
            type: "edit",
            revision: snapshot.revision,
            originalName: "origin",
            name: "origin",
            url: "../first.git",
        });
        expect(ops.setRemoteUrl).toHaveBeenCalledWith("origin", undefined, "../first.git");
        expect(state.get("origin")).toEqual(["../first.git"]);
    });

    it("refreshes actual state and retains the Git error after a URL-only failure", async () => {
        const { ops, panel, refresh } = fixture();
        const snapshot = await ready(panel);
        ops.setRemoteUrl.mockRejectedValueOnce(new Error("multiple values"));
        await panel.receive({
            type: "edit",
            revision: snapshot.revision,
            originalName: "origin",
            name: "origin",
            url: "../new.git",
        });
        expect(panel.messages.at(-1)).toMatchObject({
            type: "snapshot",
            error: expect.stringContaining("multiple values"),
            remotes: [{ name: "origin", url: "../one.git", additionalUrlCount: 0 }],
        });
        expect(refresh).toHaveBeenCalledWith("/repo-b");
    });

    it("retains partial rename failure details if the subsequent list refresh fails", async () => {
        const { ops, panel } = fixture();
        const snapshot = await ready(panel);
        ops.setRemoteUrl.mockRejectedValueOnce(new Error("multiple values"));
        ops.getRemoteNames
            .mockResolvedValueOnce(["origin"])
            .mockRejectedValueOnce(new Error("config unreadable"));
        await panel.receive({
            type: "edit",
            revision: snapshot.revision,
            originalName: "origin",
            name: "upstream",
            url: "../new.git",
        });
        const final = panel.messages.at(-1) as { type: string; message: string };
        expect(final.type).toBe("error");
        expect(final.message).toMatch(/renamed.*upstream.*multiple values/i);
        expect(final.message).toContain("config unreadable");
    });

    it("does not post after disposal while a completed mutation still refreshes B", async () => {
        const { ops, panel, refresh } = fixture();
        const pending = deferred<void>();
        ops.addRemote.mockImplementationOnce(async () => pending.promise);
        await ready(panel);
        const mutation = panel.receive({ type: "add", name: "upstream", url: "../two" });
        await vi.waitFor(() => expect(ops.addRemote).toHaveBeenCalledTimes(1));
        const count = panel.messages.length;
        panel.close();
        pending.resolve();
        await mutation;
        expect(refresh).toHaveBeenCalledWith("/repo-b");
        expect(panel.messages).toHaveLength(count);
    });

    it("shows load errors and permits retry instead of showing empty success", async () => {
        const { ops, panel } = fixture();
        ops.getRemoteNames.mockRejectedValueOnce(new Error("config unreadable"));
        await panel.receive({ type: "ready" });
        expect(panel.messages.at(-1)).toMatchObject({
            type: "error",
            message: expect.stringContaining("config unreadable"),
        });
        await panel.receive({ type: "reload" });
        expect(panel.messages.at(-1)).toMatchObject({
            type: "snapshot",
            remotes: expect.any(Array),
        });
    });
});
