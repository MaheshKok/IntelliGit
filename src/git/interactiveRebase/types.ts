/** The Git todo actions IntelliGit accepts for an interactive rebase. */
export type RebaseAction = "pick" | "reword" | "squash" | "fixup" | "drop";

/** One host-recorded commit action in the interactive rebase dialog order. */
export interface RebaseTodoEntry {
    /** Full object ID for the offered commit. */
    hash: string;
    /** Requested Git todo action. */
    action: RebaseAction;
    /** Commit subject or replacement-message marker associated with the action. */
    message?: string;
}

/** Untrusted dialog entry accepted by the submission validator. */
export interface RebaseSubmissionEntry {
    /** Candidate object ID supplied by the client. */
    hash: unknown;
    /** Candidate Git todo action supplied by the client. */
    action: unknown;
    /** Optional message supplied by the client. */
    message?: unknown;
}

/** The precise reason a submitted rebase todo list is rejected. */
export type RebaseSubmissionValidationReason =
    | "invalid-action"
    | "invalid-hash"
    | "hash-not-offered"
    | "duplicate-hash"
    | "entry-count-mismatch"
    | "missing-message"
    | "invalid-message"
    | "invalid-first-action";

/** Machine-readable reason an interactive-rebase dialog submission is refused by the host. */
export type InteractiveRebaseSubmissionRejectionReason =
    | "unknown-or-expired"
    | "wrong-origin"
    | RebaseSubmissionValidationReason
    | "repo-changed"
    | "branch-unavailable"
    | "head-unavailable"
    | "branch-moved"
    | "head-moved"
    | InteractiveRebaseGuardRejectionReason;

/** The typed result of fail-closed interactive-rebase submission validation. */
export type RebaseSubmissionValidationResult =
    | {
          /** Indicates the ordered entries may be written to a Git todo file. */
          status: "valid";
          /** Immutable copy of the validated dialog order. */
          entries: readonly RebaseTodoEntry[];
      }
    | {
          /** Indicates no todo file may be built from the submission. */
          status: "invalid";
          /** Machine-readable rejection cause for the host to report. */
          reason: RebaseSubmissionValidationReason;
      };

/** The durable lifecycle states for an IntelliGit-owned interactive rebase session. */
export type RebaseSessionLifecycle =
    | "starting"
    | "running"
    | "paused"
    | "completed-pending-push"
    | "done";

/** The upstream destination pinned for an optional post-rebase force push. */
export interface RebasePushTarget {
    /** Configured remote name for the current branch. */
    remoteName: string;
    /** Fully qualified remote-tracking ref associated with the configured upstream. */
    remoteHeadRef: string;
    /** Object ID expected at the remote-tracking ref before the force push. */
    upstreamOid: string;
}

/** Versioned durable state for one interactive-rebase submission. */
export interface RebaseSessionManifest {
    /** Schema version used to reject unknown durable state. */
    version: 1;
    /** Session UUID shared by the reservation, directory, and rebase marker. */
    sessionId: string;
    /** Repository root captured when the submission was accepted. */
    repoRoot: string;
    /** Fully qualified current branch ref, such as `refs/heads/main`. */
    branch: string;
    /** Optional all-or-none remote destination for the later force-push offer. */
    pushTarget?: RebasePushTarget;
    /** Commit immediately before the selected rebase range. */
    baseHash: string;
    /** HEAD object ID that must still match when the rebase starts. */
    expectedHead: string;
    /** ISO timestamp recorded when the session was created. */
    createdAt: string;
    /** Current durable session state. */
    lifecycle: RebaseSessionLifecycle;
    /** Object ID produced by a successfully completed rebase, when available. */
    rebasedHeadOid?: string;
}

/** The typed reasons a persisted manifest cannot be treated as actionable state. */
export type RebaseManifestAmbiguousReason =
    | "corrupt"
    | "truncated"
    | "unknown-version"
    | "invalid-schema"
    | "unreadable";

