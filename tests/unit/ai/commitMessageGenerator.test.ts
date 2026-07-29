import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    selectChatModels: vi.fn(),
    getConfiguration: vi.fn(),
    configuration: undefined as unknown,
    openOverride: undefined as
        | undefined
        | ((path: string) => Promise<Awaited<ReturnType<typeof import("node:fs/promises").open>>>),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs/promises")>();
    return {
        ...actual,
        open: (filePath: string, ...args: Parameters<typeof actual.open>[1][]) =>
            mocks.openOverride?.(filePath) ?? actual.open(filePath, ...args),
    };
});

vi.mock("vscode", () => ({
    lm: { selectChatModels: mocks.selectChatModels },
    workspace: {
        getConfiguration: mocks.getConfiguration.mockImplementation(() => ({
            get: () => mocks.configuration,
        })),
    },
    LanguageModelChatMessage: { User: vi.fn((content: string) => ({ content })) },
    LanguageModelError: class MockLanguageModelError extends Error {},
}));

import {
    CopilotUnavailableError,
    EmptyResultError,
    GenerationRequestError,
    PromptTooLargeError,
    prepareCommitMessageGeneration,
    buildCommitMessagePrompt,
} from "../../../src/ai/commitMessageGenerator";

const directories: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
    await Promise.all(
        directories.splice(0).map(async (directory) => {
            await rm(directory, { recursive: true, force: true });
        }),
    );
});

beforeEach(() => {
    mocks.configuration = undefined;
    mocks.selectChatModels.mockReset();
    mocks.openOverride = undefined;
});

function token(cancelled = false): {
    isCancellationRequested: boolean;
    onCancellationRequested: () => { dispose(): void };
} {
    return {
        isCancellationRequested: cancelled,
        onCancellationRequested: () => ({ dispose() {} }),
    };
}

function cancellableToken(): {
    token: {
        isCancellationRequested: boolean;
        onCancellationRequested: (listener: () => void) => { dispose(): void };
    };
    cancel(): void;
} {
    const listeners = new Set<() => void>();
    const value = {
        isCancellationRequested: false,
        onCancellationRequested(listener: () => void) {
            listeners.add(listener);
            return { dispose: () => listeners.delete(listener) };
        },
    };
    return {
        token: value,
        cancel: () => {
            value.isCancellationRequested = true;
            for (const listener of listeners) listener();
        },
    };
}

function model(
    family: string,
    options: {
        maxInputTokens?: number;
        countTokens?: (value: string) => number;
        text?: AsyncIterable<string>;
    } = {},
): Record<string, unknown> {
    return {
        family,
        maxInputTokens: options.maxInputTokens ?? 10_000,
        countTokens: vi.fn(async (value: string) => options.countTokens?.(value) ?? 10),
        sendRequest: vi.fn(async () => ({
            text:
                options.text ??
                (async function* () {
                    yield "fix: generated";
                })(),
        })),
    };
}

async function workspace(): Promise<{ uri: { fsPath: string } }> {
    const root = await mkdtemp(path.join(tmpdir(), "intelligit-p3-"));
    directories.push(root);
    return { uri: { fsPath: root } };
}

function request(
    folder: { uri: { fsPath: string } },
    overrides: Record<string, unknown> = {},
): Record<string, unknown> {
    return {
        workspaceFolder: folder,
        diffResult: {
            diff: "diff --git a/a.ts b/a.ts\n+line",
            summarizedPaths: [],
            truncated: false,
        },
        commitSubjects: ["fix: style context"],
        amend: false,
        token: token(),
        ...overrides,
    };
}

