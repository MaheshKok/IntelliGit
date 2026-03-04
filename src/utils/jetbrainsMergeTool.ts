import * as os from "os";
import * as path from "path";
import { spawn } from "child_process";
import { constants as fsConstants, promises as fsp } from "fs";

export interface JetBrainsMergeToolLaunchInput {
    binaryPath: string;
    repoRootFsPath: string;
    relativeFilePath: string;
    outputFileFsPath: string;
    baseContent: string;
    oursContent: string;
    theirsContent: string;
}

export interface JetBrainsMergeToolLaunchResult {
    exitCode: number | null;
    signal: NodeJS.Signals | null;
}

interface DetectedJetBrainsCandidate {
    launchPath: string;
    productKey: string | null;
    mtimeMs: number;
}

const JETBRAINS_PRODUCT_PREFERENCES = [
    "pycharm",
    "idea",
    "webstorm",
    "goland",
    "datagrip",
    "phpstorm",
    "rubymine",
    "clion",
    "rider",
    "dataspell",
    "aqua",
] as const;

const JETBRAINS_EXECUTABLE_NAMES_MAC = new Set<string>(JETBRAINS_PRODUCT_PREFERENCES);

const JETBRAINS_EXECUTABLE_NAMES_WIN = new Set<string>([
    ...JETBRAINS_PRODUCT_PREFERENCES.map((name) => `${name}64.exe`),
    ...JETBRAINS_PRODUCT_PREFERENCES.map((name) => `${name}.exe`),
]);

async function pathExists(filePath: string): Promise<boolean> {
    try {
        await fsp.access(filePath);
        return true;
    } catch {
        return false;
    }
}

async function isExecutableFile(filePath: string): Promise<boolean> {
    try {
        const stat = await fsp.stat(filePath);
        if (!stat.isFile()) return false;
        await fsp.access(filePath, fsConstants.X_OK);
        return true;
    } catch {
        return false;
    }
}

function isMacAppBundlePath(inputPath: string): boolean {
    return process.platform === "darwin" && inputPath.toLowerCase().endsWith(".app");
}

function parseBundleExecutableName(infoPlistContent: string): string | null {
    const match = infoPlistContent.match(
        /<key>\s*CFBundleExecutable\s*<\/key>\s*<string>([^<]+)<\/string>/s,
    );
    return match?.[1]?.trim() || null;
}

function parseBundleIdentifier(infoPlistContent: string): string | null {
    const match = infoPlistContent.match(
        /<key>\s*CFBundleIdentifier\s*<\/key>\s*<string>([^<]+)<\/string>/s,
    );
    return match?.[1]?.trim() || null;
}

function getProductPreferenceScore(productKey: string | null): number {
    if (!productKey) return 0;
    const idx = JETBRAINS_PRODUCT_PREFERENCES.indexOf(
        productKey as (typeof JETBRAINS_PRODUCT_PREFERENCES)[number],
    );
    return idx === -1 ? 1 : 100 - idx;
}

function rankCandidates(a: DetectedJetBrainsCandidate, b: DetectedJetBrainsCandidate): number {
    const scoreDelta =
        getProductPreferenceScore(b.productKey) - getProductPreferenceScore(a.productKey);
    if (scoreDelta !== 0) return scoreDelta;
    const mtimeDelta = b.mtimeMs - a.mtimeMs;
    if (mtimeDelta !== 0) return mtimeDelta > 0 ? 1 : -1;
    return a.launchPath.localeCompare(b.launchPath);
}

async function getFileMtimeMs(filePath: string): Promise<number> {
    try {
        const stat = await fsp.stat(filePath);
        return stat.mtimeMs || 0;
    } catch {
        return 0;
    }
}

async function readTextIfExists(filePath: string): Promise<string | null> {
    try {
        return await fsp.readFile(filePath, "utf8");
    } catch {
        return null;
    }
}

async function listDirectories(rootDir: string): Promise<string[]> {
    try {
        const entries = await fsp.readdir(rootDir, { withFileTypes: true });
        return entries
            .filter((entry) => entry.isDirectory())
            .map((entry) => path.join(rootDir, entry.name));
    } catch {
        return [];
    }
}

async function listFiles(rootDir: string): Promise<string[]> {
    try {
        const entries = await fsp.readdir(rootDir, { withFileTypes: true });
        return entries
            .filter((entry) => entry.isFile())
            .map((entry) => path.join(rootDir, entry.name));
    } catch {
        return [];
    }
}

