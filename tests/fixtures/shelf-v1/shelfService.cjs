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

// <stdin>
var stdin_exports = {};
__export(stdin_exports, {
  GitExecutor: () => GitExecutor,
  RepositoryLock: () => RepositoryLock,
  RepositoryMutationCoordinator: () => RepositoryMutationCoordinator,
  RepositoryMutationGate: () => RepositoryMutationGate,
  ShelfService: () => ShelfService,
  ShelfStore: () => ShelfStore,
  resolveShelfPaths: () => resolveShelfPaths
});
module.exports = __toCommonJS(stdin_exports);

// baseline:src/services/shelfService.ts
var import_node_crypto15 = require("node:crypto");
var import_promises20 = require("node:fs/promises");
var import_node_os6 = require("node:os");
var import_node_path20 = __toESM(require("node:path"));

// baseline:src/git/operations.ts
var import_promises11 = require("node:fs/promises");
var import_node_os3 = require("node:os");
var import_node_crypto8 = require("node:crypto");
var import_node_path11 = __toESM(require("node:path"));

// baseline:src/git/emptyTree.ts
async function readEmptyTreeOid(executor, invalidOidError = (message) => new Error(message)) {
  const result = await executor.runBinary(["hash-object", "-t", "tree", "--stdin"], {
    input: Buffer.alloc(0),
    maxOutputBytes: 128
  });
  const treeId = result.stdout.toString("utf8").trim();
  if (!/^[a-f0-9]{40,64}$/i.test(treeId)) {
    throw invalidOidError("Git returned an invalid empty-tree ID.");
  }
  return treeId;
}

// baseline:src/git/partialChanges.ts
var import_promises4 = require("node:fs/promises");
var import_node_os2 = require("node:os");
var import_node_path4 = __toESM(require("node:path"));

// baseline:src/changes/selection.ts
function textLines(content) {
  return content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}
function changeIds(blocks) {
  return blocks.flatMap(
    (block) => block.lines.filter((line) => line.kind !== "context").map((line) => line.id)
  );
}
function validateSelection(blocks, ids) {
  const available = new Set(changeIds(blocks));
  if (ids.length > available.size || new Set(ids).size !== ids.length) {
    throw new Error("Invalid or duplicate change selection.");
  }
  for (const id of ids) if (!available.has(id)) throw new Error("The change selection is stale.");
  return new Set(ids);
}
function selectedContent(base, blocks, ids) {
  const selected = validateSelection(blocks, ids);
  const source = textLines(base);
  const output = [];
  let offset = 0;
  for (const block of blocks) {
    const start = block.oldCount === 0 ? block.oldStart : block.oldStart - 1;
    if (start < offset || start > source.length) throw new Error("Invalid diff block range.");
    output.push(...source.slice(offset, start));
    offset = start;
    for (const line of block.lines) {
      if (line.kind === "add") {
        if (selected.has(line.id)) output.push(line.text);
        continue;
      }
      if (source[offset] !== line.text)
        throw new Error("The diff no longer matches its base.");
      if (line.kind === "context" || !selected.has(line.id)) output.push(line.text);
      offset++;
    }
    if (offset !== start + block.oldCount) throw new Error("Invalid diff block length.");
  }
  output.push(...source.slice(offset));
  return output.join("");
}

// baseline:src/utils/concurrency.ts
async function mapWithConcurrency(items, limit, mapper) {
  if (items.length === 0) return [];
  const bound = Math.max(1, Math.min(Math.floor(limit), items.length));
  const results = new Array(items.length);
  let nextIndex = 0;
  const runWorker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: bound }, runWorker));
  return results;
}

// baseline:src/git/partialSnapshot.ts
var import_node_buffer = require("node:buffer");
var import_promises2 = require("node:fs/promises");
var import_node_os = require("node:os");
var import_node_path2 = __toESM(require("node:path"));

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

// baseline:src/shelf/recoveryPaths.ts
var import_promises = require("node:fs/promises");
var import_node_path = __toESM(require("node:path"));

// baseline:src/shelf/recoveryGit.ts
var import_node_crypto = require("node:crypto");
var RecoverySafetyError = class extends Error {
  /** Creates a safety refusal with a caller-safe explanation. */
  constructor(message) {
    super(message);
    this.name = "RecoverySafetyError";
  }
};
var GitExecutorRecoveryGit = class {
  /** Binds binary plumbing to the active repository without re-entering its gate. */
  constructor(executor) {
    this.executor = executor;
  }
  executor;
  emptyTree;
  /** Returns HEAD, with Git's quiet unborn-repository result represented as undefined. */
  async getHead() {
    const result = await this.executor.runBinary(["rev-parse", "--verify", "--quiet", "HEAD"], {
      expectedExitCodes: [0, 1]
    });
    return result.exitCode === 0 ? readOid(result.stdout, "HEAD") : void 0;
  }
  /** Hashes the raw index listing so flags excluded by write-tree still guard recovery. */
  async getIndexFingerprint() {
    const listing = await this.executor.runBinary(["ls-files", "--stage", "-v", "-z"]);
    return (0, import_node_crypto.createHash)("sha256").update(listing.stdout).digest("hex");
  }
  /** Hashes one raw index record, including flags, without coupling rollback to other paths. */
  async getIndexPathFingerprint(relativePath) {
    const listing = await this.executor.runBinary([
      "--literal-pathspecs",
      "ls-files",
      "--stage",
      "-v",
      "-z",
      "--",
      relativePath
    ]);
    return (0, import_node_crypto.createHash)("sha256").update(listing.stdout).digest("hex");
  }
  /** Computes the repository's object-format-specific empty tree ID once. */
  async emptyTreeOid() {
    this.emptyTree ??= readEmptyTreeOid(
      this.executor,
      () => new RecoverySafetyError("Git returned an invalid empty tree object ID.")
    );
    return this.emptyTree;
  }
  /** Reads the pinned tree entry with literal pathspec handling. */
  async getBaseEntry(baseOid, relativePath) {
    if (baseOid === await this.emptyTreeOid()) return void 0;
    return parseTreeEntry(
      (await this.executor.runBinary([
        "--literal-pathspecs",
        "ls-tree",
        "-z",
        baseOid,
        "--",
        relativePath
      ])).stdout
    );
  }
  /** Reads the one supported stage-zero index entry for a literal path. */
  async getIndexEntry(relativePath) {
    return parseIndexEntry(
      (await this.executor.runBinary([
        "--literal-pathspecs",
        "ls-files",
        "--stage",
        "-z",
        "--",
        relativePath
      ])).stdout
    );
  }
  /** Reads raw blob bytes for a base tree entry. */
  async readBlob(oid) {
    return (await this.executor.runBinary(["cat-file", "blob", assertOid(oid)])).stdout;
  }
  /** Updates one index entry via Git's own index.lock protocol. */
  async writeIndexEntry(relativePath, entry) {
    const record = entry ? `${assertMode(entry.mode)} ${assertOid(entry.oid)}	${relativePath}\0` : `0 ${"0".repeat((await this.emptyTreeOid()).length)}	${relativePath}\0`;
    await this.executor.runBinary(["update-index", "-z", "--index-info"], {
      input: Buffer.from(record)
    });
  }
};
function parseTreeEntry(bytes) {
  const records = splitNulRecords(bytes);
  if (records.length === 0) return void 0;
  if (records.length !== 1)
    throw new RecoverySafetyError("Expected one base tree entry per recovery path.");
  const match = /^([0-7]{6}) blob ([a-f0-9]{40,64})\t/.exec(records[0]);
  if (!match) throw new RecoverySafetyError("Base tree entry is not a regular blob.");
  return { mode: match[1], oid: match[2] };
}
function parseIndexEntry(bytes) {
  const records = splitNulRecords(bytes);
  if (records.length === 0) return void 0;
  if (records.length !== 1)
    throw new RecoverySafetyError("Unmerged index entries cannot enter shelf recovery.");
  const match = /^([0-7]{6}) ([a-f0-9]{40,64}) ([0-3])\t/.exec(records[0]);
  if (!match || match[3] !== "0") {
    throw new RecoverySafetyError("Unmerged index entries cannot enter shelf recovery.");
  }
  return { mode: match[1], oid: match[2] };
}
function splitNulRecords(bytes) {
  return bytes.toString("utf8").split("\0").filter((record) => record.length > 0);
}
function readOid(bytes, label) {
  const oid = bytes.toString("utf8").trim();
  if (!/^[a-f0-9]{40,64}$/.test(oid)) {
    throw new RecoverySafetyError(`Git returned an invalid ${label} object ID.`);
  }
  return oid;
}
function assertMode(value) {
  if (!/^[0-7]{6}$/.test(value)) throw new RecoverySafetyError("Invalid Git index mode.");
  return value;
}
function assertOid(value) {
  if (!/^[a-f0-9]{40,64}$/.test(value)) throw new RecoverySafetyError("Invalid Git object ID.");
  return value;
}

// baseline:src/shelf/recoveryPaths.ts
function resolveRepositoryPath(repositoryRoot, relativePath) {
  const safeRelativePath = assertRepositoryRelativePath(relativePath);
  const target = import_node_path.default.resolve(repositoryRoot, safeRelativePath);
  const relative = import_node_path.default.relative(repositoryRoot, target);
  if (relative === "" || relative === ".." || relative.startsWith(".." + import_node_path.default.sep) || import_node_path.default.isAbsolute(relative)) {
    throw new RecoverySafetyError("Recovery path escapes repository root.");
  }
  return target;
}
function resolveRecoveryPath(recoveryDirectory, relativePath) {
  const target = import_node_path.default.resolve(recoveryDirectory, assertRepositoryRelativePath(relativePath));
  const relative = import_node_path.default.relative(recoveryDirectory, target);
  if (relative === "" || relative === ".." || relative.startsWith(".." + import_node_path.default.sep) || import_node_path.default.isAbsolute(relative)) {
    throw new RecoverySafetyError("Recovery staging path escapes its transaction directory.");
  }
  return target;
}
function assertRepositoryRelativePath(value) {
  if (!value || import_node_path.default.isAbsolute(value)) {
    throw new RecoverySafetyError("Recovery path must be repository-relative.");
  }
  const normalized = import_node_path.default.normalize(value);
  if (normalized === "." || normalized === ".." || normalized.startsWith(".." + import_node_path.default.sep)) {
    throw new RecoverySafetyError("Recovery path escapes repository root.");
  }
  return normalized.split(import_node_path.default.sep).join("/");
}
async function assertContainedParent(repositoryRoot, target) {
  const [root, parent] = await Promise.all([
    (0, import_promises.realpath)(repositoryRoot),
    (0, import_promises.realpath)(import_node_path.default.dirname(target))
  ]);
  assertContained(root, parent);
}
async function assertContainedParentIfPresent(repositoryRoot, target) {
  try {
    await assertContainedParent(repositoryRoot, target);
  } catch (error) {
    if (!isNotFound(error)) throw error;
    await walkContainedParent(repositoryRoot, target, false);
  }
}
async function ensureContainedParent(repositoryRoot, target) {
  await walkContainedParent(repositoryRoot, target, true);
  await assertContainedParent(repositoryRoot, target);
}
async function walkContainedParent(repositoryRoot, target, createMissing) {
  const root = await (0, import_promises.realpath)(repositoryRoot);
  const rootLexical = import_node_path.default.resolve(repositoryRoot);
  const parentLexical = import_node_path.default.resolve(import_node_path.default.dirname(target));
  const relative = import_node_path.default.relative(rootLexical, parentLexical);
  if (relative === ".." || relative.startsWith(".." + import_node_path.default.sep) || import_node_path.default.isAbsolute(relative)) {
    throw new RecoverySafetyError("Recovery write escaped the repository root.");
  }
  if (relative === "") return;
  let current = root;
  for (const component of relative.split(import_node_path.default.sep)) {
    const candidate = import_node_path.default.join(current, component);
    let details;
    try {
      details = await (0, import_promises.lstat)(candidate);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      if (!createMissing) return;
      await (0, import_promises.mkdir)(candidate, { mode: 448 });
      details = await (0, import_promises.lstat)(candidate);
    }
    if (!details.isDirectory() || details.isSymbolicLink()) {
      throw new RecoverySafetyError("Recovery write escaped the repository root.");
    }
    current = await (0, import_promises.realpath)(candidate);
    assertContained(root, current);
  }
}
function assertContained(root, candidate) {
  const relative = import_node_path.default.relative(root, candidate);
  if (relative === ".." || relative.startsWith(".." + import_node_path.default.sep) || import_node_path.default.isAbsolute(relative)) {
    throw new RecoverySafetyError("Recovery write escaped the repository root.");
  }
}
function isNotFound(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

// baseline:src/changes/parseDiff.ts
var import_node_crypto2 = require("node:crypto");
var LINE_KINDS = {
  "+": "add",
  "-": "remove",
  " ": "context"
};
function changeFingerprint(content) {
  return (0, import_node_crypto2.createHash)("sha256").update(content).digest("hex");
}
function parseChangeDiff(diff, base, target) {
  const blocks = [];
  let current;
  let oldLine = 0;
  let newLine = 0;
  for (const raw of diff.split("\n")) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(raw);
    if (header) {
      current = {
        id: String(blocks.length),
        fingerprint: "",
        oldStart: Number(header[1]),
        oldCount: Number(header[2] ?? 1),
        newStart: Number(header[3]),
        newCount: Number(header[4] ?? 1),
        lines: []
      };
      oldLine = current.oldStart;
      newLine = current.newStart;
      blocks.push(current);
      continue;
    }
    if (!current || raw === "") continue;
    if (raw === "\\ No newline at end of file") {
      const previous = current.lines.at(-1);
      if (!previous || !previous.text.endsWith("\n"))
        throw new Error("Invalid newline marker.");
      previous.text = previous.text.slice(0, -1);
      continue;
    }
    const kind = LINE_KINDS[raw[0]];
    if (!kind) throw new Error("Unsupported Git diff content.");
    const line = {
      id: `${current.id}:${current.lines.length}`,
      fingerprint: "",
      kind,
      text: raw.slice(1) + "\n",
      oldLine: kind === "add" ? null : oldLine++,
      newLine: kind === "remove" ? null : newLine++
    };
    current.lines.push(line);
  }
  for (const block of blocks) finalizeBlock(block);
  if (selectedContent(base, blocks, changeIds(blocks)) !== target) {
    throw new Error("Git diff does not reconstruct the captured file.");
  }
  return blocks;
}
function finalizeBlock(block) {
  const additions = block.lines.filter((line) => line.kind !== "remove").length;
  const removals = block.lines.filter((line) => line.kind !== "add").length;
  if (additions !== block.newCount || removals !== block.oldCount) {
    throw new Error("Invalid Git diff counts.");
  }
  block.fingerprint = changeFingerprint(
    JSON.stringify([
      block.oldStart,
      block.newStart,
      block.lines.map((line) => [line.kind, line.text])
    ])
  );
  for (const line of block.lines) {
    line.fingerprint = changeFingerprint(
      JSON.stringify([block.fingerprint, line.id.split(":")[1], line.kind, line.text])
    );
  }
}

// baseline:src/git/partialSnapshot.ts
var MAX_PARTIAL_TEXT_BYTES = 2 * 1024 * 1024;
var MAX_DIFF_BYTES = 8 * 1024 * 1024;
var MARKERS = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"];
var PartialChangesUnsupportedError = class extends Error {
};
async function assertPartialOperationIdle(gitDir) {
  const present = await Promise.all(
    MARKERS.map(async (marker) => {
      try {
        await (0, import_promises2.lstat)(import_node_path2.default.join(gitDir, marker));
        return true;
      } catch (error) {
        if (isMissing(error)) return false;
        throw error;
      }
    })
  );
  if (present.some(Boolean))
    throw new Error("Partial changes are unavailable during a Git operation.");
}
async function readPartialWorktree(root, file) {
  const target = import_node_path2.default.join(root, assertRepoRelativePath(file));
  await assertContainedParent(root, target);
  const before = await (0, import_promises2.lstat)(target);
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_PARTIAL_TEXT_BYTES) {
    throw new PartialChangesUnsupportedError(
      "Partial changes require a regular text file of at most 2 MiB."
    );
  }
  const bytes = await (0, import_promises2.readFile)(target);
  const after = await (0, import_promises2.lstat)(target);
  if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || !after.isFile() || after.isSymbolicLink()) {
    throw new Error("The file changed while reading. Reopen its changes.");
  }
  assertText(bytes);
  return bytes;
}
async function readPartialIndex(snapshot) {
  if (import_node_path2.default.resolve(snapshot.indexPath) !== import_node_path2.default.join(snapshot.gitDir, "index")) {
    throw new Error("Custom Git indexes cannot use partial changes.");
  }
  const stats = await (0, import_promises2.lstat)(snapshot.indexPath);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 64 * 1024 * 1024) {
    throw new Error("The Git index cannot be safely read.");
  }
  return (0, import_promises2.readFile)(snapshot.indexPath);
}
async function readPartialSnapshot(executor, requestedRoot, filePath, side) {
  const file = assertRepoRelativePath(filePath);
  const root = await (0, import_promises2.realpath)(requestedRoot);
  const actualRoot = await (0, import_promises2.realpath)(
    (await executor.run(["rev-parse", "--show-toplevel"])).trim()
  );
  if (actualRoot !== root) throw new Error("The repository changed.");
  const gitDir = await (0, import_promises2.realpath)((await executor.run(["rev-parse", "--absolute-git-dir"])).trim());
  const commonDir = await (0, import_promises2.realpath)(
    (await executor.run(["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim()
  );
  await assertPartialOperationIdle(gitDir);
  const head = (await executor.run(["rev-parse", "--verify", "HEAD"])).trim();
  const ref = await readPartialRef(executor);
  const indexPath = import_node_path2.default.resolve(
    root,
    (await executor.run(["rev-parse", "--git-path", "index"])).trim()
  );
  const indexHash = changeFingerprint(await readPartialIndex({ gitDir, indexPath }));
  const index = await executor.run([
    "--literal-pathspecs",
    "ls-files",
    "--stage",
    "-z",
    "--",
    file
  ]);
  const entry = singleBlobEntry(index, file);
  const flags = await executor.run(["--literal-pathspecs", "ls-files", "-v", "-z", "--", file]);
  if (flags !== `H ${file}\0`)
    throw new PartialChangesUnsupportedError(
      "Sparse and assume-unchanged files require whole-file handling."
    );
  const tree = await executor.run(["--literal-pathspecs", "ls-tree", "-z", head, "--", file]);
  const original = /^(100644|100755) blob ([a-f0-9]{40,64})\t([^\0]+)\0$/.exec(tree);
  if (!original || original[3] !== file || original[1] !== entry.mode) {
    throw new PartialChangesUnsupportedError(
      "Added, deleted, renamed and mode-changing files require whole-file handling."
    );
  }
  const base = await readPartialBlob(executor, original[2]);
  const indexed = await readPartialBlob(executor, entry.oid);
  const raw = await readPartialWorktree(root, file);
  const attributes = await readAttributes(executor, file);
  const working = await canonicalWorktree(executor, file, raw);
  const target = side === "working" ? working : indexed;
  const blocks = await computeBlocks(executor, base, target);
  const contentId = changeFingerprint(JSON.stringify([base, target, blocks]));
  const worktreeHash = changeFingerprint(raw);
  const id = changeFingerprint(
    JSON.stringify([
      root,
      head,
      ref,
      indexHash,
      file,
      side,
      worktreeHash,
      attributes,
      working,
      contentId
    ])
  );
  const snapshot = {
    root,
    head,
    ref,
    gitDir,
    commonDir,
    indexPath,
    indexHash,
    worktreeHash,
    attributes,
    mode: entry.mode,
    indexed,
    working,
    contentId,
    view: { snapshotId: id, path: file, side, base, blocks }
  };
  await assertPartialSnapshotCurrent(executor, snapshot);
  return snapshot;
}
async function assertPartialSnapshotCurrent(executor, snapshot, verifyRepository = true) {
  await assertPartialOperationIdle(snapshot.gitDir);
  const [head, ref, index, raw, attributes] = await Promise.all([
    verifyRepository ? executor.run(["rev-parse", "--verify", "HEAD"]) : Promise.resolve(snapshot.head),
    verifyRepository ? readPartialRef(executor) : Promise.resolve(snapshot.ref),
    verifyRepository ? readPartialIndex(snapshot) : Promise.resolve(void 0),
    readPartialWorktree(snapshot.root, snapshot.view.path),
    readAttributes(executor, snapshot.view.path)
  ]);
  if (head.trim() !== snapshot.head || ref !== snapshot.ref || index !== void 0 && changeFingerprint(index) !== snapshot.indexHash || changeFingerprint(raw) !== snapshot.worktreeHash || attributes !== snapshot.attributes || await canonicalWorktree(executor, snapshot.view.path, raw) !== snapshot.working) {
    throw new Error(
      "The file, index or branch changed. Your selection is retained; reopen its changes."
    );
  }
  if (!verifyRepository) return;
  const root = await (0, import_promises2.realpath)((await executor.run(["rev-parse", "--show-toplevel"])).trim());
  const gitDir = await (0, import_promises2.realpath)((await executor.run(["rev-parse", "--absolute-git-dir"])).trim());
  const indexPath = import_node_path2.default.resolve(
    root,
    (await executor.run(["rev-parse", "--git-path", "index"])).trim()
  );
  if (root !== snapshot.root || gitDir !== snapshot.gitDir || indexPath !== snapshot.indexPath) {
    throw new Error("The repository changed.");
  }
}
async function readPartialRef(executor) {
  const result = await executor.runBinary(["symbolic-ref", "--quiet", "HEAD"], {
    expectedExitCodes: [0, 1]
  });
  return result.exitCode === 0 ? result.stdout.toString("utf8").trim() : "HEAD";
}
async function readPartialBlob(executor, oid) {
  const result = await executor.runBinary(["cat-file", "blob", oid], {
    maxOutputBytes: MAX_PARTIAL_TEXT_BYTES,
    signal: AbortSignal.timeout(1e4)
  });
  if (result.truncated)
    throw new PartialChangesUnsupportedError("The file exceeds the partial-change text limit.");
  assertText(result.stdout);
  return result.stdout.toString("utf8");
}
function assertText(bytes) {
  if (bytes.length > MAX_PARTIAL_TEXT_BYTES || !(0, import_node_buffer.isUtf8)(bytes) || bytes.includes(0)) {
    throw new PartialChangesUnsupportedError(
      "Binary, non-UTF-8 and oversized files require whole-file handling."
    );
  }
  let lines = 0;
  let width = 0;
  for (const byte of bytes) {
    if (byte === 10) {
      lines++;
      width = 0;
    } else width++;
    if (lines > 1e5 || width > 16384) {
      throw new PartialChangesUnsupportedError(
        "Very long lines and large line counts require whole-file handling."
      );
    }
  }
}
function singleBlobEntry(index, file) {
  const match = /^(100644|100755) ([a-f0-9]{40,64}) 0\t([^\0]+)\0$/.exec(index);
  if (!match || match[3] !== file || /^0+$/.test(match[2])) {
    throw new PartialChangesUnsupportedError(
      "Conflicts and special index entries require whole-file handling."
    );
  }
  return { mode: match[1], oid: match[2] };
}
async function readAttributes(executor, file) {
  const output = await executor.run([
    "--literal-pathspecs",
    "check-attr",
    "-z",
    "filter",
    "working-tree-encoding",
    "--",
    file
  ]);
  const values = output.split("\0");
  for (let i = 0; i + 2 < values.length; i += 3) {
    if (values[i] !== file || !["unspecified", "unset"].includes(values[i + 2])) {
      throw new PartialChangesUnsupportedError(
        "Custom filters and working-tree encodings require whole-file handling."
      );
    }
  }
  return output;
}
async function canonicalWorktree(executor, file, raw) {
  const hash = async (args, bytes) => (await executor.runBinary(args, { input: bytes })).stdout.toString("utf8").trim();
  const clean = await hash(["hash-object", `--path=${file}`, "--stdin"], raw);
  if (clean === await hash(["hash-object", "--stdin"], raw)) return raw.toString("utf8");
  const normalized = Buffer.from(raw.toString("utf8").replace(/\r\n/g, "\n"));
  if (clean !== await hash(["hash-object", "--stdin"], normalized)) {
    throw new PartialChangesUnsupportedError(
      "Unsupported clean conversion. Use whole-file handling."
    );
  }
  return normalized.toString("utf8");
}
async function computeBlocks(executor, base, target) {
  if (base === target) return [];
  const directory = await (0, import_promises2.mkdtemp)(import_node_path2.default.join((0, import_node_os.tmpdir)(), "intelligit-change-diff-"));
  try {
    const before = import_node_path2.default.join(directory, "base");
    const after = import_node_path2.default.join(directory, "target");
    await (0, import_promises2.writeFile)(before, base, { mode: 384 });
    await (0, import_promises2.writeFile)(after, target, { mode: 384 });
    const result = await executor.runBinary(
      [
        "-c",
        "diff.suppressBlankEmpty=false",
        "diff",
        "--no-index",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--unified=3",
        "--",
        before,
        after
      ],
      {
        expectedExitCodes: [0, 1],
        maxOutputBytes: MAX_DIFF_BYTES,
        signal: AbortSignal.timeout(1e4)
      }
    );
    if (result.truncated)
      throw new PartialChangesUnsupportedError("The diff exceeds the supported size.");
    return parseChangeDiff(result.stdout.toString("utf8"), base, target);
  } finally {
    await (0, import_promises2.rm)(directory, { recursive: true, force: true });
  }
}
function isMissing(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

// baseline:src/git/partialIndexTransaction.ts
var import_node_crypto3 = require("node:crypto");
var import_promises3 = require("node:fs/promises");
var import_node_path3 = __toESM(require("node:path"));
var RecoveryRefusal = class extends Error {
};
var UnreadableJournal = class extends Error {
};
var PartialIndexPublicationError = class extends Error {
};
async function publishPartialIndex(executor, snapshot, preparedIndex, newHead, recheck, faults = {}) {
  const directory = await createTransactionDirectory(snapshot.gitDir);
  const bytes = await (0, import_promises3.readFile)(preparedIndex);
  await durableFile(import_node_path3.default.join(directory, "index"), bytes);
  const journal = {
    schemaVersion: 1,
    root: snapshot.root,
    gitDir: snapshot.gitDir,
    indexPath: snapshot.indexPath,
    oldHead: snapshot.head,
    ref: snapshot.ref,
    indexHash: snapshot.indexHash,
    preparedHash: changeFingerprint(bytes),
    newHead,
    pid: process.pid
  };
  await writeJournal(directory, journal);
  const lockPath = `${snapshot.indexPath}.lock`;
  let lock;
  let lockAcquired = false;
  let published = false;
  let refUpdateStarted = false;
  let completed = false;
  let durable = false;
  try {
    lock = await (0, import_promises3.open)(lockPath, "wx", 384);
    lockAcquired = true;
    const stats = await lock.stat({ bigint: true });
    journal.lock = { ino: String(stats.ino), dev: String(stats.dev) };
    await writeJournal(directory, journal);
    await recheck();
    await faults.afterLock?.();
    await lock.writeFile(bytes);
    await lock.sync();
    await lock.close();
    lock = void 0;
    await recheck();
    await assertPreparedLock(lockPath, journal);
    if (newHead) {
      refUpdateStarted = true;
      await executor.runBinary([
        "update-ref",
        "-m",
        "commit: IntelliGit selected changes",
        snapshot.ref,
        newHead,
        snapshot.head
      ]);
      published = true;
      await faults.afterPublish?.();
      if ((await executor.run(["rev-parse", "--verify", "HEAD"])).trim() !== newHead || await readPartialRef(executor) !== snapshot.ref) {
        throw new Error("The branch changed after publishing the selected commit.");
      }
    }
    await assertPreparedLock(lockPath, journal);
    await (0, import_promises3.rename)(lockPath, snapshot.indexPath);
    completed = true;
    await syncDirectory(snapshot.gitDir);
    durable = true;
  } catch (error) {
    if (newHead) {
      published = published || await refPointsToCommit(executor, snapshot.ref, newHead);
    }
    if (published && !completed) {
      throw new PartialIndexPublicationError(
        "The commit succeeded, but its index reconciliation needs recovery. Do not retry the commit.",
        { cause: error }
      );
    }
    if (completed) {
      throw new PartialIndexPublicationError(
        newHead ? "The commit succeeded, but its index durability needs recovery. Do not retry the commit." : "The selected changes were staged, but index durability needs recovery.",
        { cause: error }
      );
    }
    if (refUpdateStarted) {
      throw new PartialIndexPublicationError(
        "The selected commit publication could not be confirmed. Review Git history and recovery records before retrying.",
        { cause: error }
      );
    }
    throw error;
  } finally {
    await lock?.close();
    if (durable || !refUpdateStarted && !published && !completed) {
      await cleanupPartialRecord(directory, lockPath, journal, {
        durable,
        completed,
        lockAcquired
      });
    }
  }
}
async function cleanupPartialRecord(directory, lock, journal, progress2) {
  try {
    if (progress2.durable) await removePreparedIndexLock(lock, journal);
    else if (progress2.lockAcquired && journal.lock) await releaseUnpublishedLock(lock, journal);
    else if (progress2.lockAcquired) return;
    await (0, import_promises3.rm)(directory, { recursive: true, force: true });
  } catch (error) {
    if (!progress2.completed) throw error;
    console.error("[IntelliGit] Partial-index cleanup retained its recovery journal:", error);
  }
}
async function refPointsToCommit(executor, ref, commit) {
  try {
    const current = await executor.runBinary(["rev-parse", "--verify", ref], {
      expectedExitCodes: [0, 1]
    });
    return current.stdout.toString("utf8").trim() === commit;
  } catch {
    return false;
  }
}
async function preparePartialCommit(executor, snapshot, selectedIndex, directory, message, expectedTree) {
  const isolatedGitDir = import_node_path3.default.join(directory, "git");
  await (0, import_promises3.mkdir)(import_node_path3.default.join(isolatedGitDir, "objects", "info"), { recursive: true, mode: 448 });
  await (0, import_promises3.mkdir)(import_node_path3.default.join(isolatedGitDir, "refs"), { mode: 448 });
  if (/[\r\n]/.test(snapshot.commonDir))
    throw new Error("This Git directory requires the whole-file commit workflow.");
  await (0, import_promises3.writeFile)(
    import_node_path3.default.join(isolatedGitDir, "objects", "info", "alternates"),
    `${import_node_path3.default.join(snapshot.commonDir, "objects")}
`,
    { mode: 384 }
  );
  await (0, import_promises3.writeFile)(
    import_node_path3.default.join(isolatedGitDir, "HEAD"),
    snapshot.ref === "HEAD" ? `${snapshot.head}
` : `ref: ${snapshot.ref}
`,
    { mode: 384 }
  );
  const references = await executor.runBinary(
    ["for-each-ref", "--format=%(objectname) %(refname)"],
    {
      maxOutputBytes: 8 * 1024 * 1024
    }
  );
  if (references.truncated)
    throw new Error("Too many references for an isolated selected commit.");
  await (0, import_promises3.writeFile)(import_node_path3.default.join(isolatedGitDir, "packed-refs"), references.stdout, { mode: 384 });
  const config = import_node_path3.default.join(isolatedGitDir, "config");
  await executor.runBinary([
    "config",
    "--file",
    config,
    "include.path",
    import_node_path3.default.join(snapshot.commonDir, "config")
  ]);
  const worktreeConfig = import_node_path3.default.join(snapshot.gitDir, "config.worktree");
  try {
    if ((await (0, import_promises3.lstat)(worktreeConfig)).isFile()) {
      await executor.runBinary([
        "config",
        "--file",
        config,
        "--add",
        "include.path",
        worktreeConfig
      ]);
    }
  } catch (error) {
    if (!isMissing2(error)) throw error;
  }
  const options = await isolatedCommitOptions(executor, snapshot);
  const env = {
    GIT_DIR: isolatedGitDir,
    GIT_COMMON_DIR: isolatedGitDir,
    GIT_WORK_TREE: snapshot.root,
    GIT_INDEX_FILE: selectedIndex
  };
  await executor.runBinary([...options, "commit", "-m", message], {
    env,
    maxOutputBytes: 1024 * 1024
  });
  const result = await executor.runBinary([...options, "rev-parse", "--verify", "HEAD"], { env });
  const commit = result.stdout.toString("utf8").trim();
  const identity = await executor.runBinary([...options, "cat-file", "-p", commit], {
    env,
    maxOutputBytes: 1024 * 1024
  });
  const headers = identity.stdout.toString("utf8").split("\n\n")[0].split("\n");
  const tree = headers.find((line) => line.startsWith("tree "))?.slice(5);
  const parents = headers.filter((line) => line.startsWith("parent ")).map((line) => line.slice(7));
  if (identity.truncated || tree !== expectedTree || parents.length !== 1 || parents[0] !== snapshot.head) {
    throw new Error(
      "A Git hook changed the selected commit. No commit was published; review its changes."
    );
  }
  const imported = await executor.runBinary(["hash-object", "-t", "commit", "-w", "--stdin"], {
    input: identity.stdout
  });
  if (imported.stdout.toString("utf8").trim() !== commit)
    throw new Error("Selected commit identity changed during import.");
  return commit;
}
async function isolatedCommitOptions(executor, snapshot) {
  const captured = await executor.runBinary(
    [
      "config",
      "--null",
      "--get-regexp",
      "^(user\\.(name|email|signingkey)|commit\\.(gpgsign|cleanup)|gpg\\..*)$"
    ],
    { expectedExitCodes: [0, 1], maxOutputBytes: 64 * 1024 }
  );
  if (captured.truncated) throw new Error("Commit configuration exceeds its supported size.");
  const options = ["-c", "maintenance.auto=false"];
  for (const entry of captured.stdout.toString("utf8").split("\0").filter(Boolean)) {
    const separator = entry.indexOf("\n");
    if (separator < 0) throw new Error("Invalid commit configuration.");
    options.push("-c", `${entry.slice(0, separator)}=${entry.slice(separator + 1)}`);
  }
  const hooks = await executor.runBinary(["config", "--path", "--get", "core.hooksPath"], {
    expectedExitCodes: [0, 1]
  });
  const hooksPath = hooks.exitCode === 0 ? import_node_path3.default.resolve(snapshot.root, hooks.stdout.toString("utf8").trim()) : import_node_path3.default.join(snapshot.commonDir, "hooks");
  options.push("-c", `core.hooksPath=${hooksPath}`);
  const refStorage = await executor.runBinary(["config", "--get", "extensions.refStorage"], {
    expectedExitCodes: [0, 1]
  });
  if (refStorage.exitCode === 0) options.push("-c", "extensions.refStorage=files");
  return options;
}
async function recoverPartialIndexes(executor, root, gitDir, faults = {}) {
  const parent = import_node_path3.default.join(gitDir, "intelligit", "partial-index");
  const names = await recoveryNames(parent);
  const issues = [];
  let changed = false;
  for (const name of names) {
    const directory = import_node_path3.default.join(parent, name);
    await assertContainedParent(gitDir, import_node_path3.default.join(directory, "journal.json"));
    let record;
    try {
      record = await readJournal(directory, root, gitDir);
    } catch (error) {
      if (!(error instanceof UnreadableJournal)) throw error;
      issues.push({
        id: name,
        kind: "unreadable",
        location: "pending",
        reason: "The partial-index journal is unreadable. No index lock was removed."
      });
      continue;
    }
    if (record.pid !== process.pid && isAlive(record.pid)) {
      issues.push({
        id: name,
        kind: "active",
        location: "pending",
        reason: `Another process may own this partial-index recovery (PID ${record.pid}).`,
        commit: record.newHead
      });
      continue;
    }
    try {
      changed = await recoverOne(executor, directory, record, faults) || changed;
    } catch (error) {
      if (!(error instanceof RecoveryRefusal)) throw error;
      if (!await quarantineRecovery(directory, record, error.message)) {
        issues.push({
          id: name,
          kind: "blocked",
          location: "pending",
          reason: "Review quarantined partial-index records before recovering more.",
          commit: record.newHead
        });
      }
    }
  }
  const quarantine = import_node_path3.default.join(gitDir, "intelligit", "partial-index-quarantine");
  for (const id of await recoveryNames(quarantine)) {
    const directory = import_node_path3.default.join(quarantine, id);
    await assertContainedParent(gitDir, import_node_path3.default.join(directory, "journal.json"));
    let record;
    try {
      record = await readJournal(directory, root, gitDir);
    } catch (error) {
      if (!(error instanceof UnreadableJournal)) throw error;
      issues.push({
        id,
        kind: "unreadable",
        location: "quarantined",
        reason: "The quarantined partial-index journal is unreadable."
      });
      continue;
    }
    issues.push({
      id,
      kind: "quarantined",
      reason: record.refusal ?? "Partial-index recovery needs review.",
      commit: record.newHead
    });
  }
  return { changed, issues };
}
async function discardPartialRecovery(root, gitDir, id, location = "quarantined") {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid recovery record.");
  const parent = import_node_path3.default.join(
    gitDir,
    "intelligit",
    location === "pending" ? "partial-index" : "partial-index-quarantine"
  );
  if (!(await recoveryNames(parent)).includes(id))
    throw new Error("The recovery record changed.");
  const directory = import_node_path3.default.join(parent, id);
  await assertContainedParent(gitDir, import_node_path3.default.join(directory, "journal.json"));
  await assertRegularRecord(directory);
  if (location === "pending") {
    try {
      await readJournal(directory, root, gitDir);
      throw new Error("The recovery record is now readable and cannot be discarded here.");
    } catch (error) {
      if (!(error instanceof UnreadableJournal)) throw error;
    }
  }
  await (0, import_promises3.rm)(directory, { recursive: true });
  await syncDirectory(parent);
}
async function recoverOne(executor, directory, journal, faults) {
  await assertPartialOperationIdle(journal.gitDir);
  const head = (await executor.run(["rev-parse", "--verify", "HEAD"])).trim();
  const ref = await readPartialRef(executor);
  const currentHash = changeFingerprint(await readPartialIndex(journal));
  if (ref !== journal.ref)
    throw new RecoveryRefusal("The branch changed; partial-index recovery requires review.");
  if (head === (journal.newHead ?? journal.oldHead) && currentHash === journal.preparedHash) {
    await removePreparedIndexLock(`${journal.indexPath}.lock`, journal);
    await syncDirectory(journal.gitDir);
    await (0, import_promises3.rm)(directory, { recursive: true, force: true });
    return false;
  }
  if (head === journal.oldHead && currentHash === journal.indexHash) {
    await releaseUnpublishedLock(`${journal.indexPath}.lock`, journal);
    await (0, import_promises3.rm)(directory, { recursive: true, force: true });
    return false;
  }
  if (!journal.newHead || head !== journal.newHead || currentHash !== journal.indexHash) {
    throw new RecoveryRefusal(
      "The index or HEAD changed; partial-index recovery will not overwrite it."
    );
  }
  const bytes = await readPartialIndex({
    gitDir: directory,
    indexPath: import_node_path3.default.join(directory, "index")
  });
  if (changeFingerprint(bytes) !== journal.preparedHash)
    throw new RecoveryRefusal("The recovery index is corrupt.");
  const lockPath = `${journal.indexPath}.lock`;
  let lock;
  try {
    try {
      lock = await (0, import_promises3.open)(lockPath, "wx", 384);
      const stats = await lock.stat({ bigint: true });
      journal.lock = { ino: String(stats.ino), dev: String(stats.dev) };
      await writeJournal(directory, journal);
      await lock.writeFile(bytes);
      await lock.sync();
    } catch (error) {
      if (!isExists(error)) throw error;
      await assertRecoveryLock(lockPath, journal);
    }
    await lock?.close();
    lock = void 0;
    if ((await executor.run(["rev-parse", "--verify", "HEAD"])).trim() !== head || await readPartialRef(executor) !== ref || changeFingerprint(await readPartialIndex(journal)) !== currentHash) {
      throw new RecoveryRefusal("The repository changed during partial-index recovery.");
    }
    await faults.beforeRecoveryPublish?.();
    await assertRecoveryLock(lockPath, journal);
    await (0, import_promises3.rename)(lockPath, journal.indexPath);
    await syncDirectory(journal.gitDir);
    await (0, import_promises3.rm)(directory, { recursive: true, force: true });
    return true;
  } finally {
    await lock?.close();
  }
}
async function releaseUnpublishedLock(lock, journal) {
  try {
    const stats = await (0, import_promises3.lstat)(lock);
    if (!await ownsIndexLock(lock, journal) || stats.size > 64 * 1024 * 1024)
      throw new RecoveryRefusal(
        "The unpublished transaction lock ownership changed. The foreign lock is retained."
      );
    const bytes = await (0, import_promises3.readFile)(lock);
    if (bytes.length !== 0 && changeFingerprint(bytes) !== journal.preparedHash || !await ownsIndexLock(lock, journal))
      throw new RecoveryRefusal(
        "The unpublished transaction lock ownership changed. The foreign lock is retained."
      );
    await (0, import_promises3.rm)(lock);
    await syncDirectory(journal.gitDir);
  } catch (error) {
    if (!isMissing2(error)) throw error;
  }
}
async function recoveryNames(parent) {
  try {
    const namespace = await (0, import_promises3.lstat)(import_node_path3.default.dirname(parent));
    if (!namespace.isDirectory() || namespace.isSymbolicLink())
      throw new Error("Partial-index recovery requires a regular namespace.");
    const stats = await (0, import_promises3.lstat)(parent);
    if (!stats.isDirectory() || stats.isSymbolicLink())
      throw new Error("Partial-index recovery requires a regular directory.");
    const names = await (0, import_promises3.readdir)(parent);
    if (names.length > 32) throw new Error("Too many partial-index recovery records.");
    if (names.some((name) => !/^[a-f0-9-]{36}$/.test(name)))
      throw new Error("Unexpected partial-index recovery entry.");
    return names.sort();
  } catch (error) {
    if (isMissing2(error)) return [];
    throw error;
  }
}
async function quarantineRecovery(directory, journal, reason) {
  const parent = await createRecoveryParent(journal.gitDir, "partial-index-quarantine");
  journal.refusal = reason;
  await writeJournal(directory, journal);
  await removePreparedIndexLock(`${journal.indexPath}.lock`, journal);
  if ((await recoveryNames(parent)).length >= 32) return false;
  await (0, import_promises3.rename)(directory, import_node_path3.default.join(parent, (0, import_node_crypto3.randomUUID)()));
  await syncDirectory(import_node_path3.default.dirname(directory));
  await syncDirectory(parent);
  return true;
}
async function removePreparedIndexLock(lock, journal) {
  if (!await ownsIndexLock(lock, journal)) return;
  const stats = await (0, import_promises3.lstat)(lock);
  if (stats.size > 64 * 1024 * 1024) return;
  const bytes = await (0, import_promises3.readFile)(lock);
  if (changeFingerprint(bytes) === journal.preparedHash && await ownsIndexLock(lock, journal)) {
    await (0, import_promises3.rm)(lock);
    await syncDirectory(journal.gitDir);
  }
}
async function assertRecoveryLock(lock, journal) {
  try {
    await assertPreparedLock(lock, journal);
  } catch (error) {
    throw new RecoveryRefusal(
      "Index-lock ownership or content changed during recovery. The foreign lock is retained.",
      { cause: error }
    );
  }
}
async function createRecoveryParent(gitDir, kind) {
  let parent = gitDir;
  for (const name of ["intelligit", kind]) {
    const next = import_node_path3.default.join(parent, name);
    await assertContainedParent(gitDir, next);
    try {
      await (0, import_promises3.mkdir)(next, { mode: 448 });
    } catch (error) {
      if (!isExists(error)) throw error;
    }
    const stats = await (0, import_promises3.lstat)(next);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error("Partial-index recovery requires owned regular directories.");
    }
    parent = next;
    await syncDirectory(import_node_path3.default.dirname(next));
  }
  return parent;
}
async function createTransactionDirectory(gitDir) {
  if ((await recoveryNames(import_node_path3.default.join(gitDir, "intelligit", "partial-index-quarantine"))).length >= 32) {
    throw new Error("Review quarantined partial-index records before committing more.");
  }
  const parent = await createRecoveryParent(gitDir, "partial-index");
  if ((await recoveryNames(parent)).length >= 32)
    throw new Error("Review partial-index recovery records before committing more.");
  const directory = import_node_path3.default.join(parent, (0, import_node_crypto3.randomUUID)());
  await assertContainedParent(gitDir, directory);
  await (0, import_promises3.mkdir)(directory, { mode: 448 });
  await syncDirectory(parent);
  return directory;
}
async function writeJournal(directory, journal) {
  const temporary = import_node_path3.default.join(directory, `${(0, import_node_crypto3.randomUUID)()}.json`);
  await durableFile(temporary, Buffer.from(JSON.stringify(journal)));
  await (0, import_promises3.rename)(temporary, import_node_path3.default.join(directory, "journal.json"));
  await syncDirectory(directory);
}
async function durableFile(file, bytes) {
  const handle = await (0, import_promises3.open)(file, "wx", 384);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function assertRegularRecord(directory) {
  const directoryStats = await (0, import_promises3.lstat)(directory);
  if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink())
    throw new Error("Invalid partial-index journal directory.");
}
async function readJournal(directory, root, gitDir) {
  await assertRegularRecord(directory);
  try {
    return await parseJournal(directory, root, gitDir);
  } catch (error) {
    throw new UnreadableJournal("The partial-index journal is missing or invalid.", {
      cause: error
    });
  }
}
async function parseJournal(directory, root, gitDir) {
  const file = import_node_path3.default.join(directory, "journal.json");
  const stats = await (0, import_promises3.lstat)(file);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 16384) {
    throw new Error("Invalid partial-index journal.");
  }
  const journal = JSON.parse(await (0, import_promises3.readFile)(file, "utf8"));
  if (journal.schemaVersion !== 1 || journal.root !== root || journal.gitDir !== gitDir || journal.indexPath !== import_node_path3.default.join(gitDir, "index") || !/^[a-f0-9]{40,64}$/.test(journal.oldHead) || !/^(?:HEAD|refs\/heads\/[^\u0000-\u0020]+)$/.test(journal.ref) || !/^[a-f0-9]{64}$/.test(journal.indexHash) || !/^[a-f0-9]{64}$/.test(journal.preparedHash) || !Number.isSafeInteger(journal.pid) || journal.pid <= 0 || journal.newHead !== void 0 && !/^[a-f0-9]{40,64}$/.test(journal.newHead) || journal.refusal !== void 0 && (typeof journal.refusal !== "string" || journal.refusal.length > 1024)) {
    throw new Error("Invalid partial-index recovery identity.");
  }
  return journal;
}
async function ownsIndexLock(file, journal) {
  if (!journal.lock) return false;
  try {
    const stats = await (0, import_promises3.lstat)(file, { bigint: true });
    return stats.isFile() && !stats.isSymbolicLink() && String(stats.ino) === journal.lock.ino && String(stats.dev) === journal.lock.dev;
  } catch (error) {
    if (isMissing2(error)) return false;
    throw error;
  }
}
async function assertPreparedLock(file, journal) {
  if (!await ownsIndexLock(file, journal) || (await (0, import_promises3.lstat)(file)).size > 64 * 1024 * 1024 || changeFingerprint(await (0, import_promises3.readFile)(file)) !== journal.preparedHash) {
    throw new Error("Index-lock ownership changed. The foreign lock will not be overwritten.");
  }
}
function isMissing2(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
function isExists(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
  }
}
async function syncDirectory(directory) {
  if (process.platform === "win32") return;
  const handle = await (0, import_promises3.open)(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// baseline:src/git/partialChanges.ts
var MAX_SESSION_BYTES = 32 * 1024 * 1024;
var MAX_COMMIT_BYTES = 16 * 1024 * 1024;
var PartialChanges = class {
  /** The executor is derived for this captured worktree and shares activation's mutation gate. */
  constructor(executor, root) {
    this.executor = executor;
    this.root = root;
  }
  executor;
  root;
  snapshots = /* @__PURE__ */ new Map();
  bytes = 0;
  issues = [];
  /** Captures a server-owned snapshot; the browser receives only its immutable view. */
  async open(file, side = "working") {
    await this.recover();
    const snapshot = await readPartialSnapshot(this.executor, this.root, file, side);
    const old = this.snapshots.get(snapshot.view.snapshotId);
    if (old) {
      this.snapshots.delete(snapshot.view.snapshotId);
      this.snapshots.set(snapshot.view.snapshotId, old);
      return structuredClone(old.view);
    }
    this.snapshots.set(snapshot.view.snapshotId, snapshot);
    this.bytes += snapshotBytes(snapshot);
    while (this.snapshots.size > 64 || this.bytes > MAX_SESSION_BYTES) {
      const oldest = this.snapshots.entries().next().value;
      if (!oldest) break;
      this.snapshots.delete(oldest[0]);
      this.bytes -= snapshotBytes(oldest[1]);
    }
    return structuredClone(snapshot.view);
  }
  /** Resolves metadata identities from the host cache, never a supplied filename or patch. */
  snapshot(id) {
    const snapshot = this.snapshots.get(id);
    if (!snapshot) throw new Error("The change snapshot expired. Reopen its changes.");
    return snapshot;
  }
  /** Applies selected working changes, or removes selected indexed changes, without a worktree write. */
  async stage(selection, assertNoDirtyBuffer) {
    const snapshot = this.snapshot(selection.snapshotId);
    const selectedLines = validateSelection(snapshot.view.blocks, selection.lineIds);
    if (!selection.lineIds.length) throw new Error("Select changes first.");
    await this.executor.runWithinMutationGate(async () => {
      await assertNoDirtyBuffer([snapshot.view.path]);
      await assertPartialSnapshotCurrent(this.executor, snapshot);
      const directory = await (0, import_promises4.mkdtemp)(import_node_path4.default.join((0, import_node_os2.tmpdir)(), "intelligit-partial-stage-"));
      try {
        const index = import_node_path4.default.join(directory, "index");
        await (0, import_promises4.copyFile)(snapshot.indexPath, index);
        await this.materializeIndex(index);
        const selected = snapshot.view.side === "index" ? changeIds(snapshot.view.blocks).filter((id) => !selectedLines.has(id)) : selection.lineIds;
        const content = selectedContent(snapshot.view.base, snapshot.view.blocks, selected);
        assertContentSize(content);
        const result = snapshot.view.side === "index" ? content : await this.reconcileText(directory, snapshot, content);
        await this.writeBlob(index, snapshot, result);
        await publishPartialIndex(this.executor, snapshot, index, void 0, async () => {
          await assertNoDirtyBuffer([snapshot.view.path]);
          await assertPartialSnapshotCurrent(this.executor, snapshot);
        });
        this.clear();
      } finally {
        await (0, import_promises4.rm)(directory, { recursive: true, force: true });
      }
    });
  }
  /** Commits exactly selected text while retaining all unrelated index and worktree content. */
  async commit(selections, message, assertNoDirtyBuffer, faults = {}) {
    if (!message.trim() || Buffer.byteLength(message, "utf8") > 256 * 1024) {
      throw new Error("Enter a supported commit message.");
    }
    if (!selections.length || selections.length > 64)
      throw new Error("Select 1 to 64 text files.");
    const snapshots = selections.map((selection) => this.snapshot(selection.snapshotId));
    const first = snapshots[0];
    const paths = snapshots.map((snapshot) => snapshot.view.path);
    if (new Set(paths).size !== paths.length)
      throw new Error("Duplicate partial-commit files.");
    if (snapshots.some(
      (snapshot) => snapshot.indexHash !== first.indexHash || snapshot.head !== first.head || snapshot.ref !== first.ref || snapshot.root !== first.root
    )) {
      throw new Error(
        "The selected files belong to different Git snapshots. Reopen their changes."
      );
    }
    const contents = snapshots.map((snapshot, index) => {
      const ids = selections[index].lineIds;
      if (!ids.length) throw new Error("Select changes in every partial-commit file.");
      const content = selectedContent(snapshot.view.base, snapshot.view.blocks, ids);
      assertContentSize(content);
      return content;
    });
    if (contents.reduce((sum, content) => sum + Buffer.byteLength(content), 0) > MAX_COMMIT_BYTES) {
      throw new Error("The selected commit exceeds its text budget.");
    }
    return this.commitPreparedFiles(
      paths,
      (index) => Promise.resolve({ snapshot: snapshots[index], content: contents[index] }),
      message,
      assertNoDirtyBuffer,
      faults
    );
  }
  /**
   * Commits complete owned text through the protected transaction without partial aggregate limits.
   * The mandatory host predicate proves ownership; false returns before mutation for partial routing.
   * Private disk snapshots bound memory and survive editor-cache eviction only for this transaction.
   */
  async tryCommitWholeFiles(paths, message, ownsSnapshot, assertNoDirtyBuffer, faults = {}) {
    if (!message.trim() || Buffer.byteLength(message, "utf8") > 256 * 1024) {
      throw new Error("Enter a supported commit message.");
    }
    if (!paths.length) throw new Error("Select changes before committing.");
    if (new Set(paths).size !== paths.length)
      throw new Error("Duplicate partial-commit files.");
    await this.recover();
    const directory = await (0, import_promises4.mkdtemp)(import_node_path4.default.join((0, import_node_os2.tmpdir)(), "intelligit-owned-snapshots-"));
    try {
      for (const [index, file] of paths.entries()) {
        const snapshot = await readPartialSnapshot(
          this.executor,
          this.root,
          file,
          "working"
        );
        if (!ownsSnapshot(snapshot)) return void 0;
        await (0, import_promises4.writeFile)(import_node_path4.default.join(directory, String(index)), JSON.stringify(snapshot), {
          flag: "wx",
          mode: 384
        });
      }
      return await this.commitPreparedFiles(
        paths,
        async (index) => {
          const snapshot = JSON.parse(
            await (0, import_promises4.readFile)(import_node_path4.default.join(directory, String(index)), "utf8")
          );
          return { snapshot, content: snapshot.working };
        },
        message,
        assertNoDirtyBuffer,
        faults
      );
    } finally {
      await (0, import_promises4.rm)(directory, { recursive: true, force: true });
    }
  }
  /** Shares hook/tree, snapshot, index/ref publication and recovery fences for both commit entries. */
  async commitPreparedFiles(paths, readPrepared, message, assertNoDirtyBuffer, faults) {
    const first = (await readPrepared(0)).snapshot;
    for (let index = 0; index < paths.length; index++) {
      const { snapshot, content } = await readPrepared(index);
      if (snapshot.view.path !== paths[index] || snapshot.indexHash !== first.indexHash || snapshot.head !== first.head || snapshot.ref !== first.ref || snapshot.root !== first.root) {
        throw new Error(
          "The selected files belong to different Git snapshots. Reopen their changes."
        );
      }
      assertContentSize(content);
    }
    return this.executor.runWithinMutationGate(async () => {
      await this.assertCurrent(paths, readPrepared, assertNoDirtyBuffer);
      const directory = await (0, import_promises4.mkdtemp)(import_node_path4.default.join((0, import_node_os2.tmpdir)(), "intelligit-partial-commit-"));
      try {
        const selectedIndex = import_node_path4.default.join(directory, "selected-index");
        const reconciledIndex = import_node_path4.default.join(directory, "reconciled-index");
        await this.executor.runBinary(["read-tree", first.head], {
          env: { GIT_INDEX_FILE: selectedIndex }
        });
        await (0, import_promises4.copyFile)(first.indexPath, reconciledIndex);
        await this.materializeIndex(reconciledIndex);
        for (let index = 0; index < paths.length; index++) {
          const { snapshot, content } = await readPrepared(index);
          const fileDirectory = import_node_path4.default.join(directory, String(index));
          const retained = await this.reconcileText(fileDirectory, snapshot, content);
          await this.writeBlob(selectedIndex, snapshot, content);
          await this.writeBlob(reconciledIndex, snapshot, retained);
        }
        const expectedTree = await this.treeOf(selectedIndex);
        const parentTree = (await this.executor.run(["rev-parse", `${first.head}^{tree}`])).trim();
        if (expectedTree === parentTree)
          throw new Error("The selection does not change the commit tree.");
        const commit = await preparePartialCommit(
          this.executor,
          first,
          selectedIndex,
          directory,
          message,
          expectedTree
        );
        await this.assertCurrent(paths, readPrepared, assertNoDirtyBuffer);
        await publishPartialIndex(
          this.executor,
          first,
          reconciledIndex,
          commit,
          async () => {
            await this.assertCurrent(paths, readPrepared, assertNoDirtyBuffer);
          },
          faults
        );
        this.clear();
        return commit;
      } finally {
        await (0, import_promises4.rm)(directory, { recursive: true, force: true });
      }
    });
  }
  /** Pending reconciliation is replayed only under the same repository mutation gate. */
  async recover(faults = {}) {
    return this.executor.runWithinMutationGate(async () => {
      const { root, gitDir } = await this.recoveryLocation();
      const result = await recoverPartialIndexes(this.executor, root, gitDir, faults);
      this.issues = result.issues;
      if (result.changed) this.clear();
      return result.changed;
    });
  }
  /** Native review UI receives identities and reasons, never prepared index bytes. */
  recoveryIssues() {
    return structuredClone(this.issues);
  }
  /** Dismisses only an explicitly chosen quarantined record for this captured worktree. */
  async discardRecovery(id, location = "quarantined") {
    await this.executor.runWithinMutationGate(async () => {
      const { root, gitDir } = await this.recoveryLocation();
      await discardPartialRecovery(root, gitDir, id, location);
      this.issues = this.issues.filter(
        (issue) => issue.id !== id || (issue.location ?? "quarantined") !== location
      );
    });
  }
  /** Metadata rollback needs a proven unchanged head/ref and repository, not a guessed error string. */
  async canRestoreInclusion(snapshot) {
    return this.executor.runWithinMutationGate(async () => {
      try {
        const { root, gitDir } = await this.recoveryLocation();
        const head = (await this.executor.run(["rev-parse", "--verify", "HEAD"])).trim();
        return root === snapshot.root && gitDir === snapshot.gitDir && head === snapshot.head && await readPartialRef(this.executor) === snapshot.ref;
      } catch {
        return false;
      }
    });
  }
  async recoveryLocation() {
    const root = await (0, import_promises4.realpath)(this.root);
    const actual = await (0, import_promises4.realpath)(
      (await this.executor.run(["rev-parse", "--show-toplevel"])).trim()
    );
    if (actual !== root) throw new Error("The repository changed.");
    const gitDir = await (0, import_promises4.realpath)(
      (await this.executor.run(["rev-parse", "--absolute-git-dir"])).trim()
    );
    return { root, gitDir };
  }
  clear() {
    this.snapshots.clear();
    this.bytes = 0;
  }
  /** Rechecks all captured files with bounded reads and metadata/dirty-buffer guards on both sides. */
  async assertCurrent(paths, readPrepared, guard) {
    await guard(paths);
    await assertPartialSnapshotCurrent(this.executor, (await readPrepared(0)).snapshot);
    await mapWithConcurrency(
      paths.slice(1),
      6,
      async (_file, index) => assertPartialSnapshotCurrent(
        this.executor,
        (await readPrepared(index + 1)).snapshot,
        false
      )
    );
    await guard(paths);
  }
  async materializeIndex(index) {
    await this.executor.runBinary(["update-index", "--no-split-index"], {
      env: { GIT_INDEX_FILE: index }
    });
  }
  async treeOf(index) {
    const result = await this.executor.runBinary(["write-tree"], {
      env: { GIT_INDEX_FILE: index }
    });
    return result.stdout.toString("utf8").trim();
  }
  async writeBlob(index, snapshot, content) {
    assertContentSize(content);
    const hash = await this.executor.runBinary(["hash-object", "-w", "--stdin"], {
      input: Buffer.from(content)
    });
    await this.executor.runBinary(
      [
        "--literal-pathspecs",
        "update-index",
        "--add",
        "--cacheinfo",
        snapshot.mode,
        hash.stdout.toString("utf8").trim(),
        snapshot.view.path
      ],
      { env: { GIT_INDEX_FILE: index } }
    );
  }
  async reconcileText(directory, snapshot, selected) {
    if (snapshot.indexed === snapshot.view.base || snapshot.indexed === selected)
      return selected;
    await (0, import_promises4.mkdir)(directory, { recursive: true, mode: 448 });
    const selectedPath = import_node_path4.default.join(directory, "selected");
    const basePath = import_node_path4.default.join(directory, "base");
    const indexPath = import_node_path4.default.join(directory, "indexed");
    await Promise.all([
      (0, import_promises4.writeFile)(selectedPath, selected, { mode: 384 }),
      (0, import_promises4.writeFile)(basePath, snapshot.view.base, { mode: 384 }),
      (0, import_promises4.writeFile)(indexPath, snapshot.indexed, { mode: 384 })
    ]);
    const result = await this.executor.runBinary(
      ["merge-file", "-p", "--", selectedPath, basePath, indexPath],
      { expectedExitCodes: [0, 1], maxOutputBytes: MAX_PARTIAL_TEXT_BYTES }
    );
    if (result.exitCode !== 0 || result.truncated) {
      throw new Error(
        "The selection overlaps different staged content. Review the index before committing."
      );
    }
    const content = result.stdout.toString("utf8");
    assertContentSize(content);
    return content;
  }
};
function snapshotBytes(snapshot) {
  return Buffer.byteLength(snapshot.view.base) + Buffer.byteLength(snapshot.indexed) + Buffer.byteLength(snapshot.working) + Buffer.byteLength(JSON.stringify(snapshot.view.blocks));
}
function assertContentSize(content) {
  if (Buffer.byteLength(content, "utf8") > MAX_PARTIAL_TEXT_BYTES || content.includes("\0")) {
    throw new Error("The selected result exceeds the supported text size.");
  }
}

// baseline:src/git/executor.ts
var import_node_child_process = require("node:child_process");
var import_node_fs = require("node:fs");
var import_promises5 = require("node:stream/promises");
var GitExecutor = class _GitExecutor {
  /**
   * Creates an executor rooted at the repository path selected during activation.
   *
   * `defaultEnv` pins environment variables for every Git process this executor spawns, for
   * callers that must not inherit whatever the host happens to have configured. Activation
   * passes nothing and keeps inheriting the user's real environment, which is correct for a
   * running extension. A caller that needs a repository read to be reproducible on any machine
   * — a fixture recorder, whose output is committed and compared byte for byte — pins
   * `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` here so a developer's own `~/.gitconfig` (a global
   * `diff.renames=false` is enough) cannot change what the read returns. Per-invocation
   * `options.env` still wins over this, and `process.env` is never mutated either way.
   */
  constructor(repoRoot, mutationGate, defaultEnv) {
    this.mutationGate = mutationGate;
    this.defaultEnv = defaultEnv;
    this.repoRoot = repoRoot;
  }
  mutationGate;
  defaultEnv;
  repoRoot;
  processSemaphore = new Semaphore(MAX_CONCURRENT_PROCESSES);
  /**
   * Rebinds subsequent Git commands to a newly selected repository root.
   *
   * Existing callers use this when the active repository changes without
   * rebuilding every service that depends on the executor.
   */
  setRoot(repoRoot) {
    this.repoRoot = repoRoot;
  }
  /**
   * Creates a sibling executor for another repository root that shares this
   * executor's mutation gate, so derived executors stay serialized with the
   * activation-owned queue and cross-process lock.
   */
  deriveFor(repoRoot) {
    return new _GitExecutor(repoRoot, this.mutationGate, this.defaultEnv);
  }
  /**
   * Runs a raw Git command and returns stdout.
   *
   * Callers own argument validation, path safety, and user-facing error handling;
   * this method rejects every unexpected process exit so higher layers can
   * translate failures in workflow-specific ways. At most MAX_CONCURRENT_PROCESSES
   * spawned Git processes run concurrently per executor instance, matching the
   * previous Simple Git concurrency cap.
   *
   * `options.env` merges over a copy of the parent environment for this invocation
   * only — `process.env` is never mutated — and is forwarded on both the gated
   * (mutating) and ungated paths. It also wins over the executor's constructor
   * `defaultEnv`, so a per-call override still behaves as the innermost setting.
   */
  async run(args, options = {}) {
    await this.processSemaphore.acquire();
    try {
      const output = await this.runGated(args, options);
      notifyGitSuccessSafely(args);
      return output;
    } finally {
      this.processSemaphore.release();
    }
  }
  /**
   * Holds the existing repository mutation gate across a short read-then-write Git sequence.
   * The supplied runner is bound to the captured root and environment and must not reacquire
   * the gate; callers validate all arguments before entering this callback.
   */
  async runWithinMutationGate(operation) {
    const repoRoot = this.repoRoot;
    const ungated = new _GitExecutor(repoRoot, void 0, { ...this.defaultEnv });
    const run = async (args) => {
      const output = (await ungated.runBinary(args)).stdout.toString("utf8");
      notifyGitSuccessSafely(args);
      return output;
    };
    await this.processSemaphore.acquire();
    try {
      if (!this.mutationGate) return await operation(run);
      const commonDir = (await ungated.runBinary(["rev-parse", "--git-common-dir"])).stdout.toString("utf8");
      return await this.mutationGate.run(
        repoRoot,
        this.mutationGate.resolveCommonDir(repoRoot, commonDir),
        () => operation(run)
      );
    } finally {
      this.processSemaphore.release();
    }
  }
  /** Routes mutating commands through the repository mutation gate; others run directly. */
  async runGated(args, options = {}) {
    const runText = async () => (await this.runBinary(args, options)).stdout.toString("utf8");
    if (!this.mutationGate || !isMutatingGitCommand(args)) return await runText();
    const commonDir = (await this.runBinary(["rev-parse", "--git-common-dir"], options)).stdout.toString("utf8");
    return await this.mutationGate.run(
      this.repoRoot,
      this.mutationGate.resolveCommonDir(this.repoRoot, commonDir),
      runText
    );
  }
  /**
   * Runs Git without decoding stdout; output-file mode streams stdout and returns an empty buffer.
   * Status skips optional index refreshes by default so background status reads cannot take
   * the index lock from a concurrent mutation. Explicit environment settings still win.
   */
  async runBinary(args, options = {}) {
    options.signal?.throwIfAborted();
    const expectedExitCodes = options.expectedExitCodes ?? [0];
    if (options.outputFile && options.maxOutputBytes !== void 0) {
      throw new Error(
        "Git binary output cannot be both streamed to a file and byte-limited."
      );
    }
    const env = { ...process.env, ...this.defaultEnv, ...options.env };
    if (resolveSubcommand(args) === "status") {
      env.GIT_OPTIONAL_LOCKS ??= "0";
    }
    return new Promise((resolve, reject) => {
      const child = (0, import_node_child_process.spawn)("git", args, {
        cwd: this.repoRoot,
        stdio: "pipe",
        env
      });
      const stdout = [];
      const stderr = [];
      const output = options.outputFile ? (0, import_node_fs.createWriteStream)(options.outputFile) : void 0;
      let stdoutBytes = 0;
      let truncated = false;
      let terminatedForOutputLimit = false;
      let cancelled = false;
      const abort = () => {
        cancelled = true;
        child.kill();
      };
      const removeAbortListener = () => options.signal?.removeEventListener("abort", abort);
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
      const stdoutDone = output ? (0, import_promises5.pipeline)(child.stdout, output) : new Promise((resolve2) => {
        child.stdout.on("data", (chunk) => {
          const maxOutputBytes = options.maxOutputBytes;
          if (maxOutputBytes === void 0) {
            stdout.push(chunk);
            return;
          }
          const remainingBytes = maxOutputBytes - stdoutBytes;
          if (remainingBytes > 0) {
            stdout.push(chunk.subarray(0, remainingBytes));
            stdoutBytes += Math.min(chunk.length, remainingBytes);
          }
          if (chunk.length > remainingBytes) {
            truncated = true;
            terminatedForOutputLimit = true;
            child.kill();
          }
        });
        child.stdout.once("end", resolve2);
      });
      void stdoutDone.catch(() => void 0);
      child.stderr.on("data", (chunk) => stderr.push(chunk));
      const finish = async (exitCode, signal) => {
        try {
          await stdoutDone;
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        if (cancelled) {
          reject(
            Object.assign(new Error("Git command cancelled."), { name: "AbortError" })
          );
          return;
        }
        const result = {
          stdout: output ? Buffer.alloc(0) : Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
          exitCode: exitCode ?? -1,
          truncated
        };
        if (result.truncated && (result.exitCode === 0 || terminatedForOutputLimit && signal !== null)) {
          return resolve(result);
        }
        if (!signal && expectedExitCodes.includes(result.exitCode)) return resolve(result);
        const command = args.slice(0, 2).join(" ") || "(no subcommand)";
        const stderrText = result.stderr.toString("utf8").trim() || "(no stderr)";
        const outcome = signal ? `was terminated by signal ${signal}` : `exited with ${result.exitCode}`;
        reject(new Error(`git ${command} ${outcome}: ${stderrText}`));
      };
      child.once("error", (error) => {
        removeAbortListener();
        reject(error);
      });
      child.once("close", (exitCode, signal) => {
        removeAbortListener();
        void finish(exitCode, signal);
      });
      child.stdin.once("error", (error) => {
        if (!isExpectedStdinFailure(error, terminatedForOutputLimit || cancelled)) {
          reject(error);
        }
      });
      if (options.input) child.stdin.end(options.input);
      else child.stdin.end();
    });
  }
};
function isExpectedStdinFailure(error, terminatedForOutputLimit) {
  if (error.code === "EPIPE") return true;
  return error.code === "ERR_STREAM_DESTROYED" && terminatedForOutputLimit;
}
var NOTIFIED_SUBCOMMANDS = /* @__PURE__ */ new Set(["commit", "push"]);
var VALUE_TAKING_GLOBAL_OPTIONS = /* @__PURE__ */ new Set([
  "-c",
  "-C",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
  "--super-prefix"
]);
function resolveSubcommand(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === void 0) return void 0;
    if (!arg.startsWith("-")) return arg;
    if (VALUE_TAKING_GLOBAL_OPTIONS.has(arg)) index += 1;
  }
  return void 0;
}
var gitSuccessListener;
function notifyGitSuccessSafely(argv) {
  const subcommand = resolveSubcommand(argv);
  if (!subcommand || !NOTIFIED_SUBCOMMANDS.has(subcommand)) return;
  try {
    gitSuccessListener?.(subcommand, argv);
  } catch {
  }
}
function isMutatingGitCommand(args) {
  const command = args[0];
  if (!command) return false;
  if ([
    "add",
    "am",
    "apply",
    "cherry-pick",
    "checkout",
    "clean",
    "commit",
    "merge",
    "mv",
    "pull",
    "rebase",
    "reset",
    "restore",
    "revert",
    "rm",
    "switch",
    "tag"
  ].includes(command))
    return true;
  if (command === "stash") return !["list", "show"].includes(args[1] ?? "");
  if (command === "branch") return isBranchMutation(args);
  if (command === "push") return true;
  if (command === "worktree") return !["list"].includes(args[1] ?? "");
  return false;
}
var BRANCH_WRITE_FLAGS = [
  "-d",
  "-D",
  "--delete",
  "-m",
  "-M",
  "--move",
  "-c",
  "-C",
  "--copy",
  "-f",
  "--force",
  "-u",
  "--set-upstream",
  "--set-upstream-to",
  "--unset-upstream",
  "--edit-description"
];
function isBranchMutation(args) {
  const options = args.slice(1);
  if (options.some(
    (option) => BRANCH_WRITE_FLAGS.some((flag) => option === flag || option.startsWith(`${flag}=`))
  ))
    return true;
  if (options.includes("--list") || options.includes("-l")) return false;
  return options.some((option) => !option.startsWith("-"));
}
var MAX_CONCURRENT_PROCESSES = 6;
var Semaphore = class {
  constructor(limit) {
    this.limit = limit;
  }
  limit;
  active = 0;
  queue = [];
  async acquire() {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    await new Promise((resolve) => this.queue.push(resolve));
  }
  release() {
    const next = this.queue.shift();
    if (next) {
      next();
      return;
    }
    this.active -= 1;
  }
};

// baseline:src/git/mergeResolution.ts
var import_node_crypto5 = require("node:crypto");
var import_node_buffer2 = require("node:buffer");
var import_promises8 = require("node:fs/promises");

// baseline:src/utils/errors.ts
function getErrorMessage(error) {
  const raw = error instanceof Error ? error.message : String(error);
  return sanitizeErrorMessage(raw);
}
function sanitizeErrorMessage(message) {
  return message.replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/g, "$1***@");
}

// baseline:src/git/operationSupport.ts
var OUTPUT_CHANNEL_NAME = "IntelliGit";
var cachedVsCodeApi;
var outputChannel;
function getVsCodeApi() {
  if (cachedVsCodeApi !== void 0) return cachedVsCodeApi;
  try {
    const globalRequire = globalThis.require;
    cachedVsCodeApi = typeof globalRequire === "function" ? globalRequire("vscode") : require("vscode");
  } catch {
    cachedVsCodeApi = null;
  }
  return cachedVsCodeApi;
}
function getOutputChannel() {
  if (outputChannel) return outputChannel;
  const vscode = getVsCodeApi();
  outputChannel = vscode ? vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME) : { appendLine: (value) => console.warn(value) };
  return outputChannel;
}
function withNotificationPrefix(message) {
  return `${OUTPUT_CHANNEL_NAME}: ${message}`;
}
function showTimedWarningMessage(vscode, message) {
  void vscode.window.showWarningMessage(withNotificationPrefix(message));
}
function logGitOpsWarning(context, err, options) {
  const channel = getOutputChannel();
  const message = getErrorMessage(err);
  channel.appendLine(`[GitOps] ${context}: ${message}`);
  if (err instanceof Error && err.stack) {
    channel.appendLine(sanitizeErrorMessage(err.stack));
  }
  if (options?.userWarningMessage) {
    const vscode = getVsCodeApi();
    if (vscode) {
      showTimedWarningMessage(vscode, options.userWarningMessage);
    }
  }
}
function commitStatsUnavailableMessage() {
  const vscode = getVsCodeApi();
  return vscode ? vscode.l10n.t("Some commit change stats may be unavailable.") : "Some commit change stats may be unavailable.";
}
function unstagedStatsUnavailableMessage() {
  const vscode = getVsCodeApi();
  return vscode ? vscode.l10n.t("Some unstaged change stats may be unavailable.") : "Some unstaged change stats may be unavailable.";
}
function stagedStatsUnavailableMessage() {
  const vscode = getVsCodeApi();
  return vscode ? vscode.l10n.t("Some staged change stats may be unavailable.") : "Some staged change stats may be unavailable.";
}
function assertStashIndex(index) {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`Invalid stash index: ${index}`);
  }
}
function assertRepoRelativeGitPath(filePath) {
  const trimmed = filePath.trim();
  if (!trimmed || trimmed.startsWith("/") || trimmed.startsWith("\\") || /^[a-zA-Z]:[\\/]/.test(trimmed)) {
    throw new Error(`Rejected non-relative path: ${filePath}`);
  }
  if (/[\0\r\n]/.test(trimmed)) {
    throw new Error(`Rejected path containing control characters: ${filePath}`);
  }
  const normalized = trimmed.replace(/\\/g, "/");
  const segments = normalized.split("/").filter((segment) => segment && segment !== ".");
  if (segments.length === 0) {
    throw new Error(`Rejected repo root path: ${filePath}`);
  }
  if (segments.some((segment) => segment === "..")) {
    throw new Error(`Rejected path escaping repo root: ${filePath}`);
  }
  return segments.join("/");
}

// baseline:src/git/mergeResolution.ts
var import_node_path7 = __toESM(require("node:path"));

// baseline:src/shelf/safeWorktreeWrite.ts
var import_promises7 = require("node:fs/promises");
var import_node_crypto4 = require("node:crypto");
var import_node_path6 = __toESM(require("node:path"));

// baseline:src/shelf/importValidation.ts
var import_promises6 = require("node:fs/promises");
var import_node_path5 = __toESM(require("node:path"));

// baseline:src/shelf/pathValidation.ts
var WINDOWS_DEVICE_SEGMENT = /^(?:con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:\..*)?$/i;
function isSafeShelfRelativePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096 || value.includes("\0") || value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:/.test(value) || /^[/\\]{2}/.test(value) || value.includes("\\"))
    return false;
  return value.split("/").every((segment) => isSafeShelfPathSegment(segment));
}
function isSafeShelfPathSegment(segment) {
  if (!segment || segment === "." || segment === ".." || segment.includes(":")) return false;
  if (containsUnsafeUnicode(segment)) return false;
  const canonicalWindowsSegment = segment.replace(/[. ]+$/, "");
  if (!canonicalWindowsSegment || canonicalWindowsSegment.toLowerCase() === ".git") return false;
  return !WINDOWS_DEVICE_SEGMENT.test(canonicalWindowsSegment);
}
function containsUnsafeUnicode(value) {
  for (let index = 0; index < value.length; index += 1) {
    const first = value.charCodeAt(index);
    if (first >= 55296 && first <= 56319) {
      const second = value.charCodeAt(index + 1);
      if (second < 56320 || second > 57343) return true;
      const codePoint = 65536 + (first - 55296) * 1024 + second - 56320;
      if (isUnsafeUnicodeScalar(codePoint)) return true;
      index += 1;
      continue;
    }
    if (first >= 56320 && first <= 57343) return true;
    if (isUnsafeUnicodeScalar(first)) return true;
  }
  return false;
}
function isUnsafeUnicodeScalar(codePoint) {
  return codePoint <= 31 || codePoint >= 127 && codePoint <= 159 || codePoint >= 64976 && codePoint <= 65007 || (codePoint & 65535) >= 65534;
}

// baseline:src/shelf/importValidation.ts
var ShelfImportValidationError = class extends Error {
  /** Creates the stable hostile-import error without exposing patch content. */
  constructor() {
    super("Invalid imported shelf patch.");
    this.name = "ShelfImportValidationError";
  }
};
var DEFAULT_SHELF_IMPORT_VALIDATION_LIMITS = {
  maxSourceBytes: 32 * 1024 * 1024,
  maxFiles: 1e4,
  maxDecodedBytesPerFile: 16 * 1024 * 1024,
  maxDecodedBytesTotal: 64 * 1024 * 1024,
  maxHunksPerFile: 1e5,
  maxLinesPerFile: 1e6,
  maxDeclaredResultBytes: 16 * 1024 * 1024,
  maxLineBytes: 64 * 1024
};
var UTF8 = new TextDecoder("utf-8", { fatal: true });
var REGULAR_FILE_MODES = /* @__PURE__ */ new Set(["100644", "100755"]);
function normalizeImportedPatchPath(value, stripLevel = 1) {
  if (!Number.isSafeInteger(stripLevel) || stripLevel < 0 || stripLevel > 16) fail();
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) fail();
  const parts = value.split("/");
  if (parts.length <= stripLevel) fail();
  return validateRelativePath(parts.slice(stripLevel).join("/"));
}
function validateShelfManifestPath(value) {
  return validateRelativePath(value);
}
function validateImportedPatch(patch, options = {}) {
  const validator = new PatchStreamValidator(options);
  validator.write(patch);
  return validator.finish();
}
var PatchStreamValidator = class {
  limits;
  stripLevel;
  line = [];
  files = [];
  current;
  pendingUnifiedSource;
  sawUnifiedSource = false;
  sourceBytes = 0;
  decodedBytes = 0;
  constructor(options) {
    this.limits = mergedLimits(options.limits);
    this.stripLevel = options.stripLevel ?? 1;
    if (!Number.isSafeInteger(this.stripLevel) || this.stripLevel < 0 || this.stripLevel > 16) {
      fail();
    }
  }
  write(chunk) {
    for (const byte of chunk) {
      this.sourceBytes += 1;
      if (this.sourceBytes > this.limits.maxSourceBytes) fail();
      if (byte === 10) {
        this.processLine(Uint8Array.from(this.line));
        this.line.length = 0;
        continue;
      }
      this.line.push(byte);
      if (this.line.length > this.limits.maxLineBytes) fail();
    }
  }
  finish() {
    if (this.line.length > 0) {
      this.processLine(Uint8Array.from(this.line));
      this.line.length = 0;
    }
    this.finishCurrent();
    if (this.sawUnifiedSource || this.files.length === 0) {
      fail();
    }
    return {
      sourceBytes: this.sourceBytes,
      decodedBytes: this.decodedBytes,
      files: this.files.map((file) => ({
        path: file.path,
        type: file.type,
        decodedBytes: file.decodedBytes,
        declaredResultBytes: file.declaredResultBytes,
        hunkCount: file.hunkCount,
        lineCount: file.lineCount
      }))
    };
  }
  processLine(line) {
    const current = this.current;
    if (this.processActiveLine(current, line)) return;
    this.processPatchHeader(line);
  }
  processActiveLine(current, line) {
    if (current?.binary) {
      this.processBinaryLine(current, line);
      return true;
    }
    if (current?.hunk && (line[0] === 32 || line[0] === 43 || line[0] === 45 || line[0] === 92)) {
      this.processHunkLine(current, line);
      return true;
    }
    if (current?.hunk) this.assertHunkComplete(current);
    return false;
  }
  processPatchHeader(line) {
    const current = this.current;
    if (hasPrefix(line, "diff --git ")) {
      this.finishCurrent();
      const [source, destination] = parseDiffHeader(line, this.stripLevel);
      if (source === void 0 || destination === void 0) fail();
      this.startFile(destination, true);
      return;
    }
    if (hasPrefix(line, "--- ")) {
      this.startUnifiedSource(line);
      return;
    }
    if (hasPrefix(line, "+++ ")) {
      this.startUnifiedDestination(line);
      return;
    }
    if (hasPrefix(line, "@@ ")) {
      this.startHunk(line);
      return;
    }
    if (hasPrefix(line, "GIT binary patch")) {
      if (!current || !equalsAscii(line, "GIT binary patch")) fail();
      current.touched = true;
      current.binary = { needsDeclaration: true, needsPayload: false };
      return;
    }
    if (hasPrefix(line, "Binary files ")) fail();
    const metadataPathPrefix = patchMetadataPathPrefix(line);
    if (metadataPathPrefix !== void 0) {
      if (!current) fail();
      validateShelfManifestPath(decodeHeader(line.subarray(metadataPathPrefix.length)));
      current.touched = true;
      return;
    }
    if (hasPrefix(line, "new file mode ") || hasPrefix(line, "deleted file mode ") || hasPrefix(line, "old mode ") || hasPrefix(line, "new mode ")) {
      if (!current) fail();
      assertRegularMode(lastAsciiToken(line));
      current.touched = true;
      return;
    }
    if (hasPrefix(line, "index ")) {
      if (!current) fail();
      const token = lastAsciiToken(line);
      if (/^[0-7]{6}$/.test(token)) assertRegularMode(token);
    }
  }
  startUnifiedSource(line) {
    const current = this.current;
    if (current?.sawUnifiedHeader && !current.fromDiffHeader) {
      this.finishCurrent();
      this.current = void 0;
    }
    if (this.sawUnifiedSource) fail();
    this.pendingUnifiedSource = parseUnifiedHeaderPath(line, "--- ", this.stripLevel);
    this.sawUnifiedSource = true;
  }
  startUnifiedDestination(line) {
    if (!this.sawUnifiedSource) fail();
    const destination = parseUnifiedHeaderPath(line, "+++ ", this.stripLevel);
    const selected = destination ?? this.pendingUnifiedSource;
    if (selected === void 0) fail();
    if (!this.current) this.startFile(selected, false);
    const current = this.current;
    if (!current || current.path !== selected) fail();
    current.sawUnifiedHeader = true;
    this.pendingUnifiedSource = void 0;
    this.sawUnifiedSource = false;
  }
  startHunk(line) {
    const current = this.current;
    if (!current || current.hunk || !current.sawUnifiedHeader) fail();
    const hunk = parseHunkHeader(decodeHeader(line));
    if (hunk.sourceRemaining > this.limits.maxLinesPerFile || hunk.destinationRemaining > this.limits.maxLinesPerFile) {
      fail();
    }
    current.hunkCount += 1;
    if (current.hunkCount > this.limits.maxHunksPerFile) fail();
    current.touched = true;
    current.hunk = { ...hunk, lastTargetLineAddedNewline: false };
  }
  processHunkLine(file, line) {
    const hunk = file.hunk;
    if (!hunk) fail();
    if (line.includes(0)) fail();
    if (line[0] === 92) {
      if (!equalsAscii(line, "\\ No newline at end of file")) fail();
      if (hunk.lastTargetLineAddedNewline) {
        this.addDecoded(file, -1);
        hunk.lastTargetLineAddedNewline = false;
      }
      return;
    }
    if (hunk.sourceRemaining === 0 && hunk.destinationRemaining === 0) fail();
    const kind = line[0];
    const consumesSource = kind === 32 || kind === 45;
    const consumesDestination = kind === 32 || kind === 43;
    if (!consumesSource && !consumesDestination || consumesSource && hunk.sourceRemaining === 0 || consumesDestination && hunk.destinationRemaining === 0) {
      fail();
    }
    file.lineCount += 1;
    if (file.lineCount > this.limits.maxLinesPerFile) fail();
    if (consumesSource) hunk.sourceRemaining -= 1;
    if (consumesDestination) {
      hunk.destinationRemaining -= 1;
      this.addDecoded(file, line.length);
      hunk.lastTargetLineAddedNewline = true;
    } else {
      hunk.lastTargetLineAddedNewline = false;
    }
  }
  processBinaryLine(file, line) {
    const binary = file.binary;
    if (!binary) fail();
    if (line.length === 0) {
      if (binary.needsDeclaration || binary.needsPayload) fail();
      file.binary = void 0;
      return;
    }
    const declared = parseBinaryDeclaration(decodeHeader(line));
    if (declared !== void 0) {
      if (binary.needsPayload) fail();
      file.declaredResultBytes += declared;
      if (file.declaredResultBytes > this.limits.maxDeclaredResultBytes) fail();
      this.addDecoded(file, declared);
      binary.needsDeclaration = false;
      binary.needsPayload = true;
      return;
    }
    if (binary.needsDeclaration || !isPlausibleGitBinaryPayload(line)) fail();
    binary.needsPayload = false;
  }
  addDecoded(file, amount) {
    if (!Number.isSafeInteger(amount)) fail();
    if (amount < 0) {
      if (file.decodedBytes < -amount || this.decodedBytes < -amount) fail();
      file.decodedBytes += amount;
      this.decodedBytes += amount;
      return;
    }
    if (file.decodedBytes + amount > this.limits.maxDecodedBytesPerFile || this.decodedBytes + amount > this.limits.maxDecodedBytesTotal) {
      fail();
    }
    file.decodedBytes += amount;
    this.decodedBytes += amount;
  }
  startFile(pathname, fromDiffHeader) {
    if (this.files.length >= this.limits.maxFiles) fail();
    const file = {
      path: pathname,
      type: "regular",
      fromDiffHeader,
      decodedBytes: 0,
      declaredResultBytes: 0,
      hunkCount: 0,
      lineCount: 0,
      touched: false,
      sawUnifiedHeader: false,
      hunk: void 0,
      binary: void 0
    };
    this.files.push(file);
    this.current = file;
  }
  finishCurrent() {
    if (!this.current) return;
    this.assertHunkComplete(this.current);
    if (this.current.binary?.needsDeclaration || this.current.binary?.needsPayload) fail();
    if (!this.current.touched) fail();
    this.current = void 0;
  }
  assertHunkComplete(file) {
    const hunk = file.hunk;
    if (!hunk) return;
    if (hunk.sourceRemaining !== 0 || hunk.destinationRemaining !== 0) fail();
    file.hunk = void 0;
  }
};
function mergedLimits(overrides) {
  const limits = { ...DEFAULT_SHELF_IMPORT_VALIDATION_LIMITS, ...overrides };
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) fail();
  }
  if (limits.maxDecodedBytesPerFile > limits.maxDecodedBytesTotal) fail();
  return limits;
}
function parseDiffHeader(line, stripLevel) {
  const tokens = parseGitTokens(decodeHeader(line).slice("diff --git ".length));
  if (tokens.length !== 2) fail();
  return [
    normalizeImportedPatchPath(tokens[0] ?? "", stripLevel),
    normalizeImportedPatchPath(tokens[1] ?? "", stripLevel)
  ];
}
function parseUnifiedHeaderPath(line, prefix, stripLevel) {
  const value = decodeHeader(line.subarray(prefix.length));
  const pathname = value.slice(0, value.indexOf("	") >= 0 ? value.indexOf("	") : value.length);
  if (pathname === "/dev/null") return void 0;
  return normalizeImportedPatchPath(pathname, stripLevel);
}
function parseGitTokens(value) {
  const tokens = [];
  let offset = 0;
  while (offset < value.length) {
    while (value[offset] === " ") offset += 1;
    if (offset >= value.length) break;
    if (value[offset] !== '"') {
      const end = value.indexOf(" ", offset);
      tokens.push(value.slice(offset, end < 0 ? value.length : end));
      offset = end < 0 ? value.length : end + 1;
      continue;
    }
    const decoded = decodeGitQuotedPath(value, offset);
    tokens.push(decoded.value);
    offset = decoded.next;
    if (offset < value.length && value[offset] !== " ") fail();
  }
  return tokens;
}
function decodeGitQuotedPath(value, start) {
  const bytes = [];
  for (let index = start + 1; index < value.length; index += 1) {
    const character = value[index];
    if (character === '"')
      return { value: decodeHeader(Uint8Array.from(bytes)), next: index + 1 };
    if (character !== "\\") {
      const encoded = new TextEncoder().encode(character);
      bytes.push(...encoded);
      continue;
    }
    const escaped = value[index + 1];
    if (escaped === void 0) fail();
    index += 1;
    if (escaped >= "0" && escaped <= "7") {
      const digits = value.slice(index, index + 3);
      if (!/^[0-7]{3}$/.test(digits)) fail();
      bytes.push(Number.parseInt(digits, 8));
      index += 2;
      continue;
    }
    if (escaped === "\\" || escaped === '"') {
      bytes.push(escaped.charCodeAt(0));
      continue;
    }
    fail();
  }
  fail();
}
function parseHunkHeader(value) {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(value);
  if (!match) fail();
  const source = parseHunkCount(match[2]);
  const destination = parseHunkCount(match[4]);
  if (source === void 0 || destination === void 0) fail();
  return { sourceRemaining: source, destinationRemaining: destination };
}
function parseHunkCount(value) {
  if (value === void 0) return 1;
  if (!/^\d+$/.test(value)) return void 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : void 0;
}
function parseBinaryDeclaration(value) {
  const match = /^(?:literal|delta) (\d+)$/.exec(value);
  if (!match) return void 0;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) ? parsed : void 0;
}
function validateRelativePath(value) {
  if (!isSafeShelfRelativePath(value)) fail();
  return value;
}
function assertRegularMode(value) {
  if (!REGULAR_FILE_MODES.has(value)) fail();
}
function isPlausibleGitBinaryPayload(line) {
  if (line.length < 2 || line.length > 53) return false;
  const lengthCode = line[0];
  if (!(lengthCode >= 65 && lengthCode <= 90 || lengthCode >= 97 && lengthCode <= 122))
    return false;
  for (let index = 1; index < line.length; index += 1) {
    if (line[index] < 33 || line[index] > 126) return false;
  }
  return true;
}
function decodeHeader(value) {
  try {
    return UTF8.decode(value);
  } catch {
    fail();
  }
}
function hasPrefix(value, prefix) {
  if (value.length < prefix.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (value[index] !== prefix.charCodeAt(index)) return false;
  }
  return true;
}
function equalsAscii(value, expected) {
  return value.length === expected.length && hasPrefix(value, expected);
}
function lastAsciiToken(value) {
  let start = value.length;
  while (start > 0 && value[start - 1] !== 32) start -= 1;
  return decodeHeader(value.subarray(start));
}
function patchMetadataPathPrefix(line) {
  for (const prefix of ["rename from ", "rename to ", "copy from ", "copy to "]) {
    if (hasPrefix(line, prefix)) return prefix;
  }
  return void 0;
}
function fail() {
  throw new ShelfImportValidationError();
}

// baseline:src/shelf/safeWorktreeWrite.ts
async function replaceRegularWorktreeFile(repositoryRoot, relativePath, bytes) {
  return replaceMergeWorktreeFile(repositoryRoot, validateShelfManifestPath(relativePath), bytes);
}
async function replaceMergeWorktreeFile(repositoryRoot, relativePath, bytes, beforeReplace) {
  const target = resolveRepositoryPath(repositoryRoot, relativePath);
  await ensureContainedParent(repositoryRoot, target);
  const existing = await assertRegularTarget(target);
  const temporary = import_node_path6.default.join(
    import_node_path6.default.dirname(target),
    "." + import_node_path6.default.basename(target) + "." + (0, import_node_crypto4.randomUUID)() + ".tmp"
  );
  let renamed = false;
  try {
    const file = await (0, import_promises7.open)(temporary, "wx", 384);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    await (0, import_promises7.chmod)(temporary, existing.mode & 511);
    await assertRegularTarget(target);
    await beforeReplace?.();
    await (0, import_promises7.rename)(temporary, target);
    renamed = true;
  } finally {
    if (!renamed) await (0, import_promises7.rm)(temporary, { force: true }).catch(() => void 0);
  }
  await ensureContainedParent(repositoryRoot, target);
  await assertRegularTarget(target);
}
async function assertRegularTarget(target) {
  const details = await (0, import_promises7.lstat)(target);
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new Error("Raw shelf write requires an existing regular file.");
  }
  return details;
}

// baseline:src/git/mergeResolution.ts
function withLiteralPathspecs(args) {
  return ["--literal-pathspecs", ...args];
}
function mergeError(message, options) {
  return new Error(getVsCodeApi()?.l10n.t(message) ?? message, options);
}
var MAX_TEXT_BYTES = 2 * 1024 * 1024;
function fingerprint(bytes) {
  return (0, import_node_crypto5.createHash)("sha256").update(bytes).digest("hex");
}
async function readWorktree(root, relativePath) {
  const target = import_node_path7.default.join(root, relativePath);
  await assertContainedParent(root, target);
  const before = await (0, import_promises8.lstat)(target);
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_TEXT_BYTES) {
    throw mergeError("This conflict requires a regular text file of at most 2 MiB.");
  }
  const bytes = await (0, import_promises8.readFile)(target);
  const after = await (0, import_promises8.lstat)(target);
  if (!after.isFile() || after.isSymbolicLink() || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.size !== after.size || bytes.length > MAX_TEXT_BYTES)
    throw mergeError(
      "The conflict file changed while it was being read. Reopen the merge editor."
    );
  if (!(0, import_node_buffer2.isUtf8)(bytes) || bytes.includes(0)) {
    throw mergeError(
      "Binary and non-UTF-8 conflicts must be resolved outside the text merge editor."
    );
  }
  return bytes;
}
async function operationIdentity(executor) {
  const markers = [
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "rebase-merge",
    "rebase-apply"
  ];
  const identities = await Promise.all(
    markers.map(async (marker) => {
      const markerPath = (await executor.run(["rev-parse", "--path-format=absolute", "--git-path", marker])).trim();
      try {
        const stats = await (0, import_promises8.lstat)(markerPath);
        return [
          marker,
          stats.ino,
          stats.mtimeMs,
          stats.isFile() ? fingerprint(await (0, import_promises8.readFile)(markerPath)) : stats.birthtimeMs
        ];
      } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
          return [marker, null];
        throw error;
      }
    })
  );
  return JSON.stringify(identities);
}
async function readMergeResolutionSnapshot(executor, root, filePath) {
  const safePath = assertRepoRelativePath(filePath);
  const initialHead = await executor.run(["rev-parse", "HEAD"]);
  const operation = await operationIdentity(executor);
  const index = await executor.run(
    withLiteralPathspecs(["ls-files", "-u", "-z", "--", safePath])
  );
  const entries = index.split("\0").filter(Boolean);
  if (!entries.length)
    throw mergeError("The file is no longer conflicted. Reopen the conflict list.");
  const versions = /* @__PURE__ */ new Map();
  for (const entry of entries) {
    const match = /^(100644|100755) ([a-f\d]{40,64}) ([123])\t/.exec(entry);
    if (!match || entry.slice(match[0].length) !== safePath) {
      throw mergeError(
        "Submodule, symlink and special-file conflicts require a different resolver."
      );
    }
    const result = await executor.runBinary(["cat-file", "blob", match[2]], {
      maxOutputBytes: MAX_TEXT_BYTES,
      signal: AbortSignal.timeout(1e4)
    });
    if (result.truncated || !(0, import_node_buffer2.isUtf8)(result.stdout) || result.stdout.includes(0)) {
      throw mergeError(
        "Binary, non-UTF-8 or oversized conflicts cannot use the text merge editor."
      );
    }
    versions.set(Number(match[3]), result.stdout.toString("utf8"));
  }
  if (!versions.has(2) || !versions.has(3)) {
    throw mergeError(
      "A deleted-side conflict needs an explicit keep/delete resolution. Use the conflict list or Git."
    );
  }
  const worktree = fingerprint(await readWorktree(root, safePath));
  const head = await executor.run(["rev-parse", "HEAD"]);
  if (initialHead !== head || operation !== await operationIdentity(executor) || index !== await executor.run(withLiteralPathspecs(["ls-files", "-u", "-z", "--", safePath])) || worktree !== fingerprint(await readWorktree(root, safePath))) {
    throw mergeError("The conflict changed while opening. Reopen the merge editor.");
  }
  return {
    id: fingerprint(Buffer.from(JSON.stringify([safePath, head, operation, index, worktree]))),
    index,
    worktree,
    operation,
    base: versions.get(1) ?? "",
    ours: versions.get(2),
    theirs: versions.get(3)
  };
}
async function applyMergeResolution(executor, root, filePath, snapshot, content, assertNoDirtyEditor) {
  const safePath = assertRepoRelativePath(filePath);
  if (Buffer.byteLength(content, "utf8") > MAX_TEXT_BYTES || content.includes("\0")) {
    throw mergeError("The merge result exceeds the supported text size.");
  }
  if (/^(?:<{7}|>{7})(?: [^\r\n]*)?\r?$/m.test(content)) {
    throw mergeError(
      "The result still contains conflict markers. Resolve them before applying."
    );
  }
  await executor.runWithinMutationGate(async (run) => {
    await assertNoDirtyEditor();
    const current = await readMergeResolutionSnapshot(executor, root, safePath);
    if (current.id !== snapshot.id) {
      throw mergeError(
        "Git stages or the working file changed. Your draft is retained; reopen the merge editor before applying."
      );
    }
    await assertNoDirtyEditor();
    await replaceMergeWorktreeFile(root, safePath, Buffer.from(content, "utf8"), async () => {
      await assertNoDirtyEditor();
      if ((await readMergeResolutionSnapshot(executor, root, safePath)).id !== snapshot.id) {
        throw mergeError(
          "The conflict changed before saving. Your draft is retained; reopen the merge editor."
        );
      }
    });
    const after = await run(withLiteralPathspecs(["ls-files", "-u", "-z", "--", safePath]));
    if (after !== snapshot.index || await operationIdentity(executor) !== snapshot.operation) {
      throw mergeError(
        "Git stages changed during the write. The result was saved but not staged; inspect it before continuing."
      );
    }
    const bytes = await readWorktree(root, safePath);
    if (!bytes.equals(Buffer.from(content, "utf8"))) {
      throw mergeError(
        "The file changed during the write. It was not staged; your draft is retained."
      );
    }
    await assertNoDirtyEditor();
    try {
      await run(withLiteralPathspecs(["add", "--", safePath]));
    } catch (cause) {
      throw mergeError(
        "The result was saved but staging failed. Your draft is retained; inspect the file and stage it before continuing.",
        { cause }
      );
    }
  });
}

// baseline:src/git/gitDirectory.ts
var import_node_fs2 = require("node:fs");
var import_node_path8 = __toESM(require("node:path"));
function resolveGitDir(repoRoot) {
  const dotGit = import_node_path8.default.join(repoRoot, ".git");
  try {
    if (!(0, import_node_fs2.statSync)(dotGit).isFile()) return dotGit;
    const content = (0, import_node_fs2.readFileSync)(dotGit, "utf8").trim();
    const match = content.match(/^gitdir:\s*(.+)$/);
    if (!match) return dotGit;
    return import_node_path8.default.isAbsolute(match[1]) ? match[1] : import_node_path8.default.resolve(repoRoot, match[1]);
  } catch {
    return dotGit;
  }
}

// baseline:src/git/repositoryLock.ts
var import_node_crypto6 = require("node:crypto");
var import_promises9 = require("node:fs/promises");
var import_node_path9 = __toESM(require("node:path"));
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
    const lockDir = this.lockDirectory ?? import_node_path9.default.join(commonDir, "intelligit");
    const lockPath = import_node_path9.default.join(lockDir, this.lockFileName);
    await Promise.all(
      [..._RepositoryLock.failedReleases.get(lockPath) ?? []].map((release) => release())
    );
    await (0, import_promises9.mkdir)(lockDir, { recursive: true, mode: 448 });
    const owner = { nonce: (0, import_node_crypto6.randomUUID)(), pid: process.pid, heartbeatAt: Date.now() };
    for (; ; ) {
      try {
        await (0, import_promises9.writeFile)(lockPath, JSON.stringify(owner), {
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
      const takeoverPath = import_node_path9.default.join(lockDir, `takeover-${owner.nonce}`);
      try {
        await (0, import_promises9.rename)(lockPath, takeoverPath);
      } catch (error) {
        if (isNotFound2(error)) continue;
        throw error;
      }
      const moved = await readLockFile(takeoverPath);
      if (!isSameLockFile(moved, existing)) {
        await (0, import_promises9.rename)(takeoverPath, lockPath).catch(() => void 0);
        throw new RepositoryLockBusyError();
      }
      try {
        await (0, import_promises9.writeFile)(lockPath, JSON.stringify(owner), {
          encoding: "utf8",
          flag: "wx",
          mode: 384
        });
      } catch (error) {
        if (isExclusiveCreateBlocked(error)) {
          await (0, import_promises9.rm)(takeoverPath, { force: true });
          throw new RepositoryLockBusyError();
        }
        await (0, import_promises9.rename)(takeoverPath, lockPath).catch(() => void 0);
        throw error;
      }
      await (0, import_promises9.rm)(takeoverPath, { force: true });
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
          await (0, import_promises9.rm)(lockPath, { force: true });
        }
        await (0, import_promises9.rm)(temporaryPath, { force: true });
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
  await (0, import_promises9.writeFile)(temporaryPath, contents, { encoding: "utf8", mode: 384 });
  await (0, import_promises9.rename)(temporaryPath, lockPath);
}
function isSameLockFile(moved, expected) {
  if (expected.kind === "owned") {
    return moved.kind === "owned" && moved.owner.nonce === expected.owner.nonce && moved.owner.heartbeatAt === expected.owner.heartbeatAt;
  }
  return moved.kind === "unreadable";
}
async function readLockFile(lockPath) {
  try {
    const handle = await (0, import_promises9.open)(lockPath, "r");
    try {
      const [stats, contents] = await Promise.all([handle.stat(), handle.readFile("utf8")]);
      const owner = parseOwner(contents);
      return owner ? { kind: "owned", owner } : { kind: "unreadable", mtimeMs: stats.mtimeMs };
    } finally {
      await handle.close().catch(() => void 0);
    }
  } catch (error) {
    if (isNotFound2(error)) return { kind: "absent" };
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
function isNotFound2(error) {
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

// baseline:src/git/wholeIndexOperationWatcher.ts
var import_node_fs3 = require("node:fs");
var WHOLE_INDEX_OPERATION_MARKERS = [
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "sequencer",
  "rebase-merge",
  "rebase-apply"
];
var wholeIndexOperationMarkers = new Set(WHOLE_INDEX_OPERATION_MARKERS);

// baseline:src/utils/gitRefs.ts
var GIT_REF_INVALID_CHARS = /[ ~^:?*[\]\\]/;
function containsControlChars(value) {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}
function isValidBranchName(value) {
  if (!value || value.length > 255) return false;
  if (value.startsWith("-") || value.startsWith("+") || value.startsWith(".")) return false;
  if (value.endsWith(".") || value.endsWith("/") || value.endsWith(".lock")) return false;
  if (value.includes("..") || value.includes("//")) return false;
  if (GIT_REF_INVALID_CHARS.test(value)) return false;
  if (containsControlChars(value)) return false;
  if (value.includes("@{")) return false;
  const segments = value.split("/");
  if (segments.some((seg) => !seg || seg.startsWith(".") || seg.endsWith(".lock"))) return false;
  return true;
}
function assertValidBranchName(value, label = "branch name") {
  if (!isValidBranchName(value)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return value;
}
function isValidRemoteName(value) {
  if (!value || value.length > 255) return false;
  if (value.startsWith("-") || value.startsWith(".") || value.endsWith(".")) return false;
  if (value.includes("..")) return false;
  if (containsControlChars(value)) return false;
  return /^[A-Za-z0-9._-]+$/.test(value);
}
function assertValidRemoteName(value, label = "remote name") {
  if (!isValidRemoteName(value)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return value;
}

// baseline:src/git/parsers.ts
var COMMIT_FIELD_SEP = "\0";
var GIT_NUL = "%x00";
var COMMIT_LOG_FIELD_COUNT = 8;
var AMEND_FIELD_COUNT = 4;
var COMMIT_LOG_FORMAT = ["%H", "%h", "%s", "%an", "%ae", "%aI", "%P", "%D"].join(GIT_NUL) + GIT_NUL;
var COMMIT_DETAIL_FORMAT = ["%H", "%h", "%s", "%b", "%an", "%ae", "%aI", "%P", "%D"].join(
  GIT_NUL
);
var AMEND_BRANCH_COMMIT_FORMAT = ["%H", "%h", "%s", "%cI"].join(GIT_NUL) + GIT_NUL;
function parseCommitLog(result) {
  const commits = [];
  const fields = result.split(COMMIT_FIELD_SEP);
  for (let index = 0; index + COMMIT_LOG_FIELD_COUNT - 1 < fields.length; ) {
    if (!fields[index]) {
      index += 1;
      continue;
    }
    const parts = fields.slice(index, index + COMMIT_LOG_FIELD_COUNT);
    commits.push({
      hash: parts[0],
      shortHash: parts[1],
      message: parts[2],
      author: parts[3],
      email: parts[4],
      date: parts[5],
      parentHashes: splitCommitParents(parts[6]),
      refs: splitCommitRefs(parts[7])
    });
    index += COMMIT_LOG_FIELD_COUNT;
  }
  return commits;
}
function parseCommitDetail(info, fallbackHash, files) {
  const parts = info.trim().split(COMMIT_FIELD_SEP);
  return {
    hash: parts[0] || fallbackHash,
    shortHash: parts[1] || fallbackHash.slice(0, 7),
    message: parts[2] || "",
    body: parts[3] || "",
    author: parts[4] || "",
    email: parts[5] || "",
    date: parts[6] || "",
    parentHashes: splitCommitParents(parts[7]),
    refs: splitCommitRefs(parts[8]),
    files
  };
}
function parseAmendBranchCommitSummaries(output) {
  const rows = [];
  const fields = output.split(COMMIT_FIELD_SEP);
  for (let index = 0; index + AMEND_FIELD_COUNT - 1 < fields.length; ) {
    if (!fields[index]) {
      index += 1;
      continue;
    }
    const parts = fields.slice(index, index + AMEND_FIELD_COUNT);
    const hash = parts[0]?.trim() ?? "";
    const shortHash = parts[1]?.trim() ?? "";
    const subject = parts[2] ?? "";
    const date = parts[3]?.trim() ?? "";
    if (hash && shortHash) {
      rows.push({ hash, shortHash, subject, date });
    }
    index += AMEND_FIELD_COUNT;
  }
  return rows;
}
function parseStashEntries(result) {
  const entries = [];
  for (const line of result.trim().split("\n")) {
    if (!line.trim()) continue;
    const [hash, ref, message, date] = line.split("	");
    const indexMatch = (ref ?? "").match(/\{(\d+)\}/);
    entries.push({
      index: indexMatch ? parseInt(indexMatch[1]) : entries.length,
      message: message || "",
      date: date || "",
      hash: hash || ""
    });
  }
  return entries;
}
function parseFileHistoryEntries(raw) {
  return raw.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
    const [hash = "", shortHash = "", author = "", date = "", ...subjectParts] = line.split("	");
    return {
      hash,
      shortHash,
      author,
      date,
      subject: subjectParts.join("	")
    };
  }).filter((entry) => entry.hash && entry.shortHash);
}
function mapCommitFileStatus(code) {
  if (VALID_COMMIT_FILE_STATUSES.has(code)) {
    return code;
  }
  return "M";
}
function mapStatusCode(code) {
  switch (code) {
    case "M":
      return "M";
    case "A":
      return "A";
    case "D":
      return "D";
    case "R":
      return "R";
    case "C":
      return "C";
    case "?":
      return "?";
    case "!":
      return "!";
    case "U":
      return "U";
    case " ":
      return null;
    default:
      return "M";
  }
}
function isUnmergedConflictCode(code) {
  return UNMERGED_CONFLICT_CODES.has(code);
}
function mapConflictSideState(code) {
  if (code === "A") return "Added";
  if (code === "D") return "Deleted";
  return "Modified";
}
function splitCommitParents(raw) {
  return raw ? raw.split(" ").filter(Boolean) : [];
}
function splitCommitRefs(raw) {
  if (!raw) return [];
  const refs = [];
  for (const ref of raw.split(",")) {
    const trimmed = ref.trim();
    if (trimmed) refs.push(trimmed);
  }
  return refs;
}
var VALID_COMMIT_FILE_STATUSES = /* @__PURE__ */ new Set(["A", "M", "D", "R", "C", "T"]);
var UNMERGED_CONFLICT_CODES = /* @__PURE__ */ new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

// baseline:src/git/numstat.ts
function normalizeGitNumstatPath(path24) {
  const trimmed = path24.trim();
  const bracedRename = trimmed.match(/^(.*)\{([^{}]*?)\s*=>\s*([^{}]*?)\}(.*)$/);
  if (bracedRename) {
    const [, prefix, , destination, suffix] = bracedRename;
    return `${prefix}${destination.trim()}${suffix}`.trim();
  }
  const arrowIndex = trimmed.lastIndexOf("=>");
  if (arrowIndex >= 0) {
    return trimmed.slice(arrowIndex + 2).trim();
  }
  return trimmed;
}

// baseline:src/git/workingTree.ts
function parseWorkingTreeStatus(result) {
  const files = [];
  const entries = result.split("\0");
  for (let i = 0; i < entries.length; i++) {
    const entry = readPorcelainStatusEntry(entries, i);
    if (!entry) continue;
    i = entry.nextIndex;
    files.push(...toWorkingFiles(entry));
  }
  return files;
}
function applyNumstatToWorkingFiles(files, output, staged) {
  const filesByKey = /* @__PURE__ */ new Map();
  const filesIndexByKey = /* @__PURE__ */ new Map();
  for (let i = 0; i < files.length; i++) {
    const key = workingFileKey(files[i].path, files[i].staged);
    filesByKey.set(key, files[i]);
    filesIndexByKey.set(key, i);
  }
  for (const line of output.trim().split("\n")) {
    if (!line.trim()) continue;
    const cols = line.split("	");
    if (cols.length < 3) continue;
    const filePath = normalizeGitNumstatPath(cols[cols.length - 1]);
    const key = workingFileKey(filePath, staged);
    const file = filesByKey.get(key);
    if (!file) continue;
    const updated = {
      ...file,
      additions: parseGitNumstatCount(cols[0]),
      deletions: parseGitNumstatCount(cols[1])
    };
    filesByKey.set(key, updated);
    const index = filesIndexByKey.get(key);
    if (index !== void 0) files[index] = updated;
  }
}
function parseAlreadyStagedDeletedPaths(status) {
  const alreadyStagedDeleted = /* @__PURE__ */ new Set();
  const entries = status.split("\0");
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry || entry.length < 4) continue;
    const index = entry.charAt(0);
    const worktree = entry.charAt(1);
    const path24 = entry.slice(3);
    if (!path24) continue;
    if (isRenameOrCopy(index, worktree) && i + 1 < entries.length) {
      const sourcePath = entries[i + 1];
      if (index === "R" && sourcePath) alreadyStagedDeleted.add(sourcePath);
      i += 1;
    }
    if (index === "D" && worktree === " ") {
      alreadyStagedDeleted.add(path24);
    }
  }
  return alreadyStagedDeleted;
}
function planRollbackFiles(paths, status) {
  const selectedPaths = new Set(paths);
  const plan = {
    resetPaths: new Set(paths),
    checkoutPaths: new Set(paths),
    cleanupPaths: /* @__PURE__ */ new Set()
  };
  const entries = status.split("\0");
  for (let i = 0; i < entries.length; i++) {
    const entry = readPorcelainStatusEntry(entries, i);
    if (!entry) continue;
    i = entry.nextIndex;
    if (!isRollbackPathSelected(entry, selectedPaths)) continue;
    applyRollbackEntry(plan, entry);
  }
  return {
    resetPaths: Array.from(plan.resetPaths),
    checkoutPaths: Array.from(plan.checkoutPaths),
    cleanupPaths: Array.from(plan.cleanupPaths)
  };
}
function readPorcelainStatusEntry(entries, entryIndex) {
  const rawEntry = entries[entryIndex];
  if (!rawEntry || rawEntry.length < 4) return void 0;
  const index = rawEntry.charAt(0);
  const worktree = rawEntry.charAt(1);
  const path24 = rawEntry.slice(3);
  if (!path24) return void 0;
  const hasSourcePath = isRenameOrCopy(index, worktree) && entryIndex + 1 < entries.length;
  return {
    index,
    worktree,
    path: path24,
    sourcePath: hasSourcePath ? entries[entryIndex + 1] : void 0,
    nextIndex: hasSourcePath ? entryIndex + 1 : entryIndex
  };
}
function toWorkingFiles(entry) {
  const files = [];
  const hasStaged = entry.index !== " " && entry.index !== "?" && entry.index !== "!";
  const hasUnstaged = entry.worktree !== " ";
  const stagedStatus = mapStatusCode(entry.index);
  const unstagedStatus = mapStatusCode(entry.worktree);
  if (hasStaged && stagedStatus) {
    files.push(createWorkingFile(entry.path, stagedStatus, true, entry.sourcePath));
  }
  if (hasUnstaged && unstagedStatus && !(entry.index === "A" && unstagedStatus === "M")) {
    files.push(createWorkingFile(entry.path, unstagedStatus, false, entry.sourcePath));
  }
  return files;
}
function isRollbackPathSelected(entry, selectedPaths) {
  return selectedPaths.has(entry.path) || entry.sourcePath !== void 0 && entry.sourcePath.length > 0 && selectedPaths.has(entry.sourcePath);
}
function applyRollbackEntry(plan, entry) {
  if (entry.index === "R" && entry.sourcePath) {
    plan.resetPaths.add(entry.path);
    plan.resetPaths.add(entry.sourcePath);
    plan.cleanupPaths.add(entry.path);
    plan.checkoutPaths.delete(entry.path);
    plan.checkoutPaths.add(entry.sourcePath);
    return;
  }
  if (entry.index === "C" && entry.sourcePath) {
    plan.resetPaths.add(entry.path);
    plan.cleanupPaths.add(entry.path);
    plan.checkoutPaths.delete(entry.path);
    return;
  }
  if (entry.index === "?" && entry.worktree === "?") {
    plan.resetPaths.delete(entry.path);
    plan.cleanupPaths.add(entry.path);
    plan.checkoutPaths.delete(entry.path);
  }
  if (entry.index === "A") {
    plan.cleanupPaths.add(entry.path);
    plan.checkoutPaths.delete(entry.path);
  }
}
function createWorkingFile(path24, status, staged, sourcePath) {
  return {
    path: path24,
    ...sourcePath ? { sourcePath } : {},
    status,
    staged,
    additions: 0,
    deletions: 0
  };
}
function isRenameOrCopy(index, worktree) {
  return index === "R" || index === "C" || worktree === "R" || worktree === "C";
}
function parseGitNumstatCount(value) {
  if (value === "-") return 0;
  const parsed = parseInt(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}
function workingFileKey(path24, staged) {
  return `${path24}:${staged}`;
}

// baseline:src/git/stashFiles.ts
function upsertStashFile(files, path24, status = "M") {
  const existing = files.get(path24);
  if (existing) return existing;
  const created = { path: path24, status, staged: false, additions: 0, deletions: 0 };
  files.set(path24, created);
  return created;
}
function applyNameStatus(files, output) {
  const fields = output.split("\0");
  for (let index = 0; index < fields.length; ) {
    const code = fields[index++];
    if (!code) continue;
    const sourcePath = fields[index++];
    if (sourcePath === void 0) break;
    const path24 = code.startsWith("R") || code.startsWith("C") ? fields[index++] : sourcePath;
    if (!path24) continue;
    upsertStashFile(files, path24, mapStatusCode(code[0]) ?? "M");
  }
}
function applyNumstat(files, output) {
  const records = output.split("\0");
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    const firstTab = record.indexOf("	");
    const secondTab = record.indexOf("	", firstTab + 1);
    if (firstTab < 0 || secondTab < 0) continue;
    let path24 = record.slice(secondTab + 1);
    if (!path24) {
      index += 2;
      path24 = records[index];
    }
    if (!path24) continue;
    const entry = upsertStashFile(files, path24);
    files.set(path24, {
      ...entry,
      additions: record.slice(0, firstTab) === "-" ? 0 : Number(record.slice(0, firstTab)) || 0,
      deletions: record.slice(firstTab + 1, secondTab) === "-" ? 0 : Number(record.slice(firstTab + 1, secondTab)) || 0
    });
  }
}
function applyUntrackedPaths(files, output) {
  for (const path24 of output.split("\0")) {
    if (!path24) continue;
    const entry = upsertStashFile(files, path24, "?");
    files.set(path24, { ...entry, status: "?" });
  }
}
function parseStashFiles(nameStatus, numstat, untrackedPaths = "") {
  const files = /* @__PURE__ */ new Map();
  applyNameStatus(files, nameStatus);
  applyNumstat(files, numstat);
  applyUntrackedPaths(files, untrackedPaths);
  return Array.from(files.values()).sort((a, b) => a.path.localeCompare(b.path));
}

// baseline:src/git/patchApplication.ts
var fs = __toESM(require("fs"));
var os = __toESM(require("os"));
var path11 = __toESM(require("path"));
async function applyPatchTextToRepo(patchText, reverse, executor) {
  const tempDir = await fs.promises.mkdtemp(path11.join(os.tmpdir(), "intelligit-filepatch-"));
  const patchFilePath = path11.join(tempDir, "selected-change.patch");
  try {
    await fs.promises.writeFile(patchFilePath, patchText, "utf8");
    await executor.run([
      "apply",
      "--index",
      "--3way",
      "--whitespace=nowarn",
      ...reverse ? ["-R"] : [],
      patchFilePath
    ]);
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch((err) => {
      console.warn(`[intelligit] Failed to clean up temp patch dir ${tempDir}:`, err);
    });
  }
}

// baseline:src/utils/constants.ts
var EMPTY_TREE_HASH = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

// baseline:src/git/updateWithLocalChanges.ts
var import_node_crypto7 = require("node:crypto");
var import_promises10 = require("node:fs/promises");
var import_node_path10 = __toESM(require("node:path"));
async function exists(file) {
  try {
    await (0, import_promises10.lstat)(file);
    return true;
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error.code ?? ""))
      return false;
    throw error;
  }
}
async function readState(run) {
  const [root, gitDir, output] = await Promise.all([
    run(["rev-parse", "--show-toplevel"]),
    run(["rev-parse", "--absolute-git-dir"]),
    run([
      "status",
      "--porcelain=v2",
      "--branch",
      "--untracked-files=all",
      "--ignore-submodules=none",
      "-z"
    ])
  ]);
  const records = output.split("\0");
  const header = (name) => records.find((entry) => entry.startsWith(`# branch.${name} `))?.slice(name.length + 10) ?? "";
  const branch = header("head");
  const head = header("oid");
  if (!branch || !head) throw new Error("Git did not report branch ownership.");
  const repositoryRoot = import_node_path10.default.resolve(root.trim());
  const entries = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!record || record.startsWith("# ")) continue;
    entries.push(record);
    if (record.startsWith("2 ")) index++;
  }
  let nestedRepository = false;
  for (const entry of entries.filter((record) => record.startsWith("? "))) {
    const parts = entry.slice(2).split("/").filter(Boolean);
    const directoryCount = entry.endsWith("/") ? parts.length : parts.length - 1;
    for (let length = 1; length <= directoryCount; length++) {
      if (await exists(import_node_path10.default.join(repositoryRoot, ...parts.slice(0, length), ".git"))) {
        nestedRepository = true;
        break;
      }
    }
  }
  const markers = await Promise.all(
    WHOLE_INDEX_OPERATION_MARKERS.map((marker) => exists(import_node_path10.default.join(gitDir.trim(), marker)))
  );
  return {
    repositoryRoot,
    branch,
    head,
    upstream: header("upstream") ? (await run(["rev-parse", "--symbolic-full-name", "@{upstream}"])).trim() : "",
    dirty: entries.length > 0,
    activeOperation: markers.some(Boolean),
    hasUnmergedPaths: entries.some((entry) => entry.startsWith("u ")),
    unsupportedSubmodule: entries.some((entry) => {
      const fields = entry.split(" ");
      return (fields[0] === "1" || fields[0] === "2") && (fields[2].startsWith("S") || fields.slice(3, 6).includes("160000"));
    }),
    nestedRepository
  };
}
function refusal(state) {
  if (state.branch === "(detached)") return "detached";
  if (state.head === "(initial)") return "unborn";
  if (state.activeOperation) return "active-operation";
  if (state.hasUnmergedPaths) return "unmerged";
  if (!state.upstream) return "no-upstream";
  if (state.unsupportedSubmodule) return "unsupported-submodule";
  if (state.nestedRepository) return "nested-repository";
  return void 0;
}
function sameContext(actual, expected, compareHead) {
  return actual.repositoryRoot === expected.repositoryRoot && actual.branch === expected.branch && actual.upstream === expected.upstream && (!compareHead || actual.head === expected.head);
}
async function preparePullUpdate(run) {
  try {
    const state = await readState(run);
    const reason = refusal(state);
    if (reason) return { kind: "refused", reason };
    const { repositoryRoot, branch, head, upstream, dirty } = state;
    return { kind: "ready", context: { repositoryRoot, branch, head, upstream, dirty } };
  } catch (error) {
    return { kind: "failed", phase: "preflight", error, localChanges: "untouched" };
  }
}
async function listStashes(run) {
  const fields = (await run(["stash", "list", "-z", "--format=%H%x00%gs"])).split("\0");
  if (fields.at(-1) === "") fields.pop();
  if (fields.length % 2) throw new Error("Cannot verify stash identities.");
  const entries = [];
  for (let index = 0; index < fields.length; index += 2) {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(fields[index]))
      throw new Error("Cannot verify stash identity.");
    entries.push({ oid: fields[index], message: fields[index + 1] });
  }
  return entries;
}
function progress(options, phase) {
  try {
    options.onProgress?.(phase);
  } catch {
  }
}
async function restoreBackup(run, options, backup, restoredHead, integrationError) {
  try {
    await run(["cat-file", "-e", `${backup.oid}^{commit}`]);
    progress(options, "restoring");
    await run(["stash", "apply", "--index", backup.oid]);
    const state = await readState(run);
    if (state.activeOperation || state.hasUnmergedPaths || !sameContext(state, { ...options.expected, head: restoredHead }, true)) {
      throw new Error(
        "Repository changed during restoration; inspect current files and the retained backup."
      );
    }
  } catch (error) {
    let hasUnmergedPaths = false;
    try {
      hasUnmergedPaths = (await readState(run)).hasUnmergedPaths;
    } catch {
    }
    return {
      kind: "restore-failed",
      integration: integrationError ? "failed" : "succeeded",
      integrationError,
      error,
      backup,
      hasUnmergedPaths
    };
  }
  return integrationError ? {
    kind: "failed",
    phase: "pull",
    error: integrationError,
    localChanges: "restored",
    backup
  } : { kind: "complete", backup };
}
async function pullUpdateWithinGate(run, options) {
  const pullArgs = {
    rebase: ["pull", "--rebase", "--no-autostash"],
    merge: ["pull", "--no-rebase", "--no-autostash", "--no-edit", "--ff"]
  }[options.strategy];
  let phase = "preflight";
  let backup;
  let backupName;
  let saveAttempted = false;
  try {
    let state = await readState(run);
    const reason = refusal(state);
    if (reason) return { kind: "refused", reason };
    if (!sameContext(state, options.expected, true))
      return { kind: "refused", reason: "context-changed" };
    if (state.dirty && !options.saveLocalChanges)
      return { kind: "confirmation-required", context: state };
    if (state.dirty) {
      phase = "save";
      const before = new Set((await listStashes(run)).map((entry) => entry.oid));
      backupName = `IntelliGit update: ${state.branch} ${(/* @__PURE__ */ new Date()).toISOString()} [${(0, import_node_crypto7.randomUUID)()}]`;
      progress(options, "saving");
      saveAttempted = true;
      let saveError;
      try {
        await run(["stash", "push", "--include-untracked", "--message", backupName]);
      } catch (error) {
        saveError = error;
      }
      const owned = (await listStashes(run)).filter(
        (entry) => entry.message.endsWith(`: ${backupName}`) && !before.has(entry.oid)
      );
      const identities = new Set(owned.map((entry) => entry.oid));
      if (identities.size === 1) backup = { oid: owned[0].oid, message: backupName };
      if (saveError)
        return {
          kind: "failed",
          phase,
          error: saveError,
          localChanges: "uncertain",
          backup,
          backupName
        };
      if (!backup)
        throw new Error(
          "Cannot identify the new named backup; inspect the stash list before recovery."
        );
      state = await readState(run);
      if (refusal(state) || state.dirty || !sameContext(state, options.expected, true)) {
        throw new Error(
          "Repository changed while saving local changes; inspect the retained backup and current files."
        );
      }
    }
    phase = "pull";
    progress(options, "pulling");
    let integrationError;
    try {
      await run(pullArgs);
    } catch (error) {
      integrationError = error;
    }
    state = await readState(run);
    if (state.activeOperation || state.hasUnmergedPaths) {
      return {
        kind: "integration-conflict",
        error: integrationError,
        backup,
        hasUnmergedPaths: state.hasUnmergedPaths
      };
    }
    if (!sameContext(state, options.expected, false) || state.dirty) {
      return {
        kind: "failed",
        phase,
        error: integrationError ?? new Error(
          "Repository changed during pull; automatic restoration was not attempted."
        ),
        localChanges: backup ? "saved" : "uncertain",
        backup
      };
    }
    if (backup) {
      return restoreBackup(run, options, backup, state.head, integrationError);
    }
    if (integrationError)
      return {
        kind: "failed",
        phase: "pull",
        error: integrationError,
        localChanges: "untouched"
      };
    return { kind: "complete" };
  } catch (error) {
    return {
      kind: "failed",
      phase,
      error,
      localChanges: saveAttempted ? "uncertain" : "untouched",
      backup,
      backupName
    };
  }
}

// baseline:src/git/operations.ts
var BRANCH_ROW_FORMAT = [
  "%(refname)",
  "%(refname:short)",
  "%(objectname:short)",
  "%(upstream:short)",
  "%(upstream:track,nobracket)",
  "%(HEAD)",
  "%(symref:short)",
  "%(committerdate:unix)"
];
var DIFF_PER_FILE_BYTE_LIMIT = 64 * 1024;
var DIFF_CUMULATIVE_BYTE_LIMIT = 256 * 1024;
var UNTRACKED_READ_BYTE_LIMIT = 64 * 1024;
var DIFF_NUMSTAT_PATH_BATCH_SIZE = 200;
var SYMLINK_DIFF_OBJECT_ID_MAX_LENGTH = 64;
var UnbornHeadDiffError = class extends Error {
  /** Creates the typed refusal used when no amend patch source exists. */
  constructor() {
    super("Cannot assemble an amend diff for an unborn HEAD.");
    this.name = "UnbornHeadDiffError";
  }
};
function parseBranchRows(result) {
  return result.trim().split("\n").filter((line) => line.trim()).map((line) => {
    const [
      refname = "",
      name = "",
      hash = "",
      upstream = "",
      track = "",
      head = "",
      symref = "",
      committerDateRaw = ""
    ] = line.split("	");
    return [refname, name, hash, upstream, track, head, symref, committerDateRaw];
  });
}
function getSymbolicRemoteDefault(refname, symref) {
  const headMatch = /^refs\/remotes\/([^/]+)\/HEAD$/.exec(refname);
  const targetMatch = symref && isValidBranchName(symref) ? /^([^/]+)\/(.+)$/.exec(symref) : null;
  if (!headMatch || !targetMatch) return void 0;
  const [, headRemote] = headMatch;
  const [, targetRemote, localName] = targetMatch;
  if (headRemote !== targetRemote || !isValidRemoteName(headRemote) || !isValidBranchName(localName)) {
    return void 0;
  }
  return { remote: headRemote, localName, remoteRef: targetMatch[0] };
}
function collectDefaultBranchRefs(rows) {
  const defaultRemoteRefs = /* @__PURE__ */ new Set();
  const remotesWithDefault = /* @__PURE__ */ new Set();
  const defaultLocalNames = /* @__PURE__ */ new Set();
  for (const [refname, , , , , , symref] of rows) {
    const target = getSymbolicRemoteDefault(refname, symref);
    if (!target) continue;
    defaultRemoteRefs.add(target.remoteRef);
    remotesWithDefault.add(target.remote);
    defaultLocalNames.add(target.localName);
  }
  return { defaultRemoteRefs, remotesWithDefault, defaultLocalNames };
}
function getRemoteName(ref) {
  const remote = ref?.split("/")[0];
  return remote && isValidRemoteName(remote) ? remote : void 0;
}
function isRemoteDefaultBranch(name, remote, defaults) {
  return defaults.defaultRemoteRefs.has(name) || remote !== void 0 && !defaults.remotesWithDefault.has(remote) && (name === `${remote}/main` || name === `${remote}/master`);
}
function isLocalDefaultBranch(name, defaults) {
  return defaults.defaultLocalNames.has(name) || defaults.defaultLocalNames.size === 0 && (name === "main" || name === "master");
}
function parseTrackingCounts(track) {
  return {
    ahead: Number(track?.match(/ahead (\d+)/)?.[1] ?? 0),
    behind: Number(track?.match(/behind (\d+)/)?.[1] ?? 0)
  };
}
function toBranch(row, defaults) {
  const [refname, name, hash, upstream, track, head, , committerDateRaw] = row;
  if (refname.endsWith("/HEAD") || !isValidBranchName(name)) return void 0;
  const isRemote = refname.startsWith("refs/remotes/");
  const remote = getRemoteName(isRemote ? name : upstream);
  if (isRemote && !remote) return void 0;
  const trimmedCommitterDate = committerDateRaw?.trim();
  const committerDate = trimmedCommitterDate ? Number(trimmedCommitterDate) : void 0;
  const { ahead, behind } = parseTrackingCounts(track);
  const isDefault = isRemote ? isRemoteDefaultBranch(name, remote, defaults) : isLocalDefaultBranch(name, defaults);
  return {
    name,
    hash,
    isRemote,
    isCurrent: head === "*",
    isDefault: isDefault || void 0,
    committerDate: committerDate !== void 0 && Number.isFinite(committerDate) ? committerDate : void 0,
    upstream: upstream || void 0,
    remote,
    ahead,
    behind
  };
}
var UpstreamPushDeclinedError = class extends Error {
  /** Creates the user-declined push error with a stable error name for callers. */
  constructor() {
    super("Upstream push declined by user");
    this.name = "UpstreamPushDeclinedError";
  }
};
var GitOps = class _GitOps {
  /**
   * Creates a Git operation facade around an executor rooted at the active repository.
   *
   * The optional upstream confirmation callback lets UI callers decide whether push may mutate
   * branch tracking with `git push --set-upstream`.
   */
  constructor(executor, confirmSetUpstreamPush) {
    this.executor = executor;
    this.confirmSetUpstreamPush = confirmSetUpstreamPush;
  }
  executor;
  confirmSetUpstreamPush;
  /**
   * Creates a facade for another repository root whose executor shares this
   * facade's mutation gate, keeping multi-repository mutations serialized.
   */
  deriveFor(repoRoot) {
    return new _GitOps(this.executor.deriveFor(repoRoot), this.confirmSetUpstreamPush);
  }
  /** Creates a captured-root partial workflow sharing the activation-owned mutation gate. */
  partialChangesFor(repoRoot) {
    return new PartialChanges(this.executor.deriveFor(repoRoot), repoRoot);
  }
  /** Merges one validated local or remote branch through this facade's shared mutation gate. */
  async merge(branch) {
    assertValidBranchName(branch);
    await this.executor.run(["merge", branch]);
  }
  /** Rebases the current branch onto a validated local or remote branch through the shared gate. */
  async rebase(branch) {
    assertValidBranchName(branch);
    await this.executor.run(["rebase", branch]);
  }
  /**
   * Reads branch and HEAD together for dialog-time merge checks. Detached and unborn states are
   * valid identities; missing or malformed porcelain headers reject instead of guessing a target.
   */
  async getMergeTarget() {
    const output = await this.executor.run([
      "status",
      "--porcelain=v2",
      "--branch",
      "--untracked-files=no"
    ]);
    const head = /^# branch\.head (.+)$/m.exec(output)?.[1]?.trim();
    const oid = /^# branch\.oid (.+)$/m.exec(output)?.[1]?.trim();
    if (!head || !oid || oid !== "(initial)" && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)) {
      throw new Error(
        getVsCodeApi()?.l10n.t("Unable to determine the current branch and HEAD.") ?? "Unable to determine the current branch and HEAD."
      );
    }
    return { head, oid };
  }
  /** Resolves Git-reported root, worktree Git directory, and shared common Git directory. */
  async getGitDirectories() {
    const [gitDir, commonDir, repoRoot] = await Promise.all([
      this.executor.run(["rev-parse", "--git-dir"]),
      this.executor.run(["rev-parse", "--git-common-dir"]),
      this.executor.run(["rev-parse", "--show-toplevel"])
    ]);
    const root = import_node_path11.default.resolve(repoRoot.trim());
    return {
      root,
      gitDir: import_node_path11.default.resolve(root, gitDir.trim()),
      commonDir: import_node_path11.default.resolve(root, commonDir.trim())
    };
  }
  /** Initializes a Git repository at the supplied filesystem path and returns Git output. */
  async init(repoPath) {
    const executor = new GitExecutor(repoPath);
    return executor.run(["init"]);
  }
  /** Returns whether the executor root is inside a Git work tree, swallowing probe failures. */
  async isRepository() {
    try {
      const out = await this.executor.run(["rev-parse", "--is-inside-work-tree"]);
      return out.trim() === "true";
    } catch {
      return false;
    }
  }
  /** Returns whether HEAD has at least one reachable commit, treating empty repositories as false. */
  async hasAnyCommits() {
    try {
      const out = await this.executor.run(["rev-list", "--count", "HEAD"]);
      return parseInt(out.trim(), 10) > 0;
    } catch {
      return false;
    }
  }
  /**
   * Reads up to ten subject lines reachable from the current HEAD for commit-message style context.
   *
   * Unlike getLog, this deliberately excludes unrelated refs and avoids spawning Git for an unborn HEAD.
   */
  async getRecentCommitSubjects() {
    if (!await this.hasAnyCommits()) return [];
    const output = await this.executor.run(["log", "--format=%s", "-n", "10"]);
    const subjects = output.split(/\r?\n/);
    if (subjects.at(-1) === "") subjects.pop();
    return subjects.slice(0, 10);
  }
  /** Lists configured remotes after filtering invalid remote names and falling back to an empty list. */
  async getRemotes() {
    try {
      const out = await this.executor.run(["remote"]);
      return out.trim().split("\n").map((r) => r.trim()).filter(isValidRemoteName);
    } catch {
      return [];
    }
  }
  /** Lists remote names strictly so a Git read failure cannot appear as an empty repository. */
  async getRemoteNames() {
    const output = await this.executor.run(["remote"]);
    return output.replace(/\r?\n$/, "").split(/\r?\n/).filter((name) => name.length > 0);
  }
  /** Reads literal configured fetch URLs, without applying Git's insteadOf expansion. */
  async getConfiguredRemoteUrls(name) {
    if (!name || /[\0\r\n]/.test(name)) throw new Error("Invalid remote name.");
    const result = await this.executor.runBinary(
      ["config", "--null", "--get-all", "--", `remote.${name}.url`],
      { expectedExitCodes: [0, 1] }
    );
    if (result.exitCode === 1) return [];
    const urls = result.stdout.toString("utf8").split("\0");
    urls.pop();
    return urls;
  }
  /** Renames a remote through Git so tracking refs and related configuration follow it. */
  async renameRemote(oldName, newName) {
    assertValidRemoteName(oldName);
    assertValidRemoteName(newName);
    await this.executor.run(["remote", "rename", "--", oldName, newName]);
  }
  /** Replaces only the original configured fetch URL; Git rejects ambiguous duplicate matches. */
  async setRemoteUrl(name, oldUrl, newUrl) {
    assertValidRemoteName(name);
    if (!newUrl.trim() || /[\0\r\n]/.test(newUrl)) throw new Error("Invalid remote URL.");
    if (oldUrl === void 0) {
      await this.executor.run(["remote", "set-url", "--", name, newUrl]);
      return;
    }
    const escaped = oldUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    await this.executor.run(["remote", "set-url", "--", name, newUrl, `^${escaped}$`]);
  }
  /** Reads a validated remote URL so host services can inspect provider metadata. */
  async getRemoteUrl(remote) {
    assertValidRemoteName(remote);
    try {
      const out = await this.executor.run(["remote", "get-url", remote]);
      return out.trim() || null;
    } catch {
      return null;
    }
  }
  /** Reads every effective Git push destination, including pushurl and pushInsteadOf rewrites. */
  async getRemotePushUrls(remote) {
    assertValidRemoteName(remote);
    try {
      const output = await this.executor.run([
        "remote",
        "get-url",
        "--push",
        "--all",
        remote
      ]);
      const urls = output.replace(/\r?\n$/, "");
      return urls ? urls.split(/\r?\n/) : [];
    } catch {
      return [];
    }
  }
  /** Checks whether a validated local branch resolves to a distinct upstream tracking ref. */
  async branchHasUpstream(branch) {
    try {
      assertValidBranchName(branch);
      const out = await this.executor.run([
        "rev-parse",
        "--abbrev-ref",
        `${branch}@{upstream}`
      ]);
      return out.trim().length > 0 && out.trim() !== branch;
    } catch {
      return false;
    }
  }
  /** Adds a validated remote name using the caller-provided URL without transforming credentials. */
  async addRemote(name, url) {
    assertValidRemoteName(name);
    await this.executor.run(["remote", "add", name, url]);
  }
  /** Removes a validated remote name from repository configuration. */
  async removeRemote(name) {
    assertValidRemoteName(name);
    await this.executor.run(["remote", "remove", name]);
  }
  /** Pushes a validated branch to a validated remote branch while creating upstream tracking. */
  async pushWithUpstream(remote, branch, remoteBranch = branch) {
    assertValidRemoteName(remote);
    assertValidBranchName(branch);
    assertValidBranchName(remoteBranch, "remote branch name");
    const ref = remoteBranch === branch ? branch : `${branch}:${remoteBranch}`;
    return this.executor.run(["push", "-u", remote, ref]);
  }
  /** Resolves the absolute repository root reported by Git for the executor's current work tree. */
  async getRepositoryRoot() {
    const root = await this.executor.run(["rev-parse", "--show-toplevel"]);
    return root.trim();
  }
  /**
   * Reads local and remote branch metadata from Git's formatted branch output.
   *
   * Symbolic remote HEAD refs and invalid branch or remote names are discarded; ahead/behind counts
   * come from Git's upstream tracking text when available.
   */
  async getBranches() {
    const result = await this.executor.run([
      "branch",
      "-a",
      `--format=${BRANCH_ROW_FORMAT.join("	")}`
    ]);
    const rows = parseBranchRows(result);
    const defaults = collectDefaultBranchRefs(rows);
    return rows.map((row) => toBranch(row, defaults)).filter((branch) => !!branch);
  }
  /** Reads sorted repository tags, peeling annotated tags to their target objects. */
  async getTags() {
    const output = await this.executor.run([
      "for-each-ref",
      "--sort=refname",
      "--format=%(refname:strip=2)%00%(objectname)%00%(*objectname)",
      "refs/tags/"
    ]);
    return output.split(/\r?\n/).filter((row) => row.length > 0).map((row) => {
      const [name, objectHash, peeledHash] = row.split("\0");
      const hash = peeledHash || objectHash;
      if (!name || !hash) throw new Error("Invalid tag ref row received from Git.");
      return { name, hash };
    });
  }
  /**
   * Loads commit summaries from all refs or a validated branch, optionally using a literal grep filter.
   *
   * Branch names are passed after `--end-of-options`; filter text uses fixed-string grep to avoid
   * treating user input as a regular expression.
   */
  async getLog(maxCount = 500, branch, filterText, skip = 0) {
    const args = [
      "log",
      "-z",
      `--max-count=${maxCount}`,
      `--pretty=format:${COMMIT_LOG_FORMAT}`
    ];
    if (skip > 0) {
      args.push(`--skip=${skip}`);
    }
    if (filterText) {
      args.push(`--grep=${filterText}`, "-i", "--fixed-strings");
    }
    if (branch) {
      if (!isValidBranchName(branch)) {
        throw new Error("Invalid branch filter received for git log.");
      }
      args.push("--end-of-options", branch);
    } else {
      args.push("--all");
    }
    const result = await this.executor.run(args);
    return parseCommitLog(result);
  }
  /** Lists commits reachable from local branches but not from any remote-tracking ref. */
  async getUnpushedCommitHashes() {
    try {
      const out = await this.executor.run(["rev-list", "--branches", "--not", "--remotes"]);
      return out.trim().split("\n").map((line) => line.trim()).filter(Boolean);
    } catch {
      return [];
    }
  }
  /**
   * Loads commit metadata and changed-file stats for a commit hash.
   *
   * Name/status output is authoritative for file presence, while numstat augments additions and
   * deletions; numstat failures are downgraded to warnings so details still render.
   */
  async getCommitDetail(hash) {
    const info = await this.executor.run([
      "show",
      `--format=${COMMIT_DETAIL_FORMAT}`,
      "--no-patch",
      hash
    ]);
    const filesByPath = /* @__PURE__ */ new Map();
    const upsertFile = (path24, status) => {
      const existing = filesByPath.get(path24);
      if (existing) {
        if (existing.status === "M" && status !== "M") {
          const updated = { ...existing, status };
          filesByPath.set(path24, updated);
          return updated;
        }
        return existing;
      }
      const created = {
        path: path24,
        status,
        additions: 0,
        deletions: 0
      };
      filesByPath.set(path24, created);
      return created;
    };
    const nameStatus = await this.executor.run([
      "diff-tree",
      "--no-commit-id",
      "-r",
      "-m",
      "--name-status",
      hash
    ]);
    for (const line of nameStatus.trim().split("\n")) {
      if (!line.trim()) continue;
      const cols = line.split("	");
      if (cols.length >= 2) {
        const rawCode = cols[0].charAt(0);
        const status = mapCommitFileStatus(rawCode);
        const isRenameOrCopy2 = status === "R" || status === "C";
        const path24 = isRenameOrCopy2 && cols.length >= 3 ? cols[2] : cols[cols.length - 1];
        upsertFile(path24, status);
      }
    }
    try {
      const numstat = await this.executor.run([
        "diff-tree",
        "--no-commit-id",
        "-r",
        "-m",
        "--numstat",
        hash
      ]);
      for (const line of numstat.trim().split("\n")) {
        if (!line.trim()) continue;
        const cols = line.split("	");
        if (cols.length < 3) continue;
        const add = cols[0];
        const del = cols[1];
        const filePath = normalizeGitNumstatPath(cols[cols.length - 1]);
        const file = upsertFile(filePath, "M");
        const parsedAdd = add === "-" ? 0 : parseInt(add);
        const parsedDel = del === "-" ? 0 : parseInt(del);
        const newAdd = Math.max(file.additions, Number.isNaN(parsedAdd) ? 0 : parsedAdd);
        const newDel = Math.max(file.deletions, Number.isNaN(parsedDel) ? 0 : parsedDel);
        if (newAdd !== file.additions || newDel !== file.deletions) {
          const updated = { ...file, additions: newAdd, deletions: newDel };
          filesByPath.set(filePath, updated);
        }
      }
    } catch (err) {
      logGitOpsWarning("Failed to get commit numstat", err, {
        userWarningMessage: commitStatsUnavailableMessage()
      });
    }
    return parseCommitDetail(info, hash, Array.from(filesByPath.values()));
  }
  // --- Working tree operations ---
  /**
   * Reads porcelain working-tree status and augments staged and unstaged entries with numstat data.
   *
   * Status parsing uses NUL-delimited output for paths, and numstat failures produce warnings rather
   * than blocking the status view. Ignored files are included only when callers opt in because Git
   * can return large ignored directories.
   */
  async getStatus(options = {}) {
    const statusArgs = ["status", "--porcelain=v1", "-z", "-uall"];
    if (options.includeIgnored) statusArgs.push("--ignored");
    const result = await this.executor.run(statusArgs);
    const files = parseWorkingTreeStatus(result);
    if (options.withStats === false) return files;
    const applyNumstat2 = (output, staged, label, userWarningMessage) => {
      try {
        applyNumstatToWorkingFiles(files, output, staged);
      } catch (err) {
        logGitOpsWarning(`Failed to get ${label} numstat`, err, { userWarningMessage });
      }
    };
    const [unstagedStat, stagedStat] = await Promise.all([
      this.executor.run(["diff", "--numstat"]).catch((err) => {
        logGitOpsWarning("Failed to get unstaged numstat", err, {
          userWarningMessage: unstagedStatsUnavailableMessage()
        });
        return "";
      }),
      this.executor.run(["diff", "--cached", "--numstat"]).catch((err) => {
        logGitOpsWarning("Failed to get staged numstat", err, {
          userWarningMessage: stagedStatsUnavailableMessage()
        });
        return "";
      })
    ]);
    applyNumstat2(unstagedStat, false, "unstaged", unstagedStatsUnavailableMessage());
    applyNumstat2(stagedStat, true, "staged", stagedStatsUnavailableMessage());
    return files;
  }
  /** Returns whether porcelain status reports any working-tree entry without loading numstat. */
  async hasUncommittedChanges() {
    const result = await this.executor.run(["status", "--porcelain=v1", "-z", "-uall"]);
    return result.length > 0;
  }
  /**
   * Returns whether Git requires the current repository index to be committed as a whole.
   *
   * The marker probe resolves linked-worktree `gitdir:` files before checking merge, sequencer,
   * and rebase state. It reads the filesystem on every call so callers never act on stale state.
   */
  async hasWholeIndexOperationInProgress() {
    return (await this.presentOperationMarkers()).size > 0;
  }
  /**
   * Returns the controlling whole-index operation from the watcher marker set without caching.
   *
   * Rebase wins over merge, then cherry-pick, then revert because the controlling operation is
   * the one whose continue or abort command the user must run: a rebase replaying a merge-like
   * step remains a rebase. `abortMerge` consumes this classification directly.
   */
  async getActiveOperation() {
    const present = await this.presentOperationMarkers();
    if (present.has("rebase-merge") || present.has("rebase-apply")) return "rebase";
    if (present.has("MERGE_HEAD")) return "merge";
    if (present.has("CHERRY_PICK_HEAD")) return "cherry-pick";
    if (present.has("REVERT_HEAD")) return "revert";
    return "none";
  }
  /**
   * Probes every whole-index marker once, resolving linked-worktree `gitdir:` files first.
   *
   * Membership is returned by name rather than by position so the shared marker list can gain or
   * reorder entries without silently rebinding a caller's reading of the result.
   */
  async presentOperationMarkers() {
    const gitDir = resolveGitDir(await this.getRepositoryRoot());
    const probed = await Promise.all(
      WHOLE_INDEX_OPERATION_MARKERS.map(
        async (marker) => await pathExists(import_node_path11.default.join(gitDir, marker)) ? marker : void 0
      )
    );
    return new Set(probed.filter((marker) => marker !== void 0));
  }
  /**
   * Assembles the selected working-tree and optional amend patches under strict byte budgets.
   *
   * Rename sources come from the caller's validated snapshot or one fresh porcelain snapshot,
   * and every Git command that receives selected paths enables literal pathspecs before
   * acquiring bounded output.
   */
  async getDiffForPaths(paths, options = {}) {
    const selectedPaths = new Set(paths);
    const statusSnapshot = options.validatedStatusSnapshot ?? await this.getStatus({ withStats: false });
    const renameSources = /* @__PURE__ */ new Map();
    const untrackedPaths = /* @__PURE__ */ new Set();
    for (const file of statusSnapshot) {
      if (!selectedPaths.has(file.path)) continue;
      if (file.status === "R" && file.sourcePath)
        renameSources.set(file.path, file.sourcePath);
      if (file.status === "?") untrackedPaths.add(file.path);
    }
    const expandedPaths = Array.from(/* @__PURE__ */ new Set([...paths, ...renameSources.values()]));
    const trackedPaths = expandedPaths.filter((filePath) => !untrackedPaths.has(filePath));
    const hasHead = await this.hasAnyCommits();
    if (options.includeHead && !hasHead && paths.length === 0) throw new UnbornHeadDiffError();
    const baseRef = hasHead ? "HEAD" : await this.getEmptyTreeId();
    const numstatByPath = /* @__PURE__ */ new Map();
    for (let start = 0; start < trackedPaths.length; start += DIFF_NUMSTAT_PATH_BATCH_SIZE) {
      const pathBatch = trackedPaths.slice(start, start + DIFF_NUMSTAT_PATH_BATCH_SIZE);
      const result = await this.executor.runBinary(
        withLiteralPathspecs2(["diff", "--numstat", baseRef, "--", ...pathBatch]),
        { maxOutputBytes: DIFF_CUMULATIVE_BYTE_LIMIT }
      );
      for (const [filePath, numstat] of parseDiffNumstat(result.stdout)) {
        numstatByPath.set(filePath, numstat);
      }
    }
    const diffParts = [];
    const summarizedPaths = [];
    let usedBytes = 0;
    const addPart = (part) => {
      diffParts.push(part);
      usedBytes += Buffer.byteLength(part);
    };
    const summaryPart = (filePath, reason, numstat) => {
      const change = numstat ? numstat.binary ? "binary file, " : `+${numstat.added}/-${numstat.deleted} lines, ` : "";
      return `[Diff omitted for ${filePath}: ${change}${reason}.]
`;
    };
    const summarize = (filePath, reason, numstat) => {
      if (!summarizedPaths.includes(filePath)) summarizedPaths.push(filePath);
      addPart(summaryPart(filePath, reason, numstat));
    };
    const summarizeRemoval = (filePath) => {
      if (!summarizedPaths.includes(filePath)) summarizedPaths.push(filePath);
      addPart(`[${filePath} was removed while assembling the diff.]
`);
    };
    const acquire = async (filePath, args, perSourceLimit, expectedExitCodes, numstat, allowMissingPath = false) => {
      const remainingBytes = DIFF_CUMULATIVE_BYTE_LIMIT - usedBytes;
      if (remainingBytes <= 0) {
        summarize(filePath, "cumulative byte budget reached", numstat);
        return;
      }
      const perFileBudgetReason = "per-file byte budget reached";
      const cumulativeBudgetReason = "cumulative byte budget reached";
      const perFileSummaryBytes = Buffer.byteLength(
        summaryPart(filePath, perFileBudgetReason, numstat)
      );
      const budgetReason = perSourceLimit <= remainingBytes - perFileSummaryBytes ? perFileBudgetReason : cumulativeBudgetReason;
      const summaryBytes = Buffer.byteLength(summaryPart(filePath, budgetReason, numstat));
      const maxOutputBytes = Math.min(perSourceLimit, remainingBytes - summaryBytes);
      if (maxOutputBytes <= 0) {
        summarize(filePath, "cumulative byte budget reached", numstat);
        return;
      }
      if (!numstat?.binary && numstat && numstat.added + numstat.deleted > maxOutputBytes) {
        summarize(filePath, budgetReason, numstat);
        return;
      }
      let result;
      try {
        result = await this.executor.runBinary(args, {
          expectedExitCodes,
          maxOutputBytes
        });
      } catch (error) {
        if (allowMissingPath && isMissingUntrackedPathError(error)) {
          summarizeRemoval(filePath);
          return;
        }
        throw error;
      }
      if (result.truncated) {
        summarize(filePath, budgetReason, numstat);
        return;
      }
      addPart(result.stdout.toString("utf8"));
    };
    for (const filePath of trackedPaths) {
      await acquire(
        filePath,
        withLiteralPathspecs2([
          "diff",
          "--full-index",
          "--no-color",
          baseRef,
          "--",
          filePath
        ]),
        DIFF_PER_FILE_BYTE_LIMIT,
        void 0,
        numstatByPath.get(filePath)
      );
    }
    let repoRoot;
    const acquireUntrackedPath = async (filePath) => {
      repoRoot ??= await this.getRepositoryRoot();
      let untrackedStat;
      try {
        untrackedStat = await (0, import_promises11.lstat)(import_node_path11.default.resolve(repoRoot, filePath));
      } catch (error) {
        if (error.code === "ENOENT") {
          summarizeRemoval(filePath);
          return;
        }
        throw error;
      }
      if (untrackedStat.isSymbolicLink()) {
        let linkTarget;
        try {
          linkTarget = await (0, import_promises11.readlink)(import_node_path11.default.resolve(repoRoot, filePath));
        } catch (error) {
          if (error.code === "ENOENT") {
            summarizeRemoval(filePath);
            return;
          }
          throw error;
        }
        const remainingBytes = DIFF_CUMULATIVE_BYTE_LIMIT - usedBytes;
        const summaryBytes = Buffer.byteLength(
          summaryPart(filePath, "cumulative byte budget reached")
        );
        const worstCaseDiff = buildSymlinkAddDiff(
          filePath,
          linkTarget,
          "0".repeat(SYMLINK_DIFF_OBJECT_ID_MAX_LENGTH)
        );
        if (Buffer.byteLength(worstCaseDiff) > remainingBytes - summaryBytes) {
          summarize(filePath, "cumulative byte budget reached");
          return;
        }
        const objectId = (await this.executor.runBinary(["hash-object", "--stdin"], {
          input: Buffer.from(linkTarget)
        })).stdout.toString("utf8").trim();
        addPart(buildSymlinkAddDiff(filePath, linkTarget, objectId));
        return;
      }
      if (!untrackedStat.isFile()) {
        summarize(filePath, "not a regular file; diff omitted");
        return;
      }
      if (untrackedStat.size > UNTRACKED_READ_BYTE_LIMIT) {
        summarize(
          filePath,
          `untracked file is ${untrackedStat.size} bytes, per-file byte budget reached`
        );
        return;
      }
      await acquire(
        filePath,
        withLiteralPathspecs2([
          "diff",
          "--no-index",
          "--full-index",
          "--no-color",
          "--",
          "/dev/null",
          filePath
        ]),
        Math.min(DIFF_PER_FILE_BYTE_LIMIT, UNTRACKED_READ_BYTE_LIMIT),
        [0, 1],
        void 0,
        true
      );
    };
    for (const filePath of untrackedPaths) {
      await acquireUntrackedPath(filePath);
    }
    if (options.includeHead && hasHead) {
      await acquire(
        "HEAD",
        withLiteralPathspecs2(["show", "--format=", "--no-color", "HEAD"]),
        DIFF_PER_FILE_BYTE_LIMIT
      );
    }
    return {
      diff: diffParts.join(""),
      summarizedPaths,
      truncated: summarizedPaths.length > 0
    };
  }
  /** Derives the repository's empty-tree object ID without assuming a SHA-1 object format. */
  async getEmptyTreeId() {
    return readEmptyTreeOid(this.executor);
  }
  /** Stages literal repository paths, including selected deletions and rename sources. */
  async stageFiles(paths) {
    if (paths.length === 0) return;
    const pathsToStage = await this.excludeAlreadyStagedDeletedPaths(paths);
    if (pathsToStage.length === 0) return;
    await this.executor.run(withLiteralPathspecs2(["add", "--", ...pathsToStage]));
  }
  /**
   * Marks unversioned literal paths as intent-to-add without staging their content.
   *
   * Git reports these files as unstaged additions (` A`) so the commit panel can move them
   * from Unversioned Files into Changes while preserving the user's ability to review or stage
   * their contents explicitly.
   */
  async intentToAddFiles(paths) {
    if (paths.length === 0) return;
    await this.executor.run(withLiteralPathspecs2(["add", "--intent-to-add", "--", ...paths]));
  }
  /** Returns the subset of selected paths that should still be passed to `git add`. */
  async excludeAlreadyStagedDeletedPaths(paths) {
    const status = await this.executor.run(
      withLiteralPathspecs2(["status", "--porcelain=v1", "-z", "--", ...paths])
    );
    if (!status.trim()) return paths;
    const alreadyStagedDeleted = parseAlreadyStagedDeletedPaths(status);
    return paths.filter((path24) => !alreadyStagedDeleted.has(path24));
  }
  /** Unstages literal repository paths by resetting them from HEAD. */
  async unstageFiles(paths) {
    if (paths.length === 0) return;
    await this.executor.run(withLiteralPathspecs2(["reset", "HEAD", "--", ...paths]));
  }
  /**
   * Runs an index-mutating operation while restoring the exact original index on success or failure.
   * The index path is Git-resolved so linked worktrees snapshot their own index rather than a guessed `.git` path.
   * A restore failure is surfaced as a distinct error rather than masking the operation's own
   * outcome: the operation's error (or success) always stays the primary signal.
   */
  async withIndexSnapshot(operation) {
    const repoRoot = await this.getRepositoryRoot();
    const reportedIndexPath = (await this.executor.run(["rev-parse", "--git-path", "index"])).trim();
    const indexPath = import_node_path11.default.isAbsolute(reportedIndexPath) ? reportedIndexPath : import_node_path11.default.resolve(repoRoot, reportedIndexPath);
    const snapshotDirectory = await (0, import_promises11.mkdtemp)(import_node_path11.default.join((0, import_node_os3.tmpdir)(), "intelligit-index-"));
    try {
      const snapshotPath = import_node_path11.default.join(snapshotDirectory, "index");
      await (0, import_promises11.copyFile)(indexPath, snapshotPath);
      const outcome = await operation().then(
        (value) => ({ succeeded: true, value }),
        (error) => ({ succeeded: false, error })
      );
      try {
        await this.restoreIndexSnapshot(snapshotPath, indexPath);
      } catch (restoreError) {
        if (!outcome.succeeded) {
          throw new Error(
            `The Git operation failed (${getErrorMessage(outcome.error)}), and restoring the Git index snapshot also failed (${getErrorMessage(restoreError)}). The index may be left with the commit's temporary unstaging applied.`,
            { cause: outcome.error }
          );
        }
        throw new Error(
          `The commit succeeded, but restoring the Git index snapshot failed (${getErrorMessage(restoreError)}). The index may be left with the commit's temporary unstaging applied.`,
          { cause: restoreError }
        );
      }
      if (!outcome.succeeded) throw outcome.error;
      return outcome.value;
    } finally {
      await (0, import_promises11.rm)(snapshotDirectory, { recursive: true, force: true });
    }
  }
  /**
   * Restores a snapshotted index atomically: the snapshot is written to an exclusively created
   * `<index>.lock` file and then renamed onto the index, so a concurrent reader such as
   * `git status` never observes a partially written file.
   *
   * An existing `.lock` file means another Git process is currently writing the index; this is
   * retried briefly since that window is normally sub-second. If contention persists past the
   * retry budget, restoring the user's index takes priority over strict atomicity, so this
   * falls back to a direct, non-atomic copy rather than failing the restore outright.
   *
   * "Existing" is judged by `isExclusiveCreateBlocked` rather than by `EEXIST` alone, because
   * Windows does not always answer `EEXIST`. Git removes `index.lock` on every write, and a
   * removal whose handle is still open leaves the name *delete-pending*, where the exclusive
   * create below returns `EPERM` instead. Read as a fault rather than as contention, that errno
   * skipped both the retry and the fallback -- so the one path deliberately built to degrade
   * gracefully failed outright, on the platform where Git contends most.
   */
  async restoreIndexSnapshot(snapshotPath, indexPath) {
    const lockPath = `${indexPath}.lock`;
    const maxAttempts = 3;
    const retryDelayMs = 50;
    const snapshotBytes2 = await (0, import_promises11.readFile)(snapshotPath);
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        await (0, import_promises11.writeFile)(lockPath, snapshotBytes2, { flag: "wx" });
      } catch (error) {
        if (!isExclusiveCreateBlocked(error)) throw error;
        if (attempt < maxAttempts - 1) {
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
          continue;
        }
        await (0, import_promises11.copyFile)(snapshotPath, indexPath);
        return;
      }
      try {
        await (0, import_promises11.rename)(lockPath, indexPath);
        return;
      } catch (renameError) {
        await (0, import_promises11.rm)(lockPath, { force: true });
        throw renameError;
      }
    }
  }
  /**
   * Creates or amends a commit, limiting panel-owned path requests while preserving whole-index Git states.
   *
   * Omitting `paths` keeps existing callers' bare-commit behavior intact. Passing an empty array for an
   * amend request makes a message-only amend. Whole-index operations keep Git's bare commit unless
   * `rejectActiveOperation` opts into a fresh marker check that throws before either commit route.
   * This is a best-effort fence, not a transaction against external Git processes. Its diagnostic
   * error is surfaced by the caller's localized failure message, like other Git errors.
   */
  async commit(message, amend = false, paths, options) {
    const args = ["commit", "-m", message];
    if (amend) args.push("--amend");
    if (options?.rejectActiveOperation && await this.hasWholeIndexOperationInProgress()) {
      throw new Error("Cannot commit selected files while a Git operation is in progress.");
    }
    if (paths === void 0) return this.executor.run(args);
    if (!options?.rejectActiveOperation && await this.hasWholeIndexOperationInProgress()) {
      return this.executor.run(args);
    }
    if (paths.length > 0) {
      return this.executor.run(withLiteralPathspecs2([...args, "--only", "--", ...paths]));
    }
    if (amend) args.push("--only");
    return this.executor.run(args);
  }
  /**
   * Pushes the current branch and optionally prompts to create upstream tracking on no-upstream errors.
   *
   * Remote and branch names are validated before the fallback `--set-upstream` push mutates tracking.
   *
   * `force` overwrites the remote branch with `--force-with-lease`, which refuses the push when the
   * remote has moved past the local remote-tracking ref. Plain `--force` is deliberately not offered:
   * it discards commits the caller has never seen. Callers must confirm with the user first.
   *
   * A force push only ever happens against a resolved upstream, so `force` is silently dropped
   * when none resolves. That is the same reasoning as the `--set-upstream` fallback below: with no
   * upstream there is no remote history to rewrite.
   */
  async push(force = false) {
    const upstreamTarget = await this.resolveCurrentPushTarget();
    const forceArgs = force && upstreamTarget ? ["--force-with-lease"] : [];
    if (upstreamTarget && (force || upstreamTarget.remoteBranch !== upstreamTarget.localBranch)) {
      return this.executor.run([
        "push",
        ...forceArgs,
        upstreamTarget.remote,
        `HEAD:${upstreamTarget.remoteBranch}`
      ]);
    }
    try {
      return await this.executor.run(["push", ...forceArgs]);
    } catch (err) {
      if (!isNoUpstreamPushError(err)) throw err;
      const branch = await this.resolveCurrentBranchNameForPush();
      const remote = await this.resolveDefaultRemoteNameForPush();
      if (!branch || !remote) throw err;
      assertValidBranchName(branch);
      assertValidRemoteName(remote);
      const allowSetUpstream = await this.requestSetUpstreamPush(remote, branch);
      if (!allowSetUpstream) {
        throw new UpstreamPushDeclinedError();
      }
      return this.executor.run(["push", "--set-upstream", remote, branch]);
    }
  }
  /** Pulls the current branch with rebase semantics and returns Git output. */
  async pullRebase() {
    return this.executor.run(["pull", "--rebase"]);
  }
  /** Captures read-only repository ownership and prerequisites before asking to save local work. */
  async preparePullWithLocalChanges() {
    return preparePullUpdate((args) => this.executor.run(args));
  }
  /**
   * Revalidates consent and keeps save, the selected pull strategy and indexed restoration in one gate.
   * Uses only its captured ungated runner; named backups remain for deliberate manual recovery.
   */
  async pullPreservingLocalChanges(options) {
    return this.executor.runWithinMutationGate((run) => pullUpdateWithinGate(run, options));
  }
  /**
   * Fetches remote refs for the current repository without changing local checkout state.
   *
   * The command updates remote-tracking refs under `.git/refs/remotes/*` without modifying
   * the working tree, index, or local branches.
   *
   * @returns Git stdout from `git fetch`.
   * @throws Propagates `GitExecutor` failures when no remote is configured, network or
   * authentication fails, or Git exits with a non-zero status.
   */
  async fetch() {
    return this.executor.run(["fetch"]);
  }
  /** Fetches a branch into a unique ref so another fetch cannot replace its approved commit. */
  async fetchRemoteBranch(remote, branch) {
    assertValidRemoteName(remote);
    assertValidBranchName(branch);
    const temporaryRef = `refs/intelligit/fetch/${(0, import_node_crypto8.randomUUID)()}`;
    try {
      await this.executor.run([
        "fetch",
        "--",
        remote,
        `refs/heads/${branch}:${temporaryRef}`
      ]);
      return (await this.executor.run([
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${temporaryRef}^{commit}`
      ])).trim();
    } finally {
      await this.executor.run(["update-ref", "-d", temporaryRef]);
    }
  }
  /** Verifies the push remote, creates or amends a commit, then pushes the current branch. */
  async commitAndPush(message, amend = false) {
    await this.assertPushRemoteReachable();
    await this.commit(message, amend);
    return this.push();
  }
  /**
   * Checks the configured upstream remote before committing so orphaned provider remotes are surfaced early.
   */
  async assertPushRemoteReachable() {
    let upstream;
    try {
      upstream = (await this.executor.run(["rev-parse", "--abbrev-ref", "@{upstream}"])).trim().split("\n")[0];
    } catch {
      return;
    }
    if (!upstream || !upstream.includes("/")) return;
    const remote = upstream.split("/")[0];
    if (!remote) return;
    assertValidRemoteName(remote);
    let lsRemoteResult;
    try {
      lsRemoteResult = await this.executor.runBinary(["ls-remote", "--exit-code", remote], {
        expectedExitCodes: [0, 2]
      });
    } catch (err) {
      throw new Error(
        `Push remote "${remote}" is unavailable. Verify the remote repository still exists, update the remote URL, or use Publish Branch to configure a new remote. ${getErrorMessage(err)}`,
        { cause: err }
      );
    }
    if (lsRemoteResult.exitCode === 2) {
      const error = new Error(
        `git ls-remote --exit-code exited with 2: ${lsRemoteResult.stderr.toString("utf8").trim() || "(no stderr)"}`
      );
      throw new Error(
        `Push remote "${remote}" reached but reported no refs; it may simply be empty (no branches yet). Verify the remote repository still exists, update the remote URL, or use Publish Branch to configure a new remote. ${getErrorMessage(error)}`,
        { cause: error }
      );
    }
  }
  /** Resolves and validates the current branch name for upstream-push fallback prompts. */
  async resolveCurrentBranchNameForPush() {
    try {
      const raw = await this.executor.run(["rev-parse", "--abbrev-ref", "HEAD"]);
      const branch = raw.trim();
      if (!branch || branch === "HEAD") return null;
      assertValidBranchName(branch);
      return branch;
    } catch {
      return null;
    }
  }
  /** Resolves the first configured remote name for upstream-push fallback prompts. */
  async resolveDefaultRemoteNameForPush() {
    try {
      const remotes = await this.executor.run(["remote"]);
      const firstRemote = remotes.split("\n").map((r) => r.trim()).find(isValidRemoteName);
      return firstRemote ?? null;
    } catch {
      return null;
    }
  }
  /** Resolves validated upstream metadata for explicit pushes when local and remote names differ. */
  async resolveCurrentPushTarget() {
    const localBranch = await this.resolveCurrentBranchNameForPush();
    if (!localBranch) return null;
    try {
      const upstream = (await this.executor.run(["rev-parse", "--abbrev-ref", "@{upstream}"])).trim().split("\n")[0];
      const slashIndex = upstream.indexOf("/");
      if (slashIndex <= 0) return null;
      const remote = upstream.slice(0, slashIndex);
      const remoteBranch = upstream.slice(slashIndex + 1);
      assertValidRemoteName(remote);
      assertValidBranchName(remoteBranch, "remote branch name");
      return { localBranch, remote, remoteBranch };
    } catch {
      return null;
    }
  }
  /** Prompts or delegates confirmation before mutating upstream tracking during push fallback. */
  async requestSetUpstreamPush(remote, branch) {
    if (this.confirmSetUpstreamPush) {
      return this.confirmSetUpstreamPush(remote, branch);
    }
    const vscode = getVsCodeApi();
    if (!vscode) return false;
    const confirmLabel = vscode.l10n.t("Set Upstream and Push");
    const selection = await vscode.window.showWarningMessage(
      vscode.l10n.t(
        "Branch '{branch}' has no upstream. Set upstream to '{remote}/{remoteBranch}' and push?",
        { branch, remote, remoteBranch: branch }
      ),
      { modal: true },
      confirmLabel
    );
    return selection === confirmLabel;
  }
  /** Returns the full message for the latest commit, falling back to an empty string on Git failure. */
  async getLastCommitMessage() {
    try {
      return (await this.executor.run(["log", "-1", "--format=%B"])).trim();
    } catch {
      return "";
    }
  }
  /**
   * Commits on the current branch relevant when amending: ahead of the upstream
   * branch if set, otherwise the recent history on HEAD (same idea as IntelliJ
   * amend context). Uses NUL field separators in `git log --format` because `%s`
   * may contain tabs.
   */
  async getAmendBranchCommits(limit = 80) {
    try {
      const upstream = (await this.executor.run(["rev-parse", "--abbrev-ref", "@{upstream}"])).trim();
      if (upstream && upstream !== "HEAD") {
        const base = (await this.executor.run(["merge-base", "HEAD", "@{upstream}"])).trim();
        if (base) {
          const range = `${base}..HEAD`;
          const out = await this.executor.run([
            "log",
            range,
            "-z",
            `--max-count=${limit}`,
            `--format=${AMEND_BRANCH_COMMIT_FORMAT}`
          ]);
          const parsed = parseAmendBranchCommitSummaries(out);
          if (parsed.length > 0) {
            return parsed;
          }
        }
      }
    } catch {
    }
    try {
      const out = await this.executor.run([
        "log",
        "HEAD",
        "-z",
        `--max-count=${limit}`,
        `--format=${AMEND_BRANCH_COMMIT_FORMAT}`
      ]);
      return parseAmendBranchCommitSummaries(out);
    } catch {
      return [];
    }
  }
  /**
   * Rolls back selected literal paths using a porcelain-derived reset, checkout, and cleanup plan.
   *
   * Renames, copies, staged adds, and untracked paths are handled separately so cleanup only removes
   * paths Git status identifies as safe for the requested rollback.
   */
  async rollbackFiles(paths) {
    if (paths.length === 0) return;
    const status = await this.executor.run(["status", "--porcelain=v1", "-z", "-uall"]);
    const { resetPaths, checkoutPaths, cleanupPaths } = planRollbackFiles(paths, status);
    if (resetPaths.length > 0) {
      await this.executor.run(withLiteralPathspecs2(["reset", "HEAD", "--", ...resetPaths]));
    }
    if (checkoutPaths.length > 0) {
      await this.executor.run(withLiteralPathspecs2(["checkout", "--", ...checkoutPaths]));
    }
    if (cleanupPaths.length > 0) {
      await this.executor.run(withLiteralPathspecs2(["clean", "-fd", "--", ...cleanupPaths]));
    }
  }
  /** Returns whether the exact repository-relative path exists in `HEAD`. */
  async hasFileAtHead(filePath) {
    const safeFilePath = assertRepoRelativeGitPath(filePath);
    const output = await this.executor.run(
      withLiteralPathspecs2(["ls-tree", "-z", "--name-only", "HEAD", "--", safeFilePath])
    );
    return output.split("\0").includes(safeFilePath);
  }
  /** Resets the repository to HEAD and removes untracked files, discarding all working-tree changes. */
  async rollbackAll() {
    await this.executor.run(["reset", "--hard", "HEAD"]);
    await this.executor.run(["clean", "-fd"]);
  }
  // --- Stash operations ---
  /** Saves tracked and untracked changes, returning C-locale Git output so callers can detect a no-op. */
  async stashSave(paths, message = "Stashed changes") {
    const args = ["stash", "push", "--include-untracked", "-m", message];
    if (paths && paths.length > 0) {
      args.push("--", ...paths);
    }
    return this.executor.run(paths && paths.length > 0 ? withLiteralPathspecs2(args) : args, {
      env: { LC_ALL: "C" }
    });
  }
  /** Pops a validated stash index back into the working tree, optionally restoring its staged state. */
  async stashPop(index = 0, reinstateIndex = false) {
    assertStashIndex(index);
    const args = ["stash", "pop"];
    if (reinstateIndex) args.push("--index");
    args.push(`stash@{${index}}`);
    return this.executor.run(args);
  }
  /** Applies a validated stash index without dropping it, optionally restoring its staged state. */
  async stashApply(index = 0, reinstateIndex = false) {
    assertStashIndex(index);
    const args = ["stash", "apply"];
    if (reinstateIndex) args.push("--index");
    args.push(`stash@{${index}}`);
    return this.executor.run(args);
  }
  /** Applies one full stash object ID; its identity is stable when reflog selectors renumber. */
  async stashApplyByHash(hash, reinstateIndex = false) {
    const stableHash = assertStableStashHash(hash);
    const args = ["stash", "apply"];
    if (reinstateIndex) args.push("--index");
    return this.executor.run([...args, stableHash]);
  }
  /** Lists stash entries from formatted Git output, returning an empty list when stash inspection fails. */
  async listStashes() {
    try {
      const result = await this.executor.run(["stash", "list", "--format=%H	%gd	%gs	%aI"]);
      return parseStashEntries(result);
    } catch {
      return [];
    }
  }
  /** Lists stashes while propagating Git inspection failures to safety-critical callers. */
  async listStashesOrThrow() {
    const result = await this.executor.run(["stash", "list", "--format=%H	%gd	%gs	%aI"]);
    return parseStashEntries(result);
  }
  /** Drops a validated stash index and returns Git output. */
  async stashDelete(index) {
    assertStashIndex(index);
    return this.executor.run(["stash", "drop", `stash@{${index}}`]);
  }
  /** Verifies a fresh selector while holding IntelliGit's mutation gate; external Git writers remain outside that gate. */
  async stashDeleteIfHashMatches(index, hash) {
    assertStashIndex(index);
    const stableHash = assertStableStashHash(hash);
    return this.executor.runWithinMutationGate(async (run) => {
      const currentHash = (await run(["rev-parse", "--verify", `stash@{${index}}^{commit}`])).trim();
      if (currentHash.toLowerCase() !== stableHash.toLowerCase()) {
        throw new Error(`Stash entry changed at index ${index}; refresh and try again.`);
      }
      return run(["stash", "drop", `stash@{${index}}`]);
    });
  }
  /** Restores a validated stash onto a validated new branch, letting Git restore the index and drop it on success. */
  async stashBranch(branchName, index = 0) {
    assertValidBranchName(branchName);
    assertStashIndex(index);
    return this.executor.run(["stash", "branch", branchName, `stash@{${index}}`]);
  }
  /** Creates a branch at a full stash OID's base and restores its index; raw OIDs retain the reflog entry. */
  async stashBranchByHash(branchName, hash) {
    assertValidBranchName(branchName);
    const stableHash = assertStableStashHash(hash);
    return this.executor.run(["stash", "branch", branchName, stableHash]);
  }
  /** Permanently drops every stash entry in the current repository. */
  async stashClear() {
    return this.executor.run(["stash", "clear"]);
  }
  /**
   * Loads changed files for a stash with best-effort metadata and untracked-path classification.
   *
   * Name-status and numstat supply partial details, while `--only-untracked --name-only -z`
   * authoritatively distinguishes unversioned stash entries. Individual probe failures are
   * logged without discarding successful metadata from the other probes.
   */
  async getStashFiles(index) {
    assertStashIndex(index);
    const ref = `stash@{${index}}`;
    let nameStatus = "";
    let numstat = "";
    let untrackedPaths = "";
    try {
      nameStatus = await this.executor.run([
        "stash",
        "show",
        "--include-untracked",
        "--name-status",
        "-z",
        ref
      ]);
    } catch (err) {
      logGitOpsWarning(`Failed stash show --name-status for ${ref}`, err);
    }
    try {
      numstat = await this.executor.run([
        "stash",
        "show",
        "--include-untracked",
        "--numstat",
        "-z",
        ref
      ]);
    } catch (err) {
      logGitOpsWarning(`Failed stash show --numstat for ${ref}`, err);
    }
    try {
      untrackedPaths = await this.executor.run([
        "stash",
        "show",
        "--only-untracked",
        "--name-only",
        "-z",
        ref
      ]);
    } catch (err) {
      logGitOpsWarning(`Failed stash show --only-untracked for ${ref}`, err);
    }
    return parseStashFiles(nameStatus, numstat, untrackedPaths);
  }
  /**
   * Builds one binary-safe file patch from a stable stash object ID.
   *
   * The normal stash tree is compared to its first parent for tracked additions, modifications,
   * and deletions. Only an empty tracked patch probes the optional third parent, where Git stores
   * untracked files; a genuinely absent third parent means no patch, while unrelated errors reject.
   */
  async getStashFilePatch(index, stashHash, filePath) {
    assertStashIndex(index);
    const stableHash = assertStableStashHash(stashHash);
    const safePath = assertRepoRelativeGitPath(filePath);
    const diffArgs = (base, target) => withLiteralPathspecs2([
      "diff",
      "--binary",
      "--full-index",
      "--no-color",
      base,
      target,
      "--",
      safePath
    ]);
    const trackedPatch = await this.executor.run(diffArgs(`${stableHash}^1`, stableHash));
    if (trackedPatch.trim().length > 0) return trackedPatch;
    try {
      return await this.executor.run(diffArgs(EMPTY_TREE_HASH, `${stableHash}^3`));
    } catch (err) {
      if (isMissingStashUntrackedParentError(getErrorMessage(err).toLowerCase())) return "";
      throw err;
    }
  }
  /**
   * Applies and stages exactly one file from the stash entry still occupying a validated index.
   *
   * The movable `stash@{n}` ref is checked against the webview's full object ID before mutation;
   * patch generation then uses only that stable ID so later stash renumbering cannot retarget it.
   */
  async applyStashFile(index, stashHash, filePath) {
    assertStashIndex(index);
    const stableHash = assertStableStashHash(stashHash);
    const safePath = assertRepoRelativeGitPath(filePath);
    const currentHash = (await this.executor.run(["rev-parse", "--verify", `stash@{${index}}^{commit}`])).trim();
    if (currentHash.toLowerCase() !== stableHash.toLowerCase()) {
      throw new Error(`Stash entry changed at index ${index}; refresh and try again.`);
    }
    const patch = await this.getStashFilePatch(index, stableHash, safePath);
    if (patch.trim().length === 0) {
      throw new Error(`No stashed changes found for path: ${safePath}`);
    }
    await applyPatchTextToRepo(patch, false, this.executor);
  }
  /**
   * Reads the before and after versions of one stash path for VS Code diff resources.
   *
   * The first parent supplies the pre-stash version, the stash tree supplies the normal after
   * version, and the third parent is consulted only when the stash tree lacks an untracked file.
   * Missing sides stay undefined; executor failures unrelated to absent Git paths still reject.
   */
  async getStashFileContents(index, filePath) {
    assertStashIndex(index);
    const ref = `stash@{${index}}`;
    const [before, stashAfter] = await Promise.all([
      this.getOptionalStashFileContent(filePath, `${ref}^1`),
      this.getOptionalStashFileContent(filePath, ref)
    ]);
    let after = stashAfter;
    if (after === void 0) {
      after = await this.getOptionalStashFileContent(filePath, `${ref}^3`, true);
    }
    return { before, after };
  }
  /**
   * Reads one stash-side file while converting only Git's explicit missing-path diagnostics to an absent side.
   *
   * A missing third parent is expected for stashes without untracked files, but is accepted only after the
   * main stash tree was read successfully and lacked the requested path.
   */
  async getOptionalStashFileContent(filePath, ref, allowMissingUntrackedParent = false) {
    try {
      return await this.getFileContentAtRef(filePath, ref);
    } catch (err) {
      const message = getErrorMessage(err).toLowerCase();
      if (isMissingGitPathError(message)) return void 0;
      if (allowMissingUntrackedParent && isMissingStashUntrackedParentError(message)) {
        return void 0;
      }
      throw err;
    }
  }
  /** Returns parsed file-history entries for a literal repository path, following renames. */
  async getFileHistoryEntries(filePath, maxCount = 30) {
    const raw = await this.executor.run(
      withLiteralPathspecs2([
        "log",
        `--max-count=${maxCount}`,
        "--pretty=format:%H%x09%h%x09%an%x09%aI%x09%s",
        "--follow",
        "--",
        filePath
      ])
    );
    return parseFileHistoryEntries(raw);
  }
  /**
   * Reads a repository-relative file at a validated Git ref.
   *
   * File paths are normalized as repository-relative Git paths, and refs with empty, option-like, or
   * control-character content are rejected before constructing the `git show` argument.
   */
  async getFileContentAtRef(filePath, ref) {
    const trimmedRef = ref.trim();
    const safeFilePath = assertRepoRelativeGitPath(filePath);
    if (!trimmedRef) throw new Error("Git ref is empty.");
    if (trimmedRef.startsWith("-")) {
      throw new Error("Git ref must not start with '-'.");
    }
    if (/[\0\r\n]/.test(trimmedRef)) {
      throw new Error("Git ref contains invalid control characters.");
    }
    return this.executor.run(["show", `${trimmedRef}:${safeFilePath}`]);
  }
  /** Lists unresolved conflict paths from Git diff's NUL-delimited unmerged output. */
  async getConflictedFiles() {
    const out = await this.executor.run(["diff", "--name-only", "-z", "--diff-filter=U"]);
    return out.split("\0").filter(Boolean);
  }
  /**
   * Reads detailed merge-conflict states from porcelain status output and sorts them for display.
   *
   * Rename/copy source paths are skipped, and only unmerged status code pairs are returned.
   */
  async getConflictFilesDetailed() {
    const result = await this.executor.run(["status", "--porcelain=v1", "-z", "-uall"]);
    const files = [];
    const entries = result.split("\0");
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (!entry || entry.length < 4) continue;
      const oursCode = entry.charAt(0);
      const theirsCode = entry.charAt(1);
      const code = `${oursCode}${theirsCode}`;
      const path24 = entry.slice(3);
      if (!path24) continue;
      const isRenameOrCopy2 = oursCode === "R" || oursCode === "C" || theirsCode === "R" || theirsCode === "C";
      if (isRenameOrCopy2 && i + 1 < entries.length) {
        i += 1;
      }
      if (!isUnmergedConflictCode(code)) continue;
      files.push({
        path: path24,
        code,
        ours: mapConflictSideState(oursCode),
        theirs: mapConflictSideState(theirsCode)
      });
    }
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }
  /**
   * Reads base, ours, and theirs stages for a conflicted file with short per-stage timeouts.
   *
   * Missing stages are converted to empty strings so the merge UI can still open partial conflicts.
   */
  async getConflictFileVersions(filePath) {
    const withTimeout = (promise, label) => {
      return Promise.race([
        promise,
        new Promise(
          (_, reject) => setTimeout(
            () => reject(new Error(`Timed out reading ${label} for ${filePath}`)),
            1e4
          )
        )
      ]);
    };
    const [base, ours, theirs] = await Promise.all([
      withTimeout(this.executor.run(["show", `:1:${filePath}`]), "base").catch(() => ""),
      withTimeout(this.executor.run(["show", `:2:${filePath}`]), "ours").catch(() => ""),
      withTimeout(this.executor.run(["show", `:3:${filePath}`]), "theirs").catch(() => "")
    ]);
    return { base, ours, theirs };
  }
  /**
   * Resolves display labels for the two sides of an in-progress merge-like operation.
   *
   * "Ours" is the current branch name with a short-SHA fallback for detached HEAD.
   * "Theirs" prefers the first merge-like head that exists (MERGE_HEAD, REBASE_HEAD,
   * CHERRY_PICK_HEAD) resolved to a local branch name when possible, falling back to
   * a short SHA. Resolution failures degrade to generic side labels so the merge
   * editor can still open while Git state is unusual.
   */
  async getMergeSideLabels() {
    const ours = await this.resolveRefLabel("HEAD");
    const theirs = await this.resolveRefLabel("MERGE_HEAD") ?? await this.resolveRefLabel("REBASE_HEAD") ?? await this.resolveRefLabel("CHERRY_PICK_HEAD");
    return { ours: ours ?? "Yours", theirs: theirs ?? "Theirs" };
  }
  /** Resolves a ref to a branch name or short SHA, returning null when the ref is absent. */
  async resolveRefLabel(ref) {
    try {
      if (ref === "HEAD") {
        const symbolic = (await this.executor.run(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
        if (symbolic && symbolic !== "HEAD") return symbolic;
      } else {
        const named = (await this.executor.run(["name-rev", "--name-only", "--refs=refs/heads/*", ref])).trim();
        if (named && named !== "undefined" && !named.includes("~") && !named.includes("^")) {
          return named;
        }
      }
      const short = (await this.executor.run(["rev-parse", "--short", ref])).trim();
      return short || null;
    } catch {
      return null;
    }
  }
  /** Captures immutable, bounded text stages for one conflict file. */
  async openMergeResolution(filePath) {
    return readMergeResolutionSnapshot(this.executor, await this.getRepositoryRoot(), filePath);
  }
  /** Saves a text resolution only while the opened Git and working-tree snapshot remains current. */
  async applyMergeResolution(filePath, snapshot, content, assertNoDirtyEditor) {
    await applyMergeResolution(
      this.executor,
      await this.getRepositoryRoot(),
      filePath,
      snapshot,
      content,
      assertNoDirtyEditor
    );
  }
  /** Stages one literal repository path, typically after conflict-side resolution. */
  async stageFile(filePath) {
    await this.executor.run(withLiteralPathspecs2(["add", "--", filePath]));
  }
  /** Checks out the selected conflict side for a literal path and stages the resolved file. */
  async acceptConflictSide(filePath, side) {
    const sideArg = side === "ours" ? "--ours" : "--theirs";
    await this.executor.run(withLiteralPathspecs2(["checkout", sideArg, "--", filePath]));
    await this.executor.run(withLiteralPathspecs2(["add", "--", filePath]));
  }
  /**
   * Aborts the active merge-like operation, including stash-apply index conflicts.
   *
   * The dispatch consumes the same marker-based classification the panel reports, so stale refs
   * cannot override a live operation and a rebase replaying a merge remains a rebase.
   */
  async abortMerge() {
    const activeOperation = await this.getActiveOperation();
    switch (activeOperation) {
      case "rebase":
        await this.executor.run(["rebase", "--abort"]);
        return;
      case "merge":
        await this.executor.run(["merge", "--abort"]);
        return;
      case "cherry-pick":
        await this.executor.run(["cherry-pick", "--abort"]);
        return;
      case "revert":
        await this.executor.run(["revert", "--abort"]);
        return;
      // Only an unclassified repository may reach the index fallback below. A future
      // operation kind added to the union must choose its abort command here rather than
      // inherit `reset --merge`, so the union is closed at compile time instead of quietly
      // widening the fallback — this dispatch drifting from the classification is the
      // defect this method was rewritten to remove.
      case "none":
        break;
      default:
        return assertNeverActiveOperationKind(activeOperation);
    }
    const unmergedEntries = (await this.executor.run(["ls-files", "-u"])).trim();
    if (unmergedEntries) {
      await this.executor.run(["reset", "--merge"]);
      return;
    }
    throw new Error("No active merge, rebase, cherry-pick, or unmerged index state to abort.");
  }
  /** Removes a literal repository path through Git, optionally forcing removal of missing or staged files. */
  async deleteFile(filePath, force = false) {
    const args = force ? ["rm", "-f", "--", filePath] : ["rm", "--", filePath];
    await this.executor.run(withLiteralPathspecs2(args));
  }
};
function assertNeverActiveOperationKind(operation) {
  throw new Error(`Unhandled active operation kind: ${String(operation)}`);
}
function isNoUpstreamPushError(err) {
  const message = getErrorMessage(err).toLowerCase();
  return message.includes("has no upstream branch");
}
function withLiteralPathspecs2(args) {
  return ["--literal-pathspecs", ...args];
}
function parseDiffNumstat(output) {
  const stats = /* @__PURE__ */ new Map();
  for (const line of output.toString("utf8").split("\n")) {
    const [added, deleted, filePath] = line.split("	", 3);
    if (!filePath || added === void 0 || deleted === void 0) continue;
    const binary = added === "-" || deleted === "-";
    const addedLines = Number(added);
    const deletedLines = Number(deleted);
    if (!binary && (!Number.isSafeInteger(addedLines) || !Number.isSafeInteger(deletedLines)) || addedLines < 0 || deletedLines < 0)
      continue;
    stats.set(normalizeGitNumstatPath(filePath), {
      added: binary ? 0 : addedLines,
      deleted: binary ? 0 : deletedLines,
      binary
    });
  }
  return stats;
}
var GIT_PATH_SHORT_ESCAPES = /* @__PURE__ */ new Map([
  [7, "\\a"],
  [8, "\\b"],
  [9, "\\t"],
  [10, "\\n"],
  [11, "\\v"],
  [12, "\\f"],
  [13, "\\r"],
  [34, '\\"'],
  [92, "\\\\"]
]);
function isGitPathQuoteByte(byte) {
  return byte < 32 || byte > 126 || byte === 34 || byte === 92;
}
function escapeGitPathByte(byte) {
  if (!isGitPathQuoteByte(byte)) return String.fromCharCode(byte);
  return GIT_PATH_SHORT_ESCAPES.get(byte) ?? `\\${byte.toString(8).padStart(3, "0")}`;
}
function quoteGitDiffPath(displayPath) {
  const bytes = Buffer.from(displayPath, "utf8");
  if (!bytes.some(isGitPathQuoteByte)) {
    return { text: displayPath, quoted: false };
  }
  let escaped = "";
  for (const byte of bytes) escaped += escapeGitPathByte(byte);
  return { text: `"${escaped}"`, quoted: true };
}
function buildAddedContentHunk(content) {
  const endsWithNewline = content.endsWith("\n");
  const lines = (endsWithNewline ? content.slice(0, -1) : content).split("\n");
  const header = lines.length === 1 ? "@@ -0,0 +1 @@" : `@@ -0,0 +1,${lines.length} @@`;
  const body = lines.map((line) => `+${line}`).join("\n");
  const noNewlineMarker = endsWithNewline ? "" : "\n\\ No newline at end of file";
  return `${header}
${body}${noNewlineMarker}
`;
}
function buildSymlinkAddDiff(filePath, linkTarget, objectId) {
  const aSide = quoteGitDiffPath(`a/${filePath}`);
  const bSide = quoteGitDiffPath(`b/${filePath}`);
  const bTrailer = !bSide.quoted && filePath.includes(" ") ? "	" : "";
  return `diff --git ${aSide.text} ${bSide.text}
new file mode 120000
index ${"0".repeat(objectId.length)}..${objectId}
--- /dev/null
+++ ${bSide.text}${bTrailer}
` + buildAddedContentHunk(linkTarget);
}
function isMissingUntrackedPathError(error) {
  const message = getErrorMessage(error).toLowerCase();
  return error.code === "ENOENT" || isMissingGitPathError(message) || message.includes("no such file or directory") || message.includes("could not access");
}
async function pathExists(filePath) {
  try {
    await (0, import_promises11.access)(filePath);
    return true;
  } catch {
    return false;
  }
}
function isMissingGitPathError(message) {
  return message.includes("does not exist in") || message.includes("exists on disk, but not in") || message.includes("pathspec") && message.includes("did not match");
}
function isMissingStashUntrackedParentError(message) {
  return message.includes("invalid object name") || message.includes("bad revision");
}
function assertStableStashHash(value) {
  const hash = value.trim();
  if (!/^[0-9a-fA-F]{40}$/.test(hash)) {
    throw new Error("Invalid stash hash received from webview.");
  }
  return hash;
}

// baseline:src/shelf/recovery.ts
var import_node_crypto9 = require("node:crypto");
var import_node_fs5 = require("node:fs");
var import_promises12 = require("node:fs/promises");
var import_node_path12 = __toESM(require("node:path"));

// baseline:src/shelf/noFollowFlag.ts
var import_node_fs4 = require("node:fs");
function resolveNoFollowFlag(platform = process.platform) {
  if (platform === "win32") return 0;
  return typeof import_node_fs4.constants.O_NOFOLLOW === "number" ? import_node_fs4.constants.O_NOFOLLOW : 0;
}

// baseline:src/shelf/recovery.ts
var RecoveryExdevError = class extends Error {
  /** Creates the fixed cross-device recovery refusal. */
  constructor() {
    super("EXDEV: recovery staging is not on the worktree filesystem.");
    this.name = "RecoveryExdevError";
  }
};
var ShelfRecoveryFullError = class extends Error {
  /** Creates the fixed recovery-capacity refusal. */
  constructor() {
    super("Recovery full: refusing a new destructive shelf operation.");
    this.name = "ShelfRecoveryFullError";
  }
};
var ShelfRollbackRetainedError = class extends Error {
  /** Records the repository-relative paths that remain available in recovery. */
  constructor(retainedPaths) {
    super("Rollback retained recovery because another process changed a transaction path.");
    this.retainedPaths = retainedPaths;
    this.name = "ShelfRollbackRetainedError";
  }
  retainedPaths;
};
var ShelfReverter = class {
  /** Binds a reverter to one repository and its serialized storage/Git surfaces. */
  constructor(options) {
    this.options = options;
    this.git = options.git ?? new GitExecutorRecoveryGit(new GitExecutor(options.repositoryRoot));
  }
  options;
  git;
  /** Moves originals to recovery and restores each requested path to its pinned base state. */
  async revert(input) {
    const directories = await this.options.gitOps.getGitDirectories();
    return this.options.gate.run(
      this.options.repositoryRoot,
      directories.commonDir,
      async () => this.options.store.withLock(async () => {
        return this.revertWithHeldLocks(input);
      })
    );
  }
  /**
   * Reverts while the activation-owned repository gate and store lock are already held.
   *
   * ShelfService uses this path after it has durably written the shelf generation, so
   * the journal can link the destructive recovery transaction to that generation without
   * re-entering either serialization primitive.
   */
  async revertWithHeldLocks(input) {
    const directories = await this.options.gitOps.getGitDirectories();
    if (!await (this.options.sameFilesystem ?? isSameFilesystem)(
      this.options.repositoryRoot,
      directories.gitDir
    )) {
      throw new RecoveryExdevError();
    }
    if (this.options.capacityAvailable && !await this.options.capacityAvailable()) {
      throw new ShelfRecoveryFullError();
    }
    const recoveryDirectory = recoveryDirectoryFor(directories.gitDir, input.transactionId);
    return this.revertUnderGate(input, recoveryDirectory, directories.gitDir);
  }
  /** Safely rolls back only incomplete shelf-revert journals after a process restart. */
  async resumePending() {
    const directories = await this.options.gitOps.getGitDirectories();
    return this.options.gate.run(
      this.options.repositoryRoot,
      directories.commonDir,
      async () => this.options.store.withLock(async () => {
        const rolledBackIds = [];
        const retainedIds = [];
        for (const journal of await this.options.store.readJournals()) {
          if (journal.state !== "shelvePendingRevert") continue;
          try {
            if (!isIndexFingerprint(journal.expectedIndexFingerprint)) {
              throw new RecoverySafetyError(
                "Pending recovery journal has no valid index fingerprint."
              );
            }
            const moved = await this.pendingMovedPaths(journal, directories.gitDir);
            const retained = await rollbackMovedPaths(
              moved,
              this.options.repositoryRoot,
              directories.gitDir,
              this.git,
              journal.expectedIndexFingerprint
            );
            if (retained.length > 0) {
              await this.options.store.transitionJournal(journal.id, "ghost");
              retainedIds.push(journal.id);
            } else {
              await this.options.store.deleteJournal(journal.id);
              rolledBackIds.push(journal.id);
            }
          } catch {
            await this.options.store.transitionJournal(journal.id, "ghost");
            retainedIds.push(journal.id);
          }
        }
        return { rolledBackIds, retainedIds };
      })
    );
  }
  async revertUnderGate(input, recoveryDirectory, gitDirectory) {
    const originalHead = await this.currentHead();
    const state = {
      transactionId: input.transactionId,
      baseOid: input.baseOid ?? originalHead ?? await this.git.emptyTreeOid(),
      originalHead,
      expectedIndex: await this.currentIndexFingerprint(),
      journal: {
        id: input.transactionId,
        state: "shelvePendingRevert",
        pathProgress: {},
        shelf: input.shelf
      },
      moved: [],
      recoveryObjectHashes: [],
      pathProgress: {},
      seenPaths: /* @__PURE__ */ new Set()
    };
    let committed = false;
    try {
      await this.writePendingJournal(state);
      await this.checkpoint("journal-created");
      for (const file of input.files) {
        await this.revertFile(file, state, recoveryDirectory, gitDirectory);
      }
      await this.commitJournal(state);
      committed = true;
      await this.checkpoint("journal-committed");
      return { baseOid: state.baseOid, recoveryDirectory };
    } catch (error) {
      if (committed) throw error;
      const retained = await rollbackMovedPaths(
        state.moved,
        this.options.repositoryRoot,
        gitDirectory,
        this.git,
        state.expectedIndex
      );
      if (retained.length > 0) throw new ShelfRollbackRetainedError(retained);
      await this.options.store.deleteJournal(input.transactionId);
      throw error;
    }
  }
  async revertFile(file, state, recoveryDirectory, gitDirectory) {
    const relativePath = assertRepositoryRelativePath(file.relativePath);
    if (state.seenPaths.has(relativePath)) {
      throw new RecoverySafetyError(
        "A shelf recovery transaction cannot contain a path twice."
      );
    }
    state.seenPaths.add(relativePath);
    await this.verifyGitPreconditions(state.originalHead, state.expectedIndex);
    const originalIndexEntry = await this.git.getIndexEntry(relativePath);
    const originalIndexFingerprint = await this.git.getIndexPathFingerprint(relativePath);
    const target = resolveRepositoryPath(this.options.repositoryRoot, relativePath);
    const recoveryPath = resolveRecoveryPath(recoveryDirectory, relativePath);
    await assertContainedParentIfPresent(this.options.repositoryRoot, target);
    const entry = {
      relativePath,
      target,
      recoveryPath,
      hadOriginal: await fingerprint2(target) !== "absent",
      originalIndexEntry,
      originalIndexFingerprint,
      writtenFingerprint: "absent",
      writtenIndexEntry: originalIndexEntry,
      writtenIndexFingerprint: originalIndexFingerprint
    };
    state.pathProgress[entry.relativePath] = journalProgress(entry, "planned");
    await this.writePendingJournal(state);
    await this.moveOriginal(entry, state, gitDirectory);
    const baseEntry = await this.git.getBaseEntry(state.baseOid, relativePath);
    await this.writeBase(entry, baseEntry, file.baseBytes, state);
    await this.updateIndex(entry, baseEntry, state);
    if (entry.hadOriginal && await fingerprint2(recoveryPath) === "absent") {
      throw new RecoverySafetyError("Recovery object disappeared before journal commit.");
    }
    await this.verifyGitPreconditions(state.originalHead, state.expectedIndex);
    await this.checkpoint("recovery-verified");
  }
  async moveOriginal(entry, state, gitDirectory) {
    if (!entry.hadOriginal) {
      state.moved.push(entry);
      return;
    }
    const details = await (0, import_promises12.lstat)(entry.target);
    if (!details.isFile() || details.isSymbolicLink()) {
      throw new RecoverySafetyError("Only regular files can enter recovery staging.");
    }
    await ensureContainedParent(gitDirectory, entry.recoveryPath);
    if (await fingerprint2(entry.recoveryPath) !== "absent") {
      throw new RecoverySafetyError("Recovery staging path already exists.");
    }
    await assertContainedParent(this.options.repositoryRoot, entry.target);
    await assertContainedParent(gitDirectory, entry.recoveryPath);
    await (0, import_promises12.rename)(entry.target, entry.recoveryPath);
    state.moved.push(entry);
    state.pathProgress[entry.relativePath] = journalProgress(entry, "moved");
    await this.writePendingJournal(state);
    await this.checkpoint("source-moved");
    if (await fingerprint2(entry.target) !== "absent") {
      throw new RecoverySafetyError("A path reappeared during the recovery transaction.");
    }
    await assertContainedParent(gitDirectory, entry.recoveryPath);
    const snapshot = await this.options.store.putObject(
      "recovery-" + state.transactionId,
      await (0, import_promises12.readFile)(entry.recoveryPath)
    );
    await this.options.store.readObject("recovery-" + state.transactionId, snapshot.hash);
    state.recoveryObjectHashes.push(snapshot.hash);
    await this.writePendingJournal(state);
  }
  async writeBase(entry, baseEntry, suppliedBaseBytes, state) {
    if (baseEntry && !isRegularFileMode(baseEntry.mode)) {
      throw new RecoverySafetyError("Only regular-file base entries can be restored.");
    }
    if (baseEntry) {
      await writeBaseFile(
        this.options.repositoryRoot,
        entry.target,
        suppliedBaseBytes ?? await this.git.readBlob(baseEntry.oid)
      );
      entry.writtenFingerprint = await fingerprint2(entry.target);
    }
    state.pathProgress[entry.relativePath] = journalProgress(entry, "written");
    await this.writePendingJournal(state);
    await this.checkpoint("base-written");
    if (await fingerprint2(entry.target) !== entry.writtenFingerprint) {
      throw new RecoverySafetyError("A transaction-written path changed before commit.");
    }
  }
  async updateIndex(entry, baseEntry, state) {
    await this.verifyGitPreconditions(state.originalHead, state.expectedIndex);
    await this.git.writeIndexEntry(entry.relativePath, baseEntry);
    entry.writtenIndexEntry = await this.git.getIndexEntry(entry.relativePath);
    entry.writtenIndexFingerprint = await this.git.getIndexPathFingerprint(entry.relativePath);
    if (!sameIndexEntry(entry.writtenIndexEntry, baseEntry)) {
      throw new RecoverySafetyError("Git did not restore the expected base index entry.");
    }
    state.expectedIndex = await this.currentIndexFingerprint();
    state.pathProgress[entry.relativePath] = journalProgress(entry, "written");
    await this.writePendingJournal(state);
    await this.checkpoint("index-updated");
  }
  async writePendingJournal(state) {
    await this.options.store.writeJournal({
      ...state.journal,
      pathProgress: state.pathProgress,
      expectedIndexFingerprint: state.expectedIndex,
      recoveryObjectHashes: state.recoveryObjectHashes
    });
  }
  async commitJournal(state) {
    await this.options.store.writeJournal({
      ...state.journal,
      state: "shelved",
      pathProgress: Object.fromEntries(
        Object.entries(state.pathProgress).map(([relativePath, progress2]) => [
          relativePath,
          { ...progress2, phase: "reverted" }
        ])
      ),
      expectedIndexFingerprint: state.expectedIndex,
      recoveryObjectHashes: state.recoveryObjectHashes
    });
  }
  async pendingMovedPaths(journal, gitDir) {
    const recoveryDirectory = recoveryDirectoryFor(gitDir, journal.id);
    const moved = [];
    for (const [relativePath, progress2] of Object.entries(journal.pathProgress)) {
      if (!isJournalPathProgress(progress2)) {
        throw new RecoverySafetyError(
          "Pending recovery journal has invalid path progress."
        );
      }
      const safeRelativePath = assertRepositoryRelativePath(relativePath);
      const target = resolveRepositoryPath(this.options.repositoryRoot, safeRelativePath);
      const recoveryPath = resolveRecoveryPath(recoveryDirectory, safeRelativePath);
      await assertContainedParentIfPresent(this.options.repositoryRoot, target);
      await assertContainedParentIfPresent(gitDir, recoveryPath);
      const targetFingerprint = await fingerprint2(target);
      const recoveryFingerprint = await fingerprint2(recoveryPath);
      if (progress2.phase === "planned") {
        if (!progress2.hadOriginal) {
          if (targetFingerprint === "absent" && recoveryFingerprint === "absent")
            continue;
          throw new RecoverySafetyError(
            "Planned recovery path has ambiguous filesystem state."
          );
        }
        if (targetFingerprint !== "absent" && recoveryFingerprint === "absent") continue;
        if (targetFingerprint !== "absent" || recoveryFingerprint === "non-regular") {
          throw new RecoverySafetyError(
            "Planned recovery path has ambiguous filesystem state."
          );
        }
      }
      if (progress2.hadOriginal && recoveryFingerprint === "absent") {
        throw new RecoverySafetyError("Pending recovery original is missing.");
      }
      moved.push({
        relativePath: safeRelativePath,
        target,
        recoveryPath,
        hadOriginal: progress2.hadOriginal,
        originalIndexEntry: progress2.originalIndexEntry,
        originalIndexFingerprint: progress2.originalIndexFingerprint,
        writtenFingerprint: progress2.writtenFingerprint,
        writtenIndexEntry: progress2.writtenIndexEntry ?? progress2.originalIndexEntry,
        writtenIndexFingerprint: progress2.writtenIndexFingerprint
      });
    }
    return moved;
  }
  async verifyGitPreconditions(originalHead, expectedIndex) {
    if (await this.currentHead() !== originalHead) {
      throw new RecoverySafetyError("HEAD changed during the shelf recovery transaction.");
    }
    if (await this.currentIndexFingerprint() !== expectedIndex) {
      throw new RecoverySafetyError("Index changed during the shelf recovery transaction.");
    }
  }
  async currentHead() {
    return this.options.getHead ? this.options.getHead() : this.git.getHead();
  }
  async currentIndexFingerprint() {
    return this.options.getIndexFingerprint ? this.options.getIndexFingerprint() : this.git.getIndexFingerprint();
  }
  async checkpoint(checkpoint) {
    await this.options.checkpoint?.(checkpoint);
  }
};
async function purgeRecoverySnapshots(options) {
  const recoveryRoot = resolveRecoveryPath(options.gitDir, import_node_path12.default.join("intelligit", "recovery"));
  let transactionIds;
  try {
    await assertContainedParentIfPresent(options.gitDir, recoveryRoot);
    const rootDetails = await (0, import_promises12.lstat)(recoveryRoot);
    if (!rootDetails.isDirectory() || rootDetails.isSymbolicLink()) {
      throw new RecoverySafetyError("Recovery staging root is not a regular directory.");
    }
    transactionIds = await (0, import_promises12.readdir)(recoveryRoot);
  } catch (error) {
    if (isNotFound3(error)) return [];
    throw error;
  }
  const now = options.now ?? Date.now();
  const purged = [];
  for (const transactionId of [...transactionIds].sort()) {
    const target = resolveRecoveryPath(recoveryRoot, assertIdentifier(transactionId));
    await assertContainedParent(options.gitDir, target);
    const details = await (0, import_promises12.lstat)(target);
    if (details.isSymbolicLink()) {
      throw new RecoverySafetyError(
        "Recovery staging transaction is not a regular directory."
      );
    }
    if (!details.isDirectory() || options.minimumRetentionMs > 0 && now - details.mtimeMs < options.minimumRetentionMs)
      continue;
    await assertContainedParent(options.gitDir, target);
    await (0, import_promises12.rm)(target, { recursive: true, force: false });
    purged.push(transactionId);
  }
  return purged;
}
async function rollbackMovedPaths(moved, repositoryRoot, gitDirectory, git, expectedIndexFingerprint) {
  const retained = [];
  for (const entry of [...moved].reverse()) {
    try {
      await assertContainedParentIfPresent(gitDirectory, entry.recoveryPath);
      if (!await matchesWrittenIndexState(entry, git, expectedIndexFingerprint)) {
        retained.push(entry.relativePath);
        continue;
      }
      if (await fingerprint2(entry.target) !== entry.writtenFingerprint) {
        retained.push(entry.relativePath);
        continue;
      }
      const recoveryFingerprint = entry.hadOriginal ? await fingerprint2(entry.recoveryPath) : "absent";
      if (entry.hadOriginal && (recoveryFingerprint === "absent" || recoveryFingerprint === "non-regular")) {
        retained.push(entry.relativePath);
        continue;
      }
      await git.writeIndexEntry(entry.relativePath, entry.originalIndexEntry);
      if (!await matchesOriginalIndexState(entry, git)) {
        retained.push(entry.relativePath);
        continue;
      }
      if (entry.writtenIndexFingerprint === void 0) {
        expectedIndexFingerprint = await git.getIndexFingerprint();
      }
      if (entry.writtenFingerprint !== "absent") {
        await assertContainedParent(repositoryRoot, entry.target);
        await (0, import_promises12.rm)(entry.target, { force: true });
      }
      if (entry.hadOriginal) {
        await ensureContainedParent(repositoryRoot, entry.target);
        if (await fingerprint2(entry.target) !== "absent") {
          retained.push(entry.relativePath);
          continue;
        }
        await assertContainedParent(gitDirectory, entry.recoveryPath);
        await (0, import_promises12.rename)(entry.recoveryPath, entry.target);
      }
    } catch {
      retained.push(entry.relativePath);
    }
  }
  return retained.reverse();
}
async function matchesWrittenIndexState(entry, git, expectedIndexFingerprint) {
  if (!sameIndexEntry(await git.getIndexEntry(entry.relativePath), entry.writtenIndexEntry)) {
    return false;
  }
  return entry.writtenIndexFingerprint !== void 0 ? await git.getIndexPathFingerprint(entry.relativePath) === entry.writtenIndexFingerprint : expectedIndexFingerprint === void 0 || await git.getIndexFingerprint() === expectedIndexFingerprint;
}
async function matchesOriginalIndexState(entry, git) {
  if (!sameIndexEntry(await git.getIndexEntry(entry.relativePath), entry.originalIndexEntry)) {
    return false;
  }
  return entry.originalIndexFingerprint === void 0 || await git.getIndexPathFingerprint(entry.relativePath) === entry.originalIndexFingerprint;
}
async function writeBaseFile(repositoryRoot, target, bytes) {
  await ensureContainedParent(repositoryRoot, target);
  if (await fingerprint2(target) !== "absent") {
    throw new RecoverySafetyError("Refusing to replace an existing recovery target.");
  }
  const file = await (0, import_promises12.open)(
    target,
    import_node_fs5.constants.O_WRONLY | import_node_fs5.constants.O_CREAT | import_node_fs5.constants.O_EXCL | resolveNoFollowFlag(),
    384
  );
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  await (0, import_promises12.chmod)(target, 384);
  const details = await (0, import_promises12.lstat)(target);
  if (details.isSymbolicLink() || !details.isFile()) {
    throw new RecoverySafetyError("Base write did not create a regular file.");
  }
  await assertContainedParent(repositoryRoot, target);
}
function journalProgress(entry, phase) {
  return {
    phase,
    target: entry.target,
    recoveryPath: entry.recoveryPath,
    hadOriginal: entry.hadOriginal,
    writtenFingerprint: entry.writtenFingerprint,
    originalIndexEntry: entry.originalIndexEntry,
    writtenIndexEntry: entry.writtenIndexEntry,
    originalIndexFingerprint: entry.originalIndexFingerprint,
    writtenIndexFingerprint: entry.writtenIndexFingerprint
  };
}
function isJournalPathProgress(value) {
  if (!value || typeof value !== "object") return false;
  const progress2 = value;
  return (progress2.phase === "planned" || progress2.phase === "moved" || progress2.phase === "written" || progress2.phase === "reverted") && typeof progress2.target === "string" && typeof progress2.recoveryPath === "string" && typeof progress2.hadOriginal === "boolean" && typeof progress2.writtenFingerprint === "string" && isOptionalIndexEntry(progress2.originalIndexEntry) && isOptionalIndexEntry(progress2.writtenIndexEntry) && isIndexFingerprintPair(progress2.originalIndexFingerprint, progress2.writtenIndexFingerprint);
}
function isOptionalIndexEntry(value) {
  return value === void 0 || isIndexEntry(value);
}
function isIndexFingerprintPair(original, written) {
  return original === void 0 && written === void 0 || isIndexFingerprint(original) && isIndexFingerprint(written);
}
function isIndexEntry(value) {
  return !!value && typeof value === "object" && "mode" in value && "oid" in value && typeof value.mode === "string" && typeof value.oid === "string" && /^[0-7]{1,6}$/.test(value.mode) && /^[a-f0-9]{40,64}$/.test(value.oid);
}
function sameIndexEntry(left, right) {
  return left?.mode === right?.mode && left?.oid === right?.oid;
}
function isRegularFileMode(mode) {
  return mode === "100644" || mode === "100755";
}
async function fingerprint2(target) {
  try {
    const details = await (0, import_promises12.lstat)(target);
    if (!details.isFile() || details.isSymbolicLink()) {
      return "non-regular";
    }
    return `${(details.mode & 4095).toString(8)}:${(0, import_node_crypto9.createHash)("sha256").update(await (0, import_promises12.readFile)(target)).digest("hex")}`;
  } catch (error) {
    if (isNotFound3(error)) return "absent";
    throw error;
  }
}
async function isSameFilesystem(repositoryRoot, gitDir) {
  const [worktree, git] = await Promise.all([(0, import_promises12.stat)(repositoryRoot), (0, import_promises12.stat)(gitDir)]);
  return worktree.dev === git.dev;
}
function assertIdentifier(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value))
    throw new RecoverySafetyError("Invalid recovery transaction ID.");
  return value;
}
function recoveryDirectoryFor(gitDirectory, transactionId) {
  return resolveRecoveryPath(
    gitDirectory,
    import_node_path12.default.join("intelligit", "recovery", assertIdentifier(transactionId))
  );
}
function isNotFound3(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
function isIndexFingerprint(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

// baseline:src/shelf/store.ts
var import_node_crypto11 = require("node:crypto");
var import_node_async_hooks = require("node:async_hooks");
var import_promises14 = require("node:fs/promises");
var import_node_path14 = __toESM(require("node:path"));

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

// baseline:src/shelf/paths.ts
var import_node_crypto10 = require("node:crypto");
var import_promises13 = require("node:fs/promises");
var import_node_path13 = __toESM(require("node:path"));
var ShelfPathError = class extends Error {
  /** Creates a path error suitable for callers to surface directly. */
  constructor(message) {
    super(message);
    this.name = "ShelfPathError";
  }
};
async function resolveShelfPaths(options) {
  const repositoryRoot = import_node_path13.default.normalize(await (0, import_promises13.realpath)(options.repositoryRoot));
  const repoId = (0, import_node_crypto10.createHash)("sha256").update(repositoryRoot).digest("hex").slice(0, 16);
  const scopeRoot = import_node_path13.default.resolve(options.overridePath ?? options.globalStoragePath);
  const storageBase = options.overridePath ? scopeRoot : import_node_path13.default.join(scopeRoot, "shelves");
  return {
    repoId,
    root: import_node_path13.default.join(storageBase, repoId),
    scopeRoot,
    storageBase
  };
}
async function ensureShelfRoot(paths) {
  await ensurePrivateDirectory(paths.scopeRoot);
  await ensurePrivateDirectory(paths.storageBase);
  await ensurePrivateDirectory(paths.root);
}
function resolveShelfInternalPath(paths, relativePath) {
  if (!relativePath || import_node_path13.default.isAbsolute(relativePath)) {
    throw new ShelfPathError("Shelf artifact path must be a non-empty relative path.");
  }
  const target = import_node_path13.default.resolve(paths.root, relativePath);
  const relative = import_node_path13.default.relative(paths.root, target);
  if (relative === "" || relative === ".." || relative.startsWith(`..${import_node_path13.default.sep}`) || import_node_path13.default.isAbsolute(relative)) {
    throw new ShelfPathError("Shelf artifact path escapes the shelf root.");
  }
  return target;
}
async function ensureShelfInternalParent(paths, relativePath) {
  const target = resolveShelfInternalPath(paths, relativePath);
  await ensureShelfRoot(paths);
  await verifyInternalParent(paths.root, import_node_path13.default.dirname(target), true);
  return target;
}
async function assertShelfInternalParent(paths, relativePath) {
  const target = resolveShelfInternalPath(paths, relativePath);
  await ensureShelfRoot(paths);
  await verifyInternalParent(paths.root, import_node_path13.default.dirname(target), false);
  return target;
}
async function ensurePrivateDirectory(directory) {
  const absolute = import_node_path13.default.resolve(directory);
  const parsed = import_node_path13.default.parse(absolute);
  const parts = absolute.slice(parsed.root.length).split(import_node_path13.default.sep).filter(Boolean);
  if (parts.length === 0)
    throw new ShelfPathError("Shelf storage root cannot be the filesystem root.");
  let current = parsed.root;
  for (const part of parts) {
    const candidate = import_node_path13.default.join(current, part);
    let details;
    try {
      details = await (0, import_promises13.lstat)(candidate);
    } catch (error) {
      if (!isNotFound4(error)) throw error;
      details = await createDirectoryAfterMiss(candidate);
    }
    if (details.isSymbolicLink()) {
      if (isTrustedSystemAlias(candidate)) {
        current = await (0, import_promises13.realpath)(candidate);
        continue;
      }
      throw new ShelfPathError(`Shelf storage root is not a real directory: ${candidate}`);
    }
    if (!details.isDirectory()) {
      throw new ShelfPathError(`Shelf storage root is not a real directory: ${candidate}`);
    }
    current = candidate;
  }
  await (0, import_promises13.chmod)(absolute, 448);
}
async function verifyInternalParent(rootPath, directory, createMissing) {
  const rootLexical = import_node_path13.default.resolve(rootPath);
  const parentLexical = import_node_path13.default.resolve(directory);
  const relative = import_node_path13.default.relative(rootLexical, parentLexical);
  if (relative === ".." || relative.startsWith(`..${import_node_path13.default.sep}`) || import_node_path13.default.isAbsolute(relative)) {
    throw new ShelfPathError("Shelf artifact path escapes the shelf root.");
  }
  const root = await (0, import_promises13.realpath)(rootPath);
  if (relative === "") return;
  let current = root;
  for (const part of relative.split(import_node_path13.default.sep)) {
    const candidate = import_node_path13.default.join(current, part);
    let details;
    try {
      details = await (0, import_promises13.lstat)(candidate);
    } catch (error) {
      if (!isNotFound4(error)) throw error;
      if (!createMissing) throw error;
      details = await createDirectoryAfterMiss(candidate);
    }
    if (details.isSymbolicLink() || !details.isDirectory()) {
      throw new ShelfPathError(`Shelf artifact parent is not a real directory: ${candidate}`);
    }
    current = await (0, import_promises13.realpath)(candidate);
    assertContained2(root, current);
  }
}
async function createDirectoryAfterMiss(directory) {
  try {
    await (0, import_promises13.mkdir)(directory, { mode: 448 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  return (0, import_promises13.lstat)(directory);
}
function assertContained2(root, candidate) {
  const relative = import_node_path13.default.relative(root, candidate);
  if (relative === ".." || relative.startsWith(`..${import_node_path13.default.sep}`) || import_node_path13.default.isAbsolute(relative)) {
    throw new ShelfPathError("Shelf artifact path escapes the shelf root.");
  }
}
function isTrustedSystemAlias(candidate) {
  return process.platform === "darwin" && (candidate === "/tmp" || candidate === "/var");
}
function isNotFound4(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

// baseline:src/shelf/model.ts
var ShelfPersistenceContractError = class extends Error {
  /** Creates a stable storage-boundary validation error. */
  constructor() {
    super("Invalid persisted shelf contract.");
    this.name = "ShelfPersistenceContractError";
  }
};
var ShelfUnsupportedStateError = class extends Error {
  /** Creates a stable error for a rejected change. */
  constructor(changeId, state) {
    super(`Cannot shelve ${changeId}: ${state} is unsupported.`);
    this.changeId = changeId;
    this.state = state;
    this.name = "ShelfUnsupportedStateError";
  }
  changeId;
  state;
};
function assertShelfStateSupported(changeId, state) {
  throw new ShelfUnsupportedStateError(changeId, state);
}
function selectWholeShelfEntries(entries, changeIds2) {
  const selected = changeIds2 instanceof Set ? changeIds2 : new Set(changeIds2);
  return entries.filter((entry) => selected.has(entry.changeId));
}
function parseShelfPersistenceContract(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw contractError();
  const candidate = value;
  if (!Array.isArray(candidate.files)) throw contractError();
  const metadata = parseMetadata(candidate.metadata);
  const files = candidate.files.map(parseFileEntry);
  if (new Set(files.map((file) => file.changeId)).size !== files.length) throw contractError();
  return { metadata, files };
}
function parseMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw contractError();
  const metadata = value;
  if (typeof metadata.name !== "string" || metadata.name.trim().length === 0 || metadata.name.length > 255 || metadata.name.includes("\0") || !isLifecycle(metadata.lifecycle) || metadata.baseCommit !== void 0 && !isGitObjectId(metadata.baseCommit) || metadata.appliedAt !== void 0 && (!Number.isSafeInteger(metadata.appliedAt) || metadata.appliedAt < 0) || metadata.createdAt !== void 0 && (!Number.isSafeInteger(metadata.createdAt) || metadata.createdAt < 0)) {
    throw contractError();
  }
  return {
    name: metadata.name,
    baseCommit: metadata.baseCommit,
    lifecycle: metadata.lifecycle,
    createdAt: metadata.createdAt,
    appliedAt: metadata.appliedAt
  };
}
function parseFileEntry(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw contractError();
  const entry = value;
  if (!isChangeId(entry.changeId) || !isOptionalLayer(entry.indexBlock) || !isOptionalLayer(entry.worktreeBlock) || !entry.indexBlock && !entry.worktreeBlock || typeof entry.binary !== "boolean" || typeof entry.untracked !== "boolean" || !isBaseAvailability(entry.baseAvailability) || typeof entry.exactReconstruction !== "boolean" || !isLifecycle(entry.lifecycle)) {
    throw contractError();
  }
  const indexBlock = entry.indexBlock ? parseLayerBlock(entry.indexBlock) : void 0;
  const worktreeBlock = entry.worktreeBlock ? parseLayerBlock(entry.worktreeBlock) : void 0;
  const blocks = [indexBlock, worktreeBlock].filter(
    (block) => block !== void 0
  );
  if (blocks.some((block) => !block.patchObjectHash)) throw contractError();
  if (entry.baseAvailability === "full" && blocks.some((block) => !block.baseObjectHash)) {
    throw contractError();
  }
  if (!entry.exactReconstruction && (!worktreeBlock?.rawBeforeObjectHash || !worktreeBlock.rawAfterObjectHash)) {
    throw contractError();
  }
  return {
    changeId: entry.changeId,
    indexBlock,
    worktreeBlock,
    binary: entry.binary,
    untracked: entry.untracked,
    baseAvailability: entry.baseAvailability,
    exactReconstruction: entry.exactReconstruction,
    lifecycle: entry.lifecycle
  };
}
function isOptionalLayer(value) {
  return value === void 0 || !!value && typeof value === "object" && !Array.isArray(value);
}
function parseLayerBlock(value) {
  if (!isSafeShelfRelativePath(value.path) || value.renamedFrom !== void 0 && !isSafeShelfRelativePath(value.renamedFrom) || !isChangeStatus(value.status) || !isOptionalMode(value.modeBefore) || !isOptionalMode(value.modeAfter) || !isOptionalHash(value.beforeContentHash) || !isOptionalHash(value.afterContentHash) || !isOptionalHash(value.patchObjectHash) || !isOptionalHash(value.baseObjectHash) || !isOptionalHash(value.rawBeforeObjectHash) || !isOptionalHash(value.rawAfterObjectHash)) {
    throw contractError();
  }
  return { ...value };
}
function isChangeId(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}
function isChangeStatus(value) {
  return value === "M" || value === "A" || value === "D" || value === "R" || value === "T";
}
function isBaseAvailability(value) {
  return value === "full" || value === "history" || value === "none";
}
function isLifecycle(value) {
  return value === "shelved" || value === "applied" || value === "retained";
}
function isOptionalMode(value) {
  return value === void 0 || typeof value === "string" && /^[0-7]{6}$/.test(value);
}
function isOptionalHash(value) {
  return value === void 0 || typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function isGitObjectId(value) {
  return typeof value === "string" && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value);
}
function contractError() {
  return new ShelfPersistenceContractError();
}

// baseline:src/shelf/persistence.ts
function assertPersistedObjectReferences(persistence, objectHashes) {
  if (!objectHashes.every(isShelfObjectHash)) throw new ShelfPersistenceContractError();
  const available = new Set(objectHashes);
  for (const entry of persistence.files) {
    for (const block of [entry.indexBlock, entry.worktreeBlock]) {
      if (!block) continue;
      for (const hash of [
        block.patchObjectHash,
        block.baseObjectHash,
        block.rawBeforeObjectHash,
        block.rawAfterObjectHash
      ]) {
        if (hash && !available.has(hash)) throw new ShelfPersistenceContractError();
      }
    }
  }
}
function isShelfObjectHash(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

// baseline:src/shelf/store.ts
var SCHEMA_VERSION = 1;
var STORE_LOCK_FILE = "store.lock";
var ShelfStoreCorruptionError = class extends Error {
  /** Creates a corruption error with a safe storage-facing message. */
  constructor(message) {
    super(message);
    this.name = "ShelfStoreCorruptionError";
  }
};
var ShelfStaleShelfError = class extends Error {
  /** Records the caller's expected generation and the generation observed under the store lock. */
  constructor(expectedGeneration, actualGeneration) {
    super("Shelf generation is stale.");
    this.expectedGeneration = expectedGeneration;
    this.actualGeneration = actualGeneration;
    this.name = "ShelfStaleShelfError";
  }
  expectedGeneration;
  actualGeneration;
};
var ShelfStaleCatalogError = class extends Error {
  /** Records the caller's expected and lock-observed catalog generations. */
  constructor(expectedGeneration, actualGeneration) {
    super("Shelf catalog generation is stale.");
    this.expectedGeneration = expectedGeneration;
    this.actualGeneration = actualGeneration;
    this.name = "ShelfStaleCatalogError";
  }
  expectedGeneration;
  actualGeneration;
};
var ShelfStore = class {
  /** Creates a store rooted at one repository-scoped shelf path. */
  constructor(paths, options = {}) {
    this.paths = paths;
    this.options = options;
    this.lock = new RepositoryLock({
      lockDirectory: import_node_path14.default.join(paths.root, ".store-lock"),
      lockFileName: STORE_LOCK_FILE
    });
  }
  paths;
  options;
  lock;
  lockContext = new import_node_async_hooks.AsyncLocalStorage();
  /** Runs one storage mutation with the reusable nonce/heartbeat store lock. */
  async withLock(operation) {
    if (this.lockContext.getStore()) return operation();
    await ensureShelfRoot(this.paths);
    await ensureShelfInternalParent(this.paths, import_node_path14.default.join(".store-lock", STORE_LOCK_FILE));
    const release = await this.acquireWithBriefWait();
    try {
      return await this.lockContext.run(true, operation);
    } finally {
      await release();
    }
  }
  /**
   * Retries a busy store lock for a bounded window, mirroring the repository gate.
   *
   * Not every caller of this lock holds that gate first. `ShelfService.listShelves`
   * reads the catalog outside it, so without a wait an ordinary shelf mutation in
   * another window makes the panel's own read fail rather than queue behind it --
   * and the panel falls back to cached shelves, showing stale state with no error.
   * A persistent owner still surfaces busy once the window is spent.
   *
   * The window is deliberately shorter than the repository gate's 5s. That gate
   * guards a mutation the user just asked for, where waiting is the expected cost.
   * This one is reached from the commit panel's aggregate refresh, which acquires
   * twice per pass and runs alongside working-tree status, stashes and ahead/behind
   * -- so its wait is a stall on unrelated data. A second covers the shelf mutations
   * that actually caused this (hundreds of milliseconds); anything slower was always
   * going to land on the panel's cached-shelf fallback, and reaching it sooner beats
   * holding the whole refresh to find out.
   */
  async acquireWithBriefWait() {
    return acquireWithBoundedWait(() => this.lock.acquire(this.paths.root), {
      timeoutMs: this.options.acquireTimeoutMs ?? 1e3,
      retryDelayMs: this.options.acquireRetryDelayMs ?? 150
    });
  }
  /** Stores a byte object once beneath its shelf and verifies pre-existing content. */
  async putObject(shelfId, contents) {
    return this.withLock(async () => {
      const hash = hashBytes(contents);
      const target = await this.writableTarget(this.objectPath(shelfId, hash));
      try {
        await writeAtomicExclusive(target, contents);
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        await assertNotSymlink(target);
        const existing = await (0, import_promises14.readFile)(target);
        if (hashBytes(existing) !== hash) {
          throw new ShelfStoreCorruptionError("Object path content hash mismatch.");
        }
      }
      return { hash };
    });
  }
  /** Reads an immutable object only after verifying its address checksum. */
  async readObject(shelfId, hash) {
    const target = await this.readableTarget(this.objectPath(shelfId, hash));
    await assertNotSymlink(target);
    const object = await (0, import_promises14.readFile)(target);
    if (hashBytes(object) !== hash) {
      throw new ShelfStoreCorruptionError("Shelf object checksum mismatch.");
    }
    return object;
  }
  /** Adds a manifest generation, then atomically advances the small current pointer. */
  async writeGeneration(shelfId, input) {
    return this.withLock(async () => {
      const persistence = validatePersistenceInput(input);
      if (persistence) assertPersistedObjectReferences(persistence, input.objectHashes);
      const generation = await this.nextGeneration(shelfId);
      await this.writableTarget(this.generationDirectory(shelfId, generation));
      await (0, import_promises14.mkdir)(this.generationDirectory(shelfId, generation), { mode: 448 });
      const manifest = {
        schemaVersion: SCHEMA_VERSION,
        generation,
        objectHashes: [...input.objectHashes],
        files: persistence ? persistence.files : [...input.files],
        metadata: persistence?.metadata,
        checksum: ""
      };
      const complete = {
        ...manifest,
        checksum: checksumManifest(manifest)
      };
      const manifestPath = this.manifestPath(shelfId, generation);
      await this.writeAtomic(manifestPath, encodeJson(complete));
      await this.options.beforeCurrentPointerRename?.();
      await this.writeAtomic(
        this.currentPath(shelfId),
        Buffer.from(String(generation) + "\n")
      );
      await this.addShelfToCatalog(shelfId);
      return complete;
    });
  }
  /** Persists a typed shelf generation and advances its immutable current pointer. */
  async writeShelfGeneration(shelfId, input) {
    const manifest = await this.writeGeneration(shelfId, input);
    const persistence = parseShelfPersistenceContract({
      metadata: manifest.metadata,
      files: manifest.files
    });
    return { ...manifest, ...persistence };
  }
  /** Reads and checks the generation selected by the atomic pointer. */
  async readCurrentManifest(shelfId) {
    return this.readManifest(shelfId, await this.readCurrentGeneration(shelfId));
  }
  /** Reads the typed immutable manifest selected by the current pointer. */
  async readCurrentShelfManifest(shelfId) {
    const manifest = await this.readCurrentManifest(shelfId);
    const persistence = parseManifestPersistence(manifest.metadata, manifest.files);
    if (!persistence) throw new ShelfStoreCorruptionError("Missing persisted shelf contract.");
    return { ...manifest, ...persistence };
  }
  /** Runs a mutation after atomically verifying requested shelf and catalog generations. */
  async withGenerationCas(expected, operation) {
    return this.withLock(async () => {
      if (expected.expectedShelfGeneration !== void 0 && (!expected.shelfId || !isGeneration(expected.expectedShelfGeneration))) {
        throw new Error("Shelf generation CAS requires a shelf ID and safe generation.");
      }
      if (expected.expectedCatalogGeneration !== void 0 && !isGeneration(expected.expectedCatalogGeneration)) {
        throw new Error("Catalog generation CAS requires a safe generation.");
      }
      if (expected.expectedCatalogGeneration !== void 0) {
        const catalog = await this.readCatalog();
        if (catalog.catalogGeneration !== expected.expectedCatalogGeneration) {
          throw new ShelfStaleCatalogError(
            expected.expectedCatalogGeneration,
            catalog.catalogGeneration
          );
        }
      }
      if (expected.expectedShelfGeneration !== void 0 && expected.shelfId) {
        const actualGeneration = await this.currentGenerationOrUndefined(expected.shelfId);
        if (actualGeneration !== expected.expectedShelfGeneration) {
          throw new ShelfStaleShelfError(
            expected.expectedShelfGeneration,
            actualGeneration
          );
        }
      }
      return operation();
    });
  }
  /** Lists usable shelves plus corrupt IDs which callers must surface. */
  async listShelves() {
    return this.withLock(async () => {
      const catalog = await this.readCatalog();
      const root = resolveShelfInternalPath(this.paths, "shelves");
      let entries;
      try {
        entries = await (0, import_promises14.readdir)(await this.readableDirectory(root));
      } catch (error) {
        if (isNotFound5(error)) entries = [];
        else throw error;
      }
      const shelfIds = [];
      const corruptShelfIds = [];
      for (const shelfId of [...entries].sort()) {
        try {
          await this.readCurrentManifest(shelfId);
          shelfIds.push(shelfId);
        } catch {
          corruptShelfIds.push(shelfId);
        }
      }
      return { shelfIds, corruptShelfIds, catalogGeneration: catalog.catalogGeneration };
    });
  }
  /** Deletes one complete shelf generation tree while preserving separate recovery snapshots. */
  async deleteShelf(shelfId) {
    return this.withLock(async () => {
      const target = await this.writableTarget(this.shelfDirectory(shelfId));
      await assertNotSymlink(target);
      await this.readCurrentManifest(shelfId);
      const catalog = await this.readCatalog();
      await (0, import_promises14.rm)(target, { recursive: true, force: false });
      if (!catalog.shelves.includes(shelfId)) return;
      await this.writeCatalog({
        ...catalog,
        catalogGeneration: catalog.catalogGeneration + 1,
        shelves: catalog.shelves.filter((id) => id !== shelfId)
      });
    });
  }
  /** Records a durable result before returning so retried requests replay safely. */
  async runIdempotent(request, operation) {
    return this.withLock(async () => {
      const catalog = await this.readCatalog();
      const payloadHash = hashBytes(request.payload);
      const existing = catalog.ledger[request.token];
      if (existing) {
        if (existing.operation !== request.operation || existing.payloadHash !== payloadHash) {
          throw new Error("Idempotency token already used with a different payload.");
        }
        return existing.result;
      }
      const result = await operation();
      const catalogAfterOperation = await this.readCatalog();
      const next = {
        ...catalogAfterOperation,
        catalogGeneration: catalogAfterOperation.catalogGeneration + 1,
        ledger: {
          ...catalogAfterOperation.ledger,
          [request.token]: {
            operation: request.operation,
            payloadHash,
            result
          }
        }
      };
      await this.writeCatalog(next);
      return result;
    });
  }
  /** Removes only unreferenced immutable objects, never a current or journal reference. */
  async collectGarbage(shelfId) {
    return this.withLock(async () => {
      const reachable = new Set((await this.readCurrentManifest(shelfId)).objectHashes);
      for (const journal of await this.readJournals()) {
        for (const hash of journal.recoveryObjectHashes ?? []) reachable.add(hash);
      }
      const directory = this.objectsDirectory(shelfId);
      let candidates;
      try {
        candidates = await (0, import_promises14.readdir)(await this.readableDirectory(directory));
      } catch (error) {
        if (isNotFound5(error)) return [];
        throw error;
      }
      const removed = [];
      for (const hash of [...candidates].sort()) {
        if (!reachable.has(hash)) {
          await (0, import_promises14.rm)(await this.readableTarget(import_node_path14.default.join(directory, hash)), {
            force: true
          });
          removed.push(hash);
        }
      }
      return removed;
    });
  }
  /** Stores a full journal snapshot for resume/rollback rather than mutating it in place. */
  async writeJournal(journal) {
    await this.withLock(async () => {
      await this.writeAtomic(this.journalPath(journal.id), encodeJson(journal));
    });
  }
  /** Transitions an existing journal to its next durable state. */
  async transitionJournal(id, state) {
    await this.withLock(async () => {
      const journal = await this.readJournal(id);
      await this.writeAtomic(this.journalPath(id), encodeJson({ ...journal, state }));
    });
  }
  /** Deletes a completed pending journal only after recovery has reached a terminal outcome. */
  async deleteJournal(id) {
    await this.withLock(async () => {
      await (0, import_promises14.rm)(await this.readableTarget(this.journalPath(id)), { force: true });
    });
  }
  /** Returns pending and retained transaction snapshots in deterministic order. */
  async readJournals() {
    const directory = resolveShelfInternalPath(this.paths, "journals");
    let files;
    try {
      files = await (0, import_promises14.readdir)(await this.readableDirectory(directory));
    } catch (error) {
      if (isNotFound5(error)) return [];
      throw error;
    }
    return Promise.all(
      files.filter((file) => file.endsWith(".json")).sort().map((file) => this.readJournal(file.slice(0, -".json".length)))
    );
  }
  async readJournal(id) {
    const target = await this.readableTarget(this.journalPath(id));
    await assertNotSymlink(target);
    return parseJournal2(await (0, import_promises14.readFile)(target, "utf8"));
  }
  async readManifest(shelfId, generation) {
    const target = await this.readableTarget(this.manifestPath(shelfId, generation));
    await assertNotSymlink(target);
    const parsed = parseManifest(await (0, import_promises14.readFile)(target, "utf8"));
    if (parsed.generation !== generation || parsed.checksum !== checksumManifest({ ...parsed, checksum: "" })) {
      throw new ShelfStoreCorruptionError("Shelf manifest checksum mismatch.");
    }
    return parsed;
  }
  async nextGeneration(shelfId) {
    let currentGeneration = 0;
    try {
      currentGeneration = await this.readCurrentGeneration(shelfId);
    } catch (error) {
      if (!isNotFound5(error)) throw error;
    }
    if (currentGeneration > 0) {
      currentGeneration = (await this.readManifest(shelfId, currentGeneration)).generation;
    }
    let storedGeneration = 0;
    try {
      for (const entry of await (0, import_promises14.readdir)(
        await this.readableDirectory(this.shelfDirectory(shelfId))
      )) {
        const match = /^gen-([1-9]\d*)$/.exec(entry);
        const generation = match ? Number(match[1]) : Number.NaN;
        if (Number.isSafeInteger(generation))
          storedGeneration = Math.max(storedGeneration, generation);
      }
    } catch (error) {
      if (!isNotFound5(error)) throw error;
    }
    return Math.max(currentGeneration, storedGeneration) + 1;
  }
  async readCurrentGeneration(shelfId) {
    const target = await this.readableTarget(this.currentPath(shelfId));
    await assertNotSymlink(target);
    const pointer = (await (0, import_promises14.readFile)(target, "utf8")).trim();
    const generation = Number(pointer);
    if (!Number.isSafeInteger(generation) || generation < 1) {
      throw new ShelfStoreCorruptionError("Invalid shelf generation pointer.");
    }
    return generation;
  }
  async currentGenerationOrUndefined(shelfId) {
    try {
      return await this.readCurrentGeneration(shelfId);
    } catch (error) {
      if (isNotFound5(error)) return void 0;
      throw error;
    }
  }
  generationDirectory(shelfId, generation) {
    return import_node_path14.default.join(this.shelfDirectory(shelfId), "gen-" + String(generation));
  }
  async addShelfToCatalog(shelfId) {
    const catalog = await this.readCatalog();
    if (catalog.shelves.includes(shelfId)) return;
    await this.writeCatalog({
      ...catalog,
      catalogGeneration: catalog.catalogGeneration + 1,
      shelves: [...catalog.shelves, shelfId].sort()
    });
  }
  async readCatalog() {
    try {
      const target = await this.readableTarget(this.catalogPath());
      await assertNotSymlink(target);
      return parseCatalog(await (0, import_promises14.readFile)(target, "utf8"));
    } catch (error) {
      if (isNotFound5(error)) {
        return {
          schemaVersion: SCHEMA_VERSION,
          catalogGeneration: 0,
          shelves: [],
          ledger: {}
        };
      }
      throw error;
    }
  }
  async writeCatalog(catalog) {
    await this.writeAtomic(this.catalogPath(), encodeJson(catalog));
  }
  catalogPath() {
    return resolveShelfInternalPath(this.paths, "catalog.json");
  }
  shelfDirectory(shelfId) {
    return resolveShelfInternalPath(this.paths, import_node_path14.default.join("shelves", assertShelfId(shelfId)));
  }
  objectsDirectory(shelfId) {
    return import_node_path14.default.join(this.shelfDirectory(shelfId), "objects");
  }
  objectPath(shelfId, hash) {
    return import_node_path14.default.join(this.objectsDirectory(shelfId), assertHash(hash));
  }
  manifestPath(shelfId, generation) {
    return import_node_path14.default.join(this.generationDirectory(shelfId, generation), "manifest.json");
  }
  currentPath(shelfId) {
    return import_node_path14.default.join(this.shelfDirectory(shelfId), "current");
  }
  journalPath(id) {
    return resolveShelfInternalPath(
      this.paths,
      import_node_path14.default.join("journals", assertShelfId(id) + ".json")
    );
  }
  async writableTarget(target) {
    return ensureShelfInternalParent(this.paths, this.relativeToShelfRoot(target));
  }
  async readableTarget(target) {
    return assertShelfInternalParent(this.paths, this.relativeToShelfRoot(target));
  }
  async readableDirectory(directory) {
    await this.readableTarget(import_node_path14.default.join(directory, ".directory-guard"));
    const details = await (0, import_promises14.lstat)(directory);
    if (details.isSymbolicLink() || !details.isDirectory()) {
      throw new ShelfPathError(`Shelf artifact parent is not a real directory: ${directory}`);
    }
    return directory;
  }
  async writeAtomic(target, contents) {
    await writeAtomic(await this.writableTarget(target), contents);
  }
  relativeToShelfRoot(target) {
    const relative = import_node_path14.default.relative(this.paths.root, target);
    if (!relative || relative === ".." || relative.startsWith(".." + import_node_path14.default.sep) || import_node_path14.default.isAbsolute(relative)) {
      throw new ShelfPathError("Shelf artifact path escapes the shelf root.");
    }
    return relative;
  }
};
async function writeAtomic(target, contents) {
  await assertNotSymlink(target);
  const temporary = import_node_path14.default.join(
    import_node_path14.default.dirname(target),
    "." + import_node_path14.default.basename(target) + "." + (0, import_node_crypto11.randomUUID)()
  );
  await writeAtomicExclusive(temporary, contents);
  await (0, import_promises14.rename)(temporary, target);
  await fsyncDirectory(import_node_path14.default.dirname(target));
}
async function writeAtomicExclusive(target, contents) {
  const file = await (0, import_promises14.open)(target, "wx", 384);
  try {
    await file.writeFile(contents);
    await file.sync();
  } finally {
    await file.close();
  }
}
async function fsyncDirectory(directory) {
  if (process.platform === "win32") return;
  const handle = await (0, import_promises14.open)(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function assertNotSymlink(target) {
  try {
    if ((await (0, import_promises14.lstat)(target)).isSymbolicLink()) {
      throw new ShelfPathError(`Shelf artifact cannot replace a symbolic link: ${target}`);
    }
  } catch (error) {
    if (isNotFound5(error)) return;
    throw error;
  }
}
function parseCatalog(value) {
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== "object")
    throw new ShelfStoreCorruptionError("Invalid shelf catalog.");
  const catalog = parsed;
  if (catalog.schemaVersion !== SCHEMA_VERSION || typeof catalog.catalogGeneration !== "number" || !Number.isSafeInteger(catalog.catalogGeneration) || !Array.isArray(catalog.shelves) || !catalog.ledger || typeof catalog.ledger !== "object") {
    throw new ShelfStoreCorruptionError("Invalid shelf catalog.");
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    catalogGeneration: catalog.catalogGeneration,
    shelves: catalog.shelves.filter((item) => typeof item === "string"),
    ledger: catalog.ledger
  };
}
function parseManifest(value) {
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== "object")
    throw new ShelfStoreCorruptionError("Invalid shelf manifest.");
  const manifest = parsed;
  if (manifest.schemaVersion !== SCHEMA_VERSION || typeof manifest.generation !== "number" || !Number.isSafeInteger(manifest.generation) || !Array.isArray(manifest.objectHashes) || !Array.isArray(manifest.files) || typeof manifest.checksum !== "string") {
    throw new ShelfStoreCorruptionError("Invalid shelf manifest.");
  }
  if (!manifest.objectHashes.every(isShelfObjectHash)) {
    throw new ShelfStoreCorruptionError("Invalid shelf manifest.");
  }
  const persistence = parseManifestPersistence(manifest.metadata, manifest.files);
  if (persistence) assertPersistedObjectReferences(persistence, manifest.objectHashes);
  return {
    schemaVersion: SCHEMA_VERSION,
    generation: manifest.generation,
    objectHashes: manifest.objectHashes,
    files: persistence ? persistence.files : manifest.files,
    metadata: persistence?.metadata,
    checksum: manifest.checksum
  };
}
function parseJournal2(value) {
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== "object")
    throw new ShelfStoreCorruptionError("Invalid shelf journal.");
  const journal = parsed;
  if (typeof journal.id !== "string" || !isJournalState(journal.state) || !journal.pathProgress || typeof journal.pathProgress !== "object") {
    throw new ShelfStoreCorruptionError("Invalid shelf journal.");
  }
  const shelf = parseJournalShelfLink(journal.shelf);
  return {
    id: journal.id,
    state: journal.state,
    pathProgress: journal.pathProgress,
    expectedIndexFingerprint: typeof journal.expectedIndexFingerprint === "string" ? journal.expectedIndexFingerprint : void 0,
    recoveryObjectHashes: Array.isArray(journal.recoveryObjectHashes) ? journal.recoveryObjectHashes.filter(
      (hash) => typeof hash === "string"
    ) : void 0,
    shelf
  };
}
function parseManifestPersistence(metadata, files) {
  if (metadata === void 0) return void 0;
  try {
    return parseShelfPersistenceContract({ metadata, files });
  } catch (error) {
    if (error instanceof ShelfPersistenceContractError) {
      throw new ShelfStoreCorruptionError("Invalid persisted shelf contract.");
    }
    throw error;
  }
}
function parseJournalShelfLink(value) {
  if (value === void 0) return void 0;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ShelfStoreCorruptionError("Invalid shelf journal.");
  }
  const link = value;
  if (!isShelfIdentifier(link.id) || !isGeneration(link.generation) || link.generation < 1) {
    throw new ShelfStoreCorruptionError("Invalid shelf journal.");
  }
  return { id: link.id, generation: link.generation };
}
function validatePersistenceInput(input) {
  if (input.metadata === void 0) return void 0;
  if (input.schemaVersion !== SCHEMA_VERSION) throw new ShelfPersistenceContractError();
  return parseShelfPersistenceContract({ metadata: input.metadata, files: input.files });
}
function isJournalState(value) {
  return value === "shelvePendingRevert" || value === "shelved" || value === "unshelvePending" || value === "applied" || value === "ghost";
}
function checksumManifest(manifest) {
  const normalized = "checksum" in manifest ? { ...manifest, checksum: "" } : manifest;
  return hashBytes(Buffer.from(JSON.stringify(normalized)));
}
function encodeJson(value) {
  return Buffer.from(JSON.stringify(value));
}
function hashBytes(contents) {
  return (0, import_node_crypto11.createHash)("sha256").update(contents).digest("hex");
}
function assertShelfId(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid shelf identifier.");
  return value;
}
function assertHash(value) {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("Invalid shelf object hash.");
  return value;
}
function isShelfIdentifier(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value);
}
function isGeneration(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isNotFound5(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
function isAlreadyExists(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

// baseline:src/services/shelfServiceOperations.ts
var import_node_crypto12 = require("node:crypto");
var import_promises16 = require("node:fs/promises");
var import_node_path15 = __toESM(require("node:path"));

// baseline:src/shelf/patchClassification.ts
var LINE_FEED = 10;
var CARRIAGE_RETURN = 13;
var SPACE = 32;
var TAB = 9;
var QUOTE = 34;
var BACKSLASH = 92;
function classifyPatchHeader(patch) {
  let renamed = false;
  let added = false;
  let deleted = false;
  let modeChanged = false;
  let binary = false;
  let renamedFrom;
  for (let start = 0; start < patch.length; ) {
    const lineEnd = patch.indexOf(LINE_FEED, start);
    const end = lineEnd < 0 ? patch.length : lineEnd;
    const line = withoutTerminalCarriageReturn(patch.subarray(start, end));
    if (equalsAscii2(line, "GIT binary patch")) {
      binary = true;
      break;
    }
    if (hasAsciiPrefix(line, "@@ ")) break;
    if (hasAsciiPrefix(line, "rename from ")) {
      renamed = true;
      renamedFrom ??= decodePatchPath(line.subarray("rename from ".length));
    } else if (hasAsciiPrefix(line, "new file mode ")) {
      added = true;
    } else if (hasAsciiPrefix(line, "deleted file mode ")) {
      deleted = true;
    } else if (hasAsciiPrefix(line, "old mode ")) {
      modeChanged = true;
    } else if (isBinaryFilesLine(line)) {
      binary = true;
      break;
    }
    start = lineEnd < 0 ? patch.length : lineEnd + 1;
  }
  return {
    status: renamed ? "R" : added ? "A" : deleted ? "D" : modeChanged ? "T" : "M",
    renamedFrom,
    binary
  };
}
function withoutTerminalCarriageReturn(line) {
  return line[line.length - 1] === CARRIAGE_RETURN ? line.subarray(0, -1) : line;
}
function isBinaryFilesLine(line) {
  return hasAsciiPrefix(line, "Binary files ") && hasAsciiSuffix(line, " differ");
}
function hasAsciiPrefix(line, value) {
  if (line.length < value.length) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (line[index] !== value.charCodeAt(index)) return false;
  }
  return true;
}
function hasAsciiSuffix(line, value) {
  if (line.length < value.length) return false;
  const start = line.length - value.length;
  for (let index = 0; index < value.length; index += 1) {
    if (line[start + index] !== value.charCodeAt(index)) return false;
  }
  return true;
}
function equalsAscii2(line, value) {
  return line.length === value.length && hasAsciiPrefix(line, value);
}
function decodePatchPath(line) {
  if (line[0] === QUOTE) {
    const token = decodeQuotedToken(line, 0);
    return token && onlySpaces(line, token.next) ? token.value : void 0;
  }
  const tab = line.indexOf(TAB);
  return decodeUtf8(line.subarray(0, tab < 0 ? line.length : tab));
}
function decodeQuotedToken(line, start) {
  const bytes = [];
  for (let index = start + 1; index < line.length; index += 1) {
    const value = line[index];
    if (value === QUOTE) {
      const decoded = decodeUtf8(Uint8Array.from(bytes));
      return decoded === void 0 ? void 0 : { value: decoded, next: index + 1 };
    }
    if (value !== BACKSLASH) {
      bytes.push(value);
      continue;
    }
    const escaped = line[index + 1];
    if (escaped === void 0) return void 0;
    index += 1;
    if (isOctal(escaped)) {
      let octal = String.fromCharCode(escaped);
      while (octal.length < 3 && isOctal(line[index + 1])) {
        index += 1;
        octal += String.fromCharCode(line[index]);
      }
      bytes.push(Number.parseInt(octal, 8));
      continue;
    }
    const replacement = escapedCharacter(escaped);
    if (replacement === void 0) return void 0;
    bytes.push(replacement);
  }
  return void 0;
}
function escapedCharacter(value) {
  const replacements = {
    [BACKSLASH]: BACKSLASH,
    [QUOTE]: QUOTE,
    97: 7,
    98: 8,
    102: 12,
    110: LINE_FEED,
    114: CARRIAGE_RETURN,
    116: TAB,
    118: 11
  };
  return replacements[value];
}
function isOctal(value) {
  return value !== void 0 && value >= 48 && value <= 55;
}
function onlySpaces(value, offset) {
  for (let index = offset; index < value.length; index += 1) {
    if (value[index] !== SPACE) return false;
  }
  return true;
}
function decodeUtf8(value) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    return void 0;
  }
}

// baseline:src/shelf/patchIO.ts
var import_promises15 = require("node:fs/promises");
var PATCH_GENERATION_FLAGS = [
  "--binary",
  "--full-index",
  "-M",
  "--no-textconv",
  "--no-ext-diff",
  "--no-color"
];
async function generateLayerPatches(git, destinations) {
  const pathspec = destinations.paths?.length ? ["--", ...destinations.paths] : [];
  await git.runBinary(["diff", "--cached", ...PATCH_GENERATION_FLAGS, ...pathspec], {
    outputFile: destinations.indexPatchPath
  });
  await git.runBinary(["diff", ...PATCH_GENERATION_FLAGS, ...pathspec], {
    outputFile: destinations.worktreePatchPath
  });
}
async function generateUntrackedPatch(git, destination) {
  if (!destination.relativePath || destination.relativePath.startsWith("/")) {
    throw new Error("Untracked patch path must be repository-relative.");
  }
  await git.runBinary(
    [
      "diff",
      "--no-index",
      ...PATCH_GENERATION_FLAGS,
      "--",
      "/dev/null",
      destination.relativePath
    ],
    { expectedExitCodes: [0, 1], outputFile: destination.patchPath }
  );
}
var DIFF_HEADER = Buffer.from("diff --git ");
var RENAME_TO_HEADER = Buffer.from("\nrename to ");
var PLAIN_UNIFIED_SOURCE_HEADER = Buffer.from("--- ");
var DESTINATION_HEADER = Buffer.from("\n+++ ");
var HUNK_HEADER = Buffer.from("@@ ");
var LINE_FEED2 = 10;
var SPACE2 = 32;
var TAB2 = 9;
var QUOTE2 = 34;
var BACKSLASH2 = 92;
var ShelfPatchPathError = class extends Error {
  /** Creates a metadata-only parse failure without exposing patch content. */
  constructor() {
    super("Patch block has no safe destination path.");
    this.name = "ShelfPatchPathError";
  }
};
function indexPatchBlocks(patch) {
  const starts = findDiffHeaderOffsets(patch);
  if (starts.length === 0) starts.push(...findPlainUnifiedHeaderOffsets(patch));
  return starts.map((start, index) => {
    const end = starts[index + 1] ?? patch.length;
    const block = patch.subarray(start, end);
    const renamedFrom = classifyPatchHeader(block).renamedFrom;
    const path24 = readDestinationPath(block) ?? readHeaderValue(block, RENAME_TO_HEADER) ?? readDiffHeaderDestination(block) ?? readDeletionSourcePath(block);
    if (!path24) throw new ShelfPatchPathError();
    return {
      changeId: `patch-${index}`,
      start,
      end,
      path: path24,
      renamedFrom
    };
  });
}
function readDestinationPath(block) {
  const destination = readHeaderValue(block, DESTINATION_HEADER);
  return destination ? stripDestinationPrefix(destination) : void 0;
}
function readDeletionSourcePath(block) {
  if (readHeaderValue(block, DESTINATION_HEADER) !== "/dev/null") return void 0;
  const source = readHeaderValue(block, PLAIN_UNIFIED_SOURCE_HEADER);
  return source ? stripSourcePrefix(source) : void 0;
}
function readHeaderValue(block, header) {
  const line = readLineAfterHeader(block, header);
  return line ? decodePatchLinePath(line) : void 0;
}
function readDiffHeaderDestination(block) {
  if (!block.subarray(0, DIFF_HEADER.length).equals(DIFF_HEADER)) return void 0;
  const end = block.indexOf(LINE_FEED2, DIFF_HEADER.length);
  const line = block.subarray(DIFF_HEADER.length, end < 0 ? block.length : end);
  const source = readDiffHeaderToken(line, 0);
  const destination = source ? readDiffHeaderToken(line, source.next) : void 0;
  if (source && destination && onlySpaces2(line, destination.next)) {
    return stripDestinationPrefix(destination.value);
  }
  return readUnquotedSamePathDestination(line);
}
function readUnquotedSamePathDestination(line) {
  if (line[0] === QUOTE2 || line[0] !== 97 || line[1] !== 47) return void 0;
  const matches = [];
  for (let separator = line.indexOf(Buffer.from(" b/")); separator >= 0; separator = line.indexOf(Buffer.from(" b/"), separator + 1)) {
    const source = decodeUtf82(line.subarray(0, separator));
    const destination = decodeUtf82(line.subarray(separator + 1));
    const sourcePath = source ? stripSourcePrefix(source) : void 0;
    const destinationPath = destination ? stripDestinationPrefix(destination) : void 0;
    if (sourcePath && destinationPath && sourcePath === destinationPath) {
      matches.push(destinationPath);
    }
  }
  return matches.length === 1 ? matches[0] : void 0;
}
function findDiffHeaderOffsets(patch) {
  const offsets = [];
  for (
    let offset = patch.indexOf(DIFF_HEADER);
    offset >= 0;
    // The next occurrence advances the same byte-stream cursor rather than looking up collection members.
    // react-doctor-disable-next-line react-doctor/js-set-map-lookups
    offset = patch.indexOf(DIFF_HEADER, offset + 1)
  ) {
    if (!isDiffHeaderStart(patch, offset)) continue;
    offsets.push(offset);
  }
  return offsets;
}
function findPlainUnifiedHeaderOffsets(patch) {
  const offsets = [];
  for (
    let offset = patch.indexOf(PLAIN_UNIFIED_SOURCE_HEADER);
    offset >= 0;
    // The next occurrence advances the same byte-stream cursor rather than looking up collection members.
    // react-doctor-disable-next-line react-doctor/js-set-map-lookups
    offset = patch.indexOf(PLAIN_UNIFIED_SOURCE_HEADER, offset + 1)
  ) {
    if (!isPlainUnifiedHeaderStart(patch, offset)) continue;
    offsets.push(offset);
  }
  return offsets;
}
function isPlainUnifiedHeaderStart(patch, offset) {
  if (offset > 0 && patch[offset - 1] !== LINE_FEED2) return false;
  const sourceEnd = patch.indexOf(LINE_FEED2, offset);
  if (sourceEnd < 0 || patch.indexOf(DESTINATION_HEADER, sourceEnd) !== sourceEnd) return false;
  const destinationEnd = patch.indexOf(LINE_FEED2, sourceEnd + DESTINATION_HEADER.length);
  return destinationEnd >= 0 && patch.indexOf(HUNK_HEADER, destinationEnd + 1) === destinationEnd + 1;
}
function isDiffHeaderStart(patch, offset) {
  if (offset > 0 && patch[offset - 1] !== LINE_FEED2) return false;
  const pathStart = offset + DIFF_HEADER.length;
  return patch[pathStart] === QUOTE2 || patch[pathStart] === 97 && patch[pathStart + 1] === 47;
}
function readLineAfterHeader(block, header) {
  const start = block.indexOf(header);
  if (start < 0) return void 0;
  const valueStart = start + header.length;
  const end = block.indexOf(LINE_FEED2, valueStart);
  return block.subarray(valueStart, end < 0 ? block.length : end);
}
function decodePatchLinePath(line) {
  if (line[0] === QUOTE2) {
    const token = readDiffHeaderToken(line, 0);
    return token && onlySpaces2(line, token.next) ? token.value : void 0;
  }
  const tab = line.indexOf(TAB2);
  return decodeUtf82(line.subarray(0, tab < 0 ? line.length : tab));
}
function readDiffHeaderToken(line, offset) {
  let start = offset;
  while (line[start] === SPACE2) start += 1;
  if (start >= line.length) return void 0;
  if (line[start] === QUOTE2) return decodeQuotedToken2(line, start);
  let end = start;
  while (end < line.length && line[end] !== SPACE2) end += 1;
  const value = decodeUtf82(line.subarray(start, end));
  return value === void 0 ? void 0 : { value, next: end };
}
function decodeQuotedToken2(line, start) {
  const bytes = [];
  for (let index = start + 1; index < line.length; index += 1) {
    const value = line[index];
    if (value === QUOTE2) {
      const decoded = decodeUtf82(Buffer.from(bytes));
      return decoded === void 0 ? void 0 : { value: decoded, next: index + 1 };
    }
    if (value !== BACKSLASH2) {
      bytes.push(value);
      continue;
    }
    const escaped = line[index + 1];
    if (escaped === void 0) return void 0;
    index += 1;
    if (isOctal2(escaped)) {
      let octal = String.fromCharCode(escaped);
      while (octal.length < 3 && isOctal2(line[index + 1])) {
        index += 1;
        octal += String.fromCharCode(line[index]);
      }
      bytes.push(Number.parseInt(octal, 8));
      continue;
    }
    const replacement = escapedCharacter2(escaped);
    if (replacement === void 0) return void 0;
    bytes.push(replacement);
  }
  return void 0;
}
function escapedCharacter2(value) {
  const replacements = {
    [BACKSLASH2]: BACKSLASH2,
    [QUOTE2]: QUOTE2,
    97: 7,
    98: 8,
    102: 12,
    110: LINE_FEED2,
    114: 13,
    116: TAB2,
    118: 11
  };
  return replacements[value];
}
function isOctal2(value) {
  return value !== void 0 && value >= 48 && value <= 55;
}
function onlySpaces2(value, offset) {
  for (let index = offset; index < value.length; index += 1) {
    if (value[index] !== SPACE2) return false;
  }
  return true;
}
function stripDestinationPrefix(value) {
  return value.startsWith("b/") ? value.slice(2) : void 0;
}
function stripSourcePrefix(value) {
  return value.startsWith("a/") ? value.slice(2) : void 0;
}
function decodeUtf82(value) {
  const decoded = value.toString("utf8");
  return Buffer.from(decoded, "utf8").equals(value) ? decoded : void 0;
}

// baseline:src/services/shelfServiceOperations.ts
var MAX_IMPORT_BYTES = 8 * 1024 * 1024;
async function exportFlattenedPatch(store, shelfId, entries) {
  const pieces = [];
  for (const entry of entries) {
    for (const block of [entry.indexBlock, entry.worktreeBlock]) {
      if (block?.patchObjectHash)
        pieces.push(await store.readObject(shelfId, block.patchObjectHash));
    }
  }
  return Buffer.concat(pieces);
}
async function importPatchFiles(store, fileUris, name) {
  if (fileUris.length === 0) throw new Error("At least one patch file is required.");
  const shelfId = (0, import_node_crypto12.randomUUID)();
  const hashes = /* @__PURE__ */ new Set();
  const files = [];
  for (const fileUri of fileUris) {
    const patch = await readImportPatch(fileUri);
    validateImportedPatch(patch);
    for (const block of indexPatchBlocks(patch)) {
      const bytes = patch.subarray(block.start, block.end);
      const object = await store.putObject(shelfId, bytes);
      const classification = classifyPatchHeader(bytes);
      hashes.add(object.hash);
      files.push({
        changeId: `import-${files.length}`,
        worktreeBlock: {
          path: block.path,
          renamedFrom: classification.renamedFrom,
          status: classification.status,
          patchObjectHash: object.hash
        },
        binary: classification.binary,
        untracked: false,
        baseAvailability: "none",
        exactReconstruction: true,
        lifecycle: "shelved"
      });
    }
  }
  if (files.length === 0) throw new Error("Patch contains no importable change blocks.");
  const manifest = await store.writeShelfGeneration(shelfId, {
    schemaVersion: 1,
    objectHashes: [...hashes],
    metadata: { name: name ?? "Imported patches", lifecycle: "shelved", createdAt: Date.now() },
    files
  });
  return { shelfId, generation: manifest.generation };
}
async function resolveStructuralAction(input, dependencies, entry) {
  const block = entry.worktreeBlock ?? entry.indexBlock;
  if (!block) throw new Error("Structural shelf entry has no file path.");
  const sourcePath = block.status === "R" ? block.renamedFrom ?? block.path : block.path;
  const source = resolveRepositoryPath(
    dependencies.repositoryRoot,
    validateShelfManifestPath(sourcePath)
  );
  if (await pathFingerprint(source) !== input.expectedPathFingerprint) {
    throw new Error("Structural resolution path is stale.");
  }
  if (input.action === "keepLocal") return;
  if (input.action === "deleteLocal") {
    await assertFreshStructuralSource(
      dependencies.repositoryRoot,
      source,
      input.expectedPathFingerprint
    );
    await (0, import_promises16.rm)(source, { force: false });
    return;
  }
  if (input.action === "renameLocal") {
    if (!input.targetPath) throw new Error("Rename resolution requires a target path.");
    const target = resolveRepositoryPath(
      dependencies.repositoryRoot,
      validateShelfManifestPath(input.targetPath)
    );
    await assertAbsentStructuralTarget(dependencies.repositoryRoot, target);
    await assertFreshStructuralSource(
      dependencies.repositoryRoot,
      source,
      input.expectedPathFingerprint
    );
    await assertAbsentStructuralTarget(dependencies.repositoryRoot, target);
    await (0, import_promises16.rename)(source, target);
    return;
  }
  if (!block.patchObjectHash) throw new Error("Structural shelf patch is missing.");
  const patch = await dependencies.store.readObject(input.id, block.patchObjectHash);
  validateImportedPatch(patch);
  const checked = await dependencies.executor.runBinary(["apply", "--check", "-"], {
    input: patch,
    expectedExitCodes: [0, 1]
  });
  if (checked.exitCode !== 0)
    throw new Error("Shelved structural patch cannot be applied safely.");
  await dependencies.executor.runBinary(["apply", "-"], { input: patch });
}
async function pathFingerprint(target) {
  try {
    const details = await (0, import_promises16.lstat)(target);
    if (!details.isFile() || details.isSymbolicLink())
      return `type:${details.mode.toString(8)}`;
    return `${(details.mode & 4095).toString(8)}:${(0, import_node_crypto12.createHash)("sha256").update(await (0, import_promises16.readFile)(target)).digest("hex")}`;
  } catch (error) {
    if (isNotFound6(error)) return "absent";
    throw error;
  }
}
async function readImportPatch(fileUri) {
  if (!import_node_path15.default.isAbsolute(fileUri)) throw new Error("Patch import path must be absolute.");
  const details = await (0, import_promises16.lstat)(fileUri);
  if (!details.isFile() || details.isSymbolicLink() || details.size <= 0 || details.size > MAX_IMPORT_BYTES) {
    throw new Error("Patch import file is unsafe or exceeds the import limit.");
  }
  return (0, import_promises16.readFile)(fileUri);
}
async function assertFreshStructuralSource(repositoryRoot, target, expectedFingerprint) {
  await ensureContainedParent(repositoryRoot, target);
  if (await pathFingerprint(target) !== expectedFingerprint) {
    throw new Error("Structural resolution path is stale.");
  }
}
async function assertAbsentStructuralTarget(repositoryRoot, target) {
  await ensureContainedParent(repositoryRoot, target);
  if (await pathFingerprint(target) !== "absent") {
    throw new Error("Structural rename target already exists.");
  }
}
function isNotFound6(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

// baseline:src/services/shelfServiceCapture.ts
var import_node_crypto13 = require("node:crypto");
var import_promises18 = require("node:fs/promises");
var import_node_os4 = require("node:os");
var import_node_path17 = __toESM(require("node:path"));

// baseline:src/shelf/capture.ts
var import_promises17 = require("node:fs/promises");
var import_node_path16 = __toESM(require("node:path"));
async function captureWorktreeRawFidelity(input) {
  const target = resolveRepositoryFile(input.repositoryRoot, input.relativePath);
  const materialized = Buffer.from(input.materializedBytes);
  const worktree = await (0, import_promises17.readFile)(target);
  if (materialized.equals(worktree)) {
    return { entry: input.entry };
  }
  const worktreeBlock = input.entry.worktreeBlock;
  if (!worktreeBlock) {
    throw new Error("Raw worktree fidelity requires a worktree layer block.");
  }
  const before = await input.store.putObject(input.shelfId, input.preimageBytes);
  const after = await input.store.putObject(input.shelfId, worktree);
  return {
    entry: {
      ...input.entry,
      exactReconstruction: false,
      worktreeBlock: {
        ...worktreeBlock,
        rawBeforeObjectHash: before.hash,
        rawAfterObjectHash: after.hash
      }
    },
    rawBeforeObjectHash: before.hash,
    rawAfterObjectHash: after.hash
  };
}
async function assertShelfCaptureStateSupported(git, repositoryRoot) {
  const trackedPaths = await assertIndexEntriesSupported(git, repositoryRoot);
  const pinnedBasePaths = await assertPinnedBaseEntriesSupported(git, repositoryRoot);
  assertIndexAndPinnedBasePathsDoNotSwapTypes(trackedPaths, pinnedBasePaths);
  await assertStatusEntriesSupported(git, repositoryRoot, trackedPaths, pinnedBasePaths);
  await assertIndexFlagsSupported(git, repositoryRoot);
}
async function assertIndexEntriesSupported(git, repositoryRoot) {
  const stage = await git.runBinary(["ls-files", "--stage", "-z"], {
    expectedExitCodes: [0]
  });
  const trackedPaths = /* @__PURE__ */ new Set();
  for (const record of splitNullRecords(stage.stdout)) {
    const parsed = parseStageRecord(record, repositoryRoot);
    if (!parsed) continue;
    assertUnsupportedMode(parsed.mode, parsed.path);
    if (parsed.stage !== "0") assertShelfStateSupported(parsed.path, "unmerged-stage");
    trackedPaths.add(parsed.path);
  }
  return trackedPaths;
}
async function assertPinnedBaseEntriesSupported(git, repositoryRoot) {
  const head = await git.runBinary(["rev-parse", "--verify", "--quiet", "HEAD"], {
    expectedExitCodes: [0, 1]
  });
  const headOid = head.stdout.toString("ascii").trim();
  if (!headOid) return /* @__PURE__ */ new Set();
  const tree = await git.runBinary(["ls-tree", "-r", "-z", headOid], {
    expectedExitCodes: [0]
  });
  const pinnedBasePaths = /* @__PURE__ */ new Set();
  for (const record of splitNullRecords(tree.stdout)) {
    const parsed = parseTreeRecord(record, repositoryRoot);
    if (!parsed) continue;
    assertUnsupportedMode(parsed.mode, parsed.path);
    pinnedBasePaths.add(parsed.path);
  }
  return pinnedBasePaths;
}
async function assertStatusEntriesSupported(git, repositoryRoot, trackedPaths, pinnedBasePaths) {
  const status = await git.runBinary(
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    {
      expectedExitCodes: [0]
    }
  );
  for (const record of splitNullRecords(status.stdout)) {
    const parsed = parseStatusRecord(record, repositoryRoot);
    if (!parsed) continue;
    if (parsed.state === "intent-to-add") {
      assertShelfStateSupported(parsed.path, "intent-to-add");
    }
    if (parsed.state === "untracked") {
      assertUntrackedPathDoesNotReplaceTrackedFile(
        parsed.path,
        trackedPaths,
        pinnedBasePaths
      );
      await assertUntrackedPathSupported(repositoryRoot, parsed.path);
    }
    if (parsed.state === "tracked-worktree-change") {
      await assertTrackedWorktreePathSupported(repositoryRoot, parsed.path);
    }
  }
}
function assertUntrackedPathDoesNotReplaceTrackedFile(relativePath, ...trackedPathSets) {
  for (let separator = relativePath.indexOf("/"); separator >= 0; separator = relativePath.indexOf("/", separator + 1)) {
    const trackedPath = relativePath.slice(0, separator);
    if (trackedPathSets.some((trackedPaths) => trackedPaths.has(trackedPath))) {
      assertShelfStateSupported(trackedPath, "type-swap");
    }
  }
}
function assertIndexAndPinnedBasePathsDoNotSwapTypes(trackedPaths, pinnedBasePaths) {
  for (const trackedPath of trackedPaths) {
    assertUntrackedPathDoesNotReplaceTrackedFile(trackedPath, pinnedBasePaths);
  }
  for (const pinnedBasePath of pinnedBasePaths) {
    assertUntrackedPathDoesNotReplaceTrackedFile(pinnedBasePath, trackedPaths);
  }
}
async function assertIndexFlagsSupported(git, repositoryRoot) {
  const flags = await git.runBinary(["ls-files", "-v", "-z"], {
    expectedExitCodes: [0]
  });
  for (const record of splitNullRecords(flags.stdout)) {
    const parsed = parseFlagRecord(record, repositoryRoot);
    if (!parsed) continue;
    assertShelfStateSupported(parsed.path, parsed.state);
  }
}
function assertUnsupportedMode(mode, changeId) {
  if (mode === "120000") assertShelfStateSupported(changeId, "symlink");
  if (mode === "160000") assertShelfStateSupported(changeId, "submodule");
}
function splitNullRecords(output) {
  const records = [];
  let start = 0;
  for (let index = 0; index < output.length; index += 1) {
    if (output[index] !== 0) continue;
    if (index > start) records.push(output.subarray(start, index));
    start = index + 1;
  }
  if (start < output.length) records.push(output.subarray(start));
  return records;
}
function parseStageRecord(record, repositoryRoot) {
  const tab = record.indexOf(9);
  if (tab < 0) return void 0;
  const [mode, , stage] = record.subarray(0, tab).toString("ascii").split(" ");
  if (!mode || !stage) return void 0;
  return {
    mode,
    stage,
    path: decodeRepositoryPath(repositoryRoot, record.subarray(tab + 1))
  };
}
function parseTreeRecord(record, repositoryRoot) {
  const tab = record.indexOf(9);
  if (tab < 0) return void 0;
  const [mode] = record.subarray(0, tab).toString("ascii").split(" ");
  if (!mode) return void 0;
  return {
    mode,
    path: decodeRepositoryPath(repositoryRoot, record.subarray(tab + 1))
  };
}
function parseStatusRecord(record, repositoryRoot) {
  if (record.length < 4 || record[2] !== 32) return void 0;
  const state = record.subarray(0, 2).toString("ascii");
  const pathValue = decodeRepositoryPath(repositoryRoot, record.subarray(3));
  if (state === " A") return { state: "intent-to-add", path: pathValue };
  if (state === "??") return { state: "untracked", path: pathValue };
  if (state[1] !== " ") return { state: "tracked-worktree-change", path: pathValue };
  return void 0;
}
async function assertUntrackedPathSupported(repositoryRoot, relativePath) {
  await assertFilesystemPathSupported(repositoryRoot, relativePath, false);
}
async function assertTrackedWorktreePathSupported(repositoryRoot, relativePath) {
  await assertFilesystemPathSupported(repositoryRoot, relativePath, true, true);
}
async function assertFilesystemPathSupported(repositoryRoot, relativePath, allowMissing, requireRegularFile = false) {
  const target = resolveRepositoryFile(repositoryRoot, relativePath);
  let details;
  try {
    details = await (0, import_promises17.lstat)(target);
  } catch (error) {
    if (allowMissing && isNotFound7(error)) return;
    throw error;
  }
  if (details.isSymbolicLink()) {
    assertShelfStateSupported(relativePath, "symlink");
  }
  if (!details.isDirectory()) {
    if (requireRegularFile && !details.isFile()) {
      assertShelfStateSupported(relativePath, "type-swap");
    }
    return;
  }
  try {
    await (0, import_promises17.lstat)(import_node_path16.default.join(target, ".git"));
  } catch (error) {
    if (isNotFound7(error)) {
      if (requireRegularFile) assertShelfStateSupported(relativePath, "type-swap");
      return;
    }
    throw error;
  }
  assertShelfStateSupported(relativePath, "submodule");
}
function parseFlagRecord(record, repositoryRoot) {
  if (record.length < 3 || record[1] !== 32) return void 0;
  const tag = String.fromCharCode(record[0]);
  const pathValue = decodeRepositoryPath(repositoryRoot, record.subarray(2));
  if (tag === "S") return { state: "skip-worktree", path: pathValue };
  if (tag >= "a" && tag <= "z") return { state: "assume-unchanged", path: pathValue };
  return void 0;
}
function decodeRepositoryPath(repositoryRoot, value) {
  const relativePath = value.toString("utf8");
  resolveRepositoryFile(repositoryRoot, relativePath);
  return relativePath;
}
function resolveRepositoryFile(repositoryRoot, relativePath) {
  if (!relativePath || import_node_path16.default.isAbsolute(relativePath)) {
    throw new Error("Shelf capture path must be a non-empty relative path.");
  }
  const root = import_node_path16.default.resolve(repositoryRoot);
  const target = import_node_path16.default.resolve(root, relativePath);
  const relation = import_node_path16.default.relative(root, target);
  if (relation === "" || relation === ".." || relation.startsWith(`..${import_node_path16.default.sep}`) || import_node_path16.default.isAbsolute(relation)) {
    throw new Error("Shelf capture path escapes the repository root.");
  }
  return target;
}
function isNotFound7(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

// baseline:src/services/shelfServiceCapture.ts
async function captureShelfArtifacts(input, dependencies) {
  await assertShelfCaptureStateSupported(dependencies.executor, dependencies.repositoryRoot);
  const shelfId = (0, import_node_crypto13.randomUUID)();
  const directory = await (0, import_promises18.mkdtemp)(import_node_path17.default.join((0, import_node_os4.tmpdir)(), "intelligit-shelf-capture-"));
  try {
    const source = await collectCaptureSource(input.paths, directory, dependencies.executor);
    return persistCaptureSource(input.name, shelfId, source, dependencies);
  } finally {
    await (0, import_promises18.rm)(directory, { recursive: true, force: true });
  }
}
async function collectCaptureSource(paths, directory, executor) {
  const indexPatchPath = import_node_path17.default.join(directory, "index.patch");
  const worktreePatchPath = import_node_path17.default.join(directory, "worktree.patch");
  await generateLayerPatches(executor, { indexPatchPath, worktreePatchPath, paths });
  const [indexPatch, worktreePatch, baseCommit, untrackedPaths] = await Promise.all([
    (0, import_promises18.readFile)(indexPatchPath),
    (0, import_promises18.readFile)(worktreePatchPath),
    readHead(executor),
    findUntrackedPaths(executor, paths)
  ]);
  const patchByPath = /* @__PURE__ */ new Map();
  addBlocks(patchByPath, indexPatch, "index");
  addBlocks(patchByPath, worktreePatch, "worktree");
  await addUntrackedBlocks(patchByPath, untrackedPaths, directory, executor);
  return { baseCommit, patchByPath };
}
async function addUntrackedBlocks(patchByPath, paths, directory, executor) {
  for (const relativePath of paths) {
    const patchPath = import_node_path17.default.join(directory, `untracked-${patchByPath.size}.patch`);
    await generateUntrackedPatch(executor, { patchPath, relativePath });
    patchByPath.set(relativePath, { worktree: await (0, import_promises18.readFile)(patchPath), untracked: true });
  }
}
async function persistCaptureSource(name, shelfId, source, dependencies) {
  const entries = [];
  const revertFiles = [];
  const objectHashes = /* @__PURE__ */ new Set();
  const sortedPatches = Array.from(source.patchByPath.entries());
  sortedPatches.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  for (const [relativePath, patches] of sortedPatches) {
    const captured = await persistCaptureEntry(
      shelfId,
      relativePath,
      patches,
      source.baseCommit,
      dependencies,
      objectHashes
    );
    entries.push(captured.entry);
    revertFiles.push(captured.revertFiles);
  }
  if (entries.length === 0) throw new Error("No selected changes to shelve.");
  const metadata = {
    name,
    baseCommit: source.baseCommit,
    lifecycle: "shelved",
    createdAt: Date.now()
  };
  const manifest = await dependencies.store.writeShelfGeneration(shelfId, {
    schemaVersion: 1,
    objectHashes: [...objectHashes],
    metadata,
    files: entries
  });
  return { shelfId, generation: manifest.generation, baseCommit: source.baseCommit, revertFiles };
}
async function persistCaptureEntry(shelfId, relativePath, patches, baseCommit, dependencies, objectHashes) {
  const capturedIndexBlock = patches.index ? await persistBlock(shelfId, relativePath, patches.index, dependencies.store, objectHashes) : void 0;
  const capturedWorktreeBlock = patches.worktree ? await persistBlock(
    shelfId,
    relativePath,
    patches.worktree,
    dependencies.store,
    objectHashes
  ) : void 0;
  const blocks = [capturedIndexBlock, capturedWorktreeBlock].filter(
    (block) => block !== void 0
  );
  const base = baseCommit ? await readHistoryBase(baseCommit, blocks, dependencies.executor) : void 0;
  const [indexBlock, worktreeBlock] = await persistBaseObjects(
    shelfId,
    base,
    [capturedIndexBlock, capturedWorktreeBlock],
    dependencies.store,
    objectHashes,
    dependencies.recordBaseRevisions
  );
  let entry = createEntry(relativePath, patches, indexBlock, worktreeBlock, base, baseCommit);
  entry = await captureRawFidelity(
    shelfId,
    entry,
    relativePath,
    patches,
    base,
    dependencies,
    objectHashes
  );
  const blockForRevert = worktreeBlock ?? indexBlock;
  return {
    entry,
    revertFiles: blockForRevert?.status === "R" && blockForRevert.renamedFrom ? [
      { relativePath: blockForRevert.renamedFrom, baseBytes: base?.bytes },
      { relativePath: blockForRevert.path }
    ] : blockForRevert ? [{ relativePath: blockForRevert.path, baseBytes: base?.bytes }] : []
  };
}
async function persistBaseObjects(shelfId, base, blocks, store, objectHashes, recordBaseRevisions) {
  if (!recordBaseRevisions || !base || !blocks[0] && !blocks[1]) return blocks;
  const hash = (await store.putObject(shelfId, base.bytes)).hash;
  objectHashes.add(hash);
  return [
    blocks[0] && { ...blocks[0], baseObjectHash: hash },
    blocks[1] && { ...blocks[1], baseObjectHash: hash }
  ];
}
function createEntry(relativePath, patches, indexBlock, worktreeBlock, base, baseCommit) {
  return {
    changeId: `change-${(0, import_node_crypto13.createHash)("sha256").update(relativePath).digest("hex").slice(0, 20)}`,
    indexBlock,
    worktreeBlock,
    binary: patches.index !== void 0 && classifyPatchHeader(patches.index).binary || patches.worktree !== void 0 && classifyPatchHeader(patches.worktree).binary,
    untracked: patches.untracked === true,
    baseAvailability: base && (indexBlock?.baseObjectHash || worktreeBlock?.baseObjectHash) ? "full" : baseCommit ? "history" : "none",
    exactReconstruction: true,
    lifecycle: "shelved"
  };
}
async function captureRawFidelity(shelfId, entry, relativePath, patches, base, dependencies, objectHashes) {
  if (!base || entry.worktreeBlock?.status !== "M") return entry;
  const materialized = await dependencies.materializeEntry(
    relativePath,
    base.bytes,
    patches.index,
    patches.worktree
  );
  if (!materialized) return entry;
  const fidelity = await captureWorktreeRawFidelity({
    materializedBytes: materialized,
    preimageBytes: base.bytes,
    repositoryRoot: dependencies.repositoryRoot,
    relativePath,
    shelfId,
    store: dependencies.store,
    entry
  });
  if (fidelity.rawBeforeObjectHash) objectHashes.add(fidelity.rawBeforeObjectHash);
  if (fidelity.rawAfterObjectHash) objectHashes.add(fidelity.rawAfterObjectHash);
  return fidelity.entry;
}
async function persistBlock(shelfId, relativePath, patch, store, objectHashes) {
  const object = await store.putObject(shelfId, patch);
  objectHashes.add(object.hash);
  const classification = classifyPatchHeader(patch);
  return {
    path: relativePath,
    renamedFrom: classification.renamedFrom,
    status: classification.status,
    patchObjectHash: object.hash
  };
}
async function readHistoryBase(baseCommit, blocks, executor) {
  const candidate = blocks.find((block) => block.status !== "A");
  if (!candidate) return void 0;
  const safeRelativePath = validateShelfManifestPath(candidate.renamedFrom ?? candidate.path);
  const result = await executor.runBinary(["show", `${baseCommit}:${safeRelativePath}`], {
    expectedExitCodes: [0, 128]
  });
  return result.exitCode === 0 ? { bytes: result.stdout } : void 0;
}
async function readHead(executor) {
  const result = await executor.runBinary(["rev-parse", "--verify", "--quiet", "HEAD"], {
    expectedExitCodes: [0, 1]
  });
  return result.exitCode === 0 ? result.stdout.toString("ascii").trim() : void 0;
}
async function findUntrackedPaths(executor, selectedPaths) {
  const result = await executor.runBinary([
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all"
  ]);
  const selected = selectedPaths.length > 0 ? new Set(selectedPaths) : void 0;
  return result.stdout.toString("utf8").split("\0").filter((record) => record.startsWith("?? ")).map((record) => record.slice(3)).filter((relativePath) => !selected || selected.has(relativePath));
}
function addBlocks(target, patch, layer) {
  for (const block of indexPatchBlocks(patch)) {
    target.set(block.path, {
      ...target.get(block.path) ?? {},
      [layer]: patch.subarray(block.start, block.end)
    });
  }
}

// baseline:src/services/shelfConflictSession.ts
var import_node_crypto14 = require("node:crypto");
var import_node_fs6 = require("node:fs");
var import_promises19 = require("node:fs/promises");
var import_node_os5 = require("node:os");
var import_node_path19 = __toESM(require("node:path"));

// baseline:src/services/shelfServiceHelpers.ts
var import_node_path18 = __toESM(require("node:path"));
function isStructural(entry) {
  return entry.binary || [entry.indexBlock, entry.worktreeBlock].some(
    (block) => block?.status === "R" || block?.status === "D" || block?.status === "T"
  );
}
function statusFor(entries) {
  if (entries.length === 0 || entries.every((entry) => entry.kind === "applied" || entry.kind === "flattenedResidue")) {
    return "ok";
  }
  if (entries.some((entry) => entry.kind === "conflicted" || entry.kind === "structuralPending")) {
    return "conflicts";
  }
  return "partial";
}
function selectEntries(entries, changeIds2) {
  if (!changeIds2) return [...entries];
  const known = new Set(entries.map((entry) => entry.changeId));
  if (changeIds2.some((id) => !known.has(id))) {
    throw new Error("Shelf selection contains an unknown change ID.");
  }
  return selectWholeShelfEntries(entries, changeIds2);
}
function assertShelfName(name) {
  if (!name.trim() || name.length > 255 || name.includes("\0")) {
    throw new Error("Shelf name is invalid.");
  }
}
function repositoryPath(repositoryRoot, relativePath) {
  const safeRelativePath = validateShelfManifestPath(relativePath);
  const root = import_node_path18.default.resolve(repositoryRoot);
  const target = import_node_path18.default.resolve(root, safeRelativePath);
  const relation = import_node_path18.default.relative(root, target);
  if (relation === "" || relation === ".." || relation.startsWith(`..${import_node_path18.default.sep}`) || import_node_path18.default.isAbsolute(relation)) {
    throw new Error("Shelf path escapes the repository root.");
  }
  return target;
}
function isUtf83(bytes) {
  return Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes);
}
function isNotFound8(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

// baseline:src/services/shelfConflictSession.ts
function extractOursFromConflictMarkers(content) {
  const lines = content.match(/.*(?:\n|$)/g) ?? [];
  const result = [];
  let inConflict = false;
  let include = true;
  let foundMarker = false;
  for (const line of lines) {
    if (!inConflict && line.startsWith("<<<<<<<")) {
      inConflict = true;
      include = true;
      foundMarker = true;
      continue;
    }
    if (inConflict && line.startsWith("=======")) {
      include = false;
      continue;
    }
    if (inConflict && line.startsWith(">>>>>>>")) {
      inConflict = false;
      continue;
    }
    if (!inConflict || include) result.push(line);
  }
  return foundMarker && !inConflict ? result.join("") : content;
}
async function materializeShelfPatchedBase(input, dependencies) {
  const executor = dependencies.executor;
  if (!executor) throw new Error("Shelf conflict materialization requires a Git executor.");
  const block = input.entry.worktreeBlock;
  if (!block) return void 0;
  const safePath = validateShelfManifestPath(block.path);
  const indexPatch = input.entry.indexBlock?.patchObjectHash ? await dependencies.store.readObject(input.id, input.entry.indexBlock.patchObjectHash) : Buffer.alloc(0);
  const worktreePatch = block.patchObjectHash ? await dependencies.store.readObject(input.id, block.patchObjectHash) : Buffer.alloc(0);
  const directory = await (0, import_promises19.mkdtemp)(import_node_path19.default.join((0, import_node_os5.tmpdir)(), "intelligit-shelf-materialize-"));
  try {
    const target = import_node_path19.default.join(directory, safePath);
    await (0, import_promises19.mkdir)(import_node_path19.default.dirname(target), { recursive: true, mode: 448 });
    await (0, import_promises19.writeFile)(target, input.base);
    const patch = Buffer.concat([indexPatch, worktreePatch]);
    const checked = await executor.runBinary(["-C", directory, "apply", "--check", "-"], {
      input: patch,
      expectedExitCodes: [0, 1]
    });
    if (checked.exitCode !== 0) return void 0;
    await executor.runBinary(["-C", directory, "apply", "-"], { input: patch });
    return await (0, import_promises19.readFile)(target);
  } finally {
    await (0, import_promises19.rm)(directory, { recursive: true, force: true });
  }
}
var ShelfConflictSessionService = class {
  /** Binds the session to its store, repository, and mutation-serialization collaborators. */
  constructor(dependencies) {
    this.dependencies = dependencies;
  }
  dependencies;
  /** Reads immutable sides without acquiring the mutation queue or repository lock. */
  async open(input) {
    const manifest = await this.dependencies.store.readCurrentShelfManifest(input.id);
    const entry = this.conflictedEntry(manifest, input.changeId);
    const block = entry.worktreeBlock;
    const safePath = validateShelfManifestPath(block.path);
    const base = await this.dependencies.readBase(input.id, entry);
    if (!base || !isUtf83(base))
      throw new Error("Shelf conflict base is unavailable or not UTF-8.");
    const materialized = await this.materializePatchedBase({ id: input.id, entry, base });
    if (!materialized || !isUtf83(materialized)) {
      throw new Error("Shelf conflict patched base is unavailable or not UTF-8.");
    }
    const target = repositoryPath(this.dependencies.repositoryRoot, safePath);
    const bytes = await (0, import_promises19.readFile)(target);
    if (!isUtf83(bytes)) throw new Error("Shelf conflict current file is not UTF-8.");
    const fingerprint3 = await pathFingerprint(target);
    if (fingerprint3.startsWith("type:") || fingerprint3 === "absent") {
      throw new Error("Shelf conflict target is no longer a regular file.");
    }
    return {
      path: safePath,
      base: base.toString("utf8"),
      current: extractOursFromConflictMarkers(bytes.toString("utf8")),
      patchedBase: materialized.toString("utf8"),
      worktreeFingerprint: fingerprint3,
      shelfGeneration: manifest.generation
    };
  }
  /** Materializes and writes merge-file output for flattened regular-text M/M conflicts. */
  async mergeTextEntry(id, entry) {
    if (!entry.worktreeBlock || entry.baseAvailability === "none") return void 0;
    const base = await this.dependencies.readBase(id, entry);
    if (!base || !isUtf83(base)) return void 0;
    const patchedBase = await this.materializePatchedBase({ id, entry, base });
    if (!patchedBase || !isUtf83(patchedBase)) return void 0;
    const safePath = validateShelfManifestPath(entry.worktreeBlock.path);
    const target = repositoryPath(this.dependencies.repositoryRoot, safePath);
    const current = await (0, import_promises19.readFile)(target).catch(() => void 0);
    if (!current || !isUtf83(current) || !this.dependencies.executor) return void 0;
    const directory = await (0, import_promises19.mkdtemp)(import_node_path19.default.join((0, import_node_os5.tmpdir)(), "intelligit-shelf-merge-"));
    try {
      const basePath = import_node_path19.default.join(directory, "base");
      const currentPath = import_node_path19.default.join(directory, "current");
      const shelvedPath = import_node_path19.default.join(directory, "shelved");
      await Promise.all([
        (0, import_promises19.writeFile)(basePath, base),
        (0, import_promises19.writeFile)(currentPath, current),
        (0, import_promises19.writeFile)(shelvedPath, patchedBase)
      ]);
      const result = await this.dependencies.executor.runBinary(
        ["merge-file", "-p", currentPath, basePath, shelvedPath],
        { expectedExitCodes: [0, 1] }
      );
      await replaceRegularWorktreeFile(
        this.dependencies.repositoryRoot,
        safePath,
        result.stdout
      );
      return result.exitCode === 0 ? "applied" : "conflicted";
    } finally {
      await (0, import_promises19.rm)(directory, { recursive: true, force: true });
    }
  }
  /** Re-enters normal mutation serialization and applies only after both preconditions are current. */
  async apply(input) {
    try {
      return await this.dependencies.withMutation(async () => {
        const manifest = await this.dependencies.store.readCurrentShelfManifest(input.id);
        const generationStale = manifest.generation !== input.expectedShelfGeneration;
        if (generationStale && !input.staleOverride) {
          return { status: "stale", reason: "shelf" };
        }
        if (generationStale) return this.applyLocked(manifest, input, true);
        try {
          return await this.dependencies.store.withGenerationCas(
            {
              shelfId: input.id,
              expectedShelfGeneration: input.expectedShelfGeneration
            },
            async () => this.applyLocked(manifest, input, false)
          );
        } catch (error) {
          if (!(error instanceof ShelfStaleShelfError)) throw error;
          if (!input.staleOverride) return { status: "stale", reason: "shelf" };
          const current = await this.dependencies.store.readCurrentShelfManifest(
            input.id
          );
          return this.applyLocked(current, input, true);
        }
      });
    } catch (error) {
      if (error instanceof ShelfStaleShelfError) return { status: "stale", reason: "shelf" };
      throw error;
    }
  }
  async materializePatchedBase(input) {
    return this.dependencies.materializePatchedBase ? this.dependencies.materializePatchedBase(input) : materializeShelfPatchedBase(input, this.dependencies);
  }
  conflictedEntry(manifest, changeId) {
    const entry = manifest.files.find((candidate) => candidate.changeId === changeId);
    if (!entry || !entry.worktreeBlock || entry.worktreeBlock.status !== "M" || entry.binary || !entry.exactReconstruction || entry.baseAvailability === "none") {
      throw new Error("Shelf entry is not eligible for a text conflict session.");
    }
    return entry;
  }
  async applyLocked(manifest, input, generationStale) {
    const entry = this.conflictedEntry(manifest, input.changeId);
    const safePath = validateShelfManifestPath(entry.worktreeBlock.path);
    const target = repositoryPath(this.dependencies.repositoryRoot, safePath);
    const currentFingerprint = await pathFingerprint(target);
    const pathStale = currentFingerprint !== input.expectedPathFingerprint;
    if ((generationStale || pathStale) && !input.staleOverride) {
      return { status: "stale", reason: generationStale ? "shelf" : "path" };
    }
    if (generationStale || pathStale) {
      const current = await (0, import_promises19.readFile)(target).catch(() => void 0);
      if (!current)
        return {
          status: "refused",
          reason: "Current shelf conflict file cannot be parked."
        };
      try {
        await this.parkCurrent({
          id: input.id,
          generation: manifest.generation,
          path: safePath,
          bytes: current
        });
      } catch (error) {
        return {
          status: "refused",
          reason: error instanceof Error ? error.message : String(error)
        };
      }
    }
    await replaceRegularWorktreeFile(
      this.dependencies.repositoryRoot,
      safePath,
      Buffer.from(input.content, "utf8")
    );
    const next = await markShelfEntryApplied(
      this.dependencies.store,
      input.id,
      manifest,
      entry.changeId
    );
    return { status: "applied", newGeneration: next.generation };
  }
  async parkCurrent(input) {
    if (this.dependencies.parkCurrent) return this.dependencies.parkCurrent(input);
    if (!this.dependencies.getGitDirectories) {
      throw new Error("Shelf recovery parking is unavailable.");
    }
    const { gitDir } = await this.dependencies.getGitDirectories();
    await parkShelfConflictCurrent(this.dependencies.store, gitDir, input);
  }
};
async function parkShelfConflictCurrent(store, gitDir, input) {
  const journalId = `shelf-conflict-${(0, import_node_crypto14.randomUUID)().replaceAll("-", "")}`;
  const recoveryDirectory = import_node_path19.default.join(gitDir, "intelligit", "recovery", journalId);
  const target = resolveRecoveryPath(recoveryDirectory, validateShelfManifestPath(input.path));
  await store.writeJournal({
    id: journalId,
    state: "unshelvePending",
    pathProgress: { [input.path]: "conflictParking" },
    shelf: { id: input.id, generation: input.generation }
  });
  try {
    await ensureContainedParent(gitDir, target);
    const file = await (0, import_promises19.open)(
      target,
      import_node_fs6.constants.O_WRONLY | import_node_fs6.constants.O_CREAT | import_node_fs6.constants.O_EXCL | resolveNoFollowFlag(),
      384
    );
    try {
      await file.writeFile(input.bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    await (0, import_promises19.chmod)(target, 384);
    await store.transitionJournal(journalId, "applied");
  } catch (error) {
    await (0, import_promises19.rm)(recoveryDirectory, { recursive: true, force: true });
    await store.deleteJournal(journalId).catch(() => void 0);
    throw error;
  }
}
async function markShelfEntryApplied(store, shelfId, manifest, changeId) {
  const files = manifest.files.map(
    (entry) => entry.changeId === changeId ? { ...entry, lifecycle: "applied" } : entry
  );
  const allApplied = files.every((entry) => entry.lifecycle === "applied");
  const journalId = `unshelve-${(0, import_node_crypto14.randomUUID)().replaceAll("-", "")}`;
  await store.writeJournal({
    id: journalId,
    state: "unshelvePending",
    pathProgress: { [changeId]: "applied" },
    shelf: { id: shelfId, generation: manifest.generation }
  });
  const next = await store.writeShelfGeneration(shelfId, {
    schemaVersion: manifest.schemaVersion,
    objectHashes: manifest.objectHashes,
    metadata: {
      ...manifest.metadata,
      lifecycle: allApplied ? "applied" : "shelved",
      appliedAt: allApplied ? Date.now() : void 0
    },
    files
  });
  await store.transitionJournal(journalId, allApplied ? "ghost" : "applied");
  return next;
}

// baseline:src/services/shelfService.ts
var ShelfService = class {
  /** Initializes host-owned Git and recovery collaborators. */
  constructor(options) {
    this.options = options;
    this.gitOps = options.gitOps ?? new GitOps(options.executor);
    this.reverter = options.reverter ?? new ShelfReverter({
      repositoryRoot: options.repositoryRoot,
      gitOps: this.gitOps,
      gate: options.gate,
      store: options.store
    });
    this.recoveryMinimumRetentionMs = options.recoveryMinimumRetentionMs ?? 24 * 60 * 60 * 1e3;
    this.recordBaseRevisions = options.recordBaseRevisions ?? true;
    this.conflictSessions = new ShelfConflictSessionService({
      repositoryRoot: options.repositoryRoot,
      store: options.store,
      executor: options.executor,
      withMutation: (operation) => this.withMutation(operation),
      readBase: (id, entry) => this.baseForEntry(id, entry),
      getGitDirectories: () => this.gitOps.getGitDirectories()
    });
  }
  options;
  healthWarnings = /* @__PURE__ */ new Map();
  gitOps;
  reverter;
  recoveryMinimumRetentionMs;
  recordBaseRevisions;
  conflictSessions;
  /** Absolute repository root this service mutates; safe for logs and health rows. */
  get repositoryRoot() {
    return this.options.repositoryRoot;
  }
  /** Captures selected layers durably; Save to Shelf deliberately skips the destructive reverter. */
  async shelve(input) {
    assertShelfName(input.name);
    const payload = Buffer.from(JSON.stringify(input));
    return this.withMutation(async () => {
      const create = async () => {
        const created = await this.options.store.withGenerationCas(
          { expectedCatalogGeneration: input.expectedCatalogGeneration },
          async () => this.captureShelf(input)
        );
        return created;
      };
      if (!input.idempotencyToken) return create();
      return this.options.store.runIdempotent(
        { token: input.idempotencyToken, operation: "shelve", payload },
        create
      );
    });
  }
  /** Applies whole selected entries only; flattened mode never writes the Git index. */
  async unshelve(input) {
    return this.withMutation(
      async () => this.options.store.withGenerationCas(
        { shelfId: input.id, expectedShelfGeneration: input.expectedShelfGeneration },
        async () => {
          const manifest = await this.options.store.readCurrentShelfManifest(input.id);
          const selected = selectEntries(manifest.files, input.changeIds);
          const indexBefore = input.mode === "flattened" ? await this.indexFingerprint() : void 0;
          const entries = [];
          for (const entry of selected) {
            entries.push(await this.applyEntry(input.id, entry, input.mode));
            if (indexBefore && await this.indexFingerprint() !== indexBefore) {
              throw new Error("Flattened unshelve changed the Git index.");
            }
          }
          const successful = /* @__PURE__ */ new Set();
          for (const entry of entries) {
            if (entry.kind === "applied" || entry.kind === "flattenedResidue")
              successful.add(entry.changeId);
          }
          let nextGeneration = manifest.generation;
          if (input.removeFromShelf && successful.size > 0) {
            const files = manifest.files.map(
              (entry) => successful.has(entry.changeId) ? { ...entry, lifecycle: "applied" } : entry
            );
            const allApplied = files.every((entry) => entry.lifecycle === "applied");
            const journalId = `unshelve-${(0, import_node_crypto15.randomUUID)().replaceAll("-", "")}`;
            await this.options.store.writeJournal({
              id: journalId,
              state: "unshelvePending",
              pathProgress: Object.fromEntries(
                [...successful].map((changeId) => [changeId, "applied"])
              ),
              shelf: { id: input.id, generation: manifest.generation }
            });
            const next = await this.options.store.writeShelfGeneration(input.id, {
              schemaVersion: manifest.schemaVersion,
              objectHashes: manifest.objectHashes,
              metadata: {
                ...manifest.metadata,
                lifecycle: allApplied ? "applied" : "shelved",
                appliedAt: allApplied ? Date.now() : void 0
              },
              files
            });
            await this.options.store.transitionJournal(
              journalId,
              allApplied ? "ghost" : "applied"
            );
            nextGeneration = next.generation;
          }
          return {
            status: statusFor(entries),
            entries,
            shelfId: input.id,
            newGeneration: nextGeneration
          };
        }
      )
    );
  }
  /** Deletes only shelf artifacts; recovery snapshots have independent retention. */
  async deleteShelf(input) {
    return this.withMutation(
      async () => this.options.store.withGenerationCas(
        { shelfId: input.id, expectedShelfGeneration: input.expectedShelfGeneration },
        async () => {
          await this.options.store.deleteShelf(input.id);
          return { status: "ok", entries: [], shelfId: input.id };
        }
      )
    );
  }
  /** Renaming is a new immutable generation; patch objects remain content-addressed and unchanged. */
  async renameShelf(input) {
    assertShelfName(input.name);
    return this.withMutation(
      async () => this.options.store.withGenerationCas(
        { shelfId: input.id, expectedShelfGeneration: input.expectedShelfGeneration },
        async () => {
          const manifest = await this.options.store.readCurrentShelfManifest(input.id);
          const next = await this.options.store.writeShelfGeneration(input.id, {
            schemaVersion: manifest.schemaVersion,
            objectHashes: manifest.objectHashes,
            metadata: { ...manifest.metadata, name: input.name },
            files: manifest.files
          });
          return {
            status: "ok",
            entries: [],
            shelfId: input.id,
            newGeneration: next.generation
          };
        }
      )
    );
  }
  /** Creates the documented lossy content-only patch stream from whole selected entries. */
  async exportPatch(input) {
    const manifest = await this.options.store.readCurrentShelfManifest(input.id);
    return exportFlattenedPatch(
      this.options.store,
      input.id,
      selectEntries(manifest.files, input.changeIds)
    );
  }
  /** Imports bounded absolute patch files into a content-only shelf. */
  async importPatch(input) {
    if (input.name !== void 0) assertShelfName(input.name);
    const payload = Buffer.from(JSON.stringify(input));
    return this.withMutation(async () => {
      const create = async () => this.options.store.withGenerationCas(
        { expectedCatalogGeneration: input.expectedCatalogGeneration },
        async () => {
          const imported = await importPatchFiles(
            this.options.store,
            input.fileUris,
            input.name
          );
          return {
            status: "ok",
            entries: [],
            shelfId: imported.shelfId,
            newGeneration: imported.generation
          };
        }
      );
      if (!input.idempotencyToken) return create();
      return this.options.store.runIdempotent(
        { token: input.idempotencyToken, operation: "importPatch", payload },
        create
      );
    });
  }
  /** Restores a previously applied ghost shelf to its shelved lifecycle. */
  async restoreGhost(input) {
    return this.withMutation(
      async () => this.options.store.withGenerationCas(
        { shelfId: input.id, expectedShelfGeneration: input.expectedShelfGeneration },
        async () => {
          const manifest = await this.options.store.readCurrentShelfManifest(input.id);
          if (manifest.metadata.lifecycle !== "applied")
            throw new Error("Shelf is not an already-unshelved ghost.");
          const next = await this.options.store.writeShelfGeneration(input.id, {
            schemaVersion: manifest.schemaVersion,
            objectHashes: manifest.objectHashes,
            metadata: { ...manifest.metadata, lifecycle: "shelved" },
            files: manifest.files.map((file) => ({ ...file, lifecycle: "shelved" }))
          });
          return {
            status: "ok",
            entries: [],
            shelfId: input.id,
            newGeneration: next.generation
          };
        }
      )
    );
  }
  /** Deletes selected already-applied ghost shelves. */
  async cleanUp(selection) {
    return this.withMutation(async () => this.cleanUpSelection(selection));
  }
  /** Deletes fully applied ghosts older than the configured age; zero preserves PyCharm's default. */
  async cleanUpExpiredGhosts(days, now = Date.now()) {
    if (!Number.isFinite(days) || days <= 0) return { status: "ok", entries: [] };
    const cutoff = now - days * 24 * 60 * 60 * 1e3;
    return this.withMutation(async () => {
      const listed = await this.options.store.listShelves();
      const manifests = await Promise.all(
        listed.shelfIds.map(async (id) => ({
          id,
          manifest: await this.options.store.readCurrentShelfManifest(id)
        }))
      );
      const shelfIds = [];
      for (const { id, manifest } of manifests) {
        if (manifest.metadata.lifecycle === "applied" && manifest.metadata.appliedAt !== void 0 && manifest.metadata.appliedAt < cutoff) {
          shelfIds.push(id);
        }
      }
      if (shelfIds.length === 0) return { status: "ok", entries: [] };
      return this.cleanUpSelection({
        shelfIds,
        expectedCatalogGeneration: listed.catalogGeneration
      });
    });
  }
  /** Applies one explicitly chosen structural resolution after fingerprint validation. */
  async resolveStructural(input) {
    return this.withMutation(
      async () => this.options.store.withGenerationCas(
        { shelfId: input.id, expectedShelfGeneration: input.expectedShelfGeneration },
        async () => {
          const entry = (await this.options.store.readCurrentShelfManifest(input.id)).files.find((file) => file.changeId === input.changeId);
          if (!entry || !isStructural(entry))
            throw new Error("Structural shelf entry does not exist.");
          await resolveStructuralAction(input, this.options, entry);
          return {
            status: "ok",
            entries: [{ kind: "applied", changeId: entry.changeId }],
            shelfId: input.id
          };
        }
      )
    );
  }
  /** Opens a read-only shelf text-conflict session without holding mutation serialization. */
  async openShelfConflictSession(id, changeId) {
    return this.conflictSessions.open({ id, changeId });
  }
  /** Applies a shelf merge result through the session's queue, CAS, and fingerprint guards. */
  async applyShelfConflictResolution(input) {
    return this.conflictSessions.apply(input);
  }
  /** Explicit recovery purge; deleting a shelf never reaches this path. */
  async purgeRecovery() {
    return this.withMutation(async () => {
      const directories = await this.gitOps.getGitDirectories();
      return purgeRecoverySnapshots({
        gitDir: directories.gitDir,
        minimumRetentionMs: this.recoveryMinimumRetentionMs
      });
    });
  }
  /** Lists usable shelves with the lock-authoritative catalog generation. */
  async listShelves() {
    const initial = await this.options.store.listShelves();
    await Promise.all(initial.shelfIds.map((id) => this.refreshHistoryBaseAvailability(id)));
    const listed = await this.options.store.listShelves();
    this.replaceHealth(
      "corruptShelf",
      listed.corruptShelfIds.map((id) => ({ kind: "corruptShelf", detail: id }))
    );
    return {
      ...listed,
      shelves: await Promise.all(
        listed.shelfIds.map(async (id) => {
          const manifest = await this.options.store.readCurrentShelfManifest(id);
          return {
            id,
            generation: manifest.generation,
            metadata: manifest.metadata,
            files: manifest.files
          };
        })
      )
    };
  }
  /** Returns a fresh immutable snapshot of bounded advisory health state. */
  getHealthWarnings() {
    return Object.freeze(
      [...this.healthWarnings?.values() ?? []].flat().map((warning) => Object.freeze({ ...warning }))
    );
  }
  replaceHealth(kind, warnings) {
    this.healthWarnings.delete(kind);
    if (warnings.length)
      this.healthWarnings.set(
        kind,
        warnings.map((warning) => ({ ...warning }))
      );
  }
  /** Returns the immutable current entries for one shelf. */
  async getShelfFiles(id) {
    return (await this.refreshHistoryBaseAvailability(id)).files;
  }
  /** Returns only immutable stored artifacts, never a fake current-file base. */
  async getShelfFileContents(id, changeId) {
    const entry = (await this.options.store.readCurrentShelfManifest(id)).files.find(
      (file) => file.changeId === changeId
    );
    if (!entry) throw new Error("Shelf entry does not exist.");
    return {
      indexPatch: entry.indexBlock?.patchObjectHash ? await this.options.store.readObject(id, entry.indexBlock.patchObjectHash) : void 0,
      worktreePatch: entry.worktreeBlock?.patchObjectHash ? await this.options.store.readObject(id, entry.worktreeBlock.patchObjectHash) : void 0,
      rawBefore: entry.worktreeBlock?.rawBeforeObjectHash ? await this.options.store.readObject(id, entry.worktreeBlock.rawBeforeObjectHash) : void 0,
      rawAfter: entry.worktreeBlock?.rawAfterObjectHash ? await this.options.store.readObject(id, entry.worktreeBlock.rawAfterObjectHash) : void 0
    };
  }
  /** Materializes immutable base and shelved bytes for read-only shelf diff documents. */
  async getShelfDiffContents(id, changeId) {
    const manifest = await this.refreshHistoryBaseAvailability(id);
    const entry = manifest.files.find((file) => file.changeId === changeId);
    if (!entry) throw new Error("Shelf entry does not exist.");
    const block = entry.worktreeBlock ?? entry.indexBlock;
    if (!block) throw new Error("Shelf entry has no diffable file block.");
    const contents = await this.getShelfFileContents(id, changeId);
    if (!entry.exactReconstruction) {
      if (!contents.rawBefore || !contents.rawAfter) {
        throw new Error("Shelf entry is missing required raw diff bytes.");
      }
      return {
        path: block.path,
        binary: entry.binary,
        base: contents.rawBefore,
        shelved: contents.rawAfter
      };
    }
    const base = await this.baseForEntry(id, entry);
    if (!base) {
      return {
        path: block.path,
        binary: entry.binary,
        base: void 0,
        shelved: Buffer.from(
          "Shelved content is unavailable because its base is unavailable."
        )
      };
    }
    const shelved = await this.materializeEntry(
      block.path,
      base,
      contents.indexPatch,
      contents.worktreePatch
    );
    return {
      path: block.path,
      binary: entry.binary,
      base,
      shelved: shelved ?? Buffer.from("Shelved content could not be materialized from this shelf.")
    };
  }
  /** Rolls back incomplete destructive captures and removes their now-cancelled durable shelves. */
  async resumePendingRecovery() {
    const journals = await this.options.store.readJournals();
    const links = /* @__PURE__ */ new Map();
    for (const journal of journals) {
      if (journal.state === "shelvePendingRevert" && journal.shelf)
        links.set(journal.id, journal.shelf);
    }
    const result = await this.reverter.resumePending();
    for (const id of result.rolledBackIds) {
      const shelf = links.get(id);
      if (!shelf) continue;
      await this.withMutation(async () => {
        await this.options.store.deleteShelf(shelf.id).catch((error) => {
          if (!isNotFound8(error)) throw error;
        });
      });
    }
    const pending = await this.options.store.readJournals();
    this.replaceHealth(
      "pendingRecovery",
      pending.length ? [
        {
          kind: "pendingRecovery",
          detail: `${pending.length} pending recovery journal(s)`
        }
      ] : []
    );
    return result;
  }
  async captureShelf(input) {
    const captured = await captureShelfArtifacts(input, {
      repositoryRoot: this.options.repositoryRoot,
      executor: this.options.executor,
      store: this.options.store,
      recordBaseRevisions: this.recordBaseRevisions,
      materializeEntry: (relativePath, base, indexPatch, worktreePatch) => this.materializeEntry(relativePath, base, indexPatch, worktreePatch)
    });
    if (!input.keepLocal) {
      await this.reverter.revertWithHeldLocks({
        transactionId: (0, import_node_crypto15.randomUUID)().replaceAll("-", ""),
        baseOid: captured.baseCommit,
        files: captured.revertFiles.flat(),
        shelf: { id: captured.shelfId, generation: captured.generation }
      });
    }
    return {
      status: "ok",
      entries: [],
      shelfId: captured.shelfId,
      newGeneration: captured.generation
    };
  }
  /** Shared catalog-CAS deletion path for explicit and activation-time ghost cleanup. */
  async cleanUpSelection(selection) {
    return this.options.store.withGenerationCas(
      { expectedCatalogGeneration: selection.expectedCatalogGeneration },
      async () => {
        for (const id of selection.shelfIds) {
          const manifest = await this.options.store.readCurrentShelfManifest(id);
          if (manifest.metadata.lifecycle !== "applied")
            throw new Error("Clean up only accepts already-unshelved ghosts.");
          await this.options.store.deleteShelf(id);
        }
        return { status: "ok", entries: [] };
      }
    );
  }
  async applyEntry(shelfId, entry, mode) {
    if (isStructural(entry)) {
      const block = entry.worktreeBlock ?? entry.indexBlock;
      if (!block) throw new Error("Structural shelf entry has no file path.");
      const localPath = block.status === "R" ? block.renamedFrom ?? block.path : block.path;
      return {
        kind: "structuralPending",
        changeId: entry.changeId,
        reason: "Structural shelf change needs a choice.",
        path: localPath,
        pathFingerprint: await pathFingerprint(
          repositoryPath(this.options.repositoryRoot, localPath)
        )
      };
    }
    if (!entry.exactReconstruction) return this.applyRawEntry(shelfId, entry);
    if (mode === "exactState") return this.applyExactEntry(shelfId, entry);
    return this.applyFlattenedEntry(shelfId, entry);
  }
  async applyRawEntry(shelfId, entry) {
    const block = entry.worktreeBlock;
    if (!block?.rawBeforeObjectHash || !block.rawAfterObjectHash) {
      return {
        kind: "retained",
        changeId: entry.changeId,
        reason: "Raw reconstruction artifacts are missing."
      };
    }
    const target = repositoryPath(this.options.repositoryRoot, block.path);
    const [before, after, current] = await Promise.all([
      this.options.store.readObject(shelfId, block.rawBeforeObjectHash),
      this.options.store.readObject(shelfId, block.rawAfterObjectHash),
      (0, import_promises20.readFile)(target).catch((error) => {
        if (isNotFound8(error)) return void 0;
        throw error;
      })
    ]);
    if (!current?.equals(before)) {
      return {
        kind: "structuralPending",
        changeId: entry.changeId,
        reason: "Local bytes differ from raw shelf preimage.",
        path: block.path,
        pathFingerprint: await pathFingerprint(target)
      };
    }
    await replaceRegularWorktreeFile(this.options.repositoryRoot, block.path, after);
    return { kind: "applied", changeId: entry.changeId };
  }
  async applyFlattenedEntry(shelfId, entry) {
    const indexPatch = await this.blockPatch(shelfId, entry.indexBlock);
    const worktreePatch = await this.blockPatch(shelfId, entry.worktreeBlock);
    if (indexPatch && worktreePatch && await this.isCancellationResidue(shelfId, entry, indexPatch, worktreePatch)) {
      if (!await this.applyToWorktree(indexPatch)) {
        return {
          kind: "retained",
          changeId: entry.changeId,
          reason: "Index residue does not apply cleanly."
        };
      }
      return { kind: "flattenedResidue", changeId: entry.changeId };
    }
    const patch = Buffer.concat([
      indexPatch ?? Buffer.alloc(0),
      worktreePatch ?? Buffer.alloc(0)
    ]);
    if (patch.length === 0)
      return {
        kind: "retained",
        changeId: entry.changeId,
        reason: "Shelf entry has no patch."
      };
    if (await this.applyToWorktree(patch)) return { kind: "applied", changeId: entry.changeId };
    const merged = await this.mergeTextEntry(shelfId, entry, indexPatch, worktreePatch);
    return merged ?? {
      kind: "retained",
      changeId: entry.changeId,
      reason: "Patch does not apply cleanly."
    };
  }
  async applyExactEntry(shelfId, entry) {
    const indexPatch = await this.blockPatch(shelfId, entry.indexBlock);
    const worktreePatch = await this.blockPatch(shelfId, entry.worktreeBlock);
    const exactPath = entry.indexBlock?.path ?? entry.worktreeBlock?.path;
    if (exactPath && await this.pathHasStagedDivergence(exactPath)) {
      return {
        kind: "refused",
        changeId: entry.changeId,
        reason: "Index already diverges at this shelf path."
      };
    }
    const combined = Buffer.concat([
      indexPatch ?? Buffer.alloc(0),
      worktreePatch ?? Buffer.alloc(0)
    ]);
    if (!await this.checkWorktree(combined)) {
      return {
        kind: "retained",
        changeId: entry.changeId,
        reason: "Exact state patch does not apply cleanly."
      };
    }
    if (indexPatch && !await this.checkIndex(indexPatch)) {
      return {
        kind: "refused",
        changeId: entry.changeId,
        reason: "Index cannot accept the shelf layer."
      };
    }
    if (indexPatch) {
      await this.applyWorktreeUnchecked(indexPatch);
      await this.applyIndexUnchecked(indexPatch);
      await this.assertExactIndex(shelfId, entry, indexPatch);
    }
    if (worktreePatch) await this.applyWorktreeUnchecked(worktreePatch);
    return { kind: "applied", changeId: entry.changeId };
  }
  async mergeTextEntry(shelfId, entry, _indexPatch, _worktreePatch) {
    const kind = await this.conflictSessions.mergeTextEntry(shelfId, entry);
    return kind ? { kind, changeId: entry.changeId } : void 0;
  }
  async isCancellationResidue(shelfId, entry, indexPatch, worktreePatch) {
    const base = await this.baseForEntry(shelfId, entry);
    const relativePath = entry.worktreeBlock?.path ?? entry.indexBlock?.path;
    if (!base || !relativePath) return false;
    const safeRelativePath = validateShelfManifestPath(relativePath);
    const temp = await (0, import_promises20.mkdtemp)(import_node_path20.default.join((0, import_node_os6.tmpdir)(), "intelligit-shelf-residue-"));
    try {
      await (0, import_promises20.writeFile)(import_node_path20.default.join(temp, safeRelativePath), base).catch(async () => {
        await (0, import_promises20.mkdir)(import_node_path20.default.dirname(import_node_path20.default.join(temp, safeRelativePath)), {
          recursive: true,
          mode: 448
        });
        await (0, import_promises20.writeFile)(import_node_path20.default.join(temp, safeRelativePath), base);
      });
      if (!await this.applyPatchUnder(
        temp,
        safeRelativePath,
        Buffer.concat([indexPatch, worktreePatch])
      ))
        return false;
      return (await (0, import_promises20.readFile)(import_node_path20.default.join(temp, safeRelativePath))).equals(base);
    } finally {
      await (0, import_promises20.rm)(temp, { recursive: true, force: true });
    }
  }
  async baseForEntry(shelfId, entry) {
    const block = entry.worktreeBlock ?? entry.indexBlock;
    if (!block) return void 0;
    if (block.baseObjectHash)
      return this.options.store.readObject(shelfId, block.baseObjectHash);
    const manifest = await this.options.store.readCurrentShelfManifest(shelfId);
    if (!manifest.metadata.baseCommit || entry.baseAvailability === "none") return void 0;
    const safeRelativePath = validateShelfManifestPath(block.renamedFrom ?? block.path);
    const result = await this.options.executor.runBinary(
      ["show", `${manifest.metadata.baseCommit}:${safeRelativePath}`],
      { expectedExitCodes: [0, 128] }
    );
    return result.exitCode === 0 ? result.stdout : void 0;
  }
  /** Persists unavailable history bases as `none` so snapshots never promise a missing base. */
  async refreshHistoryBaseAvailability(id) {
    return this.withMutation(
      async () => this.options.store.withLock(async () => {
        const manifest = await this.options.store.readCurrentShelfManifest(id);
        if (!manifest.metadata.baseCommit) return manifest;
        const unavailable = /* @__PURE__ */ new Set();
        for (const entry of manifest.files) {
          if (entry.baseAvailability !== "history") continue;
          const block = entry.worktreeBlock ?? entry.indexBlock;
          if (!block) {
            unavailable.add(entry.changeId);
            continue;
          }
          const relativePath = validateShelfManifestPath(block.renamedFrom ?? block.path);
          const result = await this.options.executor.runBinary(
            ["show", `${manifest.metadata.baseCommit}:${relativePath}`],
            { expectedExitCodes: [0, 128] }
          );
          if (result.exitCode !== 0) unavailable.add(entry.changeId);
        }
        if (unavailable.size === 0) return manifest;
        return this.options.store.writeShelfGeneration(id, {
          schemaVersion: manifest.schemaVersion,
          objectHashes: manifest.objectHashes,
          metadata: manifest.metadata,
          files: manifest.files.map(
            (entry) => unavailable.has(entry.changeId) ? { ...entry, baseAvailability: "none" } : entry
          )
        });
      })
    );
  }
  async applyPatchUnder(directory, relativePath, patch) {
    const safeRelativePath = validateShelfManifestPath(relativePath);
    await (0, import_promises20.mkdir)(import_node_path20.default.dirname(import_node_path20.default.join(directory, safeRelativePath)), {
      recursive: true,
      mode: 448
    });
    const checked = await this.options.executor.runBinary(
      ["-C", directory, "apply", "--check", "-"],
      { input: patch, expectedExitCodes: [0, 1] }
    );
    if (checked.exitCode !== 0) return false;
    await this.options.executor.runBinary(["-C", directory, "apply", "-"], {
      input: patch
    });
    return true;
  }
  async materializeEntry(relativePath, base, indexPatch, worktreePatch) {
    const temp = await (0, import_promises20.mkdtemp)(import_node_path20.default.join((0, import_node_os6.tmpdir)(), "intelligit-shelf-materialize-"));
    try {
      const safeRelativePath = validateShelfManifestPath(relativePath);
      const target = import_node_path20.default.join(temp, safeRelativePath);
      await (0, import_promises20.mkdir)(import_node_path20.default.dirname(target), { recursive: true, mode: 448 });
      await (0, import_promises20.writeFile)(target, base);
      const patch = Buffer.concat([
        indexPatch ?? Buffer.alloc(0),
        worktreePatch ?? Buffer.alloc(0)
      ]);
      return await this.applyPatchUnder(temp, safeRelativePath, patch) ? await (0, import_promises20.readFile)(target) : void 0;
    } finally {
      await (0, import_promises20.rm)(temp, { recursive: true, force: true });
    }
  }
  async assertExactIndex(shelfId, entry, indexPatch) {
    const relativePath = entry.indexBlock?.path;
    if (!relativePath) return;
    const safeRelativePath = validateShelfManifestPath(relativePath);
    const temp = await (0, import_promises20.mkdtemp)(import_node_path20.default.join((0, import_node_os6.tmpdir)(), "intelligit-shelf-index-"));
    try {
      const target = import_node_path20.default.join(temp, safeRelativePath);
      const base = await this.baseForEntry(shelfId, entry);
      await (0, import_promises20.mkdir)(import_node_path20.default.dirname(target), { recursive: true, mode: 448 });
      if (base) await (0, import_promises20.writeFile)(target, base);
      if (!await this.applyPatchUnder(temp, safeRelativePath, indexPatch)) {
        throw new Error("Could not materialize expected exact-state index.");
      }
      const expected = await (0, import_promises20.readFile)(target).catch((error) => {
        if (isNotFound8(error)) return void 0;
        throw error;
      });
      const actual = await this.options.executor.runBinary(["show", `:${safeRelativePath}`], {
        expectedExitCodes: [0, 128]
      });
      if (actual.exitCode === 0 && (!expected || !actual.stdout.equals(expected)) || actual.exitCode !== 0 && expected) {
        throw new Error("Exact-state index did not match the captured layer.");
      }
    } finally {
      await (0, import_promises20.rm)(temp, { recursive: true, force: true });
    }
  }
  async blockPatch(shelfId, block) {
    return block?.patchObjectHash ? this.options.store.readObject(shelfId, block.patchObjectHash) : void 0;
  }
  async applyToWorktree(patch) {
    if (!await this.checkWorktree(patch)) return false;
    await this.applyWorktreeUnchecked(patch);
    return true;
  }
  async checkWorktree(patch) {
    const result = await this.options.executor.runBinary(["apply", "--check", "-"], {
      input: patch,
      expectedExitCodes: [0, 1]
    });
    return result.exitCode === 0;
  }
  async checkIndex(patch) {
    const result = await this.options.executor.runBinary(
      ["apply", "--check", "--cached", "-"],
      {
        input: patch,
        expectedExitCodes: [0, 1]
      }
    );
    return result.exitCode === 0;
  }
  async applyWorktreeUnchecked(patch) {
    await this.options.executor.runBinary(["apply", "-"], { input: patch });
  }
  async applyIndexUnchecked(patch) {
    await this.options.executor.runBinary(["apply", "--cached", "-"], { input: patch });
  }
  async pathHasStagedDivergence(relativePath) {
    const safeRelativePath = validateShelfManifestPath(relativePath);
    const result = await this.options.executor.runBinary(
      ["diff", "--cached", "--quiet", "--", safeRelativePath],
      {
        expectedExitCodes: [0, 1]
      }
    );
    return result.exitCode !== 0;
  }
  async indexFingerprint() {
    const listing = await this.options.executor.runBinary(["ls-files", "--stage", "-v", "-z"]);
    return (0, import_node_crypto15.createHash)("sha256").update(listing.stdout).digest("hex");
  }
  async withMutation(operation) {
    const directories = await this.gitOps.getGitDirectories();
    try {
      const result = await this.options.gate.run(
        this.options.repositoryRoot,
        directories.commonDir,
        () => this.options.store.withLock(operation)
      );
      this.replaceHealth("lockBusy", []);
      this.replaceHealth("recoveryFull", []);
      return result;
    } catch (error) {
      if (error instanceof RepositoryLockBusyError) {
        this.replaceHealth("lockBusy", [{ kind: "lockBusy", detail: error.message }]);
      } else if (error instanceof ShelfRecoveryFullError) {
        this.replaceHealth("recoveryFull", [
          { kind: "recoveryFull", detail: error.message }
        ]);
      } else if (error instanceof ShelfStoreCorruptionError) {
        this.replaceHealth("checksumMismatch", [
          { kind: "checksumMismatch", detail: error.message }
        ]);
      }
      throw error;
    }
  }
};

// baseline:src/git/repositoryMutationGate.ts
var import_promises21 = require("node:fs/promises");
var import_node_path21 = __toESM(require("node:path"));

// baseline:src/git/mutationCoordinator.ts
var RepositoryMutationCoordinator = class {
  tails = /* @__PURE__ */ new Map();
  /** Runs one mutation after prior mutations for the same normalized key finish. */
  async run(repoRoot, operation) {
    const previous = this.tails.get(repoRoot) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.tails.set(repoRoot, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(repoRoot) === tail) this.tails.delete(repoRoot);
    }
  }
};

// baseline:src/git/repositoryMutationGate.ts
var RepositoryMutationGate = class {
  /** Creates the shared gate from one coordinator and one cross-process lock. */
  constructor(coordinator, lock, options = {}) {
    this.coordinator = coordinator;
    this.lock = lock;
    this.acquireTimeoutMs = options.acquireTimeoutMs ?? 5e3;
    this.acquireRetryDelayMs = options.acquireRetryDelayMs ?? 150;
    this.resolveRepositoryRoot = options.resolveRepositoryRoot ?? import_promises21.realpath;
  }
  coordinator;
  lock;
  acquireTimeoutMs;
  acquireRetryDelayMs;
  resolveRepositoryRoot;
  requestedPathCoordinator = new RepositoryMutationCoordinator();
  /** Runs a short Git mutation while holding both serialization layers. */
  async run(repoRoot, commonDir, operation) {
    return this.requestedPathCoordinator.run(import_node_path21.default.resolve(repoRoot), async () => {
      const key = await this.resolveRepositoryRoot(repoRoot);
      return this.coordinator.run(key, async () => {
        const release = await this.acquireWithBriefWait(commonDir);
        try {
          return await operation();
        } finally {
          await release();
        }
      });
    });
  }
  /**
   * Retries a busy lock for a bounded window so overlapping short mutations from
   * another window queue instead of failing; persistent owners still surface busy.
   */
  async acquireWithBriefWait(commonDir) {
    return acquireWithBoundedWait(() => this.lock.acquire(commonDir), {
      timeoutMs: this.acquireTimeoutMs,
      retryDelayMs: this.acquireRetryDelayMs
    });
  }
  /** Resolves Git's relative common-dir response against the active worktree root. */
  resolveCommonDir(repoRoot, commonDir) {
    return import_node_path21.default.resolve(repoRoot, commonDir.trim());
  }
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  GitExecutor,
  RepositoryLock,
  RepositoryMutationCoordinator,
  RepositoryMutationGate,
  ShelfService,
  ShelfStore,
  resolveShelfPaths
});