describe("buildCommitMessagePrompt", () => {
    it("carries diff metadata, context, instructions, and the protected output contract", () => {
        const prompt = buildCommitMessagePrompt(
            ["Use imperative mood."],
            {
                diff: "diff --git a/a.ts b/a.ts\n+new line",
                summarizedPaths: ["big.ts"],
                truncated: true,
            },
            ["fix: existing convention"],
            false,
        );

        expect(prompt).toContain("diff --git a/a.ts b/a.ts");
        expect(prompt).toContain("big.ts");
        expect(prompt).toContain("truncated");
        expect(prompt).toContain("fix: existing convention");
        expect(prompt).toContain("normal commit");
        expect(prompt).toContain("Use imperative mood.");
        expect(prompt).toContain("no Markdown/code fences");
    });
});

describe("prepareCommitMessageGeneration", () => {
    it("selects the preferred Copilot family, falls back, and refuses no models", async () => {
        const folder = await workspace();
        const fallback = model("other");
        const preferred = model("gpt-4.1-preview");
        mocks.selectChatModels.mockResolvedValue([fallback, preferred]);

        const prepared = await prepareCommitMessageGeneration(request(folder) as never);

        expect(prepared.model).toBe(preferred);
        expect(mocks.selectChatModels).toHaveBeenCalledWith({ vendor: "copilot" });
        mocks.selectChatModels.mockResolvedValue([fallback]);
        await expect(
            prepareCommitMessageGeneration(request(folder) as never),
        ).resolves.toMatchObject({
            model: fallback,
        });
        mocks.selectChatModels.mockResolvedValue([]);
        await expect(
            prepareCommitMessageGeneration(request(folder) as never),
        ).rejects.toBeInstanceOf(CopilotUnavailableError);
    });

    it("loads bounded repository instruction text and safely skips invalid file entries", async () => {
        const folder = await workspace();
        await writeFile(
            path.join(folder.uri.fsPath, "instructions.txt"),
            "Use conventional commits.",
        );
        await writeFile(path.join(folder.uri.fsPath, "large.txt"), "x".repeat(20_000));
        await writeFile(path.join(folder.uri.fsPath, "cumulative-one.txt"), "a".repeat(8_000));
        await writeFile(path.join(folder.uri.fsPath, "cumulative-two.txt"), "b".repeat(8_000));
        await writeFile(path.join(folder.uri.fsPath, "cumulative-three.txt"), "c");
        await mkdir(path.join(folder.uri.fsPath, "directory"));
        await symlink(tmpdir(), path.join(folder.uri.fsPath, "escape"));
        mocks.configuration = [
            { text: "Use imperative mood." },
            { file: "instructions.txt" },
            { file: "../escape" },
            { file: "escape" },
            { file: "directory" },
            { file: "large.txt" },
            { file: "missing.txt" },
            { file: "cumulative-one.txt" },
            { file: "cumulative-two.txt" },
            { file: "cumulative-three.txt" },
            { text: "", file: "instructions.txt" },
            { unknown: "bad" },
        ];
        const logger = vi.fn();
        const selected = model("gpt-4o");
        mocks.selectChatModels.mockResolvedValue([selected]);

        const prepared = await prepareCommitMessageGeneration(request(folder, { logger }) as never);

        expect(prepared.prompt).toContain("Use imperative mood.");
        expect(prepared.prompt).toContain("Use conventional commits.");
        expect(prepared.prompt).not.toContain("large.txt");
        expect(logger).toHaveBeenCalledTimes(8);
    });

    it("coarse-caps mutable context, keeps the output contract, and fits within the selected token budget", async () => {
        const folder = await workspace();
        const selected = model("gpt-4", {
            maxInputTokens: 100,
            countTokens: (value) => Math.ceil(value.length / 100),
        });
        mocks.selectChatModels.mockResolvedValue([selected]);

        const prepared = await prepareCommitMessageGeneration(
            request(folder, {
                diffResult: {
                    diff: "d".repeat(60_000),
                    summarizedPaths: ["huge.ts"],
                    truncated: true,
                },
                commitSubjects: ["s".repeat(10_000)],
            }) as never,
        );

        expect(prepared.prompt).toContain("Prompt context was truncated");
        expect(prepared.prompt).toContain("no Markdown/code fences");
        expect(
            (selected.countTokens as ReturnType<typeof vi.fn>).mock.calls.length,
        ).toBeLessThanOrEqual(3);
        expect((selected.sendRequest as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    });

    it("proportionally trims adversarial token counts instead of wasting the three-count budget", async () => {
        const folder = await workspace();
        const budget = 400;
        const adversarialCount = (prompt: string) => {
            if (prompt.length > 30_000) return 39_993;
            if (prompt.length > 10_000) return 19_996;
            if (prompt.length > 1_000) return 799;
            return 400;
        };
        const selected = model("gpt-4o", {
            maxInputTokens: budget + 64,
            countTokens: adversarialCount,
        });
        mocks.selectChatModels.mockResolvedValue([selected]);

        const prepared = await prepareCommitMessageGeneration(
            request(folder, {
                diffResult: { diff: "d".repeat(50_000), summarizedPaths: [], truncated: false },
            }) as never,
        );

        expect(adversarialCount(prepared.prompt)).toBeLessThanOrEqual(budget);
        expect(
            (selected.countTokens as ReturnType<typeof vi.fn>).mock.calls.length,
        ).toBeLessThanOrEqual(3);
        expect(selected.sendRequest).toHaveBeenCalledOnce();
    });

    it("skips a FIFO without entering its blocking open path", async () => {
        const folder = await workspace();
        const fifo = path.join(folder.uri.fsPath, "instructions.fifo");
        await execFileAsync("mkfifo", [fifo]);
        mocks.configuration = [{ file: "instructions.fifo" }];
        mocks.openOverride = vi.fn((filePath: string) => {
            if (filePath === fifo) return new Promise(() => {});
            throw new Error(`Unexpected open: ${filePath}`);
        });
        const logger = vi.fn();
        mocks.selectChatModels.mockResolvedValue([model("gpt-4o")]);

        await expect(
            Promise.race([
                prepareCommitMessageGeneration(request(folder, { logger }) as never).then(
                    () => "prepared",
                ),
                new Promise<string>((resolve) => setTimeout(() => resolve("timed out"), 50)),
            ]),
        ).resolves.toBe("prepared");
        expect(logger).toHaveBeenCalledOnce();
        expect(mocks.openOverride).not.toHaveBeenCalled();
    });

    it("refuses an impossible token budget without starting a request", async () => {
        const folder = await workspace();
        const selected = model("gpt-4o", { maxInputTokens: 1, countTokens: () => 99 });
        mocks.selectChatModels.mockResolvedValue([selected]);

        await expect(
            prepareCommitMessageGeneration(request(folder) as never),
        ).rejects.toBeInstanceOf(PromptTooLargeError);
        expect(selected.sendRequest).not.toHaveBeenCalled();
    });

    it("streams text in order and rejects whitespace-only completions", async () => {
        const folder = await workspace();
        const selected = model("gpt-4o", {
            text: (async function* () {
                yield "fix: ";
                yield "streamed";
            })(),
        });
        mocks.selectChatModels.mockResolvedValue([selected]);
        const prepared = await prepareCommitMessageGeneration(request(folder) as never);
        await expect(Array.fromAsync(prepared.text)).resolves.toEqual(["fix: ", "streamed"]);

        mocks.selectChatModels.mockResolvedValue([
            model("gpt-4o", {
                text: (async function* () {
                    yield " ";
                    yield "\n";
                })(),
            }),
        ]);
        const blank = await prepareCommitMessageGeneration(request(folder) as never);
        await expect(Array.fromAsync(blank.text)).rejects.toBeInstanceOf(EmptyResultError);
    });

    it("maps request and stream language-model failures and cancellation to stable kinds", async () => {
        const folder = await workspace();
        const unavailable = model("gpt-4o");
        (unavailable.sendRequest as ReturnType<typeof vi.fn>).mockRejectedValue({
            code: "NoPermissions",
        });
        mocks.selectChatModels.mockResolvedValue([unavailable]);
        await expect(
            prepareCommitMessageGeneration(request(folder) as never),
        ).rejects.toMatchObject({ kind: "noPermissions" });

        const notFound = model("gpt-4o");
        (notFound.sendRequest as ReturnType<typeof vi.fn>).mockRejectedValue({ code: "NotFound" });
        mocks.selectChatModels.mockResolvedValue([notFound]);
        await expect(
            prepareCommitMessageGeneration(request(folder) as never),
        ).rejects.toMatchObject({ kind: "notFound" });

        const unknown = model("gpt-4o");
        (unknown.sendRequest as ReturnType<typeof vi.fn>).mockRejectedValue(
            new Error("unexpected"),
        );
        mocks.selectChatModels.mockResolvedValue([unknown]);
        await expect(
            prepareCommitMessageGeneration(request(folder) as never),
        ).rejects.toMatchObject({ kind: "unknown" });

        const streamFailure = model("gpt-4o", {
            text: (async function* () {
                throw { code: "Blocked" };
            })(),
        });
        mocks.selectChatModels.mockResolvedValue([streamFailure]);
        const prepared = await prepareCommitMessageGeneration(request(folder) as never);
        await expect(Array.fromAsync(prepared.text)).rejects.toMatchObject({ kind: "blocked" });

        mocks.selectChatModels.mockResolvedValue([model("gpt-4o")]);
        await expect(
            prepareCommitMessageGeneration(request(folder, { token: token(true) }) as never),
        ).rejects.toMatchObject({ kind: "cancelled" });
        expect(GenerationRequestError).toBeDefined();
    });

    it("cancels an unresolved model selection and harmlessly discards its later settlement", async () => {
        const folder = await workspace();
        const deferred = Promise.withResolvers<readonly Record<string, unknown>[]>();
        const cancellation = cancellableToken();
        mocks.selectChatModels.mockReturnValue(deferred.promise);

        const preparing = prepareCommitMessageGeneration(
            request(folder, { token: cancellation.token }) as never,
        );
        cancellation.cancel();
        await expect(preparing).rejects.toMatchObject({ kind: "cancelled" });
        deferred.resolve([model("gpt-4o")]);
        await expect(Promise.resolve()).resolves.toBeUndefined();
    });

    it("keeps amend context, ten supplied subjects, the output contract, and mapped causes", async () => {
        const folder = await workspace();
        const selected = model("gpt-4o");
        mocks.selectChatModels.mockResolvedValue([selected]);
        const subjects = Array.from({ length: 12 }, (_, index) => `subject ${index}`);

        const prepared = await prepareCommitMessageGeneration(
            request(folder, { amend: true, commitSubjects: subjects }) as never,
        );
        expect(prepared.prompt).toContain("commit amendment");
        expect(prepared.prompt).toContain("subject 9");
        expect(prepared.prompt).not.toContain("subject 10");
        expect(prepared.prompt).toContain("no Markdown/code fences");

        const requestCause = { code: "NoPermissions" };
        const rejected = model("gpt-4o");
        (rejected.sendRequest as ReturnType<typeof vi.fn>).mockRejectedValue(requestCause);
        mocks.selectChatModels.mockResolvedValue([rejected]);
        await expect(
            prepareCommitMessageGeneration(request(folder) as never),
        ).rejects.toMatchObject({
            kind: "noPermissions",
            cause: requestCause,
        });

        const streamCause = { code: "Blocked" };
        const streaming = model("gpt-4o", {
            text: (async function* () {
                throw streamCause;
            })(),
        });
        mocks.selectChatModels.mockResolvedValue([streaming]);
        const streamPrepared = await prepareCommitMessageGeneration(request(folder) as never);
        await expect(Array.fromAsync(streamPrepared.text)).rejects.toMatchObject({
            kind: "blocked",
            cause: streamCause,
        });
    });
});
