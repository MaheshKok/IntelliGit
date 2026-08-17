// Sign-in and sign-out commands for non-GitHub commit-check providers. Users pick a host,
// enter a personal access token (stored in SecretStorage via CredentialStore), or clear it.
// GitHub authentication is handled by VS Code's built-in session and is intentionally not
// offered here. The token value is only passed to the credential store; it is never logged.

import * as vscode from "vscode";
import { CredentialStore } from "../services/commitChecks/credentialStore";

/** A selectable provider host. A `null` host means the user is prompted for a custom host. */
interface HostPick extends vscode.QuickPickItem {
    host: string | null;
}

/**
 * The one host whose credential lives in VS Code's built-in session, not the token store.
 *
 * `GitHubProvider` reads `vscode.authentication` and never `CredentialStore`, so a token
 * stored under this key would be written and never read. The picker offers only GitLab and
 * Bitbucket, but the badge's "Sign in" action passes whatever host the failing snapshot
 * named, and "Other host..." accepts anything, so both entry points route through here.
 */
const GITHUB_HOST = "github.com";

/**
 * Registers the commit-check sign-in and sign-out commands as global disposables.
 *
 * Both commands are available in every activation mode. The credential store is a
 * stateless wrapper over `context.secrets`, so creating it here shares the same
 * secrets that any other store instance would observe.
 *
 * @param context - The extension context whose secrets back the credential store.
 */
export function registerCommitChecksAuthCommands(context: vscode.ExtensionContext): void {
    const store = new CredentialStore(context.secrets);
    context.subscriptions.push(
        vscode.commands.registerCommand("intelligit.commitChecks.signIn", (host?: string) =>
            signIn(store, host),
        ),
        vscode.commands.registerCommand("intelligit.commitChecks.signOut", () => signOut(store)),
    );
}

/**
 * Prompts for an access token and stores it for a host, optionally skipping the picker.
 *
 * When `presetHost` is a syntactically valid host (e.g. supplied by the badge "Sign in"
 * action), the host picker is skipped and the token prompt targets that host directly.
 * An absent or malformed `presetHost` falls back to the picker so a palette invocation —
 * or a host that fails validation — can still sign in safely. Cancelling either prompt
 * aborts without changing stored credentials; a storage failure surfaces a generic
 * message so the token value is never shown.
 *
 * @param store - The credential store that receives the token.
 * @param presetHost - Optional host to sign into without showing the picker; validated
 *   with `validateHost` before use, so an invalid value is ignored, not trusted.
 */
async function signIn(store: CredentialStore, presetHost?: string): Promise<void> {
    const host =
        presetHost && validateHost(presetHost) === undefined
            ? presetHost.trim()
            : await pickHost(vscode.l10n.t("Select a provider to sign in to"));
    if (!host) return;
    if (host.toLowerCase() === GITHUB_HOST) {
        await signInToGitHub();
        return;
    }

    const token = await vscode.window.showInputBox({
        prompt: vscode.l10n.t("Enter your access token for {host}", { host }),
        password: true,
        ignoreFocusOut: true,
        validateInput: (value) => (value.trim() ? undefined : vscode.l10n.t("Token is required")),
    });
    if (!token) return;

    try {
        await store.set(host, token.trim());
    } catch {
        vscode.window.showErrorMessage(vscode.l10n.t("Could not save token securely."));
        return;
    }
    await refreshCommitCheckBadges();
    vscode.window.showInformationMessage(vscode.l10n.t("Signed in to {host}.", { host }));
}

/**
 * Re-authorizes the built-in VS Code GitHub session instead of prompting for a token.
 *
 * `forceNewSession` rather than `createIfNone`, because every route to this function is a
 * recovery: the badge offers "Sign in" only once GitHub has rejected the stored session, and
 * `createIfNone` would hand that same rejected session straight back without prompting, then
 * report a sign-in that changed nothing -- the exact false success routing this host to the
 * token store would have produced. VS Code rejects the two options together, so this is a
 * replacement rather than an addition. Declining the consent prompt rejects, which is a user
 * choice rather than a failure worth reporting.
 *
 * The badge refresh afterwards does not depend on the `onDidChangeSessions` listener that
 * repository mode installs: whether re-authorizing the same account counts as a change is
 * VS Code's decision, and the user who just clicked "Sign in" expects a retry either way.
 */
