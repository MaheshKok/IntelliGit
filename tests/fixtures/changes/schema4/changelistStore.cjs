var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// baseline:src/changes/changelistStore.ts
var changelistStore_exports = {};
__export(changelistStore_exports, {
  ChangelistRevisionError: () => ChangelistRevisionError,
  ChangelistStore: () => ChangelistStore
});
module.exports = __toCommonJS(changelistStore_exports);
var import_node_crypto5 = require("node:crypto");
var import_node_util = require("node:util");

// baseline:src/changes/parseDiff.ts
var import_node_crypto = require("node:crypto");
function changeFingerprint(content) {
  return (0, import_node_crypto.createHash)("sha256").update(content).digest("hex");
}

// baseline:src/utils/repoRelativePath.ts
var path = __toESM(require("node:path"));
function assertRepoRelativePath(filePath) {
  if (!filePath || path.isAbsolute(filePath)) {
    throw new Error(`Rejected non-relative path: ${filePath}`);
  }
  if (filePath.includes("\0") || filePath.includes("\r") || filePath.includes("\n")) {
    throw new Error(`Rejected path containing control characters: ${filePath}`);
  }
  const normalized = path.normalize(filePath);
  if (normalized === ".") throw new Error(`Rejected repo root path: ${filePath}`);
  if (normalized.split(path.sep).some((segment) => segment === "..")) {
    throw new Error(`Rejected path escaping repo root: ${filePath}`);
  }
  return normalized.split(path.sep).join("/");
}

// baseline:src/changes/changelistPersistence.ts
var import_node_crypto4 = require("node:crypto");
var import_node_fs2 = require("node:fs");
var import_promises4 = require("node:fs/promises");
var import_node_path4 = __toESM(require("node:path"));

