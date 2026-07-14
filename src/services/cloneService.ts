import * as vscode from "vscode";
import * as https from "https";
import * as path from "path";
import * as fs from "fs/promises";
import { GitExecutor } from "../git/executor";
import { getErrorMessage } from "../utils/errors";
import { runGitCommandWithAskpass } from "./gitAskpass";
import { extractRepoName } from "./cloneUrl";
import { showTimedInformationMessage, showTimedWarningMessage } from "../utils/notifications";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type CloneProvider = "github" | "gitlab" | "ssh";

const GITHUB_REPO_PAGE_LIMIT = 50;
const REQUEST_TIMEOUT_MS = 30_000;

interface GitHttpAuth {
    username: string;
    token: string;
}

interface GitHubRepo {
    full_name: string;
    clone_url: string;
    ssh_url: string;
    description: string | null;
    private: boolean;
}

// ---------------------------------------------------------------------------
// Public entry point — called from the extension host
// ---------------------------------------------------------------------------

/**
 * Starts IntelliGit's interactive clone workflow from commands that may not have an active repository.
 *
 * Provider selection, URL entry, destination picking, and post-clone workspace
 * actions are all user-driven; cancellation at any prompt is treated as a
 * no-op. GitHub authentication uses VS Code sessions, while GitLab can use
 * `SecretStorage` for token migration and reuse.
 */
export async function runCloneFlow(secrets?: vscode.SecretStorage): Promise<void> {
    const provider = await pickCloneProvider();
    if (!provider) return;

    switch (provider) {
        case "github":
            await cloneViaGitHub();
            break;
        case "gitlab":
            await cloneViaGitLab(secrets);
            break;
        case "ssh":
            await cloneViaSSH();
            break;
    }
}

// ---------------------------------------------------------------------------
// Provider picker
// ---------------------------------------------------------------------------

/**
 * Presents the provider picker for the clone command and returns `undefined` on cancellation.
 */
async function pickCloneProvider(): Promise<CloneProvider | undefined> {
    const picked = await vscode.window.showQuickPick(
        [
            {
                label: vscode.l10n.t("$(github) GitHub"),
                description: vscode.l10n.t("Sign in with your GitHub account"),
                provider: "github" as const,
            },
            {
                label: vscode.l10n.t("$(gitlab) GitLab"),
                description: vscode.l10n.t("Clone with personal access token or URL"),
                provider: "gitlab" as const,
            },
            {
                label: vscode.l10n.t("$(remote) SSH"),
                description: vscode.l10n.t("Clone via git@... SSH URL"),
                provider: "ssh" as const,
            },
        ],
        { placeHolder: vscode.l10n.t("Choose how to clone a repository") },
    );
    return picked?.provider;
}

// ---------------------------------------------------------------------------
// Destination folder picker (shared)
// ---------------------------------------------------------------------------

/**
 * Lets the user choose the parent folder that will receive the cloned repository directory.
 *
 * The returned path is a VS Code `fsPath` for the selected local folder. The
 * repository name is appended later after the clone URL has been sanitized.
 */
async function pickDestinationFolder(): Promise<string | undefined> {
    const uris = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: vscode.l10n.t("Select Destination"),
        title: vscode.l10n.t("Choose where to clone the repository"),
    });
    return uris?.[0]?.fsPath;
}

// ---------------------------------------------------------------------------
// SSH clone flow
// ---------------------------------------------------------------------------

/**
 * Handles the SSH clone path for users who already have local Git SSH credentials configured.
 *
 * The flow validates only the expected `git@...` shape, prompts for a local
 * destination, and then delegates clone execution. SSH authentication errors are
 * converted into actionable user-facing hints by the shared clone error handler.
 */
async function cloneViaSSH(): Promise<void> {
    const url = await vscode.window.showInputBox({
        prompt: vscode.l10n.t("Enter the SSH clone URL (e.g. git@github.com:user/repo.git)"),
        placeHolder: "git@github.com:user/repo.git",
        validateInput: (value) => {
            if (!value.trim()) return vscode.l10n.t("URL is required");
            if (!/^git@/.test(value)) return vscode.l10n.t('URL must start with "git@"');
            return undefined;
        },
    });
    if (!url) return;

    const dest = await pickDestinationFolder();
    if (!dest) return;

    const repoName = extractRepoName(url);
    const targetPath = path.join(dest, repoName);

    await runGitClone({ url, targetPath, provider: "ssh" });
}

