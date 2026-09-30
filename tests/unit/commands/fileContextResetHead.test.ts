import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitOps } from "../../../src/git/operations";
import { GitExecutor } from "../../../src/git/executor";

const OID = "1234567890abcdef1234567890abcdef12345678";
const OID64 = `${OID}${OID.slice(0, 24)}`;
const OTHER = "abcdef1234567890abcdef1234567890abcdef12";
const mocks = vi.hoisted(() => {
    class Uri {
        constructor(
            readonly fsPath: string,
            readonly scheme = "file",
        ) {}
    }
    return {
        Uri,
        activeUri: new Uri("/repo-a/active.txt"),
        realpath: vi.fn(async (value: string) => value),
        discover: vi.fn(async () => "/repo-b\n"),
        run: vi.fn(async (args: string[]) =>
            args[0] === "rev-parse" && args.includes("--verify") ? `${OID}\n` : "main\n",
        ),
        deriveExecutor: vi.fn(),
        operation: vi.fn(async () => "none"),
        branches: vi.fn(async () => [{ name: "main", isCurrent: true }]),
        input: vi.fn(async () => "HEAD" as string | undefined),
        picker: vi.fn(async (items: Array<{ mode: string }>) => items[0]),
        warning: vi.fn(async () => "Reset" as string | undefined),
        error: vi.fn(),
        info: vi.fn(),
    };
});

vi.mock("node:fs/promises", () => ({ realpath: mocks.realpath }));
vi.mock("vscode", () => ({
    Uri: mocks.Uri,
    window: {
        get activeTextEditor() {
            return { document: { uri: mocks.activeUri } };
        },
        showInputBox: mocks.input,
        showQuickPick: mocks.picker,
        showWarningMessage: mocks.warning,
        showErrorMessage: mocks.error,
        showInformationMessage: mocks.info,
    },
    l10n: {
        t: (message: string, args?: Record<string, unknown>) =>
            Object.entries(args ?? {}).reduce(
                (text, [key, value]) => text.replaceAll(`{${key}}`, String(value)),
                message,
            ),
    },
}));
vi.mock("../../../src/git/executor", () => ({
    GitExecutor: class {
        run = mocks.discover;
        deriveFor = mocks.deriveExecutor;
    },
}));
vi.mock("../../../src/services/diffService", () => ({}));
vi.mock("../../../src/utils/notifications", () => ({ showTimedInformationMessage: mocks.info }));

import { resetHeadFileFromContext } from "../../../src/commands/fileContextCommands";

const scoped = {
    getActiveOperation: mocks.operation,
    getBranches: mocks.branches,
} as unknown as GitOps;
const deriveFor = vi.fn(() => scoped);
const gitOps = { deriveFor } as unknown as GitOps;
const executor = new GitExecutor("/repo-a");
const refresh = vi.fn(async (_repoRoot: string) => undefined);

beforeEach(() => {
    vi.clearAllMocks();
    deriveFor.mockReturnValue(scoped);
    mocks.deriveExecutor.mockReturnValue({ run: mocks.run });
    mocks.discover.mockResolvedValue("/repo-b\n");
    mocks.operation.mockResolvedValue("none");
    mocks.branches.mockResolvedValue([{ name: "main", isCurrent: true }]);
    mocks.input.mockResolvedValue("HEAD");
    mocks.picker.mockImplementation(async (items) => items[0]);
    mocks.warning.mockResolvedValue("Reset");
    mocks.run.mockImplementation(async (args) =>
        args[0] === "rev-parse" && args.includes("--verify") ? `${OID}\n` : "main\n",
    );
    refresh.mockResolvedValue(undefined);
});

const selected = () => new mocks.Uri("/repo-b/selected.txt");
const gitArgs = () => mocks.run.mock.calls.map(([args]) => args);

