import * as vscode from "vscode";
import * as https from "https";
import { execFile } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { GitOps } from "../git/operations";
import { getErrorMessage } from "../utils/errors";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PublishProvider = "github" | "gitlab";
const REQUEST_TIMEOUT_MS = 30_000;

interface CreatedRepo {
    cloneUrl: string;
    sshUrl: string;
    htmlUrl: string;
}

interface PublishAuth {
    token: string;
    /** GitLab uses "oauth2" as the username; GitHub uses x-access-token. */
    gitUsername: string;
}

type RemotePlan = { kind: "existing"; remoteName: string } | { kind: "create"; remoteName: string };

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function runPublishBranchFlow(
    gitOps: GitOps,
    branchName: string,
    repoRoot: string,
    secrets?: vscode.SecretStorage,
): Promise<void> {
    // 1. Resolve remote strategy before any provider repository is created.
    const remotes = await gitOps.getRemotes();
    const remotePlan = await pickRemotePlan(remotes);
    if (!remotePlan) return;

    if (remotePlan.kind === "existing") {
        try {
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: `Pushing to ${remotePlan.remoteName}...`,
                    cancellable: false,
                },
                async () => {
                    await gitOps.pushWithUpstream(remotePlan.remoteName, branchName);
                },
            );
            vscode.window.showInformationMessage(
                `Branch "${branchName}" published to ${remotePlan.remoteName}.`,
            );
        } catch (err) {
            vscode.window.showErrorMessage(`Failed to publish branch: ${getErrorMessage(err)}`);
        }
        return;
    }

    // 2. Provider
    const provider = await pickPublishProvider();
    if (!provider) return;

    // 3. Visibility
    const visibility = await pickVisibility();
    if (!visibility) return;

    // 4. Repo name
    const defaultName = path.basename(repoRoot);
    const repoName = await vscode.window.showInputBox({
        prompt: vscode.l10n.t("Repository name"),
        value: defaultName,
        validateInput: (value) => {
            if (!value.trim()) return "Name is required";
            if (/[^a-zA-Z0-9._-]/.test(value)) return "Only letters, digits, ., -, _ are allowed";
            return undefined;
        },
    });
    if (!repoName) return;

    // 5. Authenticate
    const auth = await acquireAuth(provider, secrets);
    if (!auth) return;

    // 6. Create the remote repository via provider API.
    let created: CreatedRepo;
    try {
        created = await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Creating repository on ${providerLabel(provider)}...`,
                cancellable: false,
            },
            async () => {
                if (provider === "github") {
                    return createGitHubRepo(auth.token, repoName, visibility);
                }
                return createGitLabRepo(auth.token, repoName, visibility);
            },
        );
    } catch (err) {
        vscode.window.showErrorMessage(`Failed to create repository: ${getErrorMessage(err)}`);
        return;
    }

    // 7. Add clean remote URL and push with transient askpass credentials.
    let remoteAdded = false;
    try {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Pushing to ${remotePlan.remoteName}...`,
                cancellable: false,
            },
            async () => {
                await gitOps.addRemote(remotePlan.remoteName, created.cloneUrl);
                remoteAdded = true;
                await runGitPushWithAskpass(repoRoot, remotePlan.remoteName, branchName, {
                    username: auth.gitUsername,
                    token: auth.token,
                });
            },
        );

        const openChoice = await vscode.window.showInformationMessage(
            `Branch "${branchName}" published to ${created.htmlUrl}`,
            "Open Repository",
        );
        if (openChoice === "Open Repository") {
            await vscode.env.openExternal(vscode.Uri.parse(created.htmlUrl));
        }
    } catch (err) {
        if (remoteAdded) {
            await gitOps.removeRemote(remotePlan.remoteName).catch(() => undefined);
        }
        const message = getErrorMessage(err);
        vscode.window.showErrorMessage(`Failed to publish branch: ${message}`);
    }
}

async function pickRemotePlan(remotes: string[]): Promise<RemotePlan | undefined> {
    if (remotes.includes("origin")) {
        const choice = await vscode.window.showQuickPick(
            [
                {
                    label: `$(git-branch) Push to Existing "origin"`,
                    description: vscode.l10n.t("Use the current origin remote without creating a new repository"),
                    action: "existing" as const,
                },
                {
                    label: vscode.l10n.t("$(add) Use a Different Remote Name"),
                    description: vscode.l10n.t("Add the new repository as a separate remote"),
                    action: "create" as const,
                },
            ],
            {
                placeHolder: 'Remote "origin" already exists. How do you want to proceed?',
            },
        );
        if (!choice) return;

        if (choice.action === "existing") {
            return { kind: "existing", remoteName: "origin" };
        }

        const remoteName = await vscode.window.showInputBox({
            prompt: vscode.l10n.t("Remote name for the new repository"),
            value: "upstream",
            validateInput: (value) => {
                if (!value.trim()) return "Name is required";
                if (remotes.includes(value.trim()))
                    return `Remote "${value.trim()}" already exists`;
                if (/[^a-zA-Z0-9._-]/.test(value))
                    return "Only letters, digits, ., -, _ are allowed";
                return undefined;
            },
        });
        if (!remoteName) return;
        return { kind: "create", remoteName: remoteName.trim() };
    }

    return { kind: "create", remoteName: "origin" };
}