// ---------------------------------------------------------------------------
// GitHub clone flow
// ---------------------------------------------------------------------------

/**
 * Handles the GitHub clone path using VS Code authentication and HTTPS clone URLs.
 *
 * Users can browse repositories through the GitHub API or paste a GitHub HTTPS
 * URL. Authenticated clones use transient askpass credentials and reset `origin`
 * to the clean clone URL after success so tokens are not persisted in `.git/config`.
 */
async function cloneViaGitHub(): Promise<void> {
    const session = await acquireGitHubSession();
    if (!session) return;

    const token = session.accessToken;

    const mode = await vscode.window.showQuickPick(
        [
            {
                label: vscode.l10n.t("$(list-tree) Browse My Repositories"),
                value: "browse" as const,
            },
            { label: vscode.l10n.t("$(link) Enter Clone URL"), value: "url" as const },
        ],
        { placeHolder: vscode.l10n.t("How would you like to select a repository?") },
    );
    if (!mode) return;

    let cloneUrl: string;

    if (mode.value === "browse") {
        const repo = await pickGitHubRepo(token);
        if (!repo) return;
        cloneUrl = repo.clone_url;
    } else {
        const input = await vscode.window.showInputBox({
            prompt: vscode.l10n.t(
                "Enter the GitHub HTTPS clone URL (e.g. https://github.com/user/repo.git)",
            ),
            placeHolder: "https://github.com/user/repo.git",
            validateInput: (value) => {
                if (!value.trim()) return vscode.l10n.t("URL is required");
                if (!/^https:\/\/github\.com\//.test(value))
                    return vscode.l10n.t("Must be a github.com HTTPS URL");
                return undefined;
            },
        });
        if (!input) return;
        cloneUrl = input;
    }

    const dest = await pickDestinationFolder();
    if (!dest) return;

    const repoName = extractRepoName(cloneUrl);
    const targetPath = path.join(dest, repoName);

    await runGitClone({
        url: cloneUrl,
        targetPath,
        provider: "github",
        auth: { username: "x-access-token", token },
        cleanRemoteUrl: cloneUrl,
    });
}

/**
 * Acquires a GitHub authentication session or shows the extension-level failure message.
 *
 * Authentication errors are swallowed after notification because clone command
 * cancellation and auth failure both end the interactive workflow without
 * throwing into command registration code.
 */
async function acquireGitHubSession(): Promise<vscode.AuthenticationSession | undefined> {
    try {
        const session = await vscode.authentication.getSession("github", ["repo"], {
            createIfNone: true,
        });
        return session;
    } catch (err) {
        const message = getErrorMessage(err);
        vscode.window.showErrorMessage(
            vscode.l10n.t(
                "GitHub authentication failed: {message}\n\nMake sure the GitHub Authentication extension is installed and enabled.",
                { message },
            ),
        );
        return undefined;
    }
}

/**
 * Fetches the authenticated user's GitHub repositories and lets them pick one to clone.
 *
 * The progress notification is intentionally non-cancellable because the HTTP
 * helper does not expose cancellation. API and parsing failures are shown to the
 * user and return `undefined` to stop the clone flow cleanly.
 */
async function pickGitHubRepo(token: string): Promise<GitHubRepo | undefined> {
    let repos: GitHubRepo[];
    try {
        repos = await vscode.window.withProgress<GitHubRepo[]>(
            {
                location: vscode.ProgressLocation.Notification,
                title: vscode.l10n.t("Fetching your GitHub repositories..."),
                cancellable: false,
            },
            () => fetchGitHubRepos(token),
        );
    } catch (err) {
        vscode.window.showErrorMessage(
            vscode.l10n.t("Failed to list GitHub repositories: {message}", {
                message: getErrorMessage(err),
            }),
        );
        return undefined;
    }

    if (!repos || repos.length === 0) {
        showTimedInformationMessage(vscode.l10n.t("No repositories found on your GitHub account."));
        return undefined;
    }

    const items = repos.map((repo) => ({
        label: repo.full_name,
        description: repo.description || "",
        detail: repo.private ? "$(lock) Private" : "$(globe) Public",
        repo,
    }));

    const picked = await vscode.window.showQuickPick(items, {
        placeHolder: vscode.l10n.t("Search or select a repository to clone"),
        matchOnDescription: true,
        matchOnDetail: true,
    });

    return picked?.repo;
}

/**
 * Reads GitHub repositories page-by-page with a bounded request count and timeout.
 *
 * The token is sent only in the HTTPS authorization header. Repositories above
 * the configured page limit cause a failure that asks users to paste the clone
 * URL directly instead of keeping the notification open indefinitely.
 */
function fetchGitHubRepos(token: string): Promise<GitHubRepo[]> {
    return new Promise((resolve, reject) => {
        const allRepos: GitHubRepo[] = [];
        let page = 1;
        let settled = false;

        const finish = (fn: () => void): void => {
            if (settled) return;
            settled = true;
            fn();
        };

        const fetchPage = (): void => {
            if (page > GITHUB_REPO_PAGE_LIMIT + 1) {
                finish(() =>
                    reject(
                        new Error(
                            `GitHub repository list exceeds ${GITHUB_REPO_PAGE_LIMIT * 100} repositories. Enter the clone URL directly instead.`,
                        ),
                    ),
                );
                return;
            }
            const url = `https://api.github.com/user/repos?per_page=100&page=${page}&sort=updated`;
            const req = https.get(
                url,
                {
                    headers: {
                        Authorization: `Bearer ${token}`,
                        "User-Agent": "vscode-intelligit",
                        Accept: "application/vnd.github.v3+json",
                    },
                },
                (res) => {
                    let data = "";
                    res.on("data", (chunk: Buffer) => (data += chunk.toString()));
                    res.on("end", () => {
                        req.setTimeout(0);
                        if (settled) return;
                        if (res.statusCode !== 200) {
                            finish(() =>
                                reject(
                                    new Error(
                                        `GitHub API returned ${res.statusCode}: ${data.slice(0, 200)}`,
                                    ),
                                ),
                            );
                            return;
                        }
                        try {
                            const repos = JSON.parse(data) as GitHubRepo[];
                            if (page > GITHUB_REPO_PAGE_LIMIT) {
                                if (repos.length > 0) {
                                    finish(() =>
                                        reject(
                                            new Error(
                                                `GitHub repository list exceeds ${GITHUB_REPO_PAGE_LIMIT * 100} repositories. Enter the clone URL directly instead.`,
                                            ),
                                        ),
                                    );
                                } else {
                                    finish(() => resolve(allRepos));
                                }
                                return;
                            }
                            allRepos.push(...repos);
                            if (repos.length === 100) {
                                page++;
                                fetchPage();
                            } else {
                                finish(() => resolve(allRepos));
                            }
                        } catch {
                            finish(() =>
                                reject(new Error("Invalid GitHub repositories API response")),
                            );
                        }
                    });
                },
            );
            req.setTimeout(REQUEST_TIMEOUT_MS, () => {
                req.destroy();
                finish(() => reject(new Error("Request timed out while fetching repositories")));
            });
            req.on("error", (err) => {
                req.setTimeout(0);
                finish(() => reject(err));
            });
        };

        fetchPage();
    });
}

// ---------------------------------------------------------------------------
// GitLab clone flow
// ---------------------------------------------------------------------------

const GITLAB_TOKEN_SECRET_KEY = "intelligit.gitlab.personalAccessToken";
const GITLAB_CLONE_HOST = "gitlab.com";

type GitLabTokenSelection = {
    token: string;
    useLegacyFallback: boolean;
};

/**
 * Validates the GitLab HTTPS clone URL accepted by the GitLab clone prompt.
 *
 * Only credential-free `https://gitlab.com/...` URLs are accepted because the
 * token is supplied through askpass and must not be embedded in repository config.
 */
function validateGitLabHttpsCloneUrl(value: string): string | undefined {
    const trimmed = value.trim();
    if (!trimmed) return vscode.l10n.t("URL is required");
    let parsed: URL;
    try {
        parsed = new URL(trimmed);
    } catch {
        return vscode.l10n.t("Must be a valid GitLab HTTPS URL");
    }
    if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== GITLAB_CLONE_HOST) {
        return vscode.l10n.t("Must be a gitlab.com HTTPS URL");
    }
    if (parsed.username || parsed.password) {
        return vscode.l10n.t("URL must not include embedded credentials");
    }
    return undefined;
}

