/** A remote row owned by the extension's latest configured Git snapshot. */
export interface ManagedRemote {
    name: string;
    url: string;
    additionalUrlCount: number;
}

/** The only requests the Manage Remotes webview may send to its host. */
export type ManageRemotesRequest =
    | { type: "ready" }
    | { type: "reload" }
    | { type: "close" }
    | { type: "add"; name: string; url: string }
    | { type: "edit"; revision: number; originalName: string; name: string; url: string }
    | { type: "remove"; revision: number; name: string };

/** Host-owned messages; repository identity and original URL never come from the client. */
export type ManageRemotesResponse =
    | { type: "busy" }
    | { type: "error"; message: string }
    | {
          type: "snapshot";
          repoLabel: string;
          revision: number;
          remotes: ManagedRemote[];
          error?: string;
          completed?: boolean;
      };
