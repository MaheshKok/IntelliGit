import { expect, test } from "./playwright/harnessPage";

for (const surface of ["diff-viewer", "merge-editor"] as const) {
    test(`${surface} preserves JSON property colors across segments`, async ({
        mountHarness,
        page,
    }) => {
        await mountHarness(surface);
        const property = '  "name": "intelligit"';
        const data =
            surface === "diff-viewer"
                ? {
                      path: "package.json",
                      leftLabel: "HEAD",
                      rightLabel: "Working tree",
                      segments: [
                          { type: "common", left: ["{"], right: ["{"] },
                          { type: "common", left: [property, "}"], right: [property, "}"] },
                      ],
                  }
                : {
                      filePath: "package.json",
                      oursLabel: "Ours",
                      theirsLabel: "Theirs",
                      segments: [
                          { type: "common", lines: ["{"] },
                          { type: "common", lines: [property, "}"] },
                      ],
                  };
        await page.evaluate(
            (message) => window.dispatchEvent(new MessageEvent("message", { data: message })),
            { type: surface === "diff-viewer" ? "setDiffData" : "setConflictData", data },
        );
        const properties = page.locator(".code-line-content span").filter({ hasText: '"name"' });
        await expect(properties).toHaveCount(surface === "diff-viewer" ? 2 : 3);
        const light = await page
            .locator("body")
            .evaluate(
                (body) =>
                    body.classList.contains("vscode-light") ||
                    body.classList.contains("vscode-high-contrast-light"),
            );
        for (const propertyToken of await properties.all()) {
            await expect(propertyToken).toHaveCSS(
                "color",
                light ? "rgb(4, 81, 165)" : "rgb(156, 220, 254)",
            );
        }
    });
}