// ---------------------------------------------------------------------------
// Auth acquisition
// ---------------------------------------------------------------------------

async function acquireAuth(
    provider: PublishProvider,
    secrets?: vscode.SecretStorage,
): Promise<PublishAuth | undefined> {
    if (provider === "github") {
        const session = await acquireGitHubSession();
        if (!session) return undefined;
        return {
            token: session.accessToken,
            gitUsername: "x-access-token",
        };
    }

    const token = await getGitLabToken(secrets);
    if (!token) return undefined;
    return {
        token,
        gitUsername: "oauth2",
    };
}

// ---------------------------------------------------------------------------
// Provider + visibility pickers
// ---------------------------------------------------------------------------

async function pickPublishProvider(): Promise<PublishProvider | undefined> {
    const picked = await vscode.window.showQuickPick(
        [
            {
                label: vscode.l10n.t("$(github) GitHub"),
                description: vscode.l10n.t("Create a repository on GitHub and push"),
                provider: "github" as const,
            },
            {
                label: vscode.l10n.t("$(gitlab) GitLab"),
                description: vscode.l10n.t("Create a project on GitLab and push"),
                provider: "gitlab" as const,
            },
        ],
        { placeHolder: vscode.l10n.t("Where do you want to publish this branch?") },
    );
    return picked?.provider;
}

async function pickVisibility(): Promise<"private" | "public" | undefined> {
    const picked = await vscode.window.showQuickPick(
        [
            {
                label: vscode.l10n.t("$(lock) Private"),
                description: vscode.l10n.t("Only you and collaborators can see this repository"),
                value: "private" as const,
            },
            {
                label: vscode.l10n.t("$(globe) Public"),
                description: vscode.l10n.t("Anyone on the internet can see this repository"),
                value: "public" as const,
            },
        ],
        { placeHolder: vscode.l10n.t("Choose repository visibility") },
    );
    return picked?.value;
}

function providerLabel(provider: PublishProvider): string {
    return provider === "github" ? "GitHub" : "GitLab";
}

// ---------------------------------------------------------------------------
// GitHub: auth + API
// ---------------------------------------------------------------------------

async function acquireGitHubSession(): Promise<vscode.AuthenticationSession | undefined> {
    try {
        return await vscode.authentication.getSession("github", ["repo"], {
            createIfNone: true,
        });
    } catch (err) {
        vscode.window.showErrorMessage(`GitHub authentication failed: ${getErrorMessage(err)}`);
        return undefined;
    }
}

