import type { Page } from "@playwright/test";

import type { Box, ClippingInput, SizedTarget } from "../oracles/geometry";
import type { ContrastSample, Rgba } from "../oracles/contrast";

/** The border widths needed to inset a client rect to its content box. */
export interface BorderWidths {
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
    readonly left: number;
}

/** Inputs collected from one rendered harness page for the pure non-pixel oracles. */
export interface CollectedOracleInputs {
    /** One entry per non-truncatable text element, keyed for reporting. */
    readonly clipping: readonly {
        readonly id: string;
        readonly input: ClippingInput;
    }[];
    readonly contrast: readonly ContrastSample[];
    /** Rendered text from each visible direct-text candidate, paired with its page locator key. */
    readonly renderedTexts: readonly {
        readonly id: string;
        readonly oracleKey: string;
        readonly text: string;
    }[];
    readonly interactiveTargets: readonly SizedTarget[];
}

/** Parses the comma-separated rgb()/rgba() form returned by Chromium computed styles. */
export function parseRgba(value: string): Rgba {
    const match =
        /^(rgb|rgba)\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*(\d*\.?\d+))?\s*\)$/u.exec(
            value.trim(),
        );
    const srgbMatch =
        /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\s*\)$/u.exec(
            value.trim(),
        );
    if (match === null && srgbMatch === null) {
        throw new Error(`Unable to parse CSS colour "${value}".`);
    }

    if (match === null) {
        const [, redText, greenText, blueText, alphaText] = srgbMatch;
        const red = Number(redText);
        const green = Number(greenText);
        const blue = Number(blueText);
        const alpha = alphaText === undefined ? 1 : Number(alphaText);
        if (
            ![red, green, blue].every(
                (channel) => Number.isFinite(channel) && channel >= 0 && channel <= 1,
            ) ||
            !Number.isFinite(alpha) ||
            alpha < 0 ||
            alpha > 1
        ) {
            throw new Error(`Unable to parse CSS colour "${value}".`);
        }
        return { r: red * 255, g: green * 255, b: blue * 255, a: alpha };
    }

    const [, format, redText, greenText, blueText, alphaText] = match;
    const red = Number(redText);
    const green = Number(greenText);
    const blue = Number(blueText);
    const alpha = alphaText === undefined ? 1 : Number(alphaText);
    if (
        (format === "rgba" && alphaText === undefined) ||
        (format === "rgb" && alphaText !== undefined) ||
        ![red, green, blue].every(
            (channel) => Number.isInteger(channel) && channel >= 0 && channel <= 255,
        ) ||
        !Number.isFinite(alpha) ||
        alpha < 0 ||
        alpha > 1
    ) {
        throw new Error(`Unable to parse CSS colour "${value}".`);
    }

    return { r: red, g: green, b: blue, a: alpha };
}

/** Converts a client rect and border widths into the rectangle occupied by the content box. */
export function contentBoxFromClientRect(rect: Box, borders: BorderWidths): Box {
    return {
        left: rect.left + borders.left,
        top: rect.top + borders.top,
        right: rect.right - borders.right,
        bottom: rect.bottom - borders.bottom,
    };
}

/** Fails loudly when the page produced no visible text candidates for the live-page oracle. */
export function assertNonEmptyCandidates(candidateCount: number): void {
    if (candidateCount === 0) {
        throw new Error("Oracle input collection found zero visible text candidates inside #root.");
    }
}