// baseline:src/git/repositoryLock.ts
var import_node_crypto2 = require("node:crypto");
var import_promises = require("node:fs/promises");
var import_node_path = __toESM(require("node:path"));
var RepositoryLockBusyError = class extends Error {
  /** Creates the stable busy error surfaced to callers. */
  constructor() {
    super("Repository mutation is already in progress.");
    this.name = "RepositoryLockBusyError";
  }
};
var RepositoryLock = class _RepositoryLock {
  static failedReleases = /* @__PURE__ */ new Map();
  heartbeatIntervalMs;
  staleAfterMs;
  livenessProbe;
  beforeTakeover;
  beforeClaimConfirmed;
  lockDirectory;
  lockFileName;
  /** Creates a lock using conservative heartbeat and stale thresholds. */
  constructor(options = {}) {
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 5e3;
    this.staleAfterMs = options.staleAfterMs ?? 3e4;
    this.livenessProbe = options.livenessProbe ?? isProcessLive;
    this.beforeTakeover = options.beforeTakeover;
    this.beforeClaimConfirmed = options.beforeClaimConfirmed;
    this.lockDirectory = options.lockDirectory;
    this.lockFileName = options.lockFileName ?? "repo.lock";
  }
  /** Retries this process's failed cleanup before acquiring; live leases are never reclaimed here. */
  async acquire(commonDir) {
    const lockDir = this.lockDirectory ?? import_node_path.default.join(commonDir, "intelligit");
    const lockPath = import_node_path.default.join(lockDir, this.lockFileName);
    await Promise.all(
      [..._RepositoryLock.failedReleases.get(lockPath) ?? []].map((release) => release())
    );
    await (0, import_promises.mkdir)(lockDir, { recursive: true, mode: 448 });
    const owner = { nonce: (0, import_node_crypto2.randomUUID)(), pid: process.pid, heartbeatAt: Date.now() };
    for (; ; ) {
      try {
        await (0, import_promises.writeFile)(lockPath, JSON.stringify(owner), {
          encoding: "utf8",
          flag: "wx",
          mode: 384
        });
        return await this.confirmClaim(lockPath, owner);
      } catch (error) {
        if (!isExclusiveCreateBlocked(error)) throw error;
      }
      const existing = await readLockFile(lockPath);
      if (!this.isStale(existing)) throw new RepositoryLockBusyError();
      if (existing.kind === "owned" && await this.livenessProbe(existing.owner.pid)) {
        throw new RepositoryLockBusyError();
      }
      await this.beforeTakeover?.();
      const takeoverPath = import_node_path.default.join(lockDir, `takeover-${owner.nonce}`);
      try {
        await (0, import_promises.rename)(lockPath, takeoverPath);
      } catch (error) {
        if (isNotFound(error)) continue;
        throw error;
      }
      const moved = await readLockFile(takeoverPath);
      if (!isSameLockFile(moved, existing)) {
        await (0, import_promises.rename)(takeoverPath, lockPath).catch(() => void 0);
        throw new RepositoryLockBusyError();
      }
      try {
        await (0, import_promises.writeFile)(lockPath, JSON.stringify(owner), {
          encoding: "utf8",
          flag: "wx",
          mode: 384
        });
      } catch (error) {
        if (isExclusiveCreateBlocked(error)) {
          await (0, import_promises.rm)(takeoverPath, { force: true });
          throw new RepositoryLockBusyError();
        }
        await (0, import_promises.rename)(takeoverPath, lockPath).catch(() => void 0);
        throw error;
      }
      await (0, import_promises.rm)(takeoverPath, { force: true });
      return await this.confirmClaim(lockPath, owner);
    }
  }
  /**
   * Confirms the record just written is the one at the lock path, then starts the heartbeat.
   *
   * The exclusive create wins the path before the record has landed in it, so a claimant
   * stalled between the two leaves a zero-length file that a contender is entitled to reclaim
   * as residue. Reading the path back is how such a claimant learns it lost, rather than
   * returning a release callback -- and a heartbeat -- for a lock another process now holds.
   * A record that is not ours is left where it is, because it is not ours to remove.
   */
  async confirmClaim(lockPath, owner) {
    await this.beforeClaimConfirmed?.();
    const claimed = await readLockFile(lockPath);
    if (claimed.kind !== "owned" || claimed.owner.nonce !== owner.nonce) {
      throw new RepositoryLockBusyError();
    }
    return this.releaseCallback(lockPath, owner);
  }
  /**
   * Whether the observed lock file is old enough to be a takeover candidate.
   *
   * An unreadable file has no heartbeat to read and no pid to probe, so its own mtime is the
   * only evidence about it. That is sufficient evidence only because no process that believes
   * it holds the lock can produce this state: heartbeats are published by rename, so the lock
   * path always holds a whole record -- the new one or the previous one -- and a claim whose
   * record never landed is caught by `confirmClaim` before it becomes a held lock. An
   * unreadable lock path is therefore residue, of a process killed under an older build or of
   * outright corruption, and mtime measures how long it has been lying there.
   *
   * The distinction matters because this branch cannot consult `livenessProbe`. An `owned`
   * record that has gone stale still falls through to the probe, which refuses to displace an
   * owner that is merely slow; an unreadable one carries no pid, so there is nothing to ask.
   */
  isStale(state) {
    switch (state.kind) {
      case "absent":
        return false;
      case "owned":
        return Date.now() - state.owner.heartbeatAt > this.staleAfterMs;
      case "unreadable":
        return Date.now() - state.mtimeMs > this.staleAfterMs;
    }
  }
  /** Serializes release attempts and retains failed owner-checked cleanup for the next acquisition. */
  releaseCallback(lockPath, owner) {
    let released = false;
    let releaseAttempt;
    const temporaryPath = `${lockPath}.${owner.nonce}`;
    let pendingWrite = Promise.resolve();
    let lastPublishFailure;
    const heartbeat = setInterval(() => {
      owner.heartbeatAt = Date.now();
      const snapshot = JSON.stringify(owner);
      pendingWrite = pendingWrite.then(() => publishLockRecord(temporaryPath, lockPath, snapshot)).catch((error) => {
        const description = error instanceof Error ? error.message : String(error);
        if (description === lastPublishFailure) return;
        lastPublishFailure = description;
        console.error(
          `IntelliGit: repository lock heartbeat could not publish its record; another process may take this lock over while it is still held: ${description}`
        );
      });
    }, this.heartbeatIntervalMs);
    heartbeat.unref();
    const release = () => {
      if (released) return Promise.resolve();
      if (releaseAttempt) return releaseAttempt;
      clearInterval(heartbeat);
      releaseAttempt = pendingWrite.then(async () => {
        const existing = await readLockFile(lockPath);
        if (existing.kind === "owned" && existing.owner.nonce === owner.nonce) {
          await (0, import_promises.rm)(lockPath, { force: true });
        }
        await (0, import_promises.rm)(temporaryPath, { force: true });
        released = true;
        const failed = _RepositoryLock.failedReleases.get(lockPath);
        failed?.delete(release);
        if (failed?.size === 0) _RepositoryLock.failedReleases.delete(lockPath);
      }).catch((error) => {
        const failed = _RepositoryLock.failedReleases.get(lockPath) ?? /* @__PURE__ */ new Set();
        failed.add(release);
        _RepositoryLock.failedReleases.set(lockPath, failed);
        throw error;
      }).finally(() => {
        releaseAttempt = void 0;
      });
      return releaseAttempt;
    };
    return release;
  }
};
async function publishLockRecord(temporaryPath, lockPath, contents) {
  await (0, import_promises.writeFile)(temporaryPath, contents, { encoding: "utf8", mode: 384 });
  await (0, import_promises.rename)(temporaryPath, lockPath);
}
function isSameLockFile(moved, expected) {
  if (expected.kind === "owned") {
    return moved.kind === "owned" && moved.owner.nonce === expected.owner.nonce && moved.owner.heartbeatAt === expected.owner.heartbeatAt;
  }
  return moved.kind === "unreadable";
}
async function readLockFile(lockPath) {
  try {
    const handle = await (0, import_promises.open)(lockPath, "r");
    try {
      const [stats, contents] = await Promise.all([handle.stat(), handle.readFile("utf8")]);
      const owner = parseOwner(contents);
      return owner ? { kind: "owned", owner } : { kind: "unreadable", mtimeMs: stats.mtimeMs };
    } finally {
      await handle.close().catch(() => void 0);
    }
  } catch (error) {
    if (isNotFound(error)) return { kind: "absent" };
    return { kind: "unreadable", mtimeMs: Date.now() };
  }
}
function parseOwner(contents) {
  let parsed;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return void 0;
  }
  if (!parsed || typeof parsed !== "object") return void 0;
  const owner = parsed;
  return typeof owner.nonce === "string" && typeof owner.pid === "number" && typeof owner.heartbeatAt === "number" ? { nonce: owner.nonce, pid: owner.pid, heartbeatAt: owner.heartbeatAt } : void 0;
}
function isExclusiveCreateBlocked(error, platform = process.platform) {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  if (error.code === "EEXIST") return true;
  return platform === "win32" && error.code === "EPERM";
}
function isNotFound(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
function isProcessLive(pid) {
  try {
    process.kill(pid, 0);
    return Promise.resolve(true);
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : void 0;
    return Promise.resolve(code !== "ESRCH");
  }
}

// baseline:src/git/partialSnapshot.ts
var import_node_buffer = require("node:buffer");
var import_promises3 = require("node:fs/promises");
var import_node_os = require("node:os");
var import_node_path3 = __toESM(require("node:path"));

// baseline:src/shelf/recoveryPaths.ts
var import_promises2 = require("node:fs/promises");
var import_node_path2 = __toESM(require("node:path"));

// baseline:src/shelf/recoveryGit.ts
var import_node_crypto3 = require("node:crypto");

// baseline:src/git/partialSnapshot.ts
var MAX_PARTIAL_TEXT_BYTES = 2 * 1024 * 1024;
var MAX_DIFF_BYTES = 8 * 1024 * 1024;
var PartialChangesUnsupportedError = class extends Error {
};

// baseline:src/git/boundedLockRetry.ts
async function acquireWithBoundedWait(acquire, options) {
  const deadline = Date.now() + options.timeoutMs;
  for (; ; ) {
    try {
      return await acquire();
    } catch (error) {
      if (!(error instanceof RepositoryLockBusyError)) throw error;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw error;
      await new Promise(
        (resolve) => setTimeout(resolve, Math.min(options.retryDelayMs, remainingMs))
      );
    }
  }
}

// baseline:src/shelf/noFollowFlag.ts
var import_node_fs = require("node:fs");
function resolveNoFollowFlag(platform = process.platform) {
  if (platform === "win32") return 0;
  return typeof import_node_fs.constants.O_NOFOLLOW === "number" ? import_node_fs.constants.O_NOFOLLOW : 0;
}

// baseline:src/changes/rangeMetadata.ts
var HASH = /^[a-f0-9]{64}$/;
function validRangeMetadata(ownership, owners, inline = false) {
  const validate = inline ? validSnapshot : validSnapshotReference;
  if (ownership.tracking !== void 0 && !validate(ownership.tracking)) return false;
  if (ownership.history === void 0) return true;
  if (!Array.isArray(ownership.history) || ownership.history.length > 2) return false;
  return ownership.history.every(
    (entry) => record(entry) && validate(entry.snapshot) && record(entry.lines) && Object.entries(entry.lines).every(
      ([hash, owner]) => HASH.test(hash) && typeof owner === "string" && owners.has(owner)
    )
  );
}
function validSnapshot(input) {
  const value = input;
  if (!record(value) || !HASH.test(value.contentId) || !HASH.test(value.baseHash) || !HASH.test(value.workingHash) || !HASH.test(value.indexHash) || typeof value.head !== "string" || !/^[a-f0-9]{40,64}$/.test(value.head))
    return false;
  if (!hashes(value.baseLines) || !hashes(value.workingLines) || !Array.isArray(value.anchors) || value.anchors.length > 1e5)
    return false;
  const fingerprints = /* @__PURE__ */ new Set();
  const ids = /* @__PURE__ */ new Set();
  return value.anchors.every((anchor) => {
    if (!record(anchor) || anchor.kind !== "add" && anchor.kind !== "remove" || !Number.isSafeInteger(anchor.line) || anchor.line < 0 || !HASH.test(anchor.fingerprint) || !HASH.test(anchor.hash) || typeof anchor.id !== "string" || !/^\d{1,5}:\d{1,6}$/.test(anchor.id))
      return false;
    if (ids.has(anchor.id) || fingerprints.has(anchor.fingerprint)) return false;
    ids.add(anchor.id);
    fingerprints.add(anchor.fingerprint);
    const lines = anchor.kind === "add" ? value.workingLines : value.baseLines;
    return lines[anchor.line] === anchor.hash && hashes(anchor.context) && anchor.context.length <= 5;
  });
}
function hashes(value) {
  return Array.isArray(value) && value.length <= 1e5 && value.every((item) => typeof item === "string" && HASH.test(item));
}
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function validSnapshotReference(input) {
  const value = input;
  return record(value) && Object.keys(value).length === 7 && HASH.test(value.blob) && HASH.test(value.contentId) && HASH.test(value.baseHash) && HASH.test(value.workingHash) && HASH.test(value.indexHash) && typeof value.head === "string" && /^[a-f0-9]{40,64}$/.test(value.head) && Number.isSafeInteger(value.anchorCount) && value.anchorCount >= 0 && value.anchorCount <= 1e5;
}
function snapshotReference(snapshot, blob) {
  return {
    blob,
    contentId: snapshot.contentId,
    baseHash: snapshot.baseHash,
    workingHash: snapshot.workingHash,
    head: snapshot.head,
    indexHash: snapshot.indexHash,
    anchorCount: snapshot.anchors.length
  };
}

// baseline:src/changes/changelistPersistence.ts
var MAX_BYTES = 64 * 1024 * 1024;
var ChangelistPersistence = class _ChangelistPersistence {
  /** Binds paths already canonicalized by open; metadata locking remains separate from Git's index lock. */
  constructor(root, gitDir, directory) {
    this.root = root;
    this.gitDir = gitDir;
    this.directory = directory;
    this.filename = import_node_path4.default.join(directory, "state.json");
    this.evidenceDirectory = import_node_path4.default.join(directory, "evidence");
    this.lock = new RepositoryLock({ lockDirectory: directory, lockFileName: "metadata.lock" });
  }
  root;
  gitDir;
  directory;
  lock;
  cached;
  filename;
  evidenceDirectory;
  evidenceDirectoryDurable = false;
  /** Refuse symlinked metadata directories before acquiring or writing any record. */
  static async open(root, gitDir) {
    const canonicalRoot = await (0, import_promises4.realpath)(root);
    const canonicalGit = await (0, import_promises4.realpath)(gitDir);
    const parent = import_node_path4.default.join(canonicalGit, "intelligit");
    const directory = import_node_path4.default.join(parent, "changelists");
    await (0, import_promises4.mkdir)(parent, { recursive: true, mode: 448 });
    if (await (0, import_promises4.realpath)(parent) !== parent)
      throw new Error("Changelist storage requires review.");
    await (0, import_promises4.mkdir)(directory, { mode: 448 }).catch((error) => {
      if (!hasCode(error, "EEXIST")) throw error;
    });
    if (await (0, import_promises4.realpath)(directory) !== directory)
      throw new Error("Changelist storage requires review.");
    return new _ChangelistPersistence(canonicalRoot, canonicalGit, directory);
  }
  /** Brief contention retries; the acquired lease spans read/check/write or the selected commit. */
  acquire() {
    return acquireWithBoundedWait(() => this.lock.acquire(this.gitDir), {
      timeoutMs: 2e3,
      retryDelayMs: 25
    });
  }
  /**
   * Reuses validated state only while the file identity and parser are unchanged. Callers
   * must not mutate the borrowed state; ChangelistStore returns independent snapshots.
   * Missing, unsafe, or unreadable records invalidate the cache and retain read failures.
   */
  read(parse) {
    let bytes;
    let identity;
    try {
      const stat = (0, import_node_fs2.lstatSync)(this.filename, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES)
        throw new Error("Changelist metadata requires review and will not be overwritten.");
      identity = recordIdentity(stat);
      if (this.cached?.identity === identity && this.cached.parse === parse)
        return this.cached.state;
      this.cached = void 0;
      bytes = (0, import_node_fs2.readFileSync)(this.filename, "utf8");
      if (Buffer.byteLength(bytes) > MAX_BYTES) throw new ChangelistEvidenceError();
      if (recordIdentity((0, import_node_fs2.lstatSync)(this.filename, { bigint: true })) !== identity)
        identity = void 0;
    } catch (error) {
      this.cached = void 0;
      if (hasCode(error, "ENOENT")) return void 0;
      throw error;
    }
    const saved = JSON.parse(bytes);
    const state = parse(saved.state);
    if (saved.schemaVersion !== 4 || saved.root !== this.root || saved.gitDir !== this.gitDir || !state)
      throw new Error("Changelist metadata requires review and will not be overwritten.");
    if (identity !== void 0) this.cached = { identity, parse, state };
    return state;
  }
  /** Publish only a complete fsynced record; a failed write leaves the previous file intact. */
  async write(state) {
    const envelope = {
      schemaVersion: 4,
      root: this.root,
      gitDir: this.gitDir,
      state
    };
    await this.assertReferences(state);
    await this.publish(this.filename, envelope);
  }
  /** Reads the old inline envelope only during a lease-protected connection upgrade. */
  async readLegacy(parse) {
    let bytes;
    try {
      bytes = await this.readImmutable(this.filename);
    } catch (error) {
      if (hasCode(error, "ENOENT")) return void 0;
      throw error;
    }
    const saved = JSON.parse(bytes);
    if (saved.schemaVersion === 4) return void 0;
    const state = parse(saved.state);
    if (saved.schemaVersion !== 3 || saved.root !== this.root || saved.gitDir !== this.gitDir || !state)
      throw new ChangelistEvidenceError();
    return { state, bytes };
  }
  /** Retains every interrupted legacy generation; a matching corrupt backup cannot be replaced. */
  async backupLegacy(bytes) {
    const filename = import_node_path4.default.join(
      this.directory,
      `state-v3.${changeFingerprint(bytes)}.backup.json`
    );
    await this.publishImmutable(filename, bytes);
  }
  /** Publishes bound evidence before the manifest; unsupported fresh content stays in the whole-file workflow. */
  async storeSnapshot(file, snapshot) {
    try {
      const safe = assertRepoRelativePath(file);
      if (!validSnapshot(snapshot))
        throw new PartialChangesUnsupportedError("Unsupported tracked range content.");
      const bytes = JSON.stringify({
        schemaVersion: 1,
        root: this.root,
        gitDir: this.gitDir,
        path: safe,
        snapshot
      });
      const reference = snapshotReference(snapshot, changeFingerprint(bytes));
      if (Buffer.byteLength(bytes) > MAX_BYTES)
        throw new PartialChangesUnsupportedError("Unsupported tracked range content.");
      await this.evidenceDirectoryReady(true);
      await this.publishImmutable(
        import_node_path4.default.join(this.evidenceDirectory, `${reference.blob}.json`),
        bytes
      );
      return reference;
    } catch (error) {
      if (error instanceof PartialChangesUnsupportedError) throw error;
      throw new ChangelistEvidenceError(error);
    }
  }
  /** Loads one bound snapshot under the caller's metadata lease; mismatches never become defaults. */
  async loadSnapshot(file, reference) {
    try {
      const safe = assertRepoRelativePath(file);
      if (!validSnapshotReference(reference)) throw new ChangelistEvidenceError();
      await this.evidenceDirectoryReady(false);
      const bytes = await this.readImmutable(
        import_node_path4.default.join(this.evidenceDirectory, `${reference.blob}.json`)
      );
      if (changeFingerprint(bytes) !== reference.blob) throw new ChangelistEvidenceError();
      const saved = JSON.parse(bytes);
      if (saved.schemaVersion !== 1 || saved.root !== this.root || saved.gitDir !== this.gitDir || saved.path !== safe || !validSnapshot(saved.snapshot))
        throw new ChangelistEvidenceError();
      const expected = snapshotReference(saved.snapshot, reference.blob);
      if (Object.keys(expected).some(
        (key) => expected[key] !== reference[key]
      ))
        throw new ChangelistEvidenceError();
      return saved.snapshot;
    } catch (error) {
      throw new ChangelistEvidenceError(error);
    }
  }
  /** Connection validates all live payloads once; ordinary metadata reads remain payload-free. */
  async validateEvidence(state) {
    for (const [file, references] of fileReferences(state)) {
      for (const reference of references) await this.loadSnapshot(file, reference);
    }
  }
  /** Counts names once per publication and refuses dangling references without hydrating payloads. */
  async assertReferences(state) {
    await this.evidenceDirectoryReady(true);
    const names = new Set(await (0, import_promises4.readdir)(this.evidenceDirectory));
    for (const [, references] of fileReferences(state)) {
      for (const reference of references) {
        if (!validSnapshotReference(reference) || !names.has(`${reference.blob}.json`))
          throw new ChangelistEvidenceError();
      }
    }
  }
  /** Collection is lease-protected and post-publication; failure leaves harmless recovery debris. */
  async collect(previous, current) {
    try {
      await this.evidenceDirectoryReady(false);
      const live = new Set(
        fileReferences(current).flatMap(
          ([, refs]) => refs.map((ref) => `${ref.blob}.json`)
        )
      );
      const candidates = previous ? [
        ...new Set(
          fileReferences(previous).flatMap(
            ([, refs]) => refs.map((ref) => `${ref.blob}.json`)
          )
        )
      ] : await (0, import_promises4.readdir)(this.evidenceDirectory);
      for (const name of candidates) {
        if (live.has(name) || !/^[a-f0-9]{64}\.json(?:\.[a-f0-9-]{36}\.tmp)?$/.test(name))
          continue;
        const filename = import_node_path4.default.join(this.evidenceDirectory, name);
        const stat = await (0, import_promises4.lstat)(filename).catch((error) => {
          if (hasCode(error, "ENOENT")) return void 0;
          throw error;
        });
        if (stat?.isFile() && !stat.isSymbolicLink()) await (0, import_promises4.rm)(filename);
      }
    } catch (error) {
      console.warn("[IntelliGit] Changelist evidence cleanup failed:", error);
    }
  }
  /** Revalidates the canonical parent chain before payload access; symbolic directories are refused. */
  async evidenceDirectoryReady(create) {
    if (await (0, import_promises4.realpath)(this.directory) !== this.directory)
      throw new ChangelistEvidenceError();
    if (create)
      await (0, import_promises4.mkdir)(this.evidenceDirectory, { mode: 448 }).then(() => {
        this.evidenceDirectoryDurable = false;
      }).catch((error) => {
        if (!hasCode(error, "EEXIST")) throw error;
      });
    if (await (0, import_promises4.realpath)(this.evidenceDirectory) !== this.evidenceDirectory)
      throw new ChangelistEvidenceError();
    if (create && !this.evidenceDirectoryDurable) {
      await this.syncDirectory(this.directory);
      this.evidenceDirectoryDurable = true;
    }
  }
  /** Bounded actual reads plus descriptor/path identity checks also protect platforms without O_NOFOLLOW. */
  async readImmutable(filename) {
    const before = await (0, import_promises4.lstat)(filename, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_BYTES)
      throw new ChangelistEvidenceError();
    const handle = await (0, import_promises4.open)(filename, import_node_fs2.constants.O_RDONLY | resolveNoFollowFlag());
    try {
      if (recordIdentity(await handle.stat({ bigint: true })) !== recordIdentity(before))
        throw new ChangelistEvidenceError();
      const chunks = [];
      let total = 0;
      for (; ; ) {
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_BYTES + 1 - total));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
        if (!bytesRead) break;
        total += bytesRead;
        if (total > MAX_BYTES) throw new ChangelistEvidenceError();
        chunks.push(chunk.subarray(0, bytesRead));
      }
      if (recordIdentity(await handle.stat({ bigint: true })) !== recordIdentity(before) || recordIdentity(await (0, import_promises4.lstat)(filename, { bigint: true })) !== recordIdentity(before))
        throw new ChangelistEvidenceError();
      return Buffer.concat(chunks, total).toString("utf8");
    } finally {
      await handle.close();
    }
  }
  /** Create-only publication validates an existing digest instead of overwriting corrupt evidence. */
  async publishImmutable(filename, bytes) {
    try {
      if (await this.readImmutable(filename) !== bytes) throw new ChangelistEvidenceError();
      await this.syncDirectory(import_node_path4.default.dirname(filename));
      return;
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
    }
    try {
      await this.publish(filename, bytes, true, true);
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      if (await this.readImmutable(filename) !== bytes) throw new ChangelistEvidenceError();
      await this.syncDirectory(import_node_path4.default.dirname(filename));
    }
  }
  /** Existing orphan payloads also cross the directory durability barrier before being referenced. */
  async syncDirectory(filename) {
    if (process.platform === "win32") return;
    const directory = await (0, import_promises4.open)(filename, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
  /** Migration evidence is create-once and is never replaced by a later window's stale copy. */
  async backup(value) {
    const filename = import_node_path4.default.join(this.directory, "migration.json");
    try {
      await this.publish(filename, value, true);
    } catch (error) {
      if (hasCode(error, "EEXIST")) {
        const stat = (0, import_node_fs2.lstatSync)(filename);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES)
          throw new Error("Changelist migration backup requires review.");
        const saved = JSON.parse((0, import_node_fs2.readFileSync)(filename, "utf8"));
        if (saved.root !== value.root || JSON.stringify(saved.state) !== JSON.stringify(value.state))
          throw new Error("Changelist migration backup requires review.");
        return;
      }
      throw error;
    }
  }
  /** Only this root's immutable seed proves its migration; missing or corrupt evidence cannot authorize it. */
  migratedFrom(root, state) {
    const filename = import_node_path4.default.join(this.directory, "migration.json");
    try {
      const stat = (0, import_node_fs2.lstatSync)(filename);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES)
        throw new Error("Changelist migration backup requires review.");
      const saved = JSON.parse((0, import_node_fs2.readFileSync)(filename, "utf8"));
      return saved?.root === root && JSON.stringify(saved.state) === JSON.stringify(state);
    } catch (error) {
      if (hasCode(error, "ENOENT")) return false;
      throw error;
    }
  }
  /** Preserve a conflicting workspace migration separately instead of overwriting either intent. */
  async preserveConflict(value) {
    await this.publish(
      import_node_path4.default.join(
        this.directory,
        `migration-conflict-${changeFingerprint(JSON.stringify(value))}.json`
      ),
      value
    );
  }
  /** Fsync before publication; create-only links also preserve existing migration evidence. */
  async publish(filename, value, createOnly = false, exactBytes = false) {
    const bytes = exactBytes ? String(value) : JSON.stringify(value);
    if (Buffer.byteLength(bytes) > MAX_BYTES)
      throw new Error("Changelist metadata exceeds its storage budget.");
    const temporary = `${filename}.${(0, import_node_crypto4.randomUUID)()}.tmp`;
    const handle = await (0, import_promises4.open)(temporary, "wx", 384);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      if (createOnly) await (0, import_promises4.link)(temporary, filename);
      else await (0, import_promises4.rename)(temporary, filename);
      if (process.platform !== "win32") {
        const directory = await (0, import_promises4.open)(import_node_path4.default.dirname(filename), "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
    } finally {
      await handle.close().catch(() => void 0);
      await (0, import_promises4.rm)(temporary, { force: true });
    }
  }
};
function recordIdentity(stat) {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}
function hasCode(error, code) {
  return error instanceof Error && "code" in error && error.code === code;
}
var ChangelistEvidenceError = class extends Error {
  /** Existing review wording is retained; the original I/O failure remains available for diagnostics. */
  constructor(cause) {
    super("Changelist metadata requires review and will not be overwritten.", { cause });
  }
};
function fileReferences(state) {
  return Object.entries(state.changes).map(([file, ownership]) => {
    const refs = [
      ...ownership.tracking ? [ownership.tracking] : [],
      ...(ownership.history ?? []).map((entry) => entry.snapshot)
    ];
    return [file, refs];
  });
}

