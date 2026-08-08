// File-exchange transport for the E2E control channel. Playwright writes
// `<nonce>.request.json` into `$INTELLIGIT_E2E_CHANNEL_DIR`; the extension watches that
// directory, consumes the request, and writes `<nonce>.response.json` back atomically so a
// reader polling for it can never observe a partial write (PLAN.md Phase 1 step 10).

import { randomBytes } from "node:crypto";
import type { FSWatcher } from "node:fs";
import { existsSync, readFileSync, renameSync, rmSync, watch, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const NONCE_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const REQUEST_SUFFIX = ".request.json";
const RESPONSE_SUFFIX = ".response.json";

/**
 * Validates a nonce extracted from a filename. The nonce is the sole namespacing key for
 * this transport, so it must never be allowed to contain a path separator or traversal
 * sequence -- otherwise a malformed or hostile filename could make the "atomic" response
 * write land outside the channel directory.
 */
export function isValidNonce(nonce: string): boolean {
    return NONCE_PATTERN.test(nonce);
}

/**
 * Extracts the nonce from a `<nonce>.request.json` basename, or `undefined` if the filename
 * doesn't match that shape or carries an invalid nonce.
 */
export function nonceFromRequestFilename(filename: string): string | undefined {
    if (!filename.endsWith(REQUEST_SUFFIX)) {
        return undefined;
    }
    const nonce = filename.slice(0, -REQUEST_SUFFIX.length);
    return isValidNonce(nonce) ? nonce : undefined;
}

/**
 * Reads and JSON-parses a `<nonce>.request.json` file. Returns `undefined` if the file is
 * missing, e.g. a race where a prior watcher tick already consumed and removed it.
 */
export function readRequestFile(channelDir: string, nonce: string): unknown {
    const path = join(channelDir, `${nonce}${REQUEST_SUFFIX}`);
    if (!existsSync(path)) {
        return undefined;
    }
    return JSON.parse(readFileSync(path, "utf8"));
}

/** Deletes a consumed `<nonce>.request.json` file so the watcher never reprocesses it. */
export function removeRequestFile(channelDir: string, nonce: string): void {
    rmSync(join(channelDir, `${nonce}${REQUEST_SUFFIX}`), { force: true });
}

/**
 * Writes `<nonce>.response.json` atomically: the payload is written to a sibling temp file
 * first, then moved into place with a single `rename`, which POSIX and NTFS both guarantee
 * is atomic within one directory. A reader polling for the response file therefore either
 * sees no file yet, or the complete one -- never a partial write.
 */
export function writeResponseFileAtomic(channelDir: string, nonce: string, payload: unknown): void {
    const finalPath = join(channelDir, `${nonce}${RESPONSE_SUFFIX}`);
    const tempPath = join(channelDir, `.${nonce}.${randomBytes(6).toString("hex")}.tmp`);
    writeFileSync(tempPath, JSON.stringify(payload), "utf8");
    renameSync(tempPath, finalPath);
}

/** Disposer returned by {@link watchChannelDir}. */
export interface ChannelWatcher {
    dispose(): void;
}

/**
 * Starts watching `channelDir` for new `<nonce>.request.json` files, invoking `onRequest`
 * with the nonce and parsed payload for each one it can read. Malformed nonces and
 * unrelated files (including this transport's own `.response.json` and `.tmp` outputs) are
 * silently ignored by the filename filter -- they are not this watcher's concern.
 */
export function watchChannelDir(
    channelDir: string,
    onRequest: (nonce: string, payload: unknown) => void,
): ChannelWatcher {
    const watcher: FSWatcher = watch(channelDir, { persistent: false }, (_eventType, filename) => {
        if (filename === null) {
            return;
        }
        const nonce = nonceFromRequestFilename(basename(filename.toString()));
        if (nonce === undefined) {
            return;
        }
        const payload = readRequestFile(channelDir, nonce);
        if (payload === undefined) {
            return;
        }
        onRequest(nonce, payload);
    });
    return { dispose: () => watcher.close() };
}
