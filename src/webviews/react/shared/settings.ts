export interface IntelligitSettings {
    hoverDelay: number;
    tooltipsEnabled: boolean;
    iconStyle: "color" | "standard";
    commitWindowPosition: "left" | "right";
}

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
                    typeof settingsObj.hoverDelay === "number" ? settingsObj.hoverDelay : 300,
                tooltipsEnabled: settingsObj.tooltipsEnabled !== false,
                iconStyle: settingsObj.iconStyle === "color" ? "color" : "standard",
                commitWindowPosition:
                    settingsObj.commitWindowPosition === "right" ? "right" : "left",
            };
        }
    }
    return defaultSettings;
};
