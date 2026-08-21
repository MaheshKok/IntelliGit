// React context carrying the current Shiki readiness, language, and theme to
// pane-independent line-rendering components without threading props through
// every intermediate component.

import { createContext, useContext } from "react";
import type { ShikiTheme } from "./shikiHighlighter";

/** Current Shiki highlighting context for the rendered document. */
export interface SyntaxHighlightState {
    /** True once the Shiki singleton has initialized successfully. */
    ready: boolean;
    /** Resolved Shiki language id, or null when unsupported. */
    lang: string | null;
    /** Active theme mirrored from the webview body class. */
    theme: ShikiTheme;
}

/** Default state before initialization; callers use the regex tokenizer. */
const DEFAULT_STATE: SyntaxHighlightState = { ready: false, lang: null, theme: "dark-plus" };

const SyntaxHighlightContext = createContext<SyntaxHighlightState>(DEFAULT_STATE);

/** Provider used once at the root of each diff surface. */
export const SyntaxHighlightProvider = SyntaxHighlightContext.Provider;

/** Reads the current syntax-highlighting context. */
export function useSyntaxHighlightState(): SyntaxHighlightState {
    return useContext(SyntaxHighlightContext);
}
