/** Result returned by a lazy provider after it has completed its own bounded probe. */
export type ProviderLoadResult =
    | {
          readonly status: "loaded";
          readonly bytes: Uint8Array | Buffer;
          readonly mode: number;
          /** Providers such as shelves can report binary content without decoding it. */
          readonly binary?: boolean;
      }
    | { readonly status: "missing" }
    | { readonly status: "over-budget"; readonly size: number };

/** Minimal cancellation surface native delegates must re-check before editor effects. */
export interface DiffViewerCancellationToken {
    readonly isCancellationRequested: boolean;
    readonly onCancellationRequested: (listener: () => void) => { dispose(): void };
}

/** Stable provider identities carried into native fallback delegates. */
export interface StableProviderIdentities {
    readonly left?: string;
    readonly right?: string;
}

/** Native fallback receives cancellation and the identities shown by the viewer. */
export type NativeDiffDelegate = (
    cancellationToken: DiffViewerCancellationToken,
    providerIdentities: StableProviderIdentities,
) => Promise<void>;

/** One source side accepted by the unified diff funnel. */
export type SideSpec =
    | { readonly kind: "ref"; readonly ref: string }
    | { readonly kind: "worktree" }
    | {
          readonly kind: "provider";
          readonly load: (maxOutputBytes: number) => Promise<ProviderLoadResult>;
          readonly label: string;
          /** Immutable provider identity, such as a stash commit OID. */
          readonly identity: string;
      };

/** Immutable description of a single two-sided read-only diff request. */
export interface UnifiedDiffRequest {
    readonly repoRoot: string;
    readonly path: string;
    readonly left: SideSpec;
    readonly right: SideSpec;
    readonly languageId: string;
    readonly title: string;
}
