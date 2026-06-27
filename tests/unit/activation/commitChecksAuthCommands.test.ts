// Spec-derived tests for the commit-check sign-in/sign-out commands. Behavior is taken from
// the Phase 1 contract: register two commands, prompt for a host then a token on sign-in,
// store the token (lowercased host key) and confirm; on sign-out prompt and clear the token;
// cancelling any prompt is a no-op; a storage failure surfaces a generic message that never
// contains the token. The real CredentialStore runs against a Map-backed SecretStorage double;
// only the VS Code window/commands surface (an external boundary) is mocked.

import type * as vscode from "vscode";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { interpolateL10n } from "../../helpers/l10nTestHelper";

const SIGN_IN = "intelligit.commitChecks.signIn";
const SIGN_OUT = "intelligit.commitChecks.signOut";
const KEY_PREFIX = "intelligit.commitChecks.token:";

const mocks = vi.hoisted(() => {
    const commandHandlers = new Map<string, (...args: unknown[]) => Promise<void>>();
    return {
        showQuickPick: vi.fn(),
        showInputBox: vi.fn(),
        showInformationMessage: vi.fn(),
        showErrorMessage: vi.fn(),
        commandHandlers,
        registerCommand: vi.fn((id: string, handler: (...args: unknown[]) => Promise<void>) => {
            commandHandlers.set(id, handler);
            return { dispose: () => undefined };
        }),
        // The badge-refresh command is registered only in repository mode; here it is
        // absent, so executeCommand rejects to mirror that, exercising the best-effort
        // swallow in refreshCommitCheckBadges.
        executeCommand: vi.fn(async () => {
            throw new Error("command 'intelligit.commitChecks.refreshBadges' not found");
        }),
    };
});

vi.mock("vscode", () => ({
    window: {
        showQuickPick: mocks.showQuickPick,
        showInputBox: mocks.showInputBox,
        showInformationMessage: mocks.showInformationMessage,
        showErrorMessage: mocks.showErrorMessage,
    },
    commands: { registerCommand: mocks.registerCommand, executeCommand: mocks.executeCommand },
    l10n: { t: interpolateL10n },
}));

import { registerCommitChecksAuthCommands } from "../../../src/activation/commitChecksAuthCommands";

/**
 * Builds an extension context whose secrets are a Map-backed SecretStorage double.
 *
 * The store and delete spies can be made to reject once, simulating a SecretStorage
 * failure without ever embedding the token in the thrown error.
 */
function makeContext(): {
    context: vscode.ExtensionContext;
    map: Map<string, string>;
    store: ReturnType<typeof vi.fn>;
    del: ReturnType<typeof vi.fn>;
} {
    const map = new Map<string, string>();
    const get = vi.fn(async (key: string) => map.get(key));
    const store = vi.fn(async (key: string, value: string) => {
        map.set(key, value);
    });
    const del = vi.fn(async (key: string) => {
        map.delete(key);
    });
    const secrets = { get, store, delete: del } as unknown as vscode.SecretStorage;
    const context = {
        subscriptions: [] as { dispose: () => unknown }[],
        secrets,
    } as unknown as vscode.ExtensionContext;
    return { context, map, store, del };
}

/** Resolves the quick pick to the named cloud host item. */
function pickCloud(host: string): void {
    mocks.showQuickPick.mockResolvedValueOnce({ host });
}

/** Resolves the quick pick to the "Other host..." item (custom-host branch). */
function pickOther(): void {
    mocks.showQuickPick.mockResolvedValueOnce({ host: null });
}

beforeEach(() => {
    mocks.showQuickPick.mockReset();
    mocks.showInputBox.mockReset();
    mocks.showInformationMessage.mockReset();
    mocks.showErrorMessage.mockReset();
    mocks.registerCommand.mockClear();
    mocks.commandHandlers.clear();
});

describe("registerCommitChecksAuthCommands", () => {
    it("registers the sign-in and sign-out commands as disposables", () => {
        const { context } = makeContext();

        registerCommitChecksAuthCommands(context);

        expect(mocks.commandHandlers.has(SIGN_IN)).toBe(true);
        expect(mocks.commandHandlers.has(SIGN_OUT)).toBe(true);
        expect(context.subscriptions).toHaveLength(2);
    });
});