async function createGitHubRepo(
    token: string,
    name: string,
    visibility: "private" | "public",
): Promise<CreatedRepo> {
    const body = JSON.stringify({
        name,
        private: visibility === "private",
        auto_init: false,
    });

    return new Promise((resolve, reject) => {
        let settled = false;
        const fail = (message: string): void => {
            if (settled) return;
            settled = true;
            reject(new Error(message));
        };
        const succeed = (repo: CreatedRepo): void => {
            if (settled) return;
            settled = true;
            resolve(repo);
        };
        const req = https.request(
            "https://api.github.com/user/repos",
            {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${token}`,
                    "User-Agent": "vscode-intelligit",
                    Accept: "application/vnd.github.v3+json",
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(body),
                },
            },
            (res) => {
                let data = "";
                res.on("data", (chunk: Buffer) => (data += chunk.toString()));
                res.on("end", () => {
                    req.setTimeout(0);
                    if (settled) return;
                    if (res.statusCode === 201) {
                        try {
                            const repo = JSON.parse(data);
                            succeed({
                                cloneUrl: repo.clone_url as string,
                                sshUrl: repo.ssh_url as string,
                                htmlUrl: repo.html_url as string,
                            });
                        } catch {
                            fail("Invalid GitHub API response");
                        }
                    } else {
                        const msg = tryExtractApiError(data);
                        fail(msg || `GitHub API returned ${res.statusCode}`);
                    }
                });
            },
        );
        req.setTimeout(REQUEST_TIMEOUT_MS, () => {
            req.destroy();
            fail("Request timed out while creating repository");
        });
        req.on("error", (err) => {
            req.setTimeout(0);
            fail(getErrorMessage(err));
        });
        req.write(body);
        req.end();
    });
}

// ---------------------------------------------------------------------------
// GitLab: token + API
// ---------------------------------------------------------------------------

const GITLAB_TOKEN_KEY = "intelligit.gitlab.personalAccessToken";

async function getGitLabToken(secrets?: vscode.SecretStorage): Promise<string | undefined> {
    if (secrets) {
        try {
            const stored = await secrets.get(GITLAB_TOKEN_KEY);
            if (stored) return stored;
        } catch {
            // fall through
        }
    }

    const config = vscode.workspace.getConfiguration("intelligit");
    const legacy = config.get<string>("gitlab.personalAccessToken") || "";
    if (legacy) {
        if (secrets) {
            try {
                await secrets.store(GITLAB_TOKEN_KEY, legacy);
                await config.update("gitlab.personalAccessToken", undefined, true);
            } catch {
                // migration failed — still use legacy value
            }
        }
        return legacy;
    }

    const input = await vscode.window.showInputBox({
        prompt: vscode.l10n.t("Enter your GitLab Personal Access Token (requires api scope to create projects)"),
        placeHolder: "glpat-...",
        password: true,
        validateInput: (value) => {
            if (!value.trim()) return "Token is required";
            return undefined;
        },
    });
    if (!input) return undefined;

    if (secrets) {
        const save = await vscode.window.showInformationMessage(
            vscode.l10n.t("Save this token for future use?"),
            "Save",
            "Don't Save",
        );
        if (save === "Save") {
            try {
                await secrets.store(GITLAB_TOKEN_KEY, input);
            } catch {
                vscode.window.showWarningMessage(vscode.l10n.t("Could not save token securely."));
            }
        }
    }

    return input;
}

async function createGitLabRepo(
    token: string,
    name: string,
    visibility: "private" | "public",
): Promise<CreatedRepo> {
    const body = new URLSearchParams({
        name,
        visibility,
    }).toString();

    return new Promise((resolve, reject) => {
        let settled = false;
        const fail = (message: string): void => {
            if (settled) return;
            settled = true;
            reject(new Error(message));
        };
        const succeed = (repo: CreatedRepo): void => {
            if (settled) return;
            settled = true;
            resolve(repo);
        };
        const req = https.request(
            "https://gitlab.com/api/v4/projects",
            {
                method: "POST",
                headers: {
                    "PRIVATE-TOKEN": token,
                    "User-Agent": "vscode-intelligit",
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Content-Length": Buffer.byteLength(body),
                },
            },
            (res) => {
                let data = "";
                res.on("data", (chunk: Buffer) => (data += chunk.toString()));
                res.on("end", () => {
                    req.setTimeout(0);
                    if (settled) return;
                    if (res.statusCode === 201) {
                        try {
                            const project = JSON.parse(data);
                            succeed({
                                cloneUrl: project.http_url_to_repo || project.web_url + ".git",
                                sshUrl: project.ssh_url_to_repo || "",
                                htmlUrl: project.web_url as string,
                            });
                        } catch {
                            fail("Invalid GitLab API response");
                        }
                    } else {
                        const msg = tryExtractApiError(data);
                        fail(msg || `GitLab API returned ${res.statusCode}`);
                    }
                });
            },
        );
        req.setTimeout(REQUEST_TIMEOUT_MS, () => {
            req.destroy();
            fail("Request timed out while creating repository");
        });
        req.on("error", (err) => {
            req.setTimeout(0);
            fail(getErrorMessage(err));
        });
        req.write(body);
        req.end();
    });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tryExtractApiError(raw: string): string | null {
    try {
        const obj = JSON.parse(raw);
        if (obj.message) return obj.message;
        if (obj.error) return obj.error;
        if (obj.errors && Array.isArray(obj.errors))
            return obj.errors.map((e: { message?: string }) => e.message).join("; ");
        return null;
    } catch {
        return raw.slice(0, 300) || null;
    }
}

async function runGitPushWithAskpass(
    cwd: string,
    remote: string,
    branch: string,
    auth: { username: string; token: string },
): Promise<void> {
    const env = await createAskpassEnv(auth);
    try {
        await runGitCommand(cwd, ["push", "-u", remote, branch], env);
    } finally {
        await fs.rm(env.askpassDir, { recursive: true, force: true }).catch(() => undefined);
    }
}

async function createAskpassEnv(auth: {
    username: string;
    token: string;
}): Promise<Record<string, string> & { askpassDir: string }> {
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
