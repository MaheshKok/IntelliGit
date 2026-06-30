/**
 * Webview settings injected by the extension before React applications render.
 *
 * Consumers must tolerate missing or partially shaped settings because tests,
 * story-like harnesses, and older webview payloads can omit the global object.
 */
export interface IntelligitSettings {
    hoverDelay: number;
    tooltipsEnabled: boolean;
    iconStyle: "color" | "standard";
    commitWindowPosition: "left" | "right";
}

/**
 * Reads IntelliGit webview settings from `window.intelligitSettings` with safe defaults.
 *
 * The helper performs defensive runtime checks instead of trusting the injected
 * global so malformed settings cannot break rendering.
 */
export const getSettings = (): IntelligitSettings => {
    const defaultSettings: IntelligitSettings = {
        hoverDelay: 300,
        tooltipsEnabled: true,
        iconStyle: "standard",
        commitWindowPosition: "left",
    };
    if (typeof window !== "undefined") {
        const settings = (window as Window & { intelligitSettings?: unknown }).intelligitSettings;
        if (settings && typeof settings === "object") {
            const settingsObj = settings as Record<string, unknown>;
            return {
                hoverDelay:
                    // Number.isFinite rejects NaN and +/-Infinity (all typeof
                    // "number") and non-numbers without coercion, so a malformed
                    // delay can never reach rendering and timer logic.
                    Number.isFinite(settingsObj.hoverDelay)
                        ? (settingsObj.hoverDelay as number)
                        : 300,
                tooltipsEnabled: settingsObj.tooltipsEnabled !== false,
                iconStyle: settingsObj.iconStyle === "color" ? "color" : "standard",
                commitWindowPosition:
                    settingsObj.commitWindowPosition === "right" ? "right" : "left",
            };
        }
    }
    return defaultSettings;
};

/** Resolves an icon accent color through the shared color-icon setting. */
export function resolveIconColor(accentColor: string, standardColor: string): string {
    return getSettings().iconStyle === "color" ? accentColor : standardColor;
}