// baseline:src/changes/rangeMapping.ts
function mapLines(before, after) {
  if (before.length === after.length && before.every((hash, i) => hash === after[i]))
    return new Map(before.map((_, i) => [i, i]));
  const matches = /* @__PURE__ */ new Map();
  for (const radius of [0, 2]) {
    const oldKeys = uniqueContexts(before, radius);
    const newKeys = uniqueContexts(after, radius);
    for (const [key, oldLine] of oldKeys) {
      const newLine = newKeys.get(key);
      if (oldLine >= 0 && newLine !== void 0 && newLine >= 0)
        matches.set(oldLine, newLine);
    }
  }
  const ordered = [...matches].sort((a, b) => a[0] - b[0]);
  let maximum = -1;
  const invalid = /* @__PURE__ */ new Set();
  for (const [oldLine, newLine] of ordered) {
    if (newLine <= maximum) invalid.add(oldLine);
    maximum = Math.max(maximum, newLine);
  }
  let minimum = after.length;
  for (const [oldLine, newLine] of [...ordered].reverse()) {
    if (newLine >= minimum) invalid.add(oldLine);
    minimum = Math.min(minimum, newLine);
  }
  for (const oldLine of invalid) matches.delete(oldLine);
  return matches;
}
function uniqueContexts(lines, radius) {
  const result = /* @__PURE__ */ new Map();
  for (let i = 0; i < lines.length; i++) {
    const key = lines.slice(Math.max(0, i - radius), i + radius + 1).join(":");
    result.set(key, result.has(key) ? -1 : i);
  }
  return result;
}
function reconcileRanges(previous, next, fallback, active) {
  if (previous?.tracking && previous.contentId === next.contentId && !previous.stale)
    return previous;
  const old = previous?.tracking;
  if (!old) return initializeRanges(previous, next);
  if (previous.stale) return refused(previous, next);
  const historical = previous.history?.find(
    (entry) => entry.snapshot.contentId === next.contentId
  );
  const source = historical?.snapshot ?? old;
  const owners = historical?.lines ?? previous.lines;
  const { lines, ids, ambiguous } = matchRanges(source, next, owners, fallback, active);
  if (ambiguous) return refused(previous, next);
  return {
    ...previous,
    contentId: next.contentId,
    lines,
    stale: false,
    totalChanges: next.anchors.length,
    tracking: next,
    history: [{ snapshot: old, lines: previous.lines }, ...previous.history ?? []].slice(
      0,
      2
    ),
    selections: mapSelections(previous, next, historical ? /* @__PURE__ */ new Map() : ids)
  };
}
function matchRanges(source, next, owners, fallback, active) {
  const baseMap = mapLines(source.baseLines, next.baseLines);
  const workMap = mapLines(source.workingLines, next.workingLines);
  const candidates = /* @__PURE__ */ new Map();
  for (const anchor of source.anchors) {
    const line = (anchor.kind === "add" ? workMap : baseMap).get(anchor.line);
    if (line !== void 0) candidates.set(`${anchor.kind}:${line}`, anchor);
  }
  const lines = {};
  const ids = /* @__PURE__ */ new Map();
  const boundaries = [...workMap].sort((a, b) => a[1] - b[1]);
  const insertions = new Map(
    source.anchors.filter((anchor) => anchor.kind === "add").map((anchor) => [anchor.line, anchor])
  );
  const gaps = /* @__PURE__ */ new Map();
  let ambiguous = source.baseHash !== next.baseHash && source.workingHash !== next.workingHash;
  for (const anchor of next.anchors) {
    const prior = candidates.get(`${anchor.kind}:${anchor.line}`);
    let owner;
    if (prior && prior.hash === anchor.hash) {
      owner = owners[prior.fingerprint] ?? fallback;
      ids.set(prior.id, anchor.id);
    } else {
      owner = newOwner(
        anchor,
        source,
        next,
        boundaries,
        insertions,
        gaps,
        owners,
        fallback,
        active
      );
    }
    if (owner === void 0) ambiguous = true;
    else if (owner !== fallback) lines[anchor.fingerprint] = owner;
  }
  return { lines, ids, ambiguous };
}
function initializeRanges(previous, next) {
  if (previous && (previous.stale || previous.contentId !== next.contentId))
    return refused(previous, next);
  return {
    ...previous,
    contentId: next.contentId,
    lines: previous?.lines ?? {},
    totalChanges: next.anchors.length,
    tracking: next
  };
}
function newOwner(anchor, before, after, boundaries, insertions, gaps, owners, fallback, active) {
  if (before.baseHash !== after.baseHash) return void 0;
  if (anchor.kind === "remove") return active;
  let low = 0;
  let high = boundaries.length;
  while (low < high) {
    const middle = low + high >>> 1;
    if (boundaries[middle][1] < anchor.line) low = middle + 1;
    else high = middle;
  }
  const start = boundaries[low - 1]?.[0] ?? -1;
  const end = boundaries[low]?.[0] ?? before.workingLines.length;
  const key = `${start}:${end}`;
  if (gaps.has(key)) return gaps.get(key);
  const choices = /* @__PURE__ */ new Set();
  let changed = 0;
  for (let line = start + 1; line < end; line++) {
    const old = insertions.get(line);
    if (!old) continue;
    changed++;
    choices.add(owners[old.fingerprint] ?? fallback);
  }
  const owner = changed === 0 ? active : changed === end - start - 1 && choices.size === 1 ? [...choices][0] : void 0;
  gaps.set(key, owner);
  return owner;
}
function mapSelections(previous, next, ids) {
  if (!previous.selections) return void 0;
  return Object.fromEntries(
    Object.entries(previous.selections).map(([scope, selection]) => {
      if (!selection.lineIds.length && !selection.reviewRequired)
        return [
          scope,
          { ...selection, contentId: next.contentId, total: next.anchors.length }
        ];
      const mapped = selection.lineIds.map((id) => ids.get(id));
      if (selection.reviewRequired || selection.contentId !== previous.contentId || mapped.some((id) => id === void 0))
        return [scope, { ...selection, reviewRequired: true }];
      return [
        scope,
        {
          contentId: next.contentId,
          total: next.anchors.length,
          lineIds: mapped
        }
      ];
    })
  );
}
function refused(previous, next) {
  if (previous.stale && previous.contentId === next.contentId && previous.tracking)
    return previous;
  return {
    ...previous,
    contentId: next.contentId,
    totalChanges: next.anchors.length,
    stale: true,
    tracking: next,
    history: previous.tracking ? [
      { snapshot: previous.tracking, lines: previous.lines },
      ...previous.history ?? []
    ].slice(0, 2) : previous.history
  };
}

