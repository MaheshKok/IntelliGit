import { execFileSync } from "node:child_process";
import os from "node:os";

import type { Browser } from "@playwright/test";

import { oracles } from "../../oracles";
import type { VisualEnvironment } from "../oracles/visualEnvironment";

const { normalizeEnvironment } = oracles.get("visualEnvironment");

const FONT_LIST_TIMEOUT_MS = 5_000;

/** Injectable boundary for the bounded, non-shell `fc-list` invocation. */
export type FontListExecutor = (
    file: string,
    args: readonly string[],
    options: { readonly encoding: "utf8"; readonly timeout: number },
) => string;

const defaultFontListExecutor: FontListExecutor = (file, args, options) =>
    execFileSync(file, [...args], {
        encoding: options.encoding,
        timeout: options.timeout,
    });

function parseFontFamilies(line: string): readonly string[] {
    const families: string[] = [];
    let family = "";
    let escaped = false;

    for (const character of line) {
        if (character === "\\" && !escaped) {
            family += character;
            escaped = true;
            continue;
        }
        if (character === "," && !escaped) {
            families.push(family);
            family = "";
            continue;
        }
        family += character;
        escaped = false;
    }
    families.push(family);
    return families.map((value) => value.replace(/\\(.)/g, "$1"));
}

function readFontFamilies(execute: FontListExecutor): readonly string[] {
    try {
        const output = execute("fc-list", [":", "family"], {
            encoding: "utf8",
            timeout: FONT_LIST_TIMEOUT_MS,
        });
        return [
            ...new Set(
                output
                    .split("\n")
                    .flatMap(parseFontFamilies)
                    .map((family) => family.trim())
                    .filter((family) => family.length > 0),
            ),
        ].sort();
    } catch {
        return [];
    }
}

/** Captures the browser, host, container-image, and font inputs used by visual rasterization. */
export async function captureVisualEnvironment(
    browser: Browser,
    execute: FontListExecutor = defaultFontListExecutor,
): Promise<VisualEnvironment> {
    return normalizeEnvironment({
        baseImage: process.env.INTELLIGIT_BASE_IMAGE ?? "<not-in-container>",
        browserVersion: await browser.version(),
        platform: `${process.platform}-${process.arch}`,
        osRelease: os.release(),
        fonts: readFontFamilies(execute),
    });
}