async function walkDirectories(
    rootDir: string,
    options: {
        maxDepth: number;
        onDirectory?: (dirPath: string) => Promise<void> | void;
        stopAfterDirs?: number;
    },
): Promise<void> {
    const visited = new Set<string>();
    let seenDirs = 0;

    const visit = async (dirPath: string, depth: number): Promise<void> => {
        if (depth > options.maxDepth) return;
        if (visited.has(dirPath)) return;
        visited.add(dirPath);
        seenDirs += 1;
        if (options.stopAfterDirs && seenDirs > options.stopAfterDirs) return;

        await options.onDirectory?.(dirPath);

        let entries: Array<{ isDirectory(): boolean; name: string }>;
        try {
            entries = (await fsp.readdir(dirPath, { withFileTypes: true })) as Array<{
                isDirectory(): boolean;
                name: string;
            }>;
        } catch {
            return;
        }

        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            if (entry.name.startsWith(".")) continue;
            await visit(path.join(dirPath, entry.name), depth + 1);
        }
    };

    await visit(rootDir, 0);
}

function inferProductKeyFromExecutableName(fileName: string): string | null {
    const lower = fileName.toLowerCase();
    const normalized = lower.endsWith(".exe") ? lower.replace(/64?\.exe$/, "") : lower;
    return JETBRAINS_PRODUCT_PREFERENCES.includes(
        normalized as (typeof JETBRAINS_PRODUCT_PREFERENCES)[number],
    )
        ? normalized
        : null;
}

async function resolveExecutableFromMacAppBundle(appBundlePath: string): Promise<string> {
    const contentsDir = path.join(appBundlePath, "Contents");
    const macOsDir = path.join(contentsDir, "MacOS");
    const infoPlistPath = path.join(contentsDir, "Info.plist");

    if (!(await pathExists(appBundlePath))) {
        throw new Error(`JetBrains app bundle not found: ${appBundlePath}`);
    }

    try {
        const plist = await fsp.readFile(infoPlistPath, "utf8");
        const executableName = parseBundleExecutableName(plist);
        if (executableName) {
            const executablePath = path.join(macOsDir, executableName);
            if (await isExecutableFile(executablePath)) {
                return executablePath;
            }
        }
    } catch {
        // Fall through to directory scan.
    }

    const entries = await fsp.readdir(macOsDir).catch(() => {
        throw new Error(`Missing ${path.join(appBundlePath, "Contents/MacOS")} in app bundle.`);
    });

    const candidates = entries
        .filter((name) => !name.startsWith("."))
        .sort((a, b) => {
            const aPreferred = JETBRAINS_EXECUTABLE_NAMES_MAC.has(a.toLowerCase()) ? 1 : 0;
            const bPreferred = JETBRAINS_EXECUTABLE_NAMES_MAC.has(b.toLowerCase()) ? 1 : 0;
            return bPreferred - aPreferred || a.localeCompare(b);
        })
        .map((name) => path.join(macOsDir, name));

    for (const candidate of candidates) {
        if (await isExecutableFile(candidate)) return candidate;
    }

    throw new Error(`No executable file found in ${path.join(appBundlePath, "Contents/MacOS")}.`);
}

