module.exports = {
    forbidden: [
        {
            name: "not-to-unresolvable",
            comment: "All imports must resolve to a source file, npm package, or Node built-in.",
            severity: "error",
            from: {},
            to: {
                couldNotResolve: true,
            },
        },
        {
            name: "no-circular",
            comment: "Keep source modules acyclic so architecture changes remain reviewable.",
            severity: "error",
            from: {
                path: "^src",
            },
            to: {
                circular: true,
            },
        },
        {
            name: "no-webview-to-extension-host",
            comment:
                "React webviews run in the browser and must not import extension-host commands, services, git operations, or view providers.",
            severity: "error",
            from: {
                path: "^src/webviews/react/",
            },
            to: {
                path: "^src/(commands|git|services|views|extension)(/|\\.ts$)",
            },
        },
        {
            name: "no-extension-host-to-react-webview",
            comment:
                "Extension-host modules should communicate with webviews through messages and generated bundles, not import React UI code.",
            severity: "error",
            from: {
                path: "^src/(commands|git|mergeEditor|services|utils|views|extension)(/|\\.ts$)",
            },
            to: {
                path: "^src/webviews/react/",
            },
        },
        {
            name: "no-domain-layer-to-ui",
            comment: "Git, service, merge, and utility layers should not depend on VS Code view providers or React UI modules.",
            severity: "error",
            from: {
                path: "^src/(git|mergeEditor|services|utils)/",
            },
            to: {
                path: "^src/(views|webviews/react)/",
            },
        },
        {
            name: "no-webview-to-node-or-vscode-runtime",
            comment: "Browser webviews must not import Node built-ins or the VS Code extension API.",
            severity: "error",
            from: {
                path: "^src/webviews/react/",
            },
            to: {
                dependencyTypes: ["core"],
            },
        },
    ],
    options: {
        doNotFollow: {
            path: "node_modules",
        },
        moduleSystems: ["cjs", "es6"],
        tsPreCompilationDeps: true,
        enhancedResolveOptions: {
            exportsFields: ["exports"],
            conditionNames: ["import", "require", "node", "default", "types"],
            extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"],
            mainFields: ["module", "main", "types"],
        },
        skipAnalysisNotInRules: true,
    },
};