/**
 * Resolves a saved-token choice without treating an explicit replacement request as a legacy fallback.
 *
 * Returning `undefined` means the user cancelled or cleared their saved token and the clone flow must stop.
 */
async function selectSavedGitLabToken(
    secrets?: vscode.SecretStorage,
): Promise<GitLabTokenSelection | undefined> {
    const emptySelection = { token: "", useLegacyFallback: true };
    if (!secrets) return emptySelection;

    try {
        const stored = await secrets.get(GITLAB_TOKEN_SECRET_KEY);
        if (!stored) return emptySelection;

        const selection = await vscode.window.showQuickPick(
            [
                {
                    label: vscode.l10n.t("Use Saved Token"),
                    description: "********",
                    value: "saved" as const,
                },
                { label: vscode.l10n.t("Enter a Different Token"), value: "new" as const },
                { label: vscode.l10n.t("Clear Saved Token"), value: "clear" as const },
            ],
            { placeHolder: vscode.l10n.t("GitLab authentication") },
        );
        if (!selection) return undefined;
        if (selection.value === "clear") {
            await secrets.delete(GITLAB_TOKEN_SECRET_KEY);
            showTimedInformationMessage(vscode.l10n.t("Saved GitLab token cleared."));
            return undefined;
        }

        return {
            token: selection.value === "saved" ? stored : "",
            useLegacyFallback: selection.value !== "new",
        };
    } catch {
        return emptySelection;
    }
}

