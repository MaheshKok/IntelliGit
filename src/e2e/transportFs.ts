// File-exchange transport for the E2E control channel. Playwright writes
// `<nonce>.request.json` into `$INTELLIGIT_E2E_CHANNEL_DIR`; the extension watches that
// directory, consumes the request, and writes `<nonce>.response.json` back atomically so a
// reader polling for it can never observe a partial write (PLAN.md Phase 1 step 10).

import { randomBytes } from "node:crypto";
import type { FSWatcher } from "node:fs";
import { existsSync, readFileSync, renameSync, rmSync, watch, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { getErrorMessage } from "../utils/errors";

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

/**
 * Describes why a request file could not be read, in terms safe to write to the host log.
 *
 * A `JSON.parse` failure is reported without its message, because that message can contain
 * file content. Measured against this Node's V8 rather than assumed: when the parse fails at
 * position 0 the message quotes the input's first ten characters
 * (`Unexpected token 'p', "placeholde"... is not valid JSON`), and only when it fails later
 * does it report a bare position. Ten characters is a small leak but a real one, and the file
 * it comes from is not opaque bytes -- a `secret` `seed` request carries the secret value --
 * while this suite's host log is a CI log. The channel's presence-and-digest-never-values rule
 * is stated without an exception for prefixes, so this honours it without one.
 *
 * Nothing diagnosable is lost: the nonce below names the file for anyone who wants to open it,
 * and the reason it could not be read is the same for every shape of invalid JSON.
 *
 * Every other failure -- a read error, a permission error -- carries an errno and a path, not
 * file content, so its message is kept, but through `getErrorMessage` rather than raw. That is
 * the same helper the channel's other log site uses, and it applies `sanitizeErrorMessage`;
 * routing both through it keeps ONE redaction policy for the channel, with the `SyntaxError`
 * branch above as its single deliberate exception. Today no `readFileSync` errno message
 * carries a credential-bearing URL, so this changes no observable output -- which is exactly
 * why it is tested directly below rather than through the watcher: a difference nothing can
 * observe is a difference no end-to-end test can defend.
 */
export function describeReadFailure(error: unknown): string {
    if (error instanceof SyntaxError) {
        return "request file is not valid JSON (content withheld: a request body can carry a secret value)";
    }
    return getErrorMessage(error);
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
 *
 * Unreadable CONTENT is a separate matter from an unreadable name, and is handled here rather
 * than downstream. `fs.watch` fires as soon as the request file appears, which for a writer
 * that does not rename its file into place can be before the bytes are all there, so
 * `readRequestFile`'s `JSON.parse` can throw a `SyntaxError` -- inside this listener, upstream
 * of every `try`/`catch` in the caller's dispatch path, where nothing catches it and it
 * escapes as an uncaught exception in the extension host.
 *
 * Such an event is dropped rather than reported to `onRequest` as a failed request, because
 * this transport cannot tell the two causes apart from the parse error alone: a half-written
 * file and a genuinely malformed one look identical. Dropping is right for the first (the
 * writer's completing write fires another event for the same file) and merely quiet for the
 * second, whereas answering would race a spurious error response against the real one. The
 * skip is logged so a request that never gets answered has a stated reason on the host side
 * rather than presenting to the caller as an unexplained timeout.
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
        let payload: unknown;
        try {
            payload = readRequestFile(channelDir, nonce);
        } catch (error) {
            console.error(
                `E2E control channel skipped an unreadable request "${nonce}": ${describeReadFailure(error)}`,
            );
            return;
        }
        if (payload === undefined) {
            return;
        }
        onRequest(nonce, payload);
    });
    return { dispose: () => watcher.close() };
}