// baseline:src/changes/changelistStore.ts
var STORAGE_KEY = "intelligit.changelists.v1";
var BACKUP_KEY = "intelligit.changelists.v1.backup";
var MAX_DRAFT = 1e5;
var MAX_DESCRIPTION = 4e3;
var DEFAULT_CHANGELIST_ID = "default";
var instances = /* @__PURE__ */ new WeakMap();
var MAX_LISTS = 100;
var MAX_FILES = 2e4;
var ChangelistRevisionError = class extends Error {
  /** Preserve the established user-visible conflict message across storage backends. */
  constructor() {
    super("Changelists changed. Refresh before retrying.");
  }
};
function emptyState() {
  return {
    revision: 0,
    activeId: DEFAULT_CHANGELIST_ID,
    lists: [{ id: DEFAULT_CHANGELIST_ID, name: "Changes", description: "", draft: "" }],
    allDraft: "",
    files: /* @__PURE__ */ Object.create(null),
    changes: /* @__PURE__ */ Object.create(null)
  };
}
function nameFor(value) {
  const name = value.normalize("NFC").trim();
  if (!name || name.length > 80 || /[\u0000-\u001f]/.test(name)) {
    throw new Error("A changelist name must contain 1 to 80 printable characters.");
  }
  return name;
}
function parseDurableState(value) {
  return parseState(value, 2, false);
}
function parseLegacyState(value) {
  return parseState(value, 2, true);
}
var ChangelistStore = class _ChangelistStore {
  /** Loads only bounded, well-formed metadata; corrupt records never redirect Git. */
  constructor(storage) {
    this.storage = storage;
    const saved = storage?.get(STORAGE_KEY);
    if (saved === void 0) return;
    if (!saved || typeof saved !== "object" || !("entries" in saved) || !("schemaVersion" in saved) || ![1, 2, 3, 4].includes(saved.schemaVersion)) {
      this.loadError = "Changelist metadata is invalid and will not be overwritten.";
      return;
    }
    const entries = saved.entries;
    this.requiresConnection = saved.schemaVersion === 3 || saved.schemaVersion === 4;
    if (!Array.isArray(entries) || entries.length > 128) {
      this.loadError = "Changelist metadata is invalid and will not be overwritten.";
      return;
    }
    for (const value of entries) {
      const entry = metadataRecord(value);
      if (!entry || typeof entry.root !== "string" || !entry.state || this.roots.has(entry.root)) {
        this.loadError = "Changelist metadata is invalid and will not be overwritten.";
        return;
      }
      const state = parseState(entry.state, saved.schemaVersion === 1 ? 1 : 2, true);
      if (!state) {
        this.loadError = "Changelist metadata is invalid and will not be overwritten.";
        return;
      }
      if (saved.schemaVersion === 1) {
        const legacyDraft = storage?.get(`commitDraft:${entry.root}`);
        if (legacyDraft !== void 0 && (typeof legacyDraft !== "string" || legacyDraft.length > MAX_DRAFT)) {
          this.loadError = "Changelist draft is invalid and will not be overwritten.";
          return;
        }
        state.allDraft = typeof legacyDraft === "string" ? legacyDraft : "";
      }
      this.seeds.set(entry.root, state);
      this.roots.set(entry.root, this.compactMemoryState(entry.root, state));
    }
    if (saved.schemaVersion === 1) this.migrationSource = structuredClone(saved);
  }
  storage;
  roots = /* @__PURE__ */ new Map();
  writes = Promise.resolve();
  listeners = /* @__PURE__ */ new Set();
  loadError;
  migrationSource;
  commitLeases = /* @__PURE__ */ new Map();
  mirrorScopes = /* @__PURE__ */ new Map();
  durable = /* @__PURE__ */ new Map();
  requiresConnection = false;
  seeds = /* @__PURE__ */ new Map();
  hydratedReferences = /* @__PURE__ */ new WeakMap();
  evidence = /* @__PURE__ */ new Map();
  /** Reuses the workspace store so independent panels cannot overwrite each other's lists. */
  static forStorage(storage) {
    if (!storage) return new _ChangelistStore();
    const previous = instances.get(storage);
    if (previous) return previous;
    const store = new _ChangelistStore(storage);
    instances.set(storage, store);
    return store;
  }
  /** Native inputs must wait for authoritative hydration after a schema-3 workspace reload. */
  needsConnection(root) {
    return this.requiresConnection && !this.durable.has(root);
  }
  /** Returns an independent snapshot without exposing mutable host-owned maps. */
  get(root) {
    return structuredClone(this.authoritative(root));
  }
  /** Revision polling validates authoritative metadata without cloning any ownership or evidence. */
  revision(root) {
    return this.authoritative(root).revision;
  }
  /** Borrowed compact state remains private; callers receive independent snapshots through get. */
  authoritative(root) {
    if (this.loadError) throw new Error(this.loadError);
    const persistence = this.durable.get(root);
    if (persistence) {
      const saved = persistence.read(parseDurableState);
      if (!saved) throw new Error("Changelist metadata disappeared and requires review.");
      this.roots.set(root, saved);
    }
    const existing = this.roots.get(root);
    if (existing) return existing;
    const state = emptyState();
    const legacy = this.storage?.get(`commitDraft:${root}`);
    if (legacy !== void 0 && (typeof legacy !== "string" || legacy.length > MAX_DRAFT))
      throw new Error("Changelist draft is invalid and will not be overwritten.");
    state.allDraft = typeof legacy === "string" ? legacy : "";
    return state;
  }
  /**
   * Migrate under the worktree's metadata lock, retaining the original complete workspace
   * record and a downgrade sentinel. Every later writer reloads the authoritative file.
   */
  async connect(root, gitDir) {
    const operation = this.writes.then(async () => {
      if (this.durable.has(root)) return;
      const seed = this.seeds.get(root) ?? await this.hydrateState(root, this.get(root));
      const persistence = await ChangelistPersistence.open(root, gitDir);
      const release = await persistence.acquire();
      try {
        const legacy = await persistence.readLegacy(parseLegacyState);
        const existing = legacy ? void 0 : persistence.read(parseDurableState);
        const existingMatches = !this.roots.has(root) || persistence.migratedFrom(root, seed) || (legacy ? (0, import_node_util.isDeepStrictEqual)(legacy.state, seed) : existing ? await this.matchesSeed(root, existing, seed, persistence) : true);
        if (!existingMatches) {
          await persistence.preserveConflict({
            legacy: this.storage?.get(STORAGE_KEY),
            root,
            state: seed
          });
          throw new Error("Conflicting changelist migration metadata requires review.");
        }
        if (!existing && !legacy)
          await persistence.backup({
            legacy: this.storage?.get(STORAGE_KEY),
            root,
            state: seed
          });
        if (legacy) await persistence.backupLegacy(legacy.bytes);
        const state = existing ?? await this.compactState(root, legacy?.state ?? seed, persistence);
        await persistence.validateEvidence(state);
        if (this.migrationSource !== void 0) await this.backupMigration();
        const hasSeed = this.roots.has(root) || !existing && !legacy;
        await this.publishConnectionSentinel(root, seed, hasSeed);
        this.requiresConnection = true;
        if (!existing) await persistence.write(state);
        await persistence.collect(void 0, state);
        if (hasSeed) this.seeds.set(root, seed);
        this.durable.set(root, persistence);
        this.roots.set(root, state);
        this.evidence.delete(root);
        this.migrationSource = void 0;
      } finally {
        await release();
      }
    });
    this.writes = operation.then(
      () => void 0,
      () => void 0
    );
    return operation;
  }
  /** Preserves real workspace seeds, omits invented adoption intent, and avoids unchanged sentinel writes. */
  async publishConnectionSentinel(root, seed, hasSeed) {
    const seeds = new Map(this.seeds);
    if (hasSeed && !seeds.has(root)) seeds.set(root, seed);
    const sentinel = {
      schemaVersion: 4,
      entries: [...seeds].map(([key, value]) => ({ root: key, state: value }))
    };
    if (JSON.stringify(this.storage?.get(STORAGE_KEY)) !== JSON.stringify(sentinel))
      await this.storage?.update(STORAGE_KEY, sentinel);
  }
  /** Browser snapshots omit potentially large host-only range evidence and undo history. */
  view(root) {
    const state = this.get(root);
    for (const ownership of Object.values(state.changes)) {
      delete ownership.tracking;
      delete ownership.history;
    }
    return state;
  }
  /** Reconciles one host-captured snapshot atomically with the current active list and revision. */
  track(root, file, snapshot, revision) {
    const safe = assertRepoRelativePath(file);
    return this.write(root, revision, async (state) => {
      const fallback = state.files[safe] ?? state.activeId;
      state.files[safe] = fallback;
      const previous = await this.hydrate(root, safe, state.changes[safe]);
      state.changes[safe] = await this.compact(
        root,
        safe,
        reconcileRanges(previous, snapshot, fallback, state.activeId)
      );
    });
  }
  /** Failed lifecycle reads retain evidence and prevent implicit whole-file commits. */
  requireReview(root, file, unknown = false) {
    const safe = assertRepoRelativePath(file);
    return this.write(root, void 0, (state) => {
      const previous = state.changes[safe];
      if (previous || unknown)
        state.changes[safe] = {
          ...previous ?? { contentId: "", lines: {} },
          stale: true
        };
    });
  }
  /** Subscriptions report metadata changes only, never Git or filesystem mutations. */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  /** Reserves metadata after pending writes, preventing membership changes during a commit. */
  async beginCommit(root) {
    const operation = this.writes.then(async () => {
      if (this.commitLeases.has(root))
        throw new Error("A selected commit is already in progress.");
      const release = await this.durable.get(root)?.acquire();
      let state;
      try {
        state = this.get(root);
      } catch (error) {
        await release?.();
        throw error;
      }
      const token = (0, import_node_crypto5.randomUUID)();
      this.commitLeases.set(root, token);
      this.notify(root, state);
      return async () => {
        if (this.commitLeases.get(root) !== token) return;
        this.commitLeases.delete(root);
        await release?.();
        this.notify(root, this.get(root));
      };
    });
    this.writes = operation.then(
      () => void 0,
      () => void 0
    );
    return operation;
  }
  /** Shared providers expose the same root's semantic commit fence. */
  isCommitting(root) {
    return this.commitLeases.has(root);
  }
  /** Assigns new files and prunes consumed records, retaining clean history for stash/undo restoration. */
  async reconcileFiles(root, paths) {
    if (paths.length > MAX_FILES) throw new Error("Too many changelist files.");
    const safe = [...new Set(paths.map(assertRepoRelativePath))];
    if (safe.length > MAX_FILES) throw new Error("Too many changelist files.");
    return this.write(
      root,
      void 0,
      (state) => {
        const current = new Set(safe);
        for (const file of Object.keys(state.files)) {
          const change = state.changes[file];
          const consumed = change && !change.stale && change.totalChanges === 0 && Object.keys(change.lines).length === 0 && Object.keys(change.selections ?? {}).length === 0 && !change.history?.some(
            ({ snapshot }) => snapshot.baseHash === change.tracking?.baseHash && snapshot.anchorCount > 0
          );
          if (!current.has(file) && (!change || consumed)) {
            delete state.files[file];
            delete state.changes[file];
          }
        }
        for (const file of safe) {
          if (!Object.hasOwn(state.files, file)) state.files[file] = state.activeId;
        }
      },
      false
    );
  }
  /** Creates a named list under revision compare-and-swap. */
  create(root, revision, name, description = "", makeActive = false, movePaths = []) {
    return this.write(root, revision, (state) => {
      if (state.lists.length >= MAX_LISTS) throw new Error("Too many changelists.");
      const accepted = nameFor(name);
      if (state.lists.some(
        (list) => list.name.normalize("NFC").toLowerCase() === accepted.toLowerCase()
      )) {
        throw new Error("A changelist with this name already exists.");
      }
      const id = (0, import_node_crypto5.randomUUID)();
      state.lists.push({
        id,
        name: accepted,
        description: descriptionFor(description),
        draft: ""
      });
      moveWholeFiles(state, id, movePaths);
      if (makeActive) state.activeId = id;
    });
  }
  /** Renames any list without changing its stable identity or saved intent. */
  rename(root, revision, id, name) {
    return this.write(root, revision, (state) => {
      const list = requireList(state, id);
      const accepted = nameFor(name);
      if (state.lists.some(
        (item) => item.id !== id && item.name.normalize("NFC").toLowerCase() === accepted.toLowerCase()
      )) {
        throw new Error("A changelist with this name already exists.");
      }
      list.name = accepted;
    });
  }
  /** Changes where subsequently discovered files are assigned, not Git's index. */
  activate(root, revision, id) {
    return this.write(root, revision, (state) => {
      requireList(state, id);
      state.activeId = id;
    });
  }
  /** Moves only whole files atomically, preserving every saved inclusion and partial owner. */
  moveFiles(root, revision, id, paths) {
    return this.write(root, revision, (state) => {
      requireList(state, id);
      moveWholeFiles(state, id, paths);
    });
  }
  /** Edits description and name atomically; cancellation belongs to the host before this call. */
  edit(root, revision, id, name, description) {
    return this.write(root, revision, (state) => {
      const list = requireList(state, id);
      const accepted = nameFor(name);
      if (state.lists.some(
        (item) => item.id !== id && item.name.normalize("NFC").toLowerCase() === accepted.toLowerCase()
      ))
        throw new Error("A changelist with this name already exists.");
      list.name = accepted;
      list.description = descriptionFor(description);
    });
  }
  /** Reads one exact scope; a removed ID never falls back to All or the active list. */
  draft(root, scope) {
    const state = this.get(root);
    return scope === "all" ? state.allDraft ?? "" : requireList(state, scope).draft ?? "";
  }
  /** The last focused composer owns the native SCM mirror; selection never activates a list. */
  selectDraft(root, scope) {
    this.draft(root, scope);
    this.mirrorScopes.set(root, scope);
  }
  /** Removed mirror scopes follow their destination; delayed writes still carry the original ID. */
  mirrorScope(root) {
    const scope = this.mirrorScopes.get(root) ?? "all";
    return scope === "all" || this.get(root).lists.some((list) => list.id === scope) ? scope : this.get(root).removedScopes?.[scope] ?? "all";
  }
  /** Clears only the exact successfully committed draft while the host owns the commit lease. */
  clearCommittedDraft(root, scope, expected) {
    return this.write(
      root,
      void 0,
      (state) => {
        const list = scope === "all" ? void 0 : requireList(state, scope);
        if (list) {
          if ((list.draft ?? "").trim() === expected.trim()) list.draft = "";
        } else if ((state.allDraft ?? "").trim() === expected.trim()) state.allDraft = "";
      },
      false
    );
  }
  /** Compare-and-swap prevents a delayed pane, native edit or AI result overwriting newer text. */
  saveDraft(root, scope, expected, text) {
    if (text.length > MAX_DRAFT)
      return Promise.reject(new Error("The commit draft is too long."));
    return this.write(root, void 0, (state) => {
      const list = scope === "all" ? void 0 : requireList(state, scope);
      const previous = list ? list.draft ?? "" : state.allDraft ?? "";
      if (expected !== void 0 && previous !== expected)
        throw new Error(
          "The commit draft changed. Review the latest text before retrying."
        );
      if (list) list.draft = text;
      else state.allDraft = text;
    });
  }
  /** Removes metadata only, remapping every owner and fencing ambiguous inclusion atomically. */
  remove(root, revision, id, targetId, draftChoice) {
    return this.write(root, revision, (state) => {
      const source = requireList(state, id);
      const survivors = state.lists.filter((list) => list.id !== id);
      if (targetId === id) throw new Error("Choose a surviving destination changelist.");
      let target = targetId ? survivors.find((list) => list.id === targetId) : survivors.find((list) => list.id === state.activeId) ?? survivors[0];
      if (targetId && !target)
        throw new Error("The destination changelist no longer exists.");
      if (!target) {
        target = { id: (0, import_node_crypto5.randomUUID)(), name: "Changes", description: "", draft: "" };
        survivors.push(target);
      }
      const incoming = source.draft ?? "";
      const existing = target.draft ?? "";
      if (incoming && existing && !draftChoice)
        throw new Error(
          "Choose which commit draft to keep or append before removing the list."
        );
      if (!existing || draftChoice === "source") target.draft = incoming;
      else if (draftChoice === "append" && incoming)
        target.draft = `${existing}

${incoming}`;
      if ((target.draft?.length ?? 0) > MAX_DRAFT)
        throw new Error("The combined commit draft is too long.");
      for (const [file, ownership] of Object.entries(state.changes)) {
        mergeScopeSelection(ownership, state.files[file], id, target.id);
        remapOwners(ownership, id, target.id);
      }
      for (const file of Object.keys(state.files)) {
        if (state.files[file] === id) state.files[file] = target.id;
      }
      redirectRemovedScope(state, id, target.id);
      state.lists = survivors;
      if (state.activeId === id) state.activeId = target.id;
    });
  }
  /** Pins line ownership to a content identity and marks changed assignments for review. */
  registerChanges(root, file, contentId, totalChanges) {
    const safe = assertRepoRelativePath(file);
    return this.write(
      root,
      void 0,
      (state) => {
        if (!Object.hasOwn(state.files, safe)) state.files[safe] = state.activeId;
        const previous = state.changes[safe];
        if (!previous) state.changes[safe] = { contentId, lines: {}, totalChanges };
        else if (previous.contentId !== contentId) {
          state.changes[safe] = {
            ...previous,
            contentId,
            stale: Object.keys(previous.lines).length > 0,
            totalChanges
          };
        }
      },
      false
    );
  }
  /** Explicitly reviewed line assignments replace the current snapshot's metadata only. */
  assignChanges(root, revision, file, contentId, id, fingerprints, validFingerprints) {
    const safe = assertRepoRelativePath(file);
    return this.write(root, revision, (state) => {
      requireList(state, id);
      const ownership = state.changes[safe];
      if (!ownership || ownership.contentId !== contentId)
        throw new Error("The change snapshot is stale.");
      if (ownership.stale && new Set(fingerprints).size !== validFingerprints.size) {
        throw new Error(
          "Review all current changes before replacing outdated assignments."
        );
      }
      const lines = ownership.stale ? {} : { ...ownership.lines };
      for (const fingerprint of fingerprints) {
        if (!validFingerprints.has(fingerprint))
          throw new Error("Unknown change assignment.");
        lines[fingerprint] = id;
      }
      state.changes[safe] = { ...ownership, contentId, lines, stale: false };
    });
  }
  /** Records explicit commit inclusion separately from list membership or the Git index. */
  recordSelection(root, file, contentId, scope, lineIds, total) {
    return this.writeSelection(root, file, contentId, scope, lineIds, total);
  }
  /** Persists staging inclusion under the same root lease used by explicit commits. */
  prepareStageInclusion(root, revision, scope, file) {
    return this.writeSelection(
      root,
      file.path,
      file.contentId,
      scope,
      file.lineIds,
      file.total,
      revision
    );
  }
  writeSelection(root, file, contentId, scope, lineIds, total, leaseRevision) {
    const safe = assertRepoRelativePath(file);
    if (lineIds.length > 1e5 || !Number.isSafeInteger(total) || total < lineIds.length) {
      throw new Error("Invalid partial commit selection.");
    }
    return this.write(
      root,
      leaseRevision,
      (state) => {
        if (leaseRevision !== void 0 && !this.commitLeases.has(root))
          throw new Error("A selected commit lease is required.");
        if (scope !== "all") requireList(state, scope);
        const previous = state.changes[safe] ?? { contentId, lines: {} };
        state.changes[safe] = {
          ...previous,
          selections: {
            ...previous.selections,
            [scope]: { contentId, lineIds: [...lineIds], total }
          }
        };
      },
      leaseRevision === void 0
    );
  }
  /** The explicit whole-file action removes only the current view's partial inclusion. */
  resetSelection(root, revision, scope, paths) {
    if (paths.length > MAX_FILES) throw new Error("Too many changelist files.");
    return this.write(root, revision, (state) => {
      if (scope !== "all") requireList(state, scope);
      for (const file of paths.map(assertRepoRelativePath)) {
        const selections = state.changes[file]?.selections;
        if (selections) delete selections[scope];
      }
    });
  }
  /** Persists exclusion fences before Git can publish, including the whole-file All view. */
  prepareCommitInclusion(root, revision, scope, files) {
    if (!files.length || files.length > 64) throw new Error("Invalid selected commit files.");
    return this.write(
      root,
      revision,
      (state) => {
        if (!this.commitLeases.has(root))
          throw new Error("A selected commit lease is required.");
        if (scope !== "all") requireList(state, scope);
        for (const file of files) {
          const safe = assertRepoRelativePath(file.path);
          if (!Number.isSafeInteger(file.total) || file.total > 1e5 || file.lineIds.length === 0 || file.lineIds.length > file.total || new Set(file.lineIds).size !== file.lineIds.length) {
            throw new Error("Invalid selected commit inclusion.");
          }
          const previous = state.changes[safe] ?? {
            contentId: file.contentId,
            lines: {}
          };
          const inclusion = {
            contentId: file.contentId,
            lineIds: [...file.lineIds],
            total: file.total
          };
          state.changes[safe] = {
            ...previous,
            selections: { ...previous.selections, all: inclusion, [scope]: inclusion }
          };
        }
      },
      false
    );
  }
  /** Rolls back only this attempt's scope fields, retaining unrelated observations and choices. */
  restoreCommitInclusion(root, previous, attempted, scope, paths) {
    return this.write(
      root,
      void 0,
      (state) => {
        if (!this.commitLeases.has(root))
          throw new Error("A selected commit lease is required.");
        for (const file of paths.map(assertRepoRelativePath)) {
          const current = state.changes[file];
          if (!current?.selections) continue;
          for (const key of /* @__PURE__ */ new Set(["all", scope])) {
            if (JSON.stringify(current.selections[key]) !== JSON.stringify(attempted.changes[file]?.selections?.[key]))
              continue;
            const before = previous.changes[file]?.selections?.[key];
            if (before === void 0) delete current.selections[key];
            else current.selections[key] = structuredClone(before);
          }
          if (Object.keys(current.selections).length === 0) delete current.selections;
          if (!previous.changes[file] && !current.selections && current.contentId === attempted.changes[file]?.contentId && Object.keys(current.lines).length === 0 && current.totalChanges === void 0 && current.stale === void 0)
            delete state.changes[file];
        }
      },
      false
    );
  }
  /** Serializes host-local mutations, checks revisions and commit leases, and publishes only after durable storage and migration backup succeed. */
  async write(root, revision, mutate, userMutation = true) {
    const operation = this.writes.catch(() => void 0).then(async () => {
      if (userMutation && this.commitLeases.has(root)) {
        throw new Error("Changelists cannot change during a selected commit.");
      }
      const persistence = this.durable.get(root);
      if (this.requiresConnection && !persistence)
        throw new Error(
          "Changelist metadata requires a connected worktree before writing."
        );
      const release = this.commitLeases.has(root) ? void 0 : await persistence?.acquire();
      try {
        const before = this.get(root);
        if (revision !== void 0 && revision !== before.revision) {
          throw new ChangelistRevisionError();
        }
        const next = structuredClone(before);
        next.files = Object.assign(/* @__PURE__ */ Object.create(null), next.files);
        next.changes = Object.assign(/* @__PURE__ */ Object.create(null), next.changes);
        await mutate(next);
        if (JSON.stringify(before) === JSON.stringify(next) && this.migrationSource === void 0 && this.roots.has(root))
          return before;
        next.revision++;
        if (persistence) {
          await persistence.write(next);
          await persistence.collect(before, next);
          this.roots.set(root, next);
          this.notify(root, next);
          return structuredClone(next);
        }
        if (this.storage) {
          const entries = [];
          for (const [key, value] of this.roots) {
            if (key !== root)
              entries.push({
                root: key,
                state: await this.hydrateState(key, value)
              });
          }
          const seed = await this.hydrateState(root, next);
          entries.push({ root, state: seed });
          if (entries.length > 128)
            throw new Error("Too many changelist repositories.");
          if (Buffer.byteLength(JSON.stringify(entries)) > 4 * 1024 * 1024)
            throw new Error("Changelist metadata exceeds its storage budget.");
          if (this.migrationSource !== void 0) await this.backupMigration();
          await this.storage.update(STORAGE_KEY, { schemaVersion: 2, entries });
          this.seeds.set(root, seed);
        }
        this.migrationSource = void 0;
        this.roots.set(root, next);
        const live = new Set(
          Object.values(next.changes).flatMap((ownership) => [
            ...ownership.tracking ? [ownership.tracking.blob] : [],
            ...(ownership.history ?? []).map((entry) => entry.snapshot.blob)
          ])
        );
        for (const blob of this.evidence.get(root)?.keys() ?? [])
          if (!live.has(blob)) this.evidence.get(root).delete(blob);
        this.notify(root, next);
        return structuredClone(next);
      } finally {
        await release?.();
      }
    });
    this.writes = operation.then(
      () => void 0,
      () => void 0
    );
    return operation;
  }
  /** A pre-existing backup must describe this migration; never replace unrelated recovery evidence. */
  async backupMigration() {
    const backup = this.storage?.get(BACKUP_KEY);
    if (backup !== void 0 && JSON.stringify(backup) !== JSON.stringify(this.migrationSource))
      throw new Error("A different changelist migration backup requires review.");
    if (backup === void 0) await this.storage?.update(BACKUP_KEY, this.migrationSource);
  }
  /** Only known committed identities are consumed; unmatched remaining groups require review. */
  consumeCommitted(root, file, contentId, scope, committed, available, total, snapshot) {
    const safe = assertRepoRelativePath(file);
    return this.write(
      root,
      void 0,
      async (state) => {
        const previous = snapshot ? await this.compact(
          root,
          safe,
          reconcileRanges(
            await this.hydrate(root, safe, state.changes[safe]),
            snapshot,
            state.files[safe] ?? state.activeId,
            state.activeId
          )
        ) : state.changes[safe] ?? { contentId, lines: {} };
        const lines = Object.fromEntries(
          Object.entries(previous.lines).filter(([id]) => snapshot || !committed.has(id))
        );
        state.changes[safe] = {
          ...previous,
          contentId,
          lines,
          stale: snapshot && previous.stale || Object.keys(lines).some((id) => !available.has(id)),
          totalChanges: total,
          selections: {
            ...previous.selections,
            all: { contentId, lineIds: [], total },
            [scope]: { contentId, lineIds: [], total }
          }
        };
      },
      false
    );
  }
  /** Keeps detached evidence private and independently owned until a canonical worktree is connected. */
  remember(root, file, snapshot) {
    if (!validSnapshot(snapshot)) throw new ChangelistEvidenceError();
    const blob = changeFingerprint(JSON.stringify([root, file, snapshot]));
    let snapshots = this.evidence.get(root);
    if (!snapshots) this.evidence.set(root, snapshots = /* @__PURE__ */ new Map());
    if (!snapshots.has(blob)) snapshots.set(blob, structuredClone(snapshot));
    return snapshotReference(snapshot, blob);
  }
  /** Constructor conversion is synchronous; only validated legacy snapshots reach this path. */
  compactMemoryState(root, state) {
    return {
      ...state,
      changes: Object.fromEntries(
        Object.entries(state.changes).map(([file, ownership]) => {
          const { tracking, history, ...metadata } = ownership;
          return [
            file,
            {
              ...metadata,
              ...tracking ? { tracking: this.remember(root, file, tracking) } : {},
              ...history ? {
                history: history.map((entry) => ({
                  snapshot: this.remember(root, file, entry.snapshot),
                  lines: entry.lines
                }))
              } : {}
            }
          ];
        })
      )
    };
  }
  /** Hydrates just one file and each distinct snapshot once while the caller holds its metadata lease. */
  async hydrate(root, file, ownership, persistence = this.durable.get(root)) {
    if (!ownership) return void 0;
    const cache = /* @__PURE__ */ new Map();
    const load = async (reference) => {
      let pending = cache.get(reference.blob);
      if (!pending) {
        pending = (async () => {
          const snapshot = persistence ? await persistence.loadSnapshot(file, reference) : this.evidence.get(root)?.get(reference.blob);
          if (!snapshot) throw new ChangelistEvidenceError();
          const value2 = persistence ? snapshot : structuredClone(snapshot);
          if (persistence) this.hydratedReferences.set(value2, reference);
          return value2;
        })();
        cache.set(reference.blob, pending);
      }
      const value = await pending;
      const expected = snapshotReference(value, reference.blob);
      if (Object.keys(expected).some(
        (key) => expected[key] !== reference[key]
      ))
        throw new ChangelistEvidenceError();
      return value;
    };
    const { tracking, history, ...metadata } = ownership;
    return {
      ...metadata,
      ...tracking ? { tracking: await load(tracking) } : {},
      ...history ? {
        history: await Promise.all(
          history.map(async (entry) => ({
            snapshot: await load(entry.snapshot),
            lines: entry.lines
          }))
        )
      } : {}
    };
  }
  /** Replaces complete immutable snapshots with descriptors before any global clone or publication. */
  async compact(root, file, ownership, persistence = this.durable.get(root)) {
    const { tracking, history, ...metadata } = ownership;
    const save = (snapshot) => {
      const known = this.hydratedReferences.get(snapshot);
      return known ?? (persistence ? persistence.storeSnapshot(file, snapshot) : this.remember(root, file, snapshot));
    };
    return {
      ...metadata,
      ...tracking ? { tracking: await save(tracking) } : {},
      ...history ? {
        history: await Promise.all(
          history.map(async (entry) => ({
            snapshot: await save(entry.snapshot),
            lines: entry.lines
          }))
        )
      } : {}
    };
  }
  /** Compares an unproved migration seed one file at a time without retaining all durable payloads. */
  async matchesSeed(root, state, seed, persistence) {
    const { changes, ...metadata } = state;
    const { changes: original, ...legacy } = seed;
    if (!(0, import_node_util.isDeepStrictEqual)(
      { ...metadata, files: { ...metadata.files } },
      { ...legacy, files: { ...legacy.files } }
    ) || Object.keys(changes).length !== Object.keys(original).length)
      return false;
    for (const [file, ownership] of Object.entries(changes)) {
      if (!Object.hasOwn(original, file) || !(0, import_node_util.isDeepStrictEqual)(
        await this.hydrate(root, file, ownership, persistence),
        original[file]
      ))
        return false;
    }
    return true;
  }
  /** Whole-state hydration is restricted to connection and legacy workspace serialization. */
  async hydrateState(root, state, persistence = this.durable.get(root)) {
    const changes = /* @__PURE__ */ Object.create(null);
    for (const [file, ownership] of Object.entries(state.changes))
      changes[file] = await this.hydrate(root, file, ownership, persistence);
    return { ...state, changes };
  }
  /** Migration converts each file once without changing logical revisions, history order or owners. */
  async compactState(root, state, persistence) {
    const changes = /* @__PURE__ */ Object.create(null);
    for (const [file, ownership] of Object.entries(state.changes))
      changes[file] = await this.compact(root, file, ownership, persistence);
    return { ...state, changes };
  }
  notify(root, state) {
    for (const listener of this.listeners) {
      try {
        listener(root, structuredClone(state));
      } catch (error) {
        console.error("[IntelliGit] Changelist delivery failed:", error);
      }
    }
  }
};
function requireList(state, id) {
  const list = state.lists.find((entry) => entry.id === id);
  if (!list) throw new Error("The changelist no longer exists.");
  return list;
}
function remapOwners(ownership, from, to) {
  for (const lines of [
    ownership.lines,
    ...(ownership.history ?? []).map((entry) => entry.lines)
  ]) {
    for (const fingerprint of Object.keys(lines)) {
      if (lines[fingerprint] === from) lines[fingerprint] = to;
    }
  }
}
function parseState(value, version, inline) {
  if (!metadataRecord(value)) return void 0;
  const state = value;
  if (!validStateHeader(state)) return void 0;
  try {
    const ids = /* @__PURE__ */ new Set();
    for (const list of state.lists) {
      if (typeof list.id !== "string" || typeof list.name !== "string" || list.id !== DEFAULT_CHANGELIST_ID && !/^[a-f0-9-]{36}$/.test(list.id))
        return void 0;
      nameFor(list.name);
      if (!validListText(list.description, list.draft, version)) return void 0;
      if (ids.has(list.id)) return void 0;
      ids.add(list.id);
    }
    if (!ids.has(state.activeId)) return void 0;
    if (version === 1 && !ids.has(DEFAULT_CHANGELIST_ID)) return void 0;
    if (version === 2 && (typeof state.allDraft !== "string" || state.allDraft.length > MAX_DRAFT))
      return void 0;
    if (!validRedirects(state.removedScopes, ids)) return void 0;
    if (Object.keys(state.files).length > MAX_FILES) return void 0;
    for (const [file, id] of Object.entries(state.files)) {
      assertRepoRelativePath(file);
      if (!ids.has(id)) return void 0;
    }
    const changes = state.changes;
    for (const [file, ownership] of Object.entries(changes)) {
      assertRepoRelativePath(file);
      if (!validOwnership(ownership, ids, inline)) return void 0;
    }
    const parsed = structuredClone(state);
    if (version === 1) {
      parsed.lists = parsed.lists.map((list) => ({ ...list, description: "", draft: "" }));
      parsed.allDraft = "";
    }
    return parsed;
  } catch {
    return void 0;
  }
}
function metadataRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function validStateHeader(state) {
  return Number.isSafeInteger(state.revision) && state.revision >= 0 && Array.isArray(state.lists) && state.lists.length > 0 && state.lists.length <= MAX_LISTS && metadataRecord(state.files) !== void 0 && metadataRecord(state.changes) !== void 0;
}
function validOwnership(ownership, ids, inline) {
  if (!metadataRecord(ownership) || typeof ownership.contentId !== "string" || !metadataRecord(ownership.lines) || ownership.stale !== void 0 && typeof ownership.stale !== "boolean")
    return false;
  if (ownership.totalChanges !== void 0 && (!Number.isSafeInteger(ownership.totalChanges) || ownership.totalChanges < 0 || ownership.totalChanges > 1e5))
    return false;
  for (const [fingerprint, id] of Object.entries(ownership.lines)) {
    if (!/^[a-f0-9]{64}$/.test(fingerprint) || !ids.has(id)) return false;
  }
  return validCommitSelections(ownership, ids) && validRangeMetadata(ownership, ids, inline);
}
function validCommitSelections(ownership, ids) {
  if (ownership.selections === void 0) return true;
  if (!metadataRecord(ownership.selections)) return false;
  for (const [scope, selection] of Object.entries(ownership.selections)) {
    if (scope !== "all" && !ids.has(scope)) return false;
    if (!metadataRecord(selection) || typeof selection.contentId !== "string" || selection.reviewRequired !== void 0 && typeof selection.reviewRequired !== "boolean" || !Array.isArray(selection.lineIds) || selection.lineIds.length > 1e5 || selection.lineIds.some(
      (id) => typeof id !== "string" || !/^\d{1,5}:\d{1,6}$/.test(id)
    ) || !Number.isSafeInteger(selection.total) || selection.total < selection.lineIds.length || selection.total > 1e5)
      return false;
  }
  return true;
}
function descriptionFor(value) {
  if (value.length > MAX_DESCRIPTION || value.includes("\0"))
    throw new Error("A changelist description must contain at most 4000 characters.");
  return value;
}
function mergeScopeSelection(ownership, fallback, source, target) {
  const selections = ownership.selections;
  if (!selections) return;
  const incoming = selections[source];
  const existing = selections[target];
  const sourceOwns = fallback === source || Object.values(ownership.lines).includes(source);
  const targetOwns = fallback === target || Object.values(ownership.lines).includes(target);
  if (incoming && existing && incoming.contentId === existing.contentId && incoming.total === existing.total && !incoming.reviewRequired && !existing.reviewRequired && incoming.lineIds.length === existing.lineIds.length && incoming.lineIds.every((line) => existing.lineIds.includes(line))) {
    selections[target] = {
      ...existing,
      lineIds: [.../* @__PURE__ */ new Set([...existing.lineIds, ...incoming.lineIds])]
    };
  } else if (incoming || sourceOwns && existing) {
    const preserved = existing ?? incoming;
    selections[target] = {
      ...preserved,
      lineIds: [...preserved.lineIds],
      ...incoming && !targetOwns && !existing ? {} : { reviewRequired: true }
    };
  }
  delete selections[source];
}
function validListText(description, draft, version) {
  if (version === 1) return true;
  if (typeof description !== "string" || typeof draft !== "string" || draft.length > MAX_DRAFT)
    return false;
  descriptionFor(description);
  return true;
}
function validRedirects(value, ids) {
  if (value === void 0) return true;
  const entries = metadataRecord(value);
  return !!entries && Object.keys(entries).length <= 100 && Object.entries(entries).every(
    ([from, to]) => (from === DEFAULT_CHANGELIST_ID || /^[a-f0-9-]{36}$/.test(from)) && !ids.has(from) && typeof to === "string" && ids.has(to)
  );
}
function moveWholeFiles(state, id, paths) {
  if (paths.length > MAX_FILES) throw new Error("Too many changelist files.");
  for (const value of paths) {
    const file = assertRepoRelativePath(value);
    if (!Object.hasOwn(state.files, file)) throw new Error("The file list changed.");
    const ownership = state.changes[file];
    if (ownership && (Object.keys(ownership.lines).length || Object.keys(ownership.selections ?? {}).length))
      throw new Error("Move partial selections through their partial editor.");
    state.files[file] = id;
  }
}
function redirectRemovedScope(state, removed, target) {
  const redirects = Object.fromEntries(
    Object.entries(state.removedScopes ?? {}).slice(-99).map(([from, to]) => [from, to === removed ? target : to])
  );
  redirects[removed] = target;
  state.removedScopes = redirects;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ChangelistRevisionError,
  ChangelistStore
});
