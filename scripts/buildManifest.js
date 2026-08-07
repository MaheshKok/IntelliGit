// Shared build-provenance manifest contract between scripts/build.js (writer)
// and scripts/verifyBuildProvenance.js (reader). Keeping both sides of the
// on-disk format in one module means they cannot silently drift apart.
//
// The manifest records, for every declared build output, a path relative to
// the dist directory it lives in and a sha256 content hash -- so a consumer
// can prove a file on disk is really an output of the build that wrote the
// manifest, not a stale artifact left over from an earlier or unrelated one.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const MANIFEST_FILENAME = ".build-manifest.json";
const MANIFEST_SCHEMA_VERSION = 1;

/**
 * Computes the sha256 content hash of a file already on disk.
 *
 * @param {string} filePath Absolute path to the file to hash.
 * @returns {string} Lowercase hex-encoded sha256 digest of the file's bytes.
 */
function hashFileContents(filePath) {
    return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

/**
 * Builds the manifest object recording every declared output of a build, as
 * paths relative to the dist directory the manifest itself will live in.
 *
 * @param {object} input Manifest inputs.
 * @param {string} input.distDir Absolute path to the build output directory.
 * @param {string[]} input.outputPaths Absolute paths to every declared output
 *   produced by the build. Each must already exist on disk and live under
 *   distDir.
 * @returns {{schemaVersion: number, builtAt: string, files: {path: string, hash: string}[]}}
 *   The manifest object, ready to pass to writeManifest.
 */
function createManifest({ distDir, outputPaths }) {
    const files = [...outputPaths].sort().map((absolutePath) => {
        const relativePath = path.relative(distDir, absolutePath).split(path.sep).join("/");
        if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
            throw new Error(
                `Declared output ${absolutePath} does not live under dist directory ${distDir}.`,
            );
        }
        return { path: relativePath, hash: hashFileContents(absolutePath) };
    });
    return {
        schemaVersion: MANIFEST_SCHEMA_VERSION,
        builtAt: new Date().toISOString(),
        files,
    };
}

/**
 * Writes a build manifest into the given dist directory, replacing whatever
 * manifest (if any) was there before.
 *
 * @param {string} distDir Absolute path to the directory the manifest lives in.
 * @param {{schemaVersion: number, builtAt: string, files: {path: string, hash: string}[]}} manifest
 *   The manifest to write, as produced by createManifest.
 * @returns {void}
 */
function writeManifest(distDir, manifest) {
    fs.writeFileSync(
        path.join(distDir, MANIFEST_FILENAME),
        `${JSON.stringify(manifest, null, 4)}\n`,
        "utf8",
    );
}

/**
 * Reads and validates the build manifest from a dist directory. Failing
 * closed here matters: a consumer that treated a malformed or unsafe manifest
 * as "no manifest" (rather than an error) would silently downgrade a
 * corrupted provenance record into a missing one.
 *
 * @param {string} distDir Absolute path to the directory the manifest lives in.
 * @returns {{schemaVersion: number, builtAt: string, files: {path: string, hash: string}[]} | null}
 *   The parsed manifest, or null if no manifest file exists at that path.
 * @throws {Error} If the manifest exists but is not valid JSON, does not match
 *   the expected schema, or declares a file path that escapes distDir.
 */
function readManifest(distDir) {
    const manifestPath = path.join(distDir, MANIFEST_FILENAME);
    if (!fs.existsSync(manifestPath)) {
        return null;
    }

    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch (error) {
        throw new Error(`Malformed build manifest at ${manifestPath}: ${error.message}`, {
            cause: error,
        });
    }

    if (
        typeof parsed !== "object" ||
        parsed === null ||
        typeof parsed.schemaVersion !== "number" ||
        typeof parsed.builtAt !== "string" ||
        !Array.isArray(parsed.files)
    ) {
        throw new Error(`Build manifest at ${manifestPath} does not match the expected schema.`);
    }

    for (const entry of parsed.files) {
        if (typeof entry?.path !== "string" || typeof entry?.hash !== "string") {
            throw new Error(`Build manifest at ${manifestPath} has a malformed file entry.`);
        }
        if (path.isAbsolute(entry.path) || entry.path.split("/").includes("..")) {
            throw new Error(
                `Build manifest at ${manifestPath} declares an unsafe path outside dist: ${entry.path}`,
            );
        }
    }

    return parsed;
}

module.exports = {
    MANIFEST_FILENAME,
    hashFileContents,
    createManifest,
    writeManifest,
    readManifest,
};
