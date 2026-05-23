export interface IntelligitSettings {
    hoverDelay: number;
    tooltipsEnabled: boolean;
}

export const getSettings = (): IntelligitSettings => {
    const defaultSettings: IntelligitSettings = { hoverDelay: 300, tooltipsEnabled: true };
    try {
        const settings = (window as any).intelligitSettings;
        if (settings && typeof settings === "object") {
            return {
                hoverDelay: typeof settings.hoverDelay === "number" ? settings.hoverDelay : 300,
                tooltipsEnabled: settings.tooltipsEnabled !== false,
            };
        }
    } catch {}
    return defaultSettings;
};
