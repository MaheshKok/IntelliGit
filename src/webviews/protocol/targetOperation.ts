/** Optional guarded draft action published with the final ownership update. */
export type ShelfDraftChoice =
    | { readonly kind: "keep" }
    | {
          readonly kind: "copySource";
          readonly sourceListId: string;
          readonly expectedDestinationDraft: string;
      };