async function detectMacJetBrainsAppBundleCandidates(): Promise<DetectedJetBrainsCandidate[]> {
    if (process.platform !== "darwin") return [];

    const homeDir = os.homedir();
    const roots = [
        "/Applications",
        path.join(homeDir, "Applications"),
        path.join(homeDir, "Library", "Application Support", "JetBrains", "Toolbox", "apps"),
    ];
    const candidates: DetectedJetBrainsCandidate[] = [];
    const seenAppPaths = new Set<string>();

    const maybeAddAppBundle = async (appBundlePath: string): Promise<void> => {
        if (!appBundlePath.toLowerCase().endsWith(".app")) return;
        if (seenAppPaths.has(appBundlePath)) return;
        seenAppPaths.add(appBundlePath);

        const plistPath = path.join(appBundlePath, "Contents", "Info.plist");
        const plist = await readTextIfExists(plistPath);
        if (!plist) return;

        const bundleIdentifier = parseBundleIdentifier(plist)?.toLowerCase() ?? "";
        if (!bundleIdentifier.includes("jetbrains")) return;

        let launchPath: string;
        try {
            launchPath = await resolveExecutableFromMacAppBundle(appBundlePath);
        } catch {
            return;
        }

        const executableName = path.basename(launchPath).toLowerCase();
        candidates.push({
            launchPath: appBundlePath,
            productKey: inferProductKeyFromExecutableName(executableName),
            mtimeMs: await getFileMtimeMs(launchPath),
        });
    };

    await Promise.all(
        roots.map(async (rootDir) => {
            if (!(await pathExists(rootDir))) return;

            if (rootDir.endsWith(path.join("Toolbox", "apps"))) {
                await walkDirectories(rootDir, {
                    maxDepth: 6,
                    stopAfterDirs: 4000,
                    onDirectory: async (dirPath) => {
                        if (dirPath.toLowerCase().endsWith(".app")) {
                            await maybeAddAppBundle(dirPath);
                        }
                    },
                });
                return;
            }

            const topLevelDirs = await listDirectories(rootDir);
            for (const dirPath of topLevelDirs) {
                if (dirPath.toLowerCase().endsWith(".app")) {
                    await maybeAddAppBundle(dirPath);
                }
            }
        }),
    );

    return candidates.sort(rankCandidates);
}

async function findWindowsExecutableCandidatesInRoot(
    rootDir: string,
    options: { maxDepth: number; stopAfterDirs?: number },
): Promise<DetectedJetBrainsCandidate[]> {
    if (process.platform !== "win32") return [];
    if (!(await pathExists(rootDir))) return [];

    const candidates: DetectedJetBrainsCandidate[] = [];
    const seen = new Set<string>();

    await walkDirectories(rootDir, {
        maxDepth: options.maxDepth,
        stopAfterDirs: options.stopAfterDirs,
        onDirectory: async (dirPath) => {
            if (path.basename(dirPath).toLowerCase() !== "bin") return;
            const files = await listFiles(dirPath);
            for (const filePath of files) {
                const fileName = path.basename(filePath).toLowerCase();
                if (!JETBRAINS_EXECUTABLE_NAMES_WIN.has(fileName)) continue;
                if (seen.has(filePath)) continue;
                seen.add(filePath);
                const isFile = await isExecutableFile(filePath);
                if (!isFile) continue;
                candidates.push({
                    launchPath: filePath,
                    productKey: inferProductKeyFromExecutableName(fileName),
                    mtimeMs: await getFileMtimeMs(filePath),
                });
            }
        },
    });

    return candidates;
}

async function detectWindowsJetBrainsExecutableCandidates(): Promise<DetectedJetBrainsCandidate[]> {
    if (process.platform !== "win32") return [];

    const roots: Array<{ dir: string; maxDepth: number; stopAfterDirs?: number }> = [];
    const addRoot = (dir: string | undefined, maxDepth: number, stopAfterDirs?: number) => {
        if (!dir) return;
        const trimmed = dir.trim();
        if (!trimmed) return;
        if (!path.isAbsolute(trimmed)) return;
        roots.push({ dir: trimmed, maxDepth, stopAfterDirs });
    };
    const programFiles = process.env.ProgramFiles;
    const programFilesX86 = process.env["ProgramFiles(x86)"];
    const localAppData = process.env.LOCALAPPDATA;
    const appData = process.env.APPDATA;
    const userProfile = process.env.USERPROFILE;

    if (programFiles) addRoot(path.join(programFiles, "JetBrains"), 3, 1000);
    if (programFilesX86) addRoot(path.join(programFilesX86, "JetBrains"), 3, 1000);
    if (localAppData) addRoot(path.join(localAppData, "Programs", "JetBrains"), 3, 1000);
    if (localAppData) addRoot(path.join(localAppData, "JetBrains", "Toolbox", "apps"), 6, 5000);
    if (appData) addRoot(path.join(appData, "JetBrains", "Toolbox", "apps"), 6, 5000);
    if (userProfile) {
        addRoot(
            path.join(userProfile, "AppData", "Local", "JetBrains", "Toolbox", "apps"),
            6,
            5000,
        );
    }

    const all = (
        await Promise.all(
            roots.map((root) =>
                findWindowsExecutableCandidatesInRoot(root.dir, {
                    maxDepth: root.maxDepth,
                    stopAfterDirs: root.stopAfterDirs,
                }),
            ),
        )
    ).flat();

    const unique = new Map<string, DetectedJetBrainsCandidate>();
    for (const candidate of all) {
        if (!unique.has(candidate.launchPath)) unique.set(candidate.launchPath, candidate);
    }

    return Array.from(unique.values()).sort(rankCandidates);
}

