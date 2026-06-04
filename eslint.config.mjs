import js from "@eslint/js";
import globals from "globals";
import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import sonarjs from "eslint-plugin-sonarjs";
import tseslint from "typescript-eslint";
import { defineConfig } from "eslint/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const EXTENSION_TS_FILES = ["src/**/*.ts"];
const WEBVIEW_REACT_FILES = ["src/webviews/react/**/*.{ts,tsx}"];
const SCRIPT_FILES = ["scripts/**/*.js"];
const TYPED_TS_FILES = ["src/**/*.ts", "src/webviews/react/**/*.{ts,tsx}"];

const typeCheckedConfigs = tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: TYPED_TS_FILES,
}));

const typeAwareSafetyRules = {
    "@typescript-eslint/await-thenable": "error",
    "@typescript-eslint/no-base-to-string": "error",
    "@typescript-eslint/no-floating-promises": "error",
    "@typescript-eslint/no-misused-promises": "error",
    "@typescript-eslint/no-unnecessary-type-assertion": "error",
    "@typescript-eslint/no-unsafe-argument": "error",
    "@typescript-eslint/no-unsafe-assignment": "error",
    "@typescript-eslint/no-unsafe-call": "error",
    "@typescript-eslint/no-unsafe-member-access": "error",
    "@typescript-eslint/no-unsafe-return": "error",
    "@typescript-eslint/require-await": "error",
};

const sonarRules = {
    "sonarjs/cognitive-complexity": ["error", 40],
    "sonarjs/no-all-duplicated-branches": "warn",
    "sonarjs/no-collapsible-if": "warn",
    "sonarjs/no-duplicated-branches": "warn",
    "sonarjs/no-identical-conditions": "warn",
    "sonarjs/no-identical-expressions": "warn",
    "sonarjs/no-inverted-boolean-check": "warn",
    "sonarjs/no-nested-switch": "warn",
    "sonarjs/no-redundant-boolean": "warn",
    "sonarjs/prefer-single-boolean-return": "warn",
};

export default defineConfig([
    {
        ignores: ["dist/**", "coverage/**", "node_modules/**", "*.vsix"],
    },
    {
        files: SCRIPT_FILES,
        ...js.configs.recommended,
        languageOptions: {
            ...js.configs.recommended.languageOptions,
            ecmaVersion: "latest",
            sourceType: "commonjs",
            globals: globals.node,
        },
        plugins: {
            sonarjs,
        },
        rules: {
            ...js.configs.recommended.rules,
            ...sonarRules,
        },
    },
    ...typeCheckedConfigs,
    {
        files: EXTENSION_TS_FILES,
        ignores: ["src/webviews/react/**"],
        languageOptions: {
            parserOptions: {
                project: "./tsconfig.json",
                tsconfigRootDir: __dirname,
            },
            globals: globals.node,
        },
        plugins: {
            sonarjs,
        },
        rules: {
            "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
            ...typeAwareSafetyRules,
            ...sonarRules,
        },
    },
    {
        files: WEBVIEW_REACT_FILES,
        languageOptions: {
            parserOptions: {
                project: "./tsconfig.webview.json",
                tsconfigRootDir: __dirname,
                ecmaFeatures: {
                    jsx: true,
                },
            },
            globals: globals.browser,
        },
        plugins: {
            react,
            "react-hooks": reactHooks,
            sonarjs,
        },
        settings: {
            react: {
                version: "18.2.0",
            },
        },
        rules: {
            ...react.configs.flat.recommended.rules,
            ...react.configs.flat["jsx-runtime"].rules,
            "react/prop-types": "off",
            "react-hooks/rules-of-hooks": "error",
            "react-hooks/exhaustive-deps": "warn",
            "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
            ...typeAwareSafetyRules,
            ...sonarRules,
            "@typescript-eslint/no-misused-promises": [
                "error",
                {
                    checksVoidReturn: {
                        attributes: false,
                    },
                },
            ],
        },
    },
    {
        // Existing high-complexity hotspots are grandfathered at their current
        // measured values so the global 40-point gate is meaningful for new code
        // while still blocking these functions from getting worse in this branch.
        files: ["src/commands/commitCommands.ts"],
        rules: { "sonarjs/cognitive-complexity": ["error", 135] },
    },
    {
        files: ["src/mergeEditor/conflictParser.ts"],
        rules: { "sonarjs/cognitive-complexity": ["error", 47] },
    },
    {
        files: ["src/utils/fileIconTheme.ts"],
        rules: { "sonarjs/cognitive-complexity": ["error", 62] },
    },
    {
        files: ["src/views/CommitPanelViewProvider.ts"],
        rules: { "sonarjs/cognitive-complexity": ["error", 61] },
    },
    {
        files: ["src/views/UndockedViewProvider.ts"],
        rules: { "sonarjs/cognitive-complexity": ["error", 59] },
    },
]);