async function signInToGitHub(): Promise<void> {
    try {
        await vscode.authentication.getSession("github", ["repo"], { forceNewSession: true });
    } catch {
        return;
    }
    await refreshCommitCheckBadges();
    vscode.window.showInformationMessage(
        vscode.l10n.t("Signed in to {host}.", { host: GITHUB_HOST }),
    );
}

/**
 * Prompts for a host and clears any token stored for it.
 *
 * @param store - The credential store whose token is removed.
 */
async function signOut(store: CredentialStore): Promise<void> {
    const host = await pickHost(vscode.l10n.t("Select a provider to sign out of"));
    if (!host) return;
    if (host.toLowerCase() === GITHUB_HOST) {
        // Deleting a key that was never written succeeds, so the stock confirmation would
        // report a sign-out that did not happen while the built-in session stayed live.
        vscode.window.showInformationMessage(
            vscode.l10n.t("Manage the GitHub sign-in from the VS Code Accounts menu."),
        );
        return;
    }

    try {
        await store.delete(host);
    } catch {
        vscode.window.showErrorMessage(vscode.l10n.t("Could not clear the saved token."));
        return;
    }
    await refreshCommitCheckBadges();
    vscode.window.showInformationMessage(
        vscode.l10n.t("Cleared the saved token for {host}.", { host }),
    );
}

/**
 * Asks repository mode to re-render commit-check badges after a credential change.
 *
 * Every activation mode registers `intelligit.commitChecks.refreshBadges` — repository
 * mode with the real handler, the other two with a placeholder — so the rejection here
 * is defence against a genuine failure (a mode mid-handover), not the expected case it
 * once was. Refreshing clears the coordinator cache, letting a freshly signed-in (or
 * signed-out) host re-fetch its badge without a window reload.
 */
async function refreshCommitCheckBadges(): Promise<void> {
    await vscode.commands
        .executeCommand("intelligit.commitChecks.refreshBadges")
        .then(undefined, () => undefined);
}

/**
 * Presents the provider host picker and returns the chosen host.
 *
 * The two cloud hosts are offered directly; "Other host..." prompts for a custom
 * host so self-hosted GitLab and Bitbucket Server instances can be used.
 *
 * @param placeHolder - The quick-pick placeholder describing the action.
 * @returns The selected host, or `undefined` if the user cancelled.
 */
async function pickHost(placeHolder: string): Promise<string | undefined> {
    const items: HostPick[] = [
        { label: vscode.l10n.t("$(gitlab) GitLab"), description: "gitlab.com", host: "gitlab.com" },
        {
            label: vscode.l10n.t("$(source-control) Bitbucket"),
            description: "bitbucket.org",
            host: "bitbucket.org",
        },
        { label: vscode.l10n.t("$(edit) Other host..."), host: null },
    ];
    const picked = await vscode.window.showQuickPick(items, { placeHolder });
    if (!picked) return undefined;
    if (picked.host) return picked.host;
    return promptCustomHost();
}

/**
 * Prompts for a custom host name for self-hosted providers.
 *
 * @returns The trimmed host name, or `undefined` if the user cancelled or left it blank.
 */
async function promptCustomHost(): Promise<string | undefined> {
    const input = await vscode.window.showInputBox({
        prompt: vscode.l10n.t("Enter the host name (e.g. gitlab.example.com)"),
        placeHolder: "gitlab.example.com",
        ignoreFocusOut: true,
        validateInput: validateHost,
    });
    return input?.trim() || undefined;
}

/**
 * Validates a user-entered host so a pasted URL or `user@host` cannot become an
 * unrecoverable secret key.
 *
 * @param value - The raw input box value.
 * @returns An error message to display, or `undefined` when the host is acceptable.
 */
function validateHost(value: string): string | undefined {
    const host = value.trim();
    if (!host) return vscode.l10n.t("Host is required");
    // Host plus optional :port only — letters, digits, dots, hyphens. This rejects a
    // scheme (https://), a path (/foo), and credentials (user@host). ponytail: bracketed
    // IPv6 literals are rejected too; add a branch if a provider ever needs one.
    if (!/^[A-Za-z0-9.-]+(:\d+)?$/.test(host)) {
        return vscode.l10n.t(
            "Enter a host name only, like gitlab.example.com (no https:// or path).",
        );
    }
    return undefined;
}