/** The typed result of loading one durable interactive-rebase manifest. */
export type RebaseManifestReadResult =
    | {
          /** No manifest exists for this session. */
          status: "missing";
      }
    | {
          /** The persisted state conforms to the current schema and is actionable. */
          status: "valid";
          /** Validated durable session state. */
          manifest: RebaseSessionManifest;
      }
    | {
          /** Persisted state exists but must not drive an operation. */
          status: "ambiguous";
          /** Machine-readable reason for the fail-closed recovery path. */
          reason: RebaseManifestAmbiguousReason;
      };

/** Paths owned by one per-repository interactive-rebase storage namespace. */
export interface RebaseStoragePaths {
    /** Per-repository directory rooted under the caller-supplied extension storage. */
    repositoryDirectory: string;
    /** Parent directory for per-submission helper artifacts. */
    sessionsDirectory: string;
    /** Parent directory for durable manifests that outlive helper-artifact cleanup. */
    manifestDirectory: string;
    /** Exclusive-create pointer file used for the repository reservation. */
    reservationPath: string;
    /** Produces the helper-artifact directory path for one validated session ID. */
    sessionDirectory(sessionId: string): string;
    /** Produces the durable manifest path for one validated session ID. */
    manifestPath(sessionId: string): string;
}

/** The helper-artifact paths created for one interactive-rebase submission. */
export interface RebaseSessionPaths {
    /** Directory named by the session ID; it contains only helper artifacts. */
    directory: string;
    /** Todo content file consumed by the sequence-editor helper. */
    todoPath: string;
    /** JSON map keyed by commit object ID for message-bearing steps. */
    messageMapPath: string;
    /** Directory containing one-shot helper consumption markers. */
    consumptionDirectory: string;
}

/** Successful exclusive ownership of one repository's interactive-rebase reservation. */
export interface RebaseReservation {
    /** Session ID recorded in the exclusive pointer file. */
    sessionId: string;
    /** Pointer file that must be removed when the reservation is released. */
    pointerPath: string;
}

/** Result of attempting to reserve one repository for an interactive rebase. */
export type RebaseReservationAcquireResult =
    | {
          /** This caller exclusively owns the repository reservation. */
          status: "acquired";
          /** Reservation handle required for release. */
          reservation: RebaseReservation;
      }
    | {
          /** Another rebase state prevents this submission from proceeding. */
          status: "rejected";
          /** The fail-closed reason acquisition was denied. */
          reason: "reservation-exists" | "rebase-in-progress";
      };

/** Result of activation-time orphan reservation cleanup. */
export type RebaseReservationSweepResult =
    | {
          /** No reservation pointer existed. */
          status: "none";
      }
    | {
          /** A pointer without a rebase directory or live manifest was removed. */
          status: "reclaimed";
      }
    | {
          /** Existing state was retained because it may still represent an active rebase. */
          status: "retained";
          /** Condition that prevents safe orphan cleanup. */
          reason: "rebase-in-progress" | "live-manifest" | "ambiguous-state";
      };

/** One commit offered to the interactive-rebase dialog in oldest-first order. */
export interface InteractiveRebaseRangeCommit {
    /** Full Git object ID for the commit. */
    hash: string;
    /** Author name exactly as Git emitted it. */
    authorName: string;
    /** ISO-8601 author timestamp exactly as Git emitted it. */
    authoredAt: string;
    /** Full commit body exactly as Git emitted it. */
    body: string;
    /** Whether the commit is already reachable from a remote-tracking reference. */
    isPushed: boolean;
}

/** Machine-readable reason loading a bounded interactive-rebase range was rejected. */
export type InteractiveRebaseRangeRejectionReason =
    | "invalid-base-hash"
    | "invalid-head-hash"
    | "range-too-large"
    | "invalid-range-count"
    | "empty-range"
    | "output-truncated"
    | "missing-trailing-sentinel"
    | "malformed-arity"
    | "count-mismatch"
    | "git-error";

/** Fail-closed result of loading one interactive-rebase commit range. */
export type InteractiveRebaseRangeResult =
    | {
          /** The bounded range was loaded and parsed without ambiguity. */
          status: "ok";
          /** Commits ordered from the selected commit through HEAD. */
          commits: readonly InteractiveRebaseRangeCommit[];
      }
    | {
          /** The range could not safely be offered to a dialog. */
          status: "rejected";
          /** Machine-readable rejection cause for the later UI layer. */
          reason: InteractiveRebaseRangeRejectionReason;
      };