/** Collects live DOM geometry, colour, accessibility, and target data for the pure oracles. */
export async function collectOracleInputs(page: Page): Promise<CollectedOracleInputs> {
    const collected = await page.evaluate(() => {
        const root = document.querySelector("#root");
        if (root === null) {
            throw new Error("Oracle input collection could not find #root.");
        }

        const toBox = (rect: DOMRect): Box => ({
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
        });

        const parseNumber = (value: string): number => {
            const parsed = Number.parseFloat(value);
            return Number.isFinite(parsed) ? parsed : 0;
        };

        const contentBox = (rect: DOMRect, style: CSSStyleDeclaration): Box => ({
            left: rect.left + parseNumber(style.borderLeftWidth),
            top: rect.top + parseNumber(style.borderTopWidth),
            right: rect.right - parseNumber(style.borderRightWidth),
            bottom: rect.bottom - parseNumber(style.borderBottomWidth),
        });

        const parseColor = (value: string): Rgba => {
            const match =
                /^(rgb|rgba)\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*(\d*\.?\d+))?\s*\)$/u.exec(
                    value.trim(),
                );
            const srgbMatch =
                /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\s*\)$/u.exec(
                    value.trim(),
                );
            if (match === null && srgbMatch === null) {
                throw new Error(`Unable to parse CSS colour "${value}".`);
            }

            if (match === null) {
                const [, redText, greenText, blueText, alphaText] = srgbMatch;
                const red = Number(redText);
                const green = Number(greenText);
                const blue = Number(blueText);
                const alpha = alphaText === undefined ? 1 : Number(alphaText);
                if (
                    ![red, green, blue].every(
                        (channel) => Number.isFinite(channel) && channel >= 0 && channel <= 1,
                    ) ||
                    !Number.isFinite(alpha) ||
                    alpha < 0 ||
                    alpha > 1
                ) {
                    throw new Error(`Unable to parse CSS colour "${value}".`);
                }
                return { r: red * 255, g: green * 255, b: blue * 255, a: alpha };
            }

            const [, format, redText, greenText, blueText, alphaText] = match;
            const red = Number(redText);
            const green = Number(greenText);
            const blue = Number(blueText);
            const alpha = alphaText === undefined ? 1 : Number(alphaText);
            if (
                (format === "rgba" && alphaText === undefined) ||
                (format === "rgb" && alphaText !== undefined) ||
                ![red, green, blue].every(
                    (channel) => Number.isInteger(channel) && channel >= 0 && channel <= 255,
                ) ||
                !Number.isFinite(alpha) ||
                alpha < 0 ||
                alpha > 1
            ) {
                throw new Error(`Unable to parse CSS colour "${value}".`);
            }

            return { r: red, g: green, b: blue, a: alpha };
        };

        const domPathFor = (element: Element): string => {
            const segments: string[] = [];
            let current: Element | null = element;
            while (current !== null && current !== root) {
                const parent = current.parentElement;
                if (parent === null) break;
                const sameTagSiblings = Array.from(parent.children).filter(
                    (sibling) => sibling.tagName === current?.tagName,
                );
                const ordinal = sameTagSiblings.indexOf(current) + 1;
                segments.unshift(`${current.tagName.toLowerCase()}:nth-of-type(${ordinal})`);
                current = parent;
            }
            return `#root > ${segments.join(" > ")}`;
        };

        const locatorFor = (element: Element): string => {
            const tagName = element.tagName.toLowerCase();
            const testId = element.getAttribute("data-testid")?.trim();
            const elementId = element.getAttribute("id")?.trim();
            const classNames = element.getAttribute("class")?.trim();
            const descriptor = testId
                ? `[data-testid="${testId}"]`
                : elementId
                  ? `#${elementId}`
                  : classNames
                    ? `.${classNames.split(/\s+/u).join(".")}`
                    : "";
            return `${tagName}${descriptor} (${domPathFor(element)})`;
        };

        // `display:none` on ANY ancestor removes the box, but a computed-style read on the
        // element itself still reports that element's own `display` -- so checking the element
        // in isolation misses it. That is why every button inside a collapsed container was
        // reported as a zero-size target, and why text inside hidden panels was still being
        // scored for contrast.
        //
        // `getClientRects()` is the honest test: an empty list means no box was generated
        // anywhere up the tree, while an element that IS rendered at 0x0 still returns one
        // zero-area rect -- which is precisely the defect `findZeroSizeTargets` must keep
        // catching. A naive `width > 0 && height > 0` filter here would delete that oracle.
        //
        // `visibility` inherits, so the element's own computed value already carries an
        // ancestor's `hidden`. `opacity` does not inherit, so it needs the walk.
        const isRendered = (element: Element): boolean => {
            if (element.getClientRects().length === 0) {
                return false;
            }
            if (getComputedStyle(element).visibility === "hidden") {
                return false;
            }
            let node: Element | null = element;
            while (node !== null) {
                if (getComputedStyle(node).opacity === "0") {
                    return false;
                }
                node = node.parentElement;
            }
            return true;
        };

        const elements = Array.from(root.querySelectorAll("*"));
        const candidates = elements.filter((element) => {
            const text = element.textContent?.trim() ?? "";
            const hasDirectTextNode = Array.from(element.childNodes).some(
                (node) =>
                    node.nodeType === Node.TEXT_NODE && (node.textContent?.trim() ?? "").length > 0,
            );
            return text.length > 0 && hasDirectTextNode && isRendered(element);
        });

        const clipping: { id: string; input: object }[] = [];
        const contrast: ContrastSample[] = [];
        const renderedTexts: {
            id: string;
            oracleKey: string;
            text: string;
        }[] = [];

        for (const [index, element] of candidates.entries()) {
            const id = locatorFor(element);
            const oracleKey = String(index);
            element.setAttribute("data-oracle-key", oracleKey);
            const style = getComputedStyle(element);
            const range = document.createRange();
            range.selectNodeContents(element);
            const textRects = Array.from(range.getClientRects()).map(toBox);
            range.detach();

            const clipBoxes: Box[] = [];
            let ancestor: Element | null = element.parentElement;
            while (ancestor !== null) {
                const ancestorStyle = getComputedStyle(ancestor);
                // Only `hidden` and `clip` put text out of reach. `auto` and `scroll` overflow
                // into an area the user can scroll to, so counting them as clippers marks every
                // scroll container in the tree as a defect -- a false red across most of the UI,
                // and a suite that is red everywhere gets tuned away instead of fixed.
                //
                // Axis-aware on purpose: CSS forces the other axis to `auto` when one axis is
                // `hidden`, so a horizontally-clipping ancestor still scrolls vertically. An
                // unbounded edge makes `findClippingLosses` compute a full-width intersection and
                // therefore zero loss on that axis, with no special case in the oracle.
                //
                // The literals are inline because this function is serialized into the page; a
                // module-scope constant would be `undefined` at runtime and silently match nothing.
                const clipsX =
                    ancestorStyle.overflowX === "hidden" || ancestorStyle.overflowX === "clip";
                const clipsY =
                    ancestorStyle.overflowY === "hidden" || ancestorStyle.overflowY === "clip";
                if (clipsX || clipsY) {
                    const bounds = contentBox(ancestor.getBoundingClientRect(), ancestorStyle);
                    clipBoxes.push({
                        left: clipsX ? bounds.left : -Infinity,
                        right: clipsX ? bounds.right : Infinity,
                        top: clipsY ? bounds.top : -Infinity,
                        bottom: clipsY ? bounds.bottom : Infinity,
                    });
                }
                ancestor = ancestor.parentElement;
            }

            let inactive = false;
            let stateElement: Element | null = element;
            while (stateElement !== null) {
                if (
                    stateElement.matches(":disabled") ||
                    stateElement.matches('[aria-disabled="true"]')
                ) {
                    inactive = true;
                    break;
                }
                stateElement = stateElement.parentElement;
            }

            const backgroundLayers: Rgba[] = [];
            let backgroundElement: Element | null = element;
            while (backgroundElement !== null) {
                backgroundLayers.push(
                    parseColor(getComputedStyle(backgroundElement).backgroundColor),
                );
                backgroundElement = backgroundElement.parentElement;
            }
            backgroundLayers.reverse();
            contrast.push({
                id,
                inactive,
                foreground: parseColor(style.color),
                backgroundLayers,
            });

            // Keep rendered text in the same normalized form as the pure source matcher; the
            // fixture supplies the expected value, while this is the value the page produced.
            renderedTexts.push({
                id,
                oracleKey,
                text: (element.textContent ?? "").normalize("NFC").replace(/\s+/gu, " ").trim(),
            });

            if (style.textOverflow !== "ellipsis") {
                clipping.push({
                    id,
                    input: {
                        textRects,
                        clipBoxes,
                        viewport: {
                            left: 0,
                            top: 0,
                            right: window.innerWidth,
                            bottom: window.innerHeight,
                        },
                    },
                });
            }
        }

        const interactiveTargets: SizedTarget[] = Array.from(
            root.querySelectorAll(
                'button, a[href], input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="checkbox"]',
            ),
        )
            .filter(isRendered)
            .map((element) => ({
                id: locatorFor(element),
                box: toBox(element.getBoundingClientRect()),
            }));

        return {
            candidateCount: candidates.length,
            clipping,
            contrast,
            renderedTexts,
            interactiveTargets,
        };
    });

    assertNonEmptyCandidates(collected.candidateCount);
    return {
        clipping: collected.clipping as readonly {
            readonly id: string;
            readonly input: ClippingInput;
        }[],
        contrast: collected.contrast,
        renderedTexts: collected.renderedTexts,
        interactiveTargets: collected.interactiveTargets,
    };
}