/** Migrates the legacy GitLab token into SecretStorage when available and still returns it on failure. */
async function getLegacyGitLabToken(secrets?: vscode.SecretStorage): Promise<string> {
    const config = vscode.workspace.getConfiguration("intelligit");
    const legacyToken = config.get<string>("gitlab.personalAccessToken") || "";
    if (!legacyToken || !secrets) return legacyToken;

    try {
        await secrets.store(GITLAB_TOKEN_SECRET_KEY, legacyToken);
        await config.update("gitlab.personalAccessToken", undefined, true);
    } catch {
        // The legacy token remains usable for this clone when secure migration is unavailable.
    }

    return legacyToken;
}

/** Prompts for a new GitLab token and offers best-effort secure storage after a successful entry. */
async function promptForGitLabToken(secrets?: vscode.SecretStorage): Promise<string | undefined> {
    const token = await vscode.window.showInputBox({
        prompt: vscode.l10n.t(
            "Enter your GitLab Personal Access Token (requires read_repository scope)",
        ),
        placeHolder: "glpat-...",
        password: true,
        validateInput: (value) => {
            if (!value.trim()) return vscode.l10n.t("Token is required");
            return undefined;
        },
    });
    if (!token) return undefined;
    if (!secrets) return token;

    const saveAction = vscode.l10n.t("Save");
    const dontSaveAction = vscode.l10n.t("Don't Save");
    const save = await vscode.window.showInformationMessage(
        vscode.l10n.t("Save this token for future use?"),
        saveAction,
        dontSaveAction,
    );
    if (save !== saveAction) return token;

    try {
        await secrets.store(GITLAB_TOKEN_SECRET_KEY, token);
    } catch {
        showTimedWarningMessage(vscode.l10n.t("Could not save token securely."));
    }

    return token;
}

/**
 * Handles the GitLab clone path with token lookup, optional secure storage, and HTTPS cloning.
 *
 * The flow first tries `SecretStorage`, then migrates the legacy setting when
 * present, and finally prompts for a personal access token. Any prompt
 * cancellation stops the workflow without mutating the filesystem.
 */
async function cloneViaGitLab(secrets?: vscode.SecretStorage): Promise<void> {
    const savedToken = await selectSavedGitLabToken(secrets);
    if (!savedToken) return;

    let token = savedToken.token;
    if (!token && savedToken.useLegacyFallback) {
        token = await getLegacyGitLabToken(secrets);
    }
    if (!token) {
        const promptedToken = await promptForGitLabToken(secrets);
        if (!promptedToken) return;
        token = promptedToken;
    }

    const cloneUrl = await vscode.window.showInputBox({
        prompt: vscode.l10n.t(
            "Enter the GitLab HTTPS clone URL (e.g. https://gitlab.com/user/repo.git)",
        ),
        placeHolder: "https://gitlab.com/user/repo.git",
        validateInput: validateGitLabHttpsCloneUrl,
    });
    if (!cloneUrl) return;
    const cleanCloneUrl = cloneUrl.trim();

    const dest = await pickDestinationFolder();
    if (!dest) return;

    const repoName = extractRepoName(cleanCloneUrl);
    const targetPath = path.join(dest, repoName);

    await runGitClone({
        url: cleanCloneUrl,
        targetPath,
        provider: "gitlab",
        auth: { username: "oauth2", token },
        cleanRemoteUrl: cleanCloneUrl,
    });
}