describe("signIn", () => {
    it("stores the entered token under the chosen host and confirms", async () => {
        const { context, map, store } = makeContext();
        registerCommitChecksAuthCommands(context);
        pickCloud("gitlab.com");
        mocks.showInputBox.mockResolvedValueOnce("glpat-abc");

        await mocks.commandHandlers.get(SIGN_IN)!();

        expect(store).toHaveBeenCalledWith(`${KEY_PREFIX}gitlab.com`, "glpat-abc");
        expect(map.get(`${KEY_PREFIX}gitlab.com`)).toBe("glpat-abc");
        expect(mocks.showInformationMessage).toHaveBeenCalledWith("Signed in to gitlab.com.");
        expect(mocks.showErrorMessage).not.toHaveBeenCalled();
    });

    it("trims surrounding whitespace from the token before storing", async () => {
        const { context, map } = makeContext();
        registerCommitChecksAuthCommands(context);
        pickCloud("gitlab.com");
        mocks.showInputBox.mockResolvedValueOnce("  glpat-padded  ");

        await mocks.commandHandlers.get(SIGN_IN)!();

        expect(map.get(`${KEY_PREFIX}gitlab.com`)).toBe("glpat-padded");
    });

    it("lowercases a mixed-case custom host so the stored key is reachable", async () => {
        const { context, map } = makeContext();
        registerCommitChecksAuthCommands(context);
        pickOther();
        mocks.showInputBox
            .mockResolvedValueOnce("GitLab.Example.com") // custom host prompt
            .mockResolvedValueOnce("tok"); // token prompt

        await mocks.commandHandlers.get(SIGN_IN)!();

        expect(map.get(`${KEY_PREFIX}gitlab.example.com`)).toBe("tok");
        expect(map.has(`${KEY_PREFIX}GitLab.Example.com`)).toBe(false);
    });

    it("does nothing when the host pick is cancelled", async () => {
        const { context, store } = makeContext();
        registerCommitChecksAuthCommands(context);
        mocks.showQuickPick.mockResolvedValueOnce(undefined);

        await mocks.commandHandlers.get(SIGN_IN)!();

        expect(store).not.toHaveBeenCalled();
        expect(mocks.showInputBox).not.toHaveBeenCalled();
        expect(mocks.showInformationMessage).not.toHaveBeenCalled();
    });

    it("does nothing when the token entry is cancelled", async () => {
        const { context, store } = makeContext();
        registerCommitChecksAuthCommands(context);
        pickCloud("gitlab.com");
        mocks.showInputBox.mockResolvedValueOnce(undefined);

        await mocks.commandHandlers.get(SIGN_IN)!();

        expect(store).not.toHaveBeenCalled();
        expect(mocks.showInformationMessage).not.toHaveBeenCalled();
    });

    it("does not store when the entered token is empty", async () => {
        const { context, store } = makeContext();
        registerCommitChecksAuthCommands(context);
        pickCloud("gitlab.com");
        mocks.showInputBox.mockResolvedValueOnce("");

        await mocks.commandHandlers.get(SIGN_IN)!();

        expect(store).not.toHaveBeenCalled();
        expect(mocks.showInformationMessage).not.toHaveBeenCalled();
    });

    it("shows a generic error and confirms nothing when storage fails", async () => {
        const { context, store, map } = makeContext();
        registerCommitChecksAuthCommands(context);
        pickCloud("gitlab.com");
        mocks.showInputBox.mockResolvedValueOnce("glpat-SUPERSECRET");
        store.mockRejectedValueOnce(new Error("secret storage unavailable"));

        await mocks.commandHandlers.get(SIGN_IN)!();

        // Stored exactly once: it failed, was not retried, and left nothing behind.
        expect(store).toHaveBeenCalledTimes(1);
        expect(mocks.showErrorMessage).toHaveBeenCalledWith("Could not save token securely.");
        // The token must never leak into the surfaced message.
        const shownError = mocks.showErrorMessage.mock.calls[0]?.[0] as string;
        expect(shownError).not.toContain("glpat-SUPERSECRET");
        expect(mocks.showInformationMessage).not.toHaveBeenCalled();
        expect(map.size).toBe(0);
    });

    it("rejects an empty or whitespace-only token via the input validator", async () => {
        const { context } = makeContext();
        registerCommitChecksAuthCommands(context);
        pickCloud("gitlab.com");
        // Cancel the token prompt; we only need the validator captured from its options.
        mocks.showInputBox.mockResolvedValueOnce(undefined);

        await mocks.commandHandlers.get(SIGN_IN)!();

        const validateToken = mocks.showInputBox.mock.calls[0]?.[0]?.validateInput as (
            value: string,
        ) => string | undefined;
        expect(validateToken("")).toBe("Token is required");
        expect(validateToken("   ")).toBe("Token is required");
        expect(validateToken("glpat-abc")).toBeUndefined();
    });

    it("rejects a pasted URL as a custom host via the input validator", async () => {
        const { context } = makeContext();
        registerCommitChecksAuthCommands(context);
        pickOther();
        // Cancel the custom-host prompt so sign-in aborts; we only need the captured options.
        mocks.showInputBox.mockResolvedValueOnce(undefined);

        await mocks.commandHandlers.get(SIGN_IN)!();

        const validateHost = mocks.showInputBox.mock.calls[0]?.[0]?.validateInput as (
            value: string,
        ) => string | undefined;
        expect(validateHost("")).toBe("Host is required");
        expect(validateHost("https://gitlab.example.com")).toBeTruthy();
        expect(validateHost("gitlab.example.com/group/repo")).toBeTruthy();
        expect(validateHost("user@gitlab.example.com")).toBeTruthy();
        expect(validateHost("gitlab.example.com")).toBeUndefined();
        expect(validateHost("gitlab.example.com:8443")).toBeUndefined();
    });

    it("skips the host picker and prompts for a token when a valid host arg is passed", async () => {
        const { context, map, store } = makeContext();
        registerCommitChecksAuthCommands(context);
        // No pickCloud(): the picker must not be consulted when a host is supplied.
        mocks.showInputBox.mockResolvedValueOnce("glpat-self-hosted");

        await mocks.commandHandlers.get(SIGN_IN)!("gitlab.acme.com");

        expect(mocks.showQuickPick).not.toHaveBeenCalled();
        expect(store).toHaveBeenCalledWith(`${KEY_PREFIX}gitlab.acme.com`, "glpat-self-hosted");
        expect(map.get(`${KEY_PREFIX}gitlab.acme.com`)).toBe("glpat-self-hosted");
        expect(mocks.showInformationMessage).toHaveBeenCalledWith("Signed in to gitlab.acme.com.");
    });

    it("targets the token prompt at the passed host", async () => {
        const { context } = makeContext();
        registerCommitChecksAuthCommands(context);
        mocks.showInputBox.mockResolvedValueOnce("tok");

        await mocks.commandHandlers.get(SIGN_IN)!("bitbucket.acme.com");

        const promptText = mocks.showInputBox.mock.calls[0]?.[0]?.prompt as string;
        expect(promptText).toContain("bitbucket.acme.com");
    });

    it("still shows the picker when invoked with no host arg (palette path)", async () => {
        const { context, map } = makeContext();
        registerCommitChecksAuthCommands(context);
        pickCloud("gitlab.com");
        mocks.showInputBox.mockResolvedValueOnce("glpat-palette");

        await mocks.commandHandlers.get(SIGN_IN)!();

        expect(mocks.showQuickPick).toHaveBeenCalledTimes(1);
        expect(map.get(`${KEY_PREFIX}gitlab.com`)).toBe("glpat-palette");
    });

    it("rejects an invalid passed host and falls back to the picker", async () => {
        const { context, map, store } = makeContext();
        registerCommitChecksAuthCommands(context);
        // A malformed host (URL with scheme/path) must not become a secret key; the
        // command falls back to the picker so the user can still sign in safely.
        pickCloud("gitlab.com");
        mocks.showInputBox.mockResolvedValueOnce("glpat-fallback");

        await mocks.commandHandlers.get(SIGN_IN)!("https://evil.example.com/steal");

        expect(mocks.showQuickPick).toHaveBeenCalledTimes(1);
        expect(store).toHaveBeenCalledWith(`${KEY_PREFIX}gitlab.com`, "glpat-fallback");
        expect(map.has(`${KEY_PREFIX}https://evil.example.com/steal`)).toBe(false);
    });
});

