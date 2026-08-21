// Shiki syntax highlighting module for diff webviews.
// The JavaScript regex engine is CSP-safe (no wasm/eval); grammars are bundled
// statically and tokenization is cached per source line.
import { createHighlighterCoreSync } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

import js from "@shikijs/langs/javascript";
import ts from "@shikijs/langs/typescript";
import jsx from "@shikijs/langs/jsx";
import tsx from "@shikijs/langs/tsx";
import json from "@shikijs/langs/json";
import python from "@shikijs/langs/python";
import go from "@shikijs/langs/go";
import css from "@shikijs/langs/css";
import html from "@shikijs/langs/html";
import yaml from "@shikijs/langs/yaml";
import shell from "@shikijs/langs/shell";
import markdown from "@shikijs/langs/markdown";

import darkPlus from "@shikijs/themes/dark-plus";
import lightPlus from "@shikijs/themes/light-plus";

/** Bundled Shiki theme name mirroring VS Code's default light/dark themes. */
export type ShikiTheme = "dark-plus" | "light-plus";

/** One grammar-tokenized run with its resolved color and font-style bitmask. */
export interface ShikiToken {
    /** The token's literal text content. */
    text: string;
    /** Resolved foreground color from the active theme, if any. */
    color?: string;
    /** Font-style bitmask (1=italic, 2=bold, 4=underline), if any. */
    fontStyle?: number;
}

// Map file extensions to Shiki language identifiers.
const extensionMap: Record<string, string> = {
    js: "javascript",
    ts: "typescript",
    jsx: "jsx",
    tsx: "tsx",
    json: "json",
    py: "python",
    go: "go",
    css: "css",
    html: "html",
    yaml: "yaml",
    yml: "yaml",
    sh: "shell",
    bash: "shell",
    md: "markdown",
};

// Lazy-initialized sync highlighter singleton.
let highlighter: ReturnType<typeof createHighlighterCoreSync> | null = null;
let highlighterReady = false;

// Line-level token cache (capped at 5000 entries to prevent unbounded growth).
const tokenCache = new Map<string, ShikiToken[] | null>();
const CACHE_MAX = 5000;

/** Detect the user's theme preference from VS Code's body classList. */
export function detectTheme(): ShikiTheme {
    if (typeof document === "undefined") return "light-plus";
    const classes = document.body.classList;
    if (classes.contains("vscode-dark") || classes.contains("vscode-high-contrast")) {
        return "dark-plus";
    }
    return "light-plus";
}

/** Derive a registered Shiki language identifier from a file path. */
export function langForPath(filePath: string): string | null {
    const lastDot = filePath.lastIndexOf(".");
    if (lastDot === -1 || lastDot === filePath.length - 1) return null;
    const ext = filePath.substring(lastDot + 1).toLowerCase();
    return extensionMap[ext] ?? null;
}

/** Initialize the sync Shiki singleton; returns true only on first success. */
export function initShiki(): boolean {
    if (highlighterReady) return false;
    try {
        highlighter = createHighlighterCoreSync({
            langs: [js, ts, jsx, tsx, json, python, go, css, html, yaml, shell, markdown],
            themes: [darkPlus, lightPlus],
            engine: createJavaScriptRegexEngine({ forgiving: true }),
        });
        highlighterReady = true;
        return true;
    } catch (err) {
        console.error("Failed to initialize Shiki:", err);
        return false;
    }
}

/** Check whether Shiki is ready for tokenization. */
export function isShikiReady(): boolean {
    return highlighterReady && highlighter !== null;
}

/** Tokenize one line with Shiki, returning null when unavailable or unsupported. */
export function highlightLine(line: string, lang: string, theme: ShikiTheme): ShikiToken[] | null {
    if (!isShikiReady() || !highlighter) return null;

    const cacheKey = `${line}|${lang}|${theme}`;
    if (tokenCache.has(cacheKey)) return tokenCache.get(cacheKey) ?? null;

    try {
        const lines = highlighter.codeToTokensBase(line, { lang, theme });
        if (!lines || lines.length === 0) {
            tokenCache.set(cacheKey, null);
            return null;
        }
        const tokens: ShikiToken[] = [];
        for (const token of lines[0]) {
            tokens.push({ text: token.content, color: token.color, fontStyle: token.fontStyle });
        }
        if (tokenCache.size >= CACHE_MAX) {
            const firstKey = tokenCache.keys().next().value;
            if (firstKey) tokenCache.delete(firstKey);
        }
        tokenCache.set(cacheKey, tokens);
        return tokens;
    } catch (err) {
        console.warn(`Failed to highlight line with lang="${lang}":`, err);
        tokenCache.set(cacheKey, null);
        return null;
    }
}
