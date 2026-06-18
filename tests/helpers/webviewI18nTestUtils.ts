import enCatalog from "../../src/webviews/i18n/en.json";

export function installWebviewI18n(locale = "en"): void {
    const payload = {
        locale,
        fallbackLocale: "en",
        catalog: enCatalog,
        fallbackCatalog: enCatalog,
    };

    if (typeof window !== "undefined") {
        Object.defineProperty(window, "intelligitI18n", {
            configurable: true,
            value: payload,
        });
    }

    Object.defineProperty(globalThis, "intelligitI18n", {
        configurable: true,
        value: payload,
    });
}
