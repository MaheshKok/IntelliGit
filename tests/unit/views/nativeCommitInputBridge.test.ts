import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const vscodeMock = vi.hoisted(() => ({
    extensions: {
        getExtension: vi.fn(),
    },
}));

vi.mock("vscode", () => vscodeMock);

import type {
    SharedNativeCommitInputRecord,
    VsCodeGitApi,
    VsCodeGitRepository,
} from "../../../src/views/nativeCommitInputBridge";
import {
    NativeCommitInputBridge,
    normalizedPath,
} from "../../../src/views/nativeCommitInputBridge";

type FakeBox = VsCodeGitRepository["inputBox"] & {
    readonly writes?: string[];
};

const ROOT = "/workspace/repository";

let shared: Map<string, SharedNativeCommitInputRecord>;
let drafts: Map<string, string>;
let api: VsCodeGitApi;
let bridge: NativeCommitInputBridge | undefined;
let onNativeChange: ReturnType<typeof vi.fn<(root: string, text: string) => void>>;
let persistDraft: ReturnType<typeof vi.fn<(root: string, text: string) => void>>;
let readDraft: ReturnType<typeof vi.fn<(root: string) => string>>;

function makeRepository(root = ROOT, initial = ""): VsCodeGitRepository {
    return {
        rootUri: { fsPath: root } as VsCodeGitRepository["rootUri"],
        inputBox: { value: initial },
    };
}

function makeApi(repository: VsCodeGitRepository): VsCodeGitApi {
    return { repositories: [repository] };
}

function makeBridge(
    resolveApi: () => Promise<VsCodeGitApi | undefined> = async () => api,
    pollIntervalMs = 1000,
): NativeCommitInputBridge {
    bridge = new NativeCommitInputBridge({
        resolveApi,
        readDraft,
        persistDraft,
        onNativeChange,
        pollIntervalMs,
        shared,
    });
    return bridge;
}

