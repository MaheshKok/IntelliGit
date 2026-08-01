import * as crypto from "node:crypto";
import type {
    PendingRebaseDialogConsumeResult,
    PendingRebaseDialogRequest,
    PendingRebaseDialogRequestInput,
    PendingRebaseDialogRequestRegistryOptions,
    PendingRebaseDialogRequests,
} from "./types";

const REQUEST_TIMEOUT_MS = 5 * 60 * 1_000;

type StoredRequest = {
    request: PendingRebaseDialogRequest;
    expiresAt: number;
};

/**
 * Creates an in-memory registry for one-shot interactive-rebase dialog requests.
 *
 * The registry binds each request to the exact provider instance that opened it, so another
 * commit-list surface cannot submit or consume the same request ID. Entries are frozen snapshots
 * and expire lazily through the injected clock, avoiding a long-lived timer per dialog.
 */
export function createPendingRebaseDialogRequests(
    options: PendingRebaseDialogRequestRegistryOptions = {},
): PendingRebaseDialogRequests {
    const requests = new Map<string, StoredRequest>();
    const now = options.now ?? Date.now;

    const expireRequests = (): void => {
        const currentTime = now();
        for (const [requestId, stored] of requests) {
            if (stored.expiresAt <= currentTime) requests.delete(requestId);
        }
    };

    const hasSameOriginAndRoot = (
        stored: StoredRequest,
        request: PendingRebaseDialogRequestInput,
    ): boolean =>
        stored.request.originProvider === request.originProvider &&
        stored.request.repoRoot === request.repoRoot;

    const freezeRequest = (request: PendingRebaseDialogRequest): PendingRebaseDialogRequest =>
        Object.freeze({
            ...request,
            rangeHashes: Object.freeze([...request.rangeHashes]),
        });

    return {
        register(request) {
            expireRequests();
            for (const [requestId, stored] of requests) {
                if (hasSameOriginAndRoot(stored, request)) requests.delete(requestId);
            }
            const requestId = crypto.randomUUID();
            requests.set(requestId, {
                request: freezeRequest({ ...request, requestId }),
                expiresAt: now() + REQUEST_TIMEOUT_MS,
            });
            return requestId;
        },
        consume(requestId, originProvider) {
            expireRequests();
            const stored = requests.get(requestId);
            if (!stored) return rejected("unknown-or-expired");
            if (stored.request.originProvider !== originProvider) return rejected("wrong-origin");
            requests.delete(requestId);
            return { status: "consumed", request: freezeRequest(stored.request) };
        },
        cancel(requestId) {
            expireRequests();
            requests.delete(requestId);
        },
        cancelAllForOrigin(originProvider) {
            expireRequests();
            for (const [requestId, stored] of requests) {
                if (stored.request.originProvider === originProvider) requests.delete(requestId);
            }
        },
        cancelForOrigins(origins, repoRoot) {
            expireRequests();
            for (const [requestId, stored] of requests) {
                if (stored.request.repoRoot !== repoRoot) continue;
                if (origins.includes(stored.request.originProvider)) requests.delete(requestId);
            }
        },
    };
}

function rejected(
    reason: Extract<PendingRebaseDialogConsumeResult, { status: "rejected" }>["reason"],
): PendingRebaseDialogConsumeResult {
    return { status: "rejected", reason };
}