describe("signOut", () => {
    it("clears the stored token for the chosen host and confirms", async () => {
        const { context, map, del } = makeContext();
        map.set(`${KEY_PREFIX}gitlab.com`, "glpat-abc");
        registerCommitChecksAuthCommands(context);
        pickCloud("gitlab.com");

        await mocks.commandHandlers.get(SIGN_OUT)!();

        expect(del).toHaveBeenCalledWith(`${KEY_PREFIX}gitlab.com`);
        expect(map.has(`${KEY_PREFIX}gitlab.com`)).toBe(false);
        expect(mocks.showInformationMessage).toHaveBeenCalledWith(
            "Cleared the saved token for gitlab.com.",
        );
        expect(mocks.showErrorMessage).not.toHaveBeenCalled();
    });

    it("does nothing when the host pick is cancelled", async () => {
        const { context, del } = makeContext();
        registerCommitChecksAuthCommands(context);
        mocks.showQuickPick.mockResolvedValueOnce(undefined);

        await mocks.commandHandlers.get(SIGN_OUT)!();

        expect(del).not.toHaveBeenCalled();
        expect(mocks.showInformationMessage).not.toHaveBeenCalled();
    });

    it("shows a generic error and confirms nothing when delete fails", async () => {
        const { context, del } = makeContext();
        registerCommitChecksAuthCommands(context);
        pickCloud("gitlab.com");
        del.mockRejectedValueOnce(new Error("secret storage unavailable"));

        await mocks.commandHandlers.get(SIGN_OUT)!();

        expect(mocks.showErrorMessage).toHaveBeenCalledWith("Could not clear the saved token.");
        expect(mocks.showInformationMessage).not.toHaveBeenCalled();
    });
});
