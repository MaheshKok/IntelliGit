// @vitest-environment jsdom
// Spec-derived tests for the Shiki syntax highlighting module, written from
// the exported function contracts (langForPath, detectTheme, initShiki,
// isShikiReady, highlightLine) without reading past their signatures first.

import { describe, it, expect, beforeAll, afterEach } from "vitest";
import {
    langForPath,
    detectTheme,
    initShiki,
    isShikiReady,
    highlightLine,
} from "../../../src/webviews/react/merge-editor/shikiHighlighter";

describe("langForPath", () => {
    it("maps common extensions to their Shiki language id", () => {
        expect(langForPath("src/App.ts")).toBe("typescript");
        expect(langForPath("src/App.tsx")).toBe("tsx");
        expect(langForPath("index.js")).toBe("javascript");
        expect(langForPath("component.jsx")).toBe("jsx");
        expect(langForPath("data.json")).toBe("json");
        expect(langForPath("main.py")).toBe("python");
        expect(langForPath("server.go")).toBe("go");
        expect(langForPath("style.css")).toBe("css");
        expect(langForPath("index.html")).toBe("html");
        expect(langForPath("config.yaml")).toBe("yaml");
        expect(langForPath("config.yml")).toBe("yaml");
        expect(langForPath("deploy.sh")).toBe("shell");
        expect(langForPath("deploy.bash")).toBe("shell");
        expect(langForPath("README.md")).toBe("markdown");
    });

    it("is case-insensitive on the extension", () => {
        expect(langForPath("App.TS")).toBe("typescript");
        expect(langForPath("App.Ts")).toBe("typescript");
        expect(langForPath("README.MD")).toBe("markdown");
    });

    it("uses the last extension for multi-dot filenames", () => {
        expect(langForPath("archive.tar.gz")).toBeNull();
        expect(langForPath("component.test.ts")).toBe("typescript");
        expect(langForPath("my.config.json")).toBe("json");
    });

    it("returns null when there is no extension", () => {
        expect(langForPath("Makefile")).toBeNull();
        expect(langForPath("LICENSE")).toBeNull();
    });

    it("returns null for unregistered extensions", () => {
        expect(langForPath("notes.unsupportedext")).toBeNull();
        expect(langForPath("archive.zip")).toBeNull();
        expect(langForPath("photo.png")).toBeNull();
    });

    it("returns null for an empty path", () => {
        expect(langForPath("")).toBeNull();
    });

    it("handles a bare extension with no basename", () => {
        expect(langForPath(".ts")).toBe("typescript");
    });

    it("returns null when the path ends with a trailing dot", () => {
        expect(langForPath("weird.")).toBeNull();
    });
});

describe("detectTheme", () => {
    afterEach(() => {
        document.body.className = "";
    });

    it("returns dark-plus for the vscode-dark body class", () => {
        document.body.classList.add("vscode-dark");
        expect(detectTheme()).toBe("dark-plus");
    });

    it("returns dark-plus for the vscode-high-contrast body class", () => {
        document.body.classList.add("vscode-high-contrast");
        expect(detectTheme()).toBe("dark-plus");
    });

    it("returns light-plus for the vscode-light body class", () => {
        document.body.classList.add("vscode-light");
        expect(detectTheme()).toBe("light-plus");
    });

    it("returns light-plus when no theme class is present", () => {
        expect(detectTheme()).toBe("light-plus");
    });
});

describe("highlightLine", () => {
    beforeAll(() => {
        initShiki();
    });

    it("reports the highlighter as ready after initialization", () => {
        expect(isShikiReady()).toBe(true);
    });

    it("returns null for an unregistered language", () => {
        expect(highlightLine("some text", "cobol", "dark-plus")).toBeNull();
    });

    it("tokens concatenate back to the original input", () => {
        const line = 'const total = "hello world";';
        const tokens = highlightLine(line, "typescript", "dark-plus");
        expect(tokens).not.toBeNull();
        expect(tokens!.map((t) => t.text).join("")).toBe(line);
    });

    it("assigns distinct colors to different syntax categories", () => {
        const line = 'const total = "hello";';
        const tokens = highlightLine(line, "typescript", "dark-plus");
        expect(tokens).not.toBeNull();
        const keywordToken = tokens!.find((t) => t.text === "const");
        const stringToken = tokens!.find((t) => t.text.includes("hello"));
        expect(keywordToken?.color).toBeTruthy();
        expect(stringToken?.color).toBeTruthy();
        expect(keywordToken?.color).not.toBe(stringToken?.color);
    });

    it("produces different colors for the same line under different themes", () => {
        const line = "const x = 1;";
        const darkTokens = highlightLine(line, "typescript", "dark-plus");
        const lightTokens = highlightLine(line, "typescript", "light-plus");
        expect(darkTokens).not.toBeNull();
        expect(lightTokens).not.toBeNull();
        const darkKeyword = darkTokens!.find((t) => t.text === "const");
        const lightKeyword = lightTokens!.find((t) => t.text === "const");
        expect(darkKeyword?.color).not.toBe(lightKeyword?.color);
    });

    it("returns an equal (cached) result for repeated calls with the same key", () => {
        const line = "let y = 2;";
        const first = highlightLine(line, "typescript", "dark-plus");
        const second = highlightLine(line, "typescript", "dark-plus");
        expect(second).toEqual(first);
    });

    it("handles an empty line without throwing", () => {
        expect(() => highlightLine("", "typescript", "dark-plus")).not.toThrow();
    });

    it("handles a whitespace-only line without throwing", () => {
        expect(() => highlightLine("    ", "typescript", "dark-plus")).not.toThrow();
    });

    it("tokenizes markdown without throwing", () => {
        expect(() => highlightLine("# Heading", "markdown", "dark-plus")).not.toThrow();
    });

    it("tokenizes python without throwing", () => {
        expect(() => highlightLine("def foo(): pass", "python", "dark-plus")).not.toThrow();
    });
});