async function flushResolve(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

async function prepare(
    repository: VsCodeGitRepository,
    resolveApi: () => Promise<VsCodeGitApi | undefined> = async () => api,
): Promise<NativeCommitInputBridge> {
    api = makeApi(repository);
    const current = makeBridge(resolveApi);
    current.attach(ROOT);
    await flushResolve();
    return current;
}

function setNativeValue(repository: VsCodeGitRepository, value: string): void {
    repository.inputBox.value = value;
}

function recordFor(root = ROOT): SharedNativeCommitInputRecord | undefined {
    return shared.get(normalizedPath(root));
}

beforeEach(() => {
    vi.useFakeTimers();
    shared = new Map();
    drafts = new Map();
    onNativeChange = vi.fn<(root: string, text: string) => void>();
    persistDraft = vi.fn((root: string, text: string) => {
        drafts.set(root, text);
    });
    readDraft = vi.fn((root: string) => drafts.get(root) ?? "");
    api = { repositories: [] };
    vscodeMock.extensions.getExtension.mockReset();
});

afterEach(() => {
    bridge?.dispose();
    bridge = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("NativeCommitInputBridge", () => {
    it("native change while visible calls onNativeChange once, not again on next tick", async () => {
        const repository = makeRepository(ROOT, "D");
        const current = await prepare(repository);
        current.setVisible(true);
        onNativeChange.mockClear();

        setNativeValue(repository, "N");
        vi.advanceTimersByTime(1000);
        expect(onNativeChange).toHaveBeenCalledWith(ROOT, "N");
        expect(onNativeChange).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(1000);
        expect(onNativeChange).toHaveBeenCalledTimes(1);
    });

    it("setFromPanel writes the box and following tick does not echo own write", async () => {
        const repository = makeRepository(ROOT, "D");
        const current = await prepare(repository);
        current.tick();
        onNativeChange.mockClear();
        drafts.set(ROOT, "Q");

        current.setFromPanel(ROOT, "Q");
        current.tick();

        expect(repository.inputBox.value).toBe("Q");
        expect(onNativeChange).not.toHaveBeenCalled();
    });

    it("hidden does not poll or callback, but setFromPanel still writes", async () => {
        const repository = makeRepository(ROOT, "D");
        const current = await prepare(repository);
        current.tick();
        onNativeChange.mockClear();
        current.setVisible(false);
        drafts.set(ROOT, "Q");
        current.setFromPanel(ROOT, "Q");
        expect(repository.inputBox.value).toBe("Q");
        setNativeValue(repository, "N");

        vi.advanceTimersByTime(2000);

        expect(repository.inputBox.value).toBe("N");
        expect(onNativeChange).not.toHaveBeenCalled();
    });

    it("hiding after showing stops the poll", async () => {
        const repository = makeRepository(ROOT, "D");
        const current = await prepare(repository);
        current.setVisible(true);
        onNativeChange.mockClear();
        persistDraft.mockClear();

        current.setVisible(false);
        setNativeValue(repository, "N");
        vi.advanceTimersByTime(3000);

        expect(onNativeChange).not.toHaveBeenCalledWith(ROOT, "N");
        expect(persistDraft).not.toHaveBeenCalledWith(ROOT, "N");
        expect(repository.inputBox.value).toBe("N");

        current.setVisible(true);

        expect(onNativeChange).toHaveBeenCalledWith(ROOT, "N");
        expect(onNativeChange).toHaveBeenCalledTimes(1);
        expect(persistDraft).toHaveBeenCalledWith(ROOT, "N");
        expect(persistDraft).toHaveBeenCalledTimes(1);
    });

    it("first contact adopts native non-empty text", async () => {
        const repository = makeRepository(ROOT, "N");
        const current = await prepare(repository);

        current.tick();

        expect(recordFor()).toEqual({ base: "N", pending: false });
        expect(drafts.get(ROOT)).toBe("N");
        expect(persistDraft).toHaveBeenCalledWith(ROOT, "N");
        expect(onNativeChange).toHaveBeenCalledWith(ROOT, "N");
    });

    it("first contact with native empty and stored draft pushes draft and delivers the agreed text once", async () => {
        const repository = makeRepository(ROOT, "");
        drafts.set(ROOT, "D");
        const current = await prepare(repository);

        current.tick();

        expect(repository.inputBox.value).toBe("D");
        expect(recordFor()).toEqual({ base: "D", pending: false });
        expect(persistDraft).not.toHaveBeenCalled();
        expect(onNativeChange).toHaveBeenCalledTimes(1);
        expect(onNativeChange).toHaveBeenCalledWith(ROOT, "D");
    });

    it("first contact with both native and stored draft empty creates empty base without writing", async () => {
        let writes = 0;
        const repository = makeRepository(ROOT, "");
        Object.defineProperty(repository.inputBox, "value", {
            get: () => "",
            set: () => {
                writes += 1;
            },
        });
        const current = await prepare(repository);

        current.tick();

        expect(writes).toBe(0);
        expect(recordFor()).toEqual({ base: "", pending: false });
    });

    it("R1-#1/#3 commit clear before repository discovery pushes empty text without callback", async () => {
        const repository = makeRepository(ROOT, "D");
        drafts.set(ROOT, "D");
        api = { repositories: [] };
        const current = makeBridge();
        current.attach(ROOT);
        await flushResolve();

        drafts.set(ROOT, "");
        current.setFromPanel(ROOT, "");
        api.repositories.push(repository);
        current.tick();

        expect(repository.inputBox.value).toBe("");
        expect(recordFor()).toEqual({ base: "", pending: false });
        expect(onNativeChange).not.toHaveBeenCalled();
    });

    it("R2-#1 second bridge shown after first bridge clears writes nothing and delivers the cleared text once", async () => {
        const repository = makeRepository(ROOT, "D");
        drafts.set(ROOT, "D");
        api = makeApi(repository);
        const first = makeBridge();
        first.attach(ROOT);
        const second = makeBridge();
        second.attach(ROOT);
        await flushResolve();
        first.tick();
        onNativeChange.mockClear();

        drafts.set(ROOT, "");
        first.setFromPanel(ROOT, "");
        second.setVisible(true);

        expect(repository.inputBox.value).toBe("");
        expect(onNativeChange).toHaveBeenCalledTimes(1);
        expect(onNativeChange).toHaveBeenCalledWith(ROOT, "");
        expect(onNativeChange).not.toHaveBeenCalledWith(ROOT, "D");

        second.tick();
        expect(onNativeChange).toHaveBeenCalledTimes(1);
    });

    it("R3-#2 shared pending is honored once with current store after another bridge makes contact", async () => {
        const repository = makeRepository(ROOT, "D");
        api = { repositories: [] };
        const first = makeBridge();
        first.attach(ROOT);
        const second = makeBridge();
        second.attach(ROOT);
        await flushResolve();

        drafts.set(ROOT, "B");
        second.setFromPanel(ROOT, "B");
        drafts.set(ROOT, "A");
        api.repositories.push(repository);
        first.tick();
        expect(repository.inputBox.value).toBe("A");
        expect(recordFor()).toEqual({ base: "A", pending: false });
        onNativeChange.mockClear();

        second.tick();
        expect(repository.inputBox.value).toBe("A");
        expect(onNativeChange).toHaveBeenCalledWith(ROOT, "A");
    });

    it("R3-#3 plugin write while pending adopts native text and clears pending", async () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
        let currentValue = "D";
        let throwOnWrite = true;
        const repository = makeRepository(ROOT, "D");
        repository.inputBox = {
            get value() {
                return currentValue;
            },
            set value(next: string) {
                if (throwOnWrite) {
                    throwOnWrite = false;
                    throw new Error("setter failed");
                }
                currentValue = next;
            },
        };
        api = makeApi(repository);
        const current = makeBridge();
        current.attach(ROOT);
        await flushResolve();
        current.tick();
        drafts.set(ROOT, "P");

        current.setFromPanel(ROOT, "P");
        currentValue = "N";
        current.tick();

        expect(recordFor()).toEqual({ base: "N", pending: false });
        expect(drafts.get(ROOT)).toBe("N");
        expect(onNativeChange).toHaveBeenCalledWith(ROOT, "N");
        expect(error).toHaveBeenCalledTimes(1);
    });

    it("R3-#3 setter throws once in setFromPanel, then retries stored draft without old native callback", async () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
        let currentValue = "";
        let throwOnWrite = true;
        const repository = makeRepository(ROOT, "");
        const inputBox: FakeBox = {
            get value() {
                return currentValue;
            },
            set value(next: string) {
                if (throwOnWrite) {
                    throwOnWrite = false;
                    throw new Error("setter failed");
                }
                currentValue = next;
            },
        };
        repository.inputBox = inputBox;
        const current = await prepare(repository);
        current.tick();
        onNativeChange.mockClear();
        drafts.set(ROOT, "Q");

        expect(() => current.setFromPanel(ROOT, "Q")).not.toThrow();
        expect(recordFor()).toEqual({ base: "", pending: true });

        current.tick();

        expect(currentValue).toBe("Q");
        expect(recordFor()).toEqual({ base: "Q", pending: false });
        expect(onNativeChange).not.toHaveBeenCalled();
        expect(error).toHaveBeenCalledTimes(1);
    });

    it("push whose setter throws leaves base and pending untouched and never adopts the stale box", async () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
        let currentValue = "D";
        let throwOnWrite = false;
        const repository = makeRepository(ROOT, "D");
        repository.inputBox = {
            get value() {
                return currentValue;
            },
            set value(next: string) {
                if (throwOnWrite) throw new Error("setter failed");
                currentValue = next;
            },
        };
        drafts.set(ROOT, "D");
        const current = await prepare(repository);
        current.setVisible(true);
        expect(onNativeChange).toHaveBeenCalledWith(ROOT, "D");
        expect(onNativeChange).toHaveBeenCalledTimes(1);
        onNativeChange.mockClear();
        persistDraft.mockClear();

        throwOnWrite = true;
        current.setFromPanel(ROOT, "Q");
        drafts.set(ROOT, "Q");
        current.tick();

        expect(recordFor()).toEqual({ base: "D", pending: true });
        expect(repository.inputBox.value).toBe("D");
        expect(onNativeChange).not.toHaveBeenCalledWith(ROOT, "D");
        expect(persistDraft).not.toHaveBeenCalled();

        throwOnWrite = false;
        current.tick();

        expect(repository.inputBox.value).toBe("Q");
        expect(recordFor()).toEqual({ base: "Q", pending: false });
        expect(persistDraft).not.toHaveBeenCalled();
        expect(onNativeChange).not.toHaveBeenCalledWith(ROOT, "Q");
        expect(error).toHaveBeenCalledTimes(1);
    });

    it("throwing input-box getter never throws to caller and logs once", async () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const repository = makeRepository(ROOT, "D");
        Object.defineProperty(repository.inputBox, "value", {
            get: () => {
                throw new Error("getter failed");
            },
            set: () => undefined,
        });
        const current = await prepare(repository);

        expect(() => current.tick()).not.toThrow();
        expect(() => current.tick()).not.toThrow();
        expect(error).toHaveBeenCalledTimes(1);
        expect(onNativeChange).not.toHaveBeenCalled();
        expect(persistDraft).not.toHaveBeenCalled();
        // The placeholder record never gets a base, so the root still awaits first contact.
        expect(recordFor()).toEqual({ pending: false });
    });

    it("throwing input-box setter never throws to caller", async () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const repository = makeRepository(ROOT, "D");
        const current = await prepare(repository);
        current.tick();
        Object.defineProperty(repository.inputBox, "value", {
            get: () => "D",
            set: () => {
                throw new Error("setter failed");
            },
        });
        drafts.set(ROOT, "Q");

        expect(() => current.setFromPanel(ROOT, "Q")).not.toThrow();
        expect(error).toHaveBeenCalledTimes(1);
    });

    it("attach twice for one root is a no-op", async () => {
        const repository = makeRepository(ROOT, "N");
        const current = await prepare(repository);

        current.attach(ROOT);
        current.tick();

        expect(onNativeChange).toHaveBeenCalledTimes(1);
        expect(recordFor()).toEqual({ base: "N", pending: false });
    });

    it("detach forgets seen while preserving the shared record", async () => {
        const repository = makeRepository(ROOT, "N");
        const current = await prepare(repository);
        current.tick();
        onNativeChange.mockClear();

        current.detach(ROOT);
        current.attach(ROOT);
        current.tick();

        expect(recordFor()).toEqual({ base: "N", pending: false });
        expect(onNativeChange).toHaveBeenCalledWith(ROOT, "N");
    });

    it("repository appearing after attach gets first contact on appearance tick", async () => {
        const repository = makeRepository(ROOT, "N");
        api = { repositories: [] };
        const current = makeBridge();
        current.attach(ROOT);
        await flushResolve();

        current.tick();
        expect(onNativeChange).not.toHaveBeenCalled();

        api.repositories.push(repository);
        current.tick();

        expect(onNativeChange).toHaveBeenCalledWith(ROOT, "N");
        expect(recordFor()).toEqual({ base: "N", pending: false });
    });

    it("R1-#4 pending resolve while hidden performs no callback or write after resolve", async () => {
        let resolve!: (value: VsCodeGitApi | undefined) => void;
        const pending = new Promise<VsCodeGitApi | undefined>((done) => {
            resolve = done;
        });
        const repository = makeRepository(ROOT, "D");
        api = makeApi(repository);
        const current = makeBridge(() => pending);
        current.attach(ROOT);
        current.setVisible(false);
        resolve(api);
        await flushResolve();
        vi.advanceTimersByTime(2000);

        expect(repository.inputBox.value).toBe("D");
        expect(onNativeChange).not.toHaveBeenCalled();
    });

    it("R1-#4 pending resolve disposed performs no callback or write after resolve", async () => {
        let resolve!: (value: VsCodeGitApi | undefined) => void;
        const pending = new Promise<VsCodeGitApi | undefined>((done) => {
            resolve = done;
        });
        const repository = makeRepository(ROOT, "D");
        api = makeApi(repository);
        const current = makeBridge(() => pending);
        current.attach(ROOT);
        current.setVisible(true);
        current.dispose();
        resolve(api);
        await flushResolve();
        vi.advanceTimersByTime(2000);

        expect(repository.inputBox.value).toBe("D");
        expect(onNativeChange).not.toHaveBeenCalled();
    });

    it("absent resolveApi is a no-op with no log", async () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
        vscodeMock.extensions.getExtension.mockReturnValue(undefined);
        const current = new NativeCommitInputBridge({
            readDraft,
            persistDraft,
            onNativeChange,
            shared,
        });
        current.attach(ROOT);
        await flushResolve();
        current.tick();
        current.setFromPanel(ROOT, "Q");

        expect(onNativeChange).not.toHaveBeenCalled();
        expect(persistDraft).not.toHaveBeenCalled();
        expect(error).not.toHaveBeenCalled();
    });

    it("disabled resolved extension is a no-op with no log", async () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const repository = makeRepository(ROOT, "D");
        api = makeApi(repository);
        vscodeMock.extensions.getExtension.mockReturnValue({
            activate: vi.fn(async () => ({
                enabled: false,
                getAPI: vi.fn(() => api),
            })),
        });
        const current = new NativeCommitInputBridge({
            readDraft,
            persistDraft,
            onNativeChange,
            shared,
        });
        current.attach(ROOT);
        await flushResolve();
        current.tick();

        expect(onNativeChange).not.toHaveBeenCalled();
        expect(persistDraft).not.toHaveBeenCalled();
        expect(error).not.toHaveBeenCalled();
    });

    it("rejected resolveApi logs once and stays inert", async () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const current = makeBridge(() => Promise.reject(new Error("resolve failed")));
        current.attach(ROOT);
        await flushResolve();
        current.tick();
        current.tick();

        expect(error).toHaveBeenCalledTimes(1);
        expect(String(error.mock.calls[0]?.[0])).toMatch(/^\[IntelliGit\]/);
        expect(onNativeChange).not.toHaveBeenCalled();
    });

    it("win32 trailing separator and case differences still match a repository root", async () => {
        const originalPlatform = process.platform;
        Object.defineProperty(process, "platform", { value: "win32", configurable: true });
        const requestedRoot = "/Workspace/Repo/";
        const repository = makeRepository("/workspace/repo", "N");
        api = makeApi(repository);
        const current = makeBridge();
        current.attach(requestedRoot);
        await flushResolve();

        current.tick();

        expect(onNativeChange).toHaveBeenCalledWith(requestedRoot, "N");
        expect(recordFor(requestedRoot)).toEqual({ base: "N", pending: false });
        Object.defineProperty(process, "platform", {
            value: originalPlatform,
            configurable: true,
        });
    });

    it("one throwing repository does not block other repositories", async () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const bad = makeRepository("/bad", "bad");
        Object.defineProperty(bad.inputBox, "value", {
            get: () => {
                throw new Error("bad getter");
            },
        });
        const good = makeRepository("/good", "good");
        api = { repositories: [bad, good] };
        const current = makeBridge();
        current.attach("/bad");
        current.attach("/good");
        await flushResolve();

        current.tick();

        expect(onNativeChange).toHaveBeenCalledWith("/good", "good");
        expect(recordFor("/good")).toEqual({ base: "good", pending: false });
        expect(error).toHaveBeenCalledTimes(1);
    });

    it("dispose stops the timer", async () => {
        const repository = makeRepository(ROOT, "D");
        const current = await prepare(repository);
        current.setVisible(true);
        onNativeChange.mockClear();
        current.dispose();
        setNativeValue(repository, "N");

        vi.advanceTimersByTime(2000);

        expect(onNativeChange).not.toHaveBeenCalled();
    });

    it("R4-#1 bridge B ticks first after A pre-contact clear, pushes empty and only B delivers", async () => {
        const repository = makeRepository(ROOT, "D");
        drafts.set(ROOT, "D");
        api = { repositories: [] };
        const first = makeBridge();
        first.attach(ROOT);
        const second = makeBridge();
        second.attach(ROOT);
        await flushResolve();

        drafts.set(ROOT, "");
        first.setFromPanel(ROOT, "");
        api.repositories.push(repository);
        second.tick();

        expect(repository.inputBox.value).toBe("");
        expect(onNativeChange).toHaveBeenCalledWith(ROOT, "");
        expect(onNativeChange).toHaveBeenCalledTimes(1);

        first.tick();
        expect(onNativeChange).toHaveBeenCalledTimes(1);
    });

    it("R4-#2 two bridges both deliver one plugin write", async () => {
        const repository = makeRepository(ROOT, "D");
        drafts.set(ROOT, "D");
        api = makeApi(repository);
        const first = makeBridge();
        first.attach(ROOT);
        const second = makeBridge();
        second.attach(ROOT);
        await flushResolve();
        first.tick();
        second.tick();
        onNativeChange.mockClear();

        setNativeValue(repository, "N");
        first.tick();
        expect(onNativeChange).toHaveBeenCalledWith(ROOT, "N");
        second.tick();
        expect(onNativeChange).toHaveBeenCalledWith(ROOT, "N");
        expect(onNativeChange).toHaveBeenCalledTimes(2);

        first.tick();
        second.tick();
        expect(onNativeChange).toHaveBeenCalledTimes(2);
    });

    it("first delivery is not suppressed when base moved before this bridge's first tick", async () => {
        const repository = makeRepository(ROOT, "X");
        drafts.set(ROOT, "X");
        api = makeApi(repository);
        const first = makeBridge();
        first.attach(ROOT);
        const second = makeBridge();
        second.attach(ROOT);
        await flushResolve();

        first.tick();
        onNativeChange.mockClear();

        setNativeValue(repository, "N");
        first.tick();
        expect(persistDraft).toHaveBeenCalledWith(ROOT, "N");

        second.tick();
        expect(onNativeChange.mock.calls).toEqual([
            [ROOT, "N"],
            [ROOT, "N"],
        ]);

        second.tick();
        expect(onNativeChange.mock.calls).toEqual([
            [ROOT, "N"],
            [ROOT, "N"],
        ]);
    });

    it("edit Q through A reaches B, while A does not redeliver it", async () => {
        const repository = makeRepository(ROOT, "D");
        api = makeApi(repository);
        const first = makeBridge();
        first.attach(ROOT);
        const second = makeBridge();
        second.attach(ROOT);
        await flushResolve();
        first.tick();
        second.tick();
        onNativeChange.mockClear();

        drafts.set(ROOT, "Q");
        first.setFromPanel(ROOT, "Q");
        second.tick();

        expect(onNativeChange).toHaveBeenCalledWith(ROOT, "Q");
        expect(onNativeChange).toHaveBeenCalledTimes(1);
        first.tick();
        expect(onNativeChange).toHaveBeenCalledTimes(1);
    });

    it("at startup each bridge delivers the agreed text exactly once", async () => {
        const firstRepository = makeRepository(ROOT, "N");
        const secondRoot = "/workspace/other";
        const secondRepository = makeRepository(secondRoot, "M");
        api = { repositories: [firstRepository, secondRepository] };
        const first = makeBridge();
        first.attach(ROOT);
        const second = makeBridge();
        second.attach(secondRoot);
        await flushResolve();

        first.tick();
        second.tick();

        expect(onNativeChange).toHaveBeenCalledWith(ROOT, "N");
        expect(onNativeChange).toHaveBeenCalledWith(secondRoot, "M");
        expect(onNativeChange).toHaveBeenCalledTimes(2);
        first.tick();
        second.tick();
        expect(onNativeChange).toHaveBeenCalledTimes(2);
    });

    it("R5-#1 pre-contact clear placeholder pushes empty and never adopts restored D", async () => {
        const repository = makeRepository(ROOT, "D");
        drafts.set(ROOT, "");
        api = { repositories: [] };
        const current = makeBridge();
        current.attach(ROOT);
        await flushResolve();

        current.setFromPanel(ROOT, "");
        api.repositories.push(repository);
        current.tick();

        expect(repository.inputBox.value).toBe("");
        expect(recordFor()).toEqual({ base: "", pending: false });
        expect(drafts.get(ROOT)).toBe("");
        expect(onNativeChange).not.toHaveBeenCalled();
    });

    it("R5-#2 adopt persists plugin N even when seen is already N and does not deliver", async () => {
        const repository = makeRepository(ROOT, "N");
        drafts.set(ROOT, "N");
        api = makeApi(repository);
        const first = makeBridge();
        first.attach(ROOT);
        const second = makeBridge();
        second.attach(ROOT);
        await flushResolve();
        first.tick();
        second.tick();
        onNativeChange.mockClear();
        persistDraft.mockClear();

        drafts.set(ROOT, "P");
        second.setFromPanel(ROOT, "P");
        setNativeValue(repository, "N");
        first.tick();

        expect(persistDraft).toHaveBeenCalledWith(ROOT, "N");
        expect(onNativeChange).not.toHaveBeenCalled();
        expect(recordFor()).toEqual({ base: "N", pending: false });
    });

    it("persistDraft runs on first-contact adopt and never on push", async () => {
        const adoptRepository = makeRepository(ROOT, "N");
        const current = await prepare(adoptRepository);
        current.tick();
        expect(persistDraft).toHaveBeenCalledTimes(1);

        shared = new Map();
        drafts = new Map([[ROOT, "D"]]);
        persistDraft.mockClear();
        onNativeChange.mockClear();
        const pushRepository = makeRepository(ROOT, "");
        api = makeApi(pushRepository);
        const pushBridge = makeBridge();
        pushBridge.attach(ROOT);
        await flushResolve();
        pushBridge.tick();

        expect(persistDraft).not.toHaveBeenCalled();
    });

    it("setFromPanel does not write when native value already equals message", async () => {
        let value = "D";
        const writes: string[] = [];
        const repository = makeRepository(ROOT, "");
        repository.inputBox = {
            get value() {
                return value;
            },
            set value(next: string) {
                writes.push(next);
                value = next;
            },
        };
        const current = await prepare(repository);
        current.tick();
        writes.length = 0;

        current.setFromPanel(ROOT, "D");

        expect(writes).toEqual([]);
    });
});
