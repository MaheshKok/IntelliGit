// React context carrying the merge editor's current Shiki highlighter
// readiness, resolved language, and theme down to the leaf line-rendering
// components in segments.tsx, without threading props through every
// intermediate component (CodeBlock, CommonSection, ConflictSection, ...).

import { createContext, useContext } from "react";
import type { ShikiTheme } from "./shikiHighlighter";

/** Current Shiki highlighting context for the document being rendered. */
export interface SyntaxHighlightState {
    /** True once the Shiki highlighter singleton has initialized successfully. */
    ready: boolean;
    /** Resolved Shiki language id for the open file, or null if unsupported. */
    lang: string | null;
    /** Active theme, mirrored from the webview's dark/light body class. */
    theme: ShikiTheme;
}

/** Default state before the highlighter initializes: callers fall back to the hand-rolled tokenizer. */
const DEFAULT_STATE: SyntaxHighlightState = { ready: false, lang: null, theme: "dark-plus" };

const SyntaxHighlightContext = createContext<SyntaxHighlightState>(DEFAULT_STATE);

/** Provider component used once at the merge editor's root. */
export const SyntaxHighlightProvider = SyntaxHighlightContext.Provider;

/** Reads the current Shiki highlighting context. */
export function useSyntaxHighlightState(): SyntaxHighlightState {
    return useContext(SyntaxHighlightContext);
}
