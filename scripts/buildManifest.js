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

    // A *number* is not the schema -- it only proves the field was declared.
    // This module exists so the writer and the reader cannot drift apart, and a
    // reader that accepts any version at all gives that up: a future manifest
    // whose `files` entries mean something else would be read with today's
    // rules and reported as verified provenance. Refusing an unknown version is
    // the whole point of recording one.
    if (parsed.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
        throw new Error(
            `Build manifest at ${manifestPath} declares schemaVersion ${parsed.schemaVersion}, ` +
                `but this build understands only version ${MANIFEST_SCHEMA_VERSION}.`,
        );
    }

    for (const entry of parsed.files) {
        if (typeof entry?.path !== "string" || typeof entry?.hash !== "string") {
            throw new Error(`Build manifest at ${manifestPath} has a malformed file entry.`);
        }
        assertPathStaysUnderDist(entry.path, manifestPath);
    }

    return parsed;
}

/**
 * Throws unless `relativePath` can only ever resolve to a location inside the
 * dist directory, on every platform -- not merely on the one running this code.
 *
 * The naive form of this check (`path.isAbsolute(p) || p.split("/").includes("..")`)
 * is POSIX-shaped and silently opens on Windows. `..\outside.js` contains no
 * `/`, so it splits to a single segment that is not `".."`; `path.isAbsolute`
 * is false for it under `path.win32`; and `verifyBuildProvenance` then does
 * `path.join(distDir, ...p.split("/"))`, which on Windows joins the backslash
 * through and lands outside dist. Splitting on BOTH separators, and rejecting
 * drive-qualified paths that `win32.isAbsolute` treats as relative (`C:foo`),
 * closes that without depending on which platform reads the manifest.
 *
 * @param {string} relativePath The dist-relative path declared by a manifest entry.
 * @param {string} manifestPath Absolute path of the manifest, for the error message.
 * @returns {void}
 * @throws {Error} If the path is absolute, drive-qualified, or contains a `..`,
 *   `.`, or empty segment under either separator convention.
 */
function assertPathStaysUnderDist(relativePath, manifestPath) {
    const reject = () => {
        throw new Error(
            `Build manifest at ${manifestPath} declares an unsafe path outside dist: ${relativePath}`,
        );
    };

    if (
        path.posix.isAbsolute(relativePath) ||
        path.win32.isAbsolute(relativePath) ||
        // `C:foo` is drive-RELATIVE, so `win32.isAbsolute` says false, yet
        // `win32.resolve` sends it to that drive's own working directory.
        /^[a-zA-Z]:/.test(relativePath)
    ) {
        reject();
    }

    // Split on a single separator, not a run of them: `a//b` must surface its
    // empty middle segment rather than have a `+` quantifier collapse it away.
    for (const segment of relativePath.split(/[\\/]/)) {
        if (segment === "" || segment === "." || segment === "..") {
            reject();
        }
    }
}

module.exports = {
    MANIFEST_FILENAME,
    hashFileContents,
    createManifest,
    writeManifest,
    readManifest,
};