// ---------------------------------------------------------------------------
// Shared git clone executor
// ---------------------------------------------------------------------------

/**
 * Options for the shared clone executor after provider-specific prompting has completed.
 */
interface CloneOptions {
    url: string;
    targetPath: string;
    provider: CloneProvider;
    auth?: GitHttpAuth;
    /** If set, reset origin remote to this clean URL after clone. */
    cleanRemoteUrl?: string;
}

/**
 * Performs the filesystem and Git work for a provider-specific clone selection.
 *
 * Existing target directories are removed only after a modal overwrite
 * confirmation. Clone progress is shown in a notification, errors are displayed
 * rather than propagated, and successful clones offer to open or add the new
 * repository workspace folder.
 *
 * @remarks Keep authenticated providers on askpass and clean remote URLs. Moving
 * credentials into `url` would risk persisting secrets to `.git/config`.
 */
async function runGitClone(opts: CloneOptions): Promise<void> {
    const { url, targetPath, provider, auth, cleanRemoteUrl } = opts;

    // --- Guard: check for existing directory ---
    try {
        await fs.access(targetPath);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            // Directory does not exist — proceed to clone
            await doClone();
            return;
        }
        // Permission error, invalid path, etc. — surface to user
        const message = getErrorMessage(err);
        vscode.window.showErrorMessage(
            vscode.l10n.t('Cannot access "{name}": {message}', {
                name: path.basename(targetPath),
                message,
            }),
        );
        return;
    }

    // Directory exists — ask user
    const overwriteAction = vscode.l10n.t("Overwrite");
    const overwrite = await vscode.window.showWarningMessage(
        vscode.l10n.t('Directory "{name}" already exists. Overwrite?', {
            name: path.basename(targetPath),
        }),
        { modal: true },
        overwriteAction,
    );
    if (overwrite !== overwriteAction) return;

    try {
        await fs.rm(targetPath, { recursive: true, force: true });
    } catch (err) {
        const message = getErrorMessage(err);
        vscode.window.showErrorMessage(
            vscode.l10n.t('Cannot remove existing directory "{name}": {message}', {
                name: path.basename(targetPath),
                message,
            }),
        );
        return;
    }

    await doClone();

    async function doClone(): Promise<void> {
        try {
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: vscode.l10n.t("Cloning {repo}...", { repo: extractRepoName(url) }),
                    cancellable: false,
                },
                async () => {
                    const parentDir = path.dirname(targetPath);
                    const repoDir = path.basename(targetPath);
                    if (auth) {
                        await runGitCloneWithAskpass(parentDir, ["clone", url, repoDir], auth);
                    } else {
                        const executor = new GitExecutor(parentDir);
                        await executor.run(["clone", url, repoDir]);
                    }
                },
            );

            // Keep origin on the clean URL even when Git normalizes remote config.
            if (cleanRemoteUrl) {
                try {
                    const executor = new GitExecutor(targetPath);
                    await executor.run(["remote", "set-url", "origin", cleanRemoteUrl]);
                } catch {
                    // Non-fatal: the clone succeeded; warn but don't block.
                    showTimedWarningMessage(
                        vscode.l10n.t(
                            "Cloned successfully, but could not clean the remote URL. You may want to verify the origin remote in .git/config.",
                        ),
                    );
                }
            }

            const openInNewWindowAction = vscode.l10n.t("Open in New Window");
            const openInCurrentWindowAction = vscode.l10n.t("Open in Current Window");
            const addToWorkspaceAction = vscode.l10n.t("Add to Workspace");
            const openChoice = await vscode.window.showInformationMessage(
                vscode.l10n.t("Cloned {repo} successfully.", { repo: extractRepoName(url) }),
                openInNewWindowAction,
                openInCurrentWindowAction,
                addToWorkspaceAction,
            );
            if (openChoice === openInNewWindowAction) {
                await vscode.commands.executeCommand(
                    "vscode.openFolder",
                    vscode.Uri.file(targetPath),
                    true,
                );
            } else if (openChoice === openInCurrentWindowAction) {
                await vscode.commands.executeCommand(
                    "vscode.openFolder",
                    vscode.Uri.file(targetPath),
                    false,
                );
            } else if (openChoice === addToWorkspaceAction) {
                const count = vscode.workspace.workspaceFolders?.length ?? 0;
                vscode.workspace.updateWorkspaceFolders(count, 0, {
                    uri: vscode.Uri.file(targetPath),
                });
            }
        } catch (err) {
            handleCloneError(err, url, provider);
        }
    }
}

