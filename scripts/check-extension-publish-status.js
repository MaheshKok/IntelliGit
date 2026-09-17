const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

function getExtensionId(packageJson) {
    return `${packageJson.publisher}.${packageJson.name}`;
}

function parseJsonOutput(output, source) {
    try {
        return JSON.parse(output);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to parse ${source} JSON output: ${message}`, { cause: error });
    }
}

function isVsceVersionPublished(metadata, version) {
    const versions = Array.isArray(metadata?.versions) ? metadata.versions : [];
    return versions.some((entry) => entry?.version === version);
}

function isOvsxVersionPublished(metadata, version) {
    if (!metadata || typeof metadata !== "object") return false;
    if (metadata.version === version) return true;
    const allVersions = metadata.allVersions;
    return Boolean(
        allVersions &&
        typeof allVersions === "object" &&
        Object.prototype.hasOwnProperty.call(allVersions, version),
    );
}

function isMissingMarketplaceExtensionError(message) {
    return /extension .*not found|no extension found/i.test(message);
}

function isMissingOpenVsxVersionError(message) {
    return /has no published version matching|extension .*not found|no extension found/i.test(
        message,
    );
}

/** Returns whether an Open VSX failure is safe to retry without changing release state. */
function isTransientOpenVsxError(message) {
    return /(^|[^0-9])(408|429|5[0-9]{2})([^0-9]|$)|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|network|socket hang up|fetch failed|connection reset|timed out/i.test(
        message,
    );
}

/** Blocks for the bounded backoff between transient Open VSX status attempts. */
function defaultSleep(milliseconds) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function defaultRunCommand(command, args, options = {}) {
    const result = spawnSync(command, args, {
        encoding: "utf8",
        ...options,
    });

    if (result.error) {
        throw result.error;
    }

    if (result.status !== 0) {
        const stderr = result.stderr?.trim();
        const stdout = result.stdout?.trim();
        throw new Error(stderr || stdout || `${command} exited with status ${result.status}`);
    }

    return result.stdout;
}

/**
 * Reads both registries for one package identity.
 *
 * Open VSX lookup retries only failures that cannot prove publication state and are transient by
 * HTTP or network semantics. Missing versions remain an authoritative unpublished answer; auth,
 * parse, and other permanent failures fail closed without a second request.
 */
function lookupPublishStatus({
    packageJson,
    runCommand = defaultRunCommand,
    cwd = process.cwd(),
    sleep = defaultSleep,
}) {
    const extensionId = getExtensionId(packageJson);
    const version = packageJson.version;

    let vscePublished = false;
    try {
        const vsceOutput = runCommand("bunx", ["vsce", "show", extensionId, "--json"], { cwd });
        vscePublished = isVsceVersionPublished(parseJsonOutput(vsceOutput, "vsce"), version);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!isMissingMarketplaceExtensionError(message)) {
            throw new Error(`VS Code Marketplace lookup failed: ${message}`, { cause: error });
        }
    }

    let ovsxPublished = false;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
            const ovsxOutput = runCommand(
                "bunx",
                ["ovsx", "get", extensionId, "--metadata", "--versionRange", version],
                { cwd },
            );
            ovsxPublished = isOvsxVersionPublished(parseJsonOutput(ovsxOutput, "ovsx"), version);
            break;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (isMissingOpenVsxVersionError(message)) break;
            if (!isTransientOpenVsxError(message) || attempt === 3) {
                throw new Error(`Open VSX lookup failed: ${message}`, { cause: error });
            }
            sleep(attempt * 2000);
        }
    }

    return {
        extensionId,
        version,
        vscePublished,
        ovsxPublished,
    };
}

/** Reads release identity from an explicit package file while resolving CLIs from `cwd`. */
function lookupPublishStatusFromFile({
    packageJsonPath,
    cwd = process.cwd(),
    runCommand = defaultRunCommand,
    sleep = defaultSleep,
}) {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    return lookupPublishStatus({ packageJson, cwd, runCommand, sleep });
}

function writeGitHubOutput(key, value, outputPath) {
    fs.appendFileSync(outputPath, `${key}=${value}\n`, "utf8");
}

/** Runs the status probe, optionally reading package identity from the first CLI argument. */
function main() {
    const packageJsonPath = process.argv[2]
        ? path.resolve(process.argv[2])
        : path.join(process.cwd(), "package.json");
    const status = lookupPublishStatusFromFile({ packageJsonPath });

    console.log(`Extension: ${status.extensionId}`);
    console.log(`Version: ${status.version}`);
    console.log(`VS Code Marketplace published: ${status.vscePublished}`);
    console.log(`Open VSX published: ${status.ovsxPublished}`);

    if (process.env.GITHUB_OUTPUT) {
        writeGitHubOutput(
            "vsce_published",
            String(status.vscePublished),
            process.env.GITHUB_OUTPUT,
        );
        writeGitHubOutput(
            "ovsx_published",
            String(status.ovsxPublished),
            process.env.GITHUB_OUTPUT,
        );
    }
}

if (require.main === module) {
    main();
}

module.exports = {
    getExtensionId,
    isVsceVersionPublished,
    isOvsxVersionPublished,
    lookupPublishStatus,
    lookupPublishStatusFromFile,
};
