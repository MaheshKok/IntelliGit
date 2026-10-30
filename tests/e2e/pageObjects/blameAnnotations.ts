import { expect, type Locator } from "@playwright/test";
import type { Rgba } from "../../visual/oracles/contrast";
import { oracles } from "../../oracles";

interface BlameAnnotationProbe {
    readonly editorBackground: Rgba;
    readonly descriptionForeground: Rgba;
    readonly userAgent: string;
    readonly annotations: {
        readonly label: string;
        readonly background: Rgba;
        readonly foreground: Rgba;
    }[];
}

/** Reads the actual native before-attachment colors, not a test-only extension channel. */
async function readBlameAnnotations(editor: Locator): Promise<BlameAnnotationProbe> {
    return editor.evaluate((root) => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) throw new Error("Canvas color probe unavailable.");
        const rgba = (color: string) => {
            if (!CSS.supports("color", color)) throw new Error(`Unresolved native color: ${color}`);
            context.clearRect(0, 0, 1, 1);
            context.fillStyle = color;
            context.fillRect(0, 0, 1, 1);
            const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
            return { r, g, b, a: a / 255 };
        };
        return {
            editorBackground: rgba(
                getComputedStyle(root).getPropertyValue("--vscode-editor-background").trim(),
            ),
            descriptionForeground: rgba(
                getComputedStyle(root).getPropertyValue("--vscode-descriptionForeground").trim(),
            ),
            userAgent: navigator.userAgent,
            annotations: Array.from(root.querySelectorAll(".view-line span")).flatMap((span) => {
                const style = getComputedStyle(span, "::before");
                if (["none", "normal", '""'].includes(style.content)) return [];
                return [
                    {
                        label: style.content,
                        background: rgba(style.backgroundColor),
                        foreground: rgba(style.color),
                    },
                ];
            }),
        };
    });
}

/** Requires completed, aligned annotation colors and readable text within existing poll bounds. */
export async function expectBlameAgeColors(
    editor: Locator,
    percentages: readonly (number | null)[],
): Promise<BlameAnnotationProbe> {
    let probe: BlameAnnotationProbe | undefined;
    await expect
        .poll(async () => {
            const current = await readBlameAnnotations(editor);
            probe = current;
            if (current.annotations.length !== percentages.length)
                return [
                    `Expected ${percentages.length} annotations, got ${current.annotations.length}`,
                ];
            return current.annotations.flatMap((annotation, index) => {
                const percent = percentages[index] ?? 0;
                const expected = {
                    r: Math.round(
                        current.editorBackground.r * (1 - percent / 100) + (131 * percent) / 100,
                    ),
                    g: Math.round(
                        current.editorBackground.g * (1 - percent / 100) + (191 * percent) / 100,
                    ),
                    b: Math.round(
                        current.editorBackground.b * (1 - percent / 100) + (84 * percent) / 100,
                    ),
                };
                const backgroundMatches = (["r", "g", "b"] as const).every(
                    (channel) => Math.abs(annotation.background[channel] - expected[channel]) <= 1,
                );
                const ratio = oracles
                    .get("contrast")
                    .contrastRatio(
                        oracles
                            .get("contrast")
                            .compositeOver(annotation.foreground, annotation.background),
                        annotation.background,
                    );
                const foregroundMatches =
                    percent === 0
                        ? (["r", "g", "b", "a"] as const).every(
                              (channel) =>
                                  annotation.foreground[channel] ===
                                  current.descriptionForeground[channel],
                          )
                        : annotation.foreground.a === 1;
                return backgroundMatches &&
                    annotation.background.a === 1 &&
                    foregroundMatches &&
                    ratio >= 4.5
                    ? []
                    : [{ index, percent, expected, ...annotation, ratio }];
            });
        })
        .toEqual([]);
    if (!probe) throw new Error("Native annotation probe did not run.");
    return probe;
}