// ---------------------------------------------------------------------------
// Clone error analysis
// ---------------------------------------------------------------------------

/**
 * Converts raw Git clone failures into provider-specific troubleshooting messages.
 *
 * The original error detail is preserved for the user, while common SSH and
 * token failures add concise recovery hints. Errors are intentionally not
 * rethrown because command handlers should complete after showing the message.
 */
function handleCloneError(err: unknown, url: string, provider: CloneProvider): void {
    const message = getErrorMessage(err).toLowerCase();

    if (provider === "ssh") {
        const hints: string[] = [];
        if (message.includes("permission denied") || message.includes("publickey")) {
            hints.push(
                vscode.l10n.t(
                    "Make sure your SSH key is loaded: run `ssh-add -l` in a terminal to list loaded keys.",
                ),
                vscode.l10n.t(
                    "If no keys are listed, add yours with `ssh-add ~/.ssh/id_ed25519` (or `~/.ssh/id_rsa`).",
                ),
                vscode.l10n.t(
                    "Verify your public key is added to your Git hosting account settings.",
                ),
            );
        }
        if (message.includes("host key verification failed")) {
            hints.push(
                vscode.l10n.t(
                    "The host key is not in your known_hosts file. Run `ssh-keyscan -H github.com >> ~/.ssh/known_hosts` (or the appropriate host).",
                ),
            );
        }
        if (message.includes("could not resolve host")) {
            hints.push(
                vscode.l10n.t(
                    "Check your network connection and that the hostname in the URL is correct.",
                ),
            );
        }
        if (hints.length === 0) {
            hints.push(
                vscode.l10n.t(
                    "Check that the SSH URL is correct and the remote repository exists.",
                ),
            );
        }
        showCloneErrorMessage(vscode.l10n.t("SSH clone failed"), err, hints);
    } else if (provider === "github") {
        const hints: string[] = [];
        if (
            message.includes("authentication") ||
            message.includes("403") ||
            message.includes("denied")
        ) {
            hints.push(
                vscode.l10n.t(
                    "Your GitHub token may have expired or lacks the necessary permissions. Try signing in again.",
                ),
                vscode.l10n.t('Run the "GitHub: Sign Out" command, then retry.'),
            );
        }
        if (message.includes("not found") || message.includes("404")) {
            hints.push(
                vscode.l10n.t("The repository may not exist or you do not have access to it."),
            );
        }
        showCloneErrorMessage(vscode.l10n.t("GitHub clone failed"), err, hints);
    } else if (provider === "gitlab") {
        const hints: string[] = [];
        if (message.includes("authentication") || message.includes("403")) {
            hints.push(
                vscode.l10n.t("Your GitLab personal access token may be invalid or expired."),
                vscode.l10n.t(
                    "Create a new token at GitLab Settings → Access Tokens with the `read_repository` scope.",
                ),
                vscode.l10n.t(
                    'To clear a saved token, select "Clear Saved Token" when prompted on the next attempt.',
                ),
            );
        }
        if (message.includes("not found") || message.includes("404")) {
            hints.push(
                vscode.l10n.t(
                    "The repository may not exist or is private and your token does not have access.",
                ),
            );
        }
        showCloneErrorMessage(vscode.l10n.t("GitLab clone failed"), err, hints);
    } else {
        showCloneErrorMessage(vscode.l10n.t("Clone failed"), err, []);
    }
}

function showCloneErrorMessage(title: string, err: unknown, hints: string[]): void {
    const detail = getErrorMessage(err);
    const hintText = hints.length > 0 ? `\n\n${hints.join("\n")}` : "";
    vscode.window.showErrorMessage(
        vscode.l10n.t("{title}: {detail}{hintText}", { title, detail, hintText }),
    );
}

/**
 * Runs an authenticated clone with transient askpass credentials from the clone provider.
 */
async function runGitCloneWithAskpass(
    cwd: string,
    args: string[],
    auth: GitHttpAuth,
): Promise<void> {
    await runGitCommandWithAskpass(cwd, args, auth);
}