export async function detectInstalledJetBrainsMergeToolPath(): Promise<string | null> {
    const candidates = await detectInstalledJetBrainsMergeToolCandidates();
    return candidates[0] ?? null;
}

export async function detectInstalledJetBrainsMergeToolCandidates(): Promise<string[]> {
    try {
        if (process.platform === "darwin") {
            const candidates = await detectMacJetBrainsAppBundleCandidates();
            return candidates.map((candidate) => candidate.launchPath);
        }
        if (process.platform === "win32") {
            const candidates = await detectWindowsJetBrainsExecutableCandidates();
            return candidates.map((candidate) => candidate.launchPath);
        }
        return [];
    } catch {
        return [];
    }
}

export async function resolveJetBrainsMergeBinaryPath(binaryPath: string): Promise<string> {
    const trimmed = binaryPath.trim();
    if (!trimmed) throw new Error("JetBrains merge tool path is empty.");
    if (isMacAppBundlePath(trimmed)) {
        return resolveExecutableFromMacAppBundle(trimmed);
    }
    return trimmed;
}

function sanitizeFileNamePart(value: string): string {
    return value.replace(/[^\w.-]+/g, "_");
}

function buildTempFileNames(relativeFilePath: string): {
    base: string;
    ours: string;
    theirs: string;
} {
    const ext = path.extname(relativeFilePath);
    const baseName = path.basename(relativeFilePath, ext);
    const safe = sanitizeFileNamePart(baseName || "merge");
    const suffix = ext || ".txt";
    return {
        base: `.intelligit-base-${safe}${suffix}`,
        ours: `.intelligit-ours-${safe}${suffix}`,
        theirs: `.intelligit-theirs-${safe}${suffix}`,
    };
}

export function containsConflictMarkers(text: string): boolean {
    return /^<<<<<<<[^\r\n]*\r?\n[\s\S]*?^=======\r?$[\s\S]*?^>>>>>>>[^\r\n]*$/m.test(text);
}

export async function launchJetBrainsMergeTool(
    input: JetBrainsMergeToolLaunchInput,
): Promise<JetBrainsMergeToolLaunchResult> {
    const resolvedBinaryPath = await resolveJetBrainsMergeBinaryPath(input.binaryPath);
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "intelligit-merge-"));
    const names = buildTempFileNames(input.relativeFilePath);
    const basePath = path.join(tempRoot, names.base);
    const oursPath = path.join(tempRoot, names.ours);
    const theirsPath = path.join(tempRoot, names.theirs);

    try {
        await Promise.all([
            fsp.writeFile(basePath, input.baseContent, "utf8"),
            fsp.writeFile(oursPath, input.oursContent, "utf8"),
            fsp.writeFile(theirsPath, input.theirsContent, "utf8"),
        ]);

        const args = ["merge", oursPath, theirsPath, basePath, input.outputFileFsPath];

        return await new Promise<JetBrainsMergeToolLaunchResult>((resolve, reject) => {
            const child = spawn(resolvedBinaryPath, args, {
                cwd: input.repoRootFsPath,
                stdio: ["ignore", "pipe", "pipe"],
                shell: false,
            });

            let stderr = "";
            child.stderr?.on("data", (chunk) => {
                stderr += String(chunk);
            });

            child.on("error", (err) => {
                reject(
                    new Error(
                        `Failed to launch JetBrains merge tool '${input.binaryPath}': ${err.message}`,
                    ),
                );
            });

            child.on("close", (exitCode, signal) => {
                if (exitCode !== 0 && exitCode !== null && stderr.trim()) {
                    reject(
                        new Error(
                            `JetBrains merge tool exited with code ${exitCode}: ${stderr.trim()}`,
                        ),
                    );
                    return;
                }
                if (exitCode !== 0 && exitCode !== null && !stderr.trim()) {
                    console.warn(
                        `[IntelliGit] JetBrains merge tool exited with code ${exitCode}${
                            signal ? ` (signal: ${signal})` : ""
                        } without stderr output.`,
                    );
                }
                resolve({ exitCode, signal });
            });
        });
    } finally {
        await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    }
}
