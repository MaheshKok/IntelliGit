import * as vscode from "vscode";
import * as https from "https";
import * as path from "path";
import * as fs from "fs/promises";
import * as os from "os";
import { execFile } from "child_process";
import { GitExecutor } from "../git/executor";
import { getErrorMessage } from "../utils/errors";

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
        vscode.window.showInformationMessage(
            vscode.l10n.t("No repositories found on your GitHub account."),
        );
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

async function cloneViaGitLab(secrets?: vscode.SecretStorage): Promise<void> {
    let token = "";

    // Try SecretStorage first
    if (secrets) {
        try {
            const stored = await secrets.get(GITLAB_TOKEN_SECRET_KEY);
            if (stored) {
                const use = await vscode.window.showQuickPick(
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
                if (!use) return;
                if (use.value === "clear") {
                    await secrets.delete(GITLAB_TOKEN_SECRET_KEY);
                    vscode.window.showInformationMessage(
                        vscode.l10n.t("Saved GitLab token cleared."),
                    );
                    return;
                }
                if (use.value === "saved") {
                    token = stored;
                }
            }
        } catch {
            // SecretStorage unavailable — proceed to manual entry
        }
    }

    // Fallback: check legacy settings location
    if (!token) {
        const config = vscode.workspace.getConfiguration("intelligit");
        const legacyToken = config.get<string>("gitlab.personalAccessToken") || "";
        if (legacyToken) {
            // Migrate to SecretStorage
            if (secrets) {
                try {
                    await secrets.store(GITLAB_TOKEN_SECRET_KEY, legacyToken);
                    await config.update("gitlab.personalAccessToken", undefined, true);
                    token = legacyToken;
                } catch {
                    // Migration failed — still use the legacy token this time
                    token = legacyToken;
                }
            } else {
                token = legacyToken;
            }
        }
    }

    // Prompt for token if still not set
    if (!token) {
        const input = await vscode.window.showInputBox({
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
        if (!input) return;
        token = input;

        // Save to SecretStorage
        if (secrets) {
            const saveAction = vscode.l10n.t("Save");
            const dontSaveAction = vscode.l10n.t("Don't Save");
            const save = await vscode.window.showInformationMessage(
                vscode.l10n.t("Save this token for future use?"),
                saveAction,
                dontSaveAction,
            );
            if (save === saveAction) {
                try {
                    await secrets.store(GITLAB_TOKEN_SECRET_KEY, token);
                } catch {
                    vscode.window.showWarningMessage(
                        vscode.l10n.t("Could not save token securely."),
                    );
                }
            }
        }
    }

    const cloneUrl = await vscode.window.showInputBox({
        prompt: vscode.l10n.t(
            "Enter the GitLab HTTPS clone URL (e.g. https://gitlab.com/user/repo.git)",
        ),
        placeHolder: "https://gitlab.com/user/repo.git",
        validateInput: (value) => {
            if (!value.trim()) return vscode.l10n.t("URL is required");
            if (!/^https:\/\//.test(value)) return vscode.l10n.t("Must be an HTTPS URL");
            return undefined;
        },
    });
    if (!cloneUrl) return;

    const dest = await pickDestinationFolder();
    if (!dest) return;

    const repoName = extractRepoName(cloneUrl);
    const targetPath = path.join(dest, repoName);

    await runGitClone({
        url: cloneUrl,
        targetPath,
        provider: "gitlab",
        auth: { username: "oauth2", token },
        cleanRemoteUrl: cloneUrl,
    });
}

// ---------------------------------------------------------------------------
// Shared git clone executor
// ---------------------------------------------------------------------------

interface CloneOptions {
    url: string;
    targetPath: string;
    provider: CloneProvider;
    auth?: GitHttpAuth;
    /** If set, reset origin remote to this clean URL after clone. */
    cleanRemoteUrl?: string;
}

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
                    vscode.window.showWarningMessage(
                        vscode.l10n.t(
                            "Cloned successfully, but could not clean the remote URL. You may want to verify the origin remote in .git/config.",
                        ),
                    );
                }
            }

            const openInNewWindowAction = vscode.l10n.t("Open in New Window");
            const addToWorkspaceAction = vscode.l10n.t("Add to Workspace");
            const openChoice = await vscode.window.showInformationMessage(
                vscode.l10n.t("Cloned {repo} successfully.", { repo: extractRepoName(url) }),
                openInNewWindowAction,
                addToWorkspaceAction,
            );
            if (openChoice === openInNewWindowAction) {
                await vscode.commands.executeCommand(
                    "vscode.openFolder",
                    vscode.Uri.file(targetPath),
                    true,
                );
            } else if (openChoice === addToWorkspaceAction) {
                const count = vscode.workspace.workspaceFolders?.length ?? 0;
                await vscode.workspace.updateWorkspaceFolders(count, 0, {
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractRepoName(cloneUrl: string): string {
    const cleaned = cloneUrl.replace(/\.git$/, "").replace(/\/$/, "");
    const match = cleaned.match(/\/([^/]+)$/);
    if (match) return sanitizeRepoDirectoryName(match[1]);
    const segments = cleaned.split(/[:/]/);
    return sanitizeRepoDirectoryName(segments[segments.length - 1]);
}

function sanitizeRepoDirectoryName(value: string | undefined): string {
    const sanitized = (value ?? "")
        .replace(/[\\/]/g, "")
        .split("")
        .filter((char) => {
            const code = char.charCodeAt(0);
            return code >= 32 && code !== 127;
        })
        .join("")
        .replace(/[^a-zA-Z0-9._-]/g, "")
        .trim();
    if (!sanitized || sanitized === "." || sanitized === "..") return "repo";
    return sanitized;
}

async function runGitCloneWithAskpass(
    cwd: string,
    args: string[],
    auth: GitHttpAuth,
): Promise<void> {
    const env = await createAskpassEnv(auth);
    try {
        await runGitCommand(cwd, args, env);
    } finally {
        await fs.rm(env.askpassDir, { recursive: true, force: true }).catch(() => undefined);
    }
}

async function createAskpassEnv(
    auth: GitHttpAuth,
): Promise<Record<string, string> & { askpassDir: string }> {
    const askpassDir = await fs.mkdtemp(path.join(os.tmpdir(), "intelligit-askpass-"));
    const isWindows = process.platform === "win32";
    const askpassPath = path.join(askpassDir, isWindows ? "askpass.cmd" : "askpass.sh");
    const script = isWindows
        ? [
              "@echo off",
              "echo %1 | findstr /i Username >nul",
              "if not errorlevel 1 (",
              "  <nul set /p=%INTELLIGIT_GIT_USERNAME%",
              ") else (",
              "  <nul set /p=%INTELLIGIT_GIT_TOKEN%",
              ")",
              "",
          ].join("\r\n")
        : [
              "#!/bin/sh",
              'case "$1" in',
              '*Username*) printf "%s" "$INTELLIGIT_GIT_USERNAME" ;;',
              '*) printf "%s" "$INTELLIGIT_GIT_TOKEN" ;;',
              "esac",
              "",
          ].join("\n");

    await fs.writeFile(askpassPath, script, { mode: 0o700 });
    if (!isWindows) {
        await fs.chmod(askpassPath, 0o700);
    }

    return {
        askpassDir,
        GIT_ASKPASS: askpassPath,
        GIT_TERMINAL_PROMPT: "0",
        INTELLIGIT_GIT_USERNAME: auth.username,
        INTELLIGIT_GIT_TOKEN: auth.token,
    };
}

function runGitCommand(cwd: string, args: string[], env: Record<string, string>): Promise<void> {
    return new Promise((resolve, reject) => {
        execFile(
            "git",
            args,
            {
                cwd,
                env: { ...process.env, ...env },
                windowsHide: true,
            },
            (err, stdout, stderr) => {
                if (err) {
                    const detail = String(stderr || stdout || err.message || err);
                    reject(new Error(detail.trim() || "Git command failed"));
                    return;
                }
                resolve();
            },
        );
    });
}