describe("native Reset HEAD repository contract", () => {
    it("contributes Reset directly after New Tag in both native file menus", () => {
        const manifest = JSON.parse(
            readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
        );
        expect(manifest.contributes.commands).toContainEqual({
            command: "intelligit.fileResetHead",
            title: "%command.fileResetHead%",
            category: "%intelligit%",
        });
        expect(manifest.contributes.commands).toHaveLength(100);
        for (const menu of ["intelligit.fileContext", "intelligit.editorContext"]) {
            const entries = manifest.contributes.menus[menu];
            expect(entries).toHaveLength(23);
            const tag = entries.findIndex(
                (entry: { command?: string }) => entry.command === "intelligit.fileNewTag",
            );
            expect(entries[tag + 1], `${menu} places Reset after New Tag`).toEqual({
                command: "intelligit.fileResetHead",
                when: "resourceScheme == file",
                group: "4_branch@6",
            });
        }
    });
    it("defaults visibly to HEAD and resets the clicked B to its captured commit", async () => {
        await resetHeadFileFromContext(selected(), gitOps, executor, refresh);
        expect(mocks.input).toHaveBeenCalledWith(expect.objectContaining({ value: "HEAD" }));
        expect(deriveFor).toHaveBeenCalledExactlyOnceWith("/repo-b");
        expect(mocks.deriveExecutor).toHaveBeenCalledExactlyOnceWith("/repo-b");
        expect(gitArgs()).toEqual([
            ["rev-parse", "--abbrev-ref", "HEAD"],
            ["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"],
            ["reset", "--soft", OID],
        ]);
        expect(mocks.operation).toHaveBeenCalledTimes(2);
        expect(refresh).toHaveBeenCalledExactlyOnceWith("/repo-b");
    });

    it.each(["feature", "v1.0", OID, OID.slice(0, 8), "HEAD~1"])(
        "resolves entered revision %s once through option-safe argv",
        async (revision) => {
            mocks.input.mockResolvedValue(`  ${revision}  `);
            await resetHeadFileFromContext(selected(), gitOps, executor, refresh);
            expect(gitArgs()).toContainEqual([
                "rev-parse",
                "--verify",
                "--end-of-options",
                `${revision}^{commit}`,
            ]);
            expect(gitArgs()).toContainEqual(["reset", "--soft", OID]);
        },
    );

    it("resets to a resolved SHA-256 commit OID", async () => {
        mocks.run.mockImplementation(async (args) =>
            args.includes("--verify") ? `${OID64}\n` : "main\n",
        );
        await resetHeadFileFromContext(selected(), gitOps, executor, refresh);
        expect(gitArgs()).toContainEqual(["reset", "--soft", OID64]);
        expect(refresh).toHaveBeenCalledExactlyOnceWith("/repo-b");
    });

    it.each(["soft", "mixed", "hard", "merge", "keep"])(
        "offers existing modes and dispatches %s after its modal warning",
        async (mode) => {
            mocks.picker.mockImplementation(async (items) =>
                items.find((item) => item.mode === mode),
            );
            await resetHeadFileFromContext(selected(), gitOps, executor, refresh);
            expect(
                mocks.picker.mock.calls[0][0].map((item: { mode: string }) => item.mode),
            ).toEqual(["soft", "mixed", "hard", "merge", "keep"]);
            expect(mocks.warning).toHaveBeenCalledWith(
                expect.stringContaining(`reset main to ${OID.slice(0, 8)}?`),
                expect.objectContaining({ modal: true, detail: expect.any(String) }),
                "Reset",
            );
            expect(gitArgs()).toContainEqual(["reset", `--${mode}`, OID]);
        },
    );

    it("names detached HEAD in its confirmation", async () => {
        mocks.branches.mockResolvedValue([]);
        mocks.run.mockImplementation(async (args) =>
            args.includes("--verify") ? `${OID}\n` : "HEAD\n",
        );
        await resetHeadFileFromContext(selected(), gitOps, executor, refresh);
        expect(mocks.warning).toHaveBeenCalledWith(
            `Soft reset HEAD to ${OID.slice(0, 8)}?`,
            expect.objectContaining({ modal: true }),
            "Reset",
        );
    });

    it.each([undefined, "", "   "])(
        "cancelled or blank input %s never resets or refreshes",
        async (input) => {
            mocks.input.mockResolvedValue(input);
            await resetHeadFileFromContext(selected(), gitOps, executor, refresh);
            expect(gitArgs().some((args) => args[0] === "reset")).toBe(false);
            expect(refresh).not.toHaveBeenCalled();
        },
    );

    it.each(["-bad", "missing", "tree"])(
        "invalid revision %s is rejected before modes",
        async (revision) => {
            mocks.input.mockResolvedValue(revision);
            mocks.run.mockImplementation(async (args) => {
                if (args.includes("--verify")) throw new Error("unknown revision");
                return "main\n";
            });
            await resetHeadFileFromContext(selected(), gitOps, executor, refresh);
            expect(gitArgs()).toContainEqual([
                "rev-parse",
                "--verify",
                "--end-of-options",
                `${revision}^{commit}`,
            ]);
            expect(mocks.picker).not.toHaveBeenCalled();
            expect(refresh).not.toHaveBeenCalled();
            expect(mocks.error).toHaveBeenCalledWith(expect.stringContaining(revision));
        },
    );

    it.each([
        ["40 nonhex characters", "z".repeat(40)],
        ["64 nonhex characters", "z".repeat(64)],
        ["uppercase hex", "A".repeat(40)],
        ["uppercase SHA-256 hex", "A".repeat(64)],
        ["39 hex characters", "a".repeat(39)],
        ["41 hex characters", "a".repeat(41)],
        ["63 hex characters", "a".repeat(63)],
        ["65 hex characters", "a".repeat(65)],
        ["abbreviated valid hex", "a".repeat(7)],
    ])("rejects resolver output with %s", async (_case, output) => {
        mocks.run.mockImplementation(async (args) =>
            args.includes("--verify") ? `${output}\n` : "main\n",
        );
        await resetHeadFileFromContext(selected(), gitOps, executor, refresh);
        expect(mocks.error, "invalid resolver output reports an error").toHaveBeenCalledWith(
            expect.stringContaining("Invalid reset target"),
        );
        expect(mocks.picker, "invalid resolver output never opens modes").not.toHaveBeenCalled();
        expect(gitArgs().some((args) => args[0] === "reset")).toBe(false);
        expect(refresh).not.toHaveBeenCalled();
    });

    it.each(["input", "mode", "confirmation"])(
        "%s dismissal has no reset or refresh",
        async (stage) => {
            if (stage === "input") mocks.input.mockResolvedValue(undefined);
            if (stage === "mode") mocks.picker.mockResolvedValue(undefined);
            if (stage === "confirmation") mocks.warning.mockResolvedValue(undefined);
            await resetHeadFileFromContext(selected(), gitOps, executor, refresh);
            expect(
                gitArgs().some((args) => args[0] === "reset"),
                "declined confirmation never resets",
            ).toBe(false);
            expect(refresh).not.toHaveBeenCalled();
        },
    );

    it.each(["first", "second"])(
        "the %s operation fence prevents reset and refresh",
        async (stage) => {
            if (stage === "first") mocks.operation.mockResolvedValueOnce("merge");
            else mocks.operation.mockResolvedValueOnce("none").mockResolvedValueOnce("merge");
            await resetHeadFileFromContext(selected(), gitOps, executor, refresh);
            if (stage === "first")
                expect(mocks.input, "first fence prevents target prompt").not.toHaveBeenCalled();
            expect(
                gitArgs().some((args) => args[0] === "reset"),
                "second fence prevents reset",
            ).toBe(false);
            expect(refresh).not.toHaveBeenCalled();
        },
    );

    it("rechecks the operation after a pending confirmation is accepted", async () => {
        let accept!: (choice: string) => void;
        mocks.warning.mockImplementationOnce(
            () => new Promise<string>((resolve) => (accept = resolve)),
        );
        const pending = resetHeadFileFromContext(selected(), gitOps, executor, refresh);
        await vi.waitFor(() => expect(mocks.warning).toHaveBeenCalledOnce());
        mocks.operation.mockResolvedValue("merge");
        accept("Reset");
        await pending;
        expect(mocks.operation).toHaveBeenCalledTimes(2);
        expect(
            gitArgs().some((args) => args[0] === "reset"),
            "late operation prevents reset",
        ).toBe(false);
        expect(refresh).not.toHaveBeenCalled();
    });

    it("keeps clicked B and captured OID while active repository and ref move during dialogs", async () => {
        mocks.input.mockImplementation(async () => {
            mocks.activeUri = new mocks.Uri("/repo-a/other.txt");
            mocks.discover.mockResolvedValue("/repo-a\n");
            mocks.run.mockImplementation(async (args) =>
                args.includes("--verify") ? `${OID}\n` : "other-branch\n",
            );
            return "moving-ref";
        });
        mocks.picker.mockImplementation(async (items) => {
            mocks.run.mockResolvedValue(`${OTHER}\n`);
            return items[0];
        });
        await resetHeadFileFromContext(selected(), gitOps, executor, refresh);
        expect(deriveFor, "clicked repository B remains the owner").toHaveBeenCalledExactlyOnceWith(
            "/repo-b",
        );
        expect(mocks.deriveExecutor).toHaveBeenCalledExactlyOnceWith("/repo-b");
        expect(gitArgs().filter((args) => args.includes("--verify"))).toHaveLength(1);
        expect(gitArgs(), "moving ref uses captured OID").toContainEqual(["reset", "--soft", OID]);
        expect(mocks.warning).toHaveBeenCalledWith(
            expect.stringContaining("reset main to"),
            expect.objectContaining({ modal: true }),
            "Reset",
        );
        expect(refresh).toHaveBeenCalledExactlyOnceWith("/repo-b");
    });

    it("reports Git reset failure and refreshes only clicked B", async () => {
        mocks.run.mockImplementation(async (args) => {
            if (args[0] === "reset") throw new Error("conflict");
            return args.includes("--verify") ? `${OID}\n` : "main\n";
        });
        await resetHeadFileFromContext(selected(), gitOps, executor, refresh);
        expect(mocks.error).toHaveBeenCalledWith("Reset failed: conflict");
        expect(refresh).toHaveBeenCalledExactlyOnceWith("/repo-b");
    });
});