/** Machine-readable reason the interactive-rebase action cannot proceed. */
export type InteractiveRebaseGuardRejectionReason =
    | "invalid-selected-hash"
    | "operation-in-progress"
    | "detached-head"
    | "selected-merge-commit"
    | "commit-not-ancestor"
    | "initial-commit"
    | "working-tree-dirty"
    | "range-contains-merge-commit"
    | "git-error";

/** Fail-closed result of evaluating interactive-rebase action guards. */
export type InteractiveRebaseGuardResult =
    | {
          /** Every guard passed and the range may proceed to the next host-side phase. */
          status: "ok";
      }
    | {
          /** At least one safety guard failed. */
          status: "rejected";
          /** Machine-readable reason the action must stop. */
          reason: InteractiveRebaseGuardRejectionReason;
      };

/** Values captured before issuing a single-use interactive-rebase dialog request. */
export interface PendingRebaseDialogRequestInput {
    /** Provider instance that opened the dialog and must later consume its request. */
    originProvider: object;
    /** Absolute root for the repository whose history produced the offered range. */
    repoRoot: string;
    /** Full selected commit object ID at the start of the offered range. */
    baseHash: string;
    /** Full object IDs in the exact oldest-to-newest order offered to the dialog. */
    rangeHashes: readonly string[];
    /** HEAD object ID that must still match when a later submission is accepted. */
    expectedHead: string;
    /** Fully qualified symbolic branch ref that must still be checked out on submission. */
    expectedBranch: string;
}

/** Immutable host-side record for one active interactive-rebase dialog. */
export interface PendingRebaseDialogRequest extends PendingRebaseDialogRequestInput {
    /** Host-generated one-shot identifier that never lets the webview choose Git revisions. */
    requestId: string;
}

/** Outcome of consuming one pending dialog request from a provider-specific inbound channel. */
export type PendingRebaseDialogConsumeResult =
    | {
          /** The request belonged to this provider and is removed before being returned. */
          status: "consumed";
          /** Immutable request snapshot for the submission validation phase. */
          request: PendingRebaseDialogRequest;
      }
    | {
          /** The request cannot be used by this message. */
          status: "rejected";
          /** Distinguishes missing or expired state from a request owned by another provider. */
          reason: "unknown-or-expired" | "wrong-origin";
      };

/** Result of handling one consumed interactive-rebase dialog submission. */
export type InteractiveRebaseSubmissionResult =
    | {
          /** The host accepted immutable validated todo entries for the next rebase phase. */
          status: "accepted";
          /** One-shot request consumed from the originating provider. */
          request: PendingRebaseDialogRequest;
          /** Validated copied todo entries in dialog order. */
          entries: readonly RebaseTodoEntry[];
      }
    | {
          /** The submission must not progress to the rebase engine. */
          status: "rejected";
          /** Distinct fail-closed cause for this host-side refusal. */
          reason: InteractiveRebaseSubmissionRejectionReason;
      };

/** Clock override used to make pending-request expiry deterministic in unit tests. */
export interface PendingRebaseDialogRequestRegistryOptions {
    /** Returns the current epoch milliseconds; production defaults to {@link Date.now}. */
    now?: () => number;
}

/** In-memory request registry that keeps a dialog handoff bound to its originating provider. */
export interface PendingRebaseDialogRequests {
    /** Registers one request and returns its host-generated single-use ID. */
    register(request: PendingRebaseDialogRequestInput): string;
    /** Removes and returns a request only when the same provider instance consumes it. */
    consume(requestId: string, originProvider: object): PendingRebaseDialogConsumeResult;
    /** Removes one pending request when its dialog is explicitly dismissed or superseded. */
    cancel(requestId: string): void;
    /** Removes every pending request owned by a disposed provider instance. */
    cancelAllForOrigin(originProvider: object): void;
    /**
     * Removes requests the named providers captured for a repository they no longer show.
     *
     * Cancellation is scoped to origins rather than keyed on the repository alone because the
     * docked views and the undocked panel switch repositories independently: a root-wide sweep
     * would destroy a dialog that is still open and still valid in the other window.
     */
    cancelForOrigins(origins: readonly object[], repoRoot: string): void;
}
