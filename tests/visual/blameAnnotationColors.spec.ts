import { expect, test } from "@playwright/test";
import {
    blameAnnotationColors,
    type BlameAgeRange,
} from "../../src/services/blameAnnotationColors";
import { oracles } from "../oracles";

test("blame age shades retain exact endpoints and readable text on customized themes", async ({
    page,
}) => {
    const range: BlameAgeRange = { oldest: 0, newest: 100 };
    const shades = Array.from({ length: 101 }, (_, authorTime) => {
        const shade = blameAnnotationColors(
            {
                commit: "a".repeat(40),
                authorTime,
                line: authorTime,
                author: "Ada",
                authorTimezone: "+0000",
                summary: "Change",
            },
            range,
        );
        if (!shade) throw new Error("Missing committed shade.");
        return shade;
    });
    // Neutral labels intentionally inherit the theme, so customize both foreground and background.
    const themes = [
        ["#1f1f1f", "rgba(204, 204, 204, 0.7)"],
        ["#ffffff", "#3b3b3b"],
        ["#000000", "#a0a0a0"],
        ["#fefefe", "#5b5b5b"],
        ["#303446", "#b2b2b2"],
        ["#2d1050", "#b2b2b2"],
        ["#62522c", "#eeeeee"],
        ["#104c5b", "#dddddd"],
        ["#123912", "#b2b2b2"],
        ["#83bf54", "#333333"],
        ["#898989", "#181818"],
        ["#ff0000", "#111111"],
        ["#0000ff", "#dddddd"],
        ["#00ff00", "#333333"],
        ["#4a4a4a", "#c8c8c8"],
        ["#858585", "#111111"],
    ] as const;
    const samples = await page.evaluate(
        ({ shades, themes }) => {
            const canvas = document.createElement("canvas");
            canvas.width = canvas.height = 1;
            const context = canvas.getContext("2d", { willReadFrequently: true });
            if (!context) throw new Error("Canvas color probe unavailable.");
            const rgba = (color: string) => {
                context.clearRect(0, 0, 1, 1);
                context.fillStyle = color;
                context.fillRect(0, 0, 1, 1);
                const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
                return { r, g, b, a: a / 255 };
            };
            const probe = document.createElement("span");
            probe.textContent = "Ada 2020-01-01";
            document.body.append(probe);
            const result = themes.flatMap(([background, descriptionForeground]) => {
                document.documentElement.style.setProperty(
                    "--vscode-editor-background",
                    background,
                );
                document.documentElement.style.setProperty(
                    "--vscode-descriptionForeground",
                    descriptionForeground,
                );
                return shades.map((shade, age) => {
                    for (const [property, value] of [
                        ["background-color", shade.backgroundColor],
                        ["color", shade.color],
                    ]) {
                        if (!CSS.supports(property, value))
                            throw new Error(`Unsupported annotation ${property}: ${value}`);
                        probe.style.setProperty(property, value);
                    }
                    const style = getComputedStyle(probe);
                    return {
                        theme: background,
                        age,
                        foreground: rgba(style.color),
                        background: rgba(style.backgroundColor),
                        expectedBackground: rgba(background),
                        expectedDescriptionForeground: rgba(descriptionForeground),
                    };
                });
            });
            probe.remove();
            return result;
        },
        { shades, themes },
    );
    const unreadable = samples
        .map((sample) => ({
            theme: sample.theme,
            age: sample.age,
            ratio: oracles
                .get("contrast")
                .contrastRatio(
                    oracles.get("contrast").compositeOver(sample.foreground, sample.background),
                    sample.background,
                ),
        }))
        .filter((sample) => sample.ratio < 4.5);
    expect(unreadable).toEqual([]);
    expect(
        samples.filter(
            (sample) =>
                sample.age === 0 &&
                (JSON.stringify(sample.background) !== JSON.stringify(sample.expectedBackground) ||
                    JSON.stringify(sample.foreground) !==
                        JSON.stringify(sample.expectedDescriptionForeground)),
        ),
    ).toEqual([]);
    expect(
        samples.filter(
            (sample) =>
                sample.age === 100 &&
                (sample.background.r !== 131 ||
                    sample.background.g !== 191 ||
                    sample.background.b !== 84 ||
                    sample.background.a !== 1),
        ),
    ).toEqual([]);
});
