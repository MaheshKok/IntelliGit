import js from "@eslint/js";
import globals from "globals";
import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
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

const stagedTypeAwareRules = {
    "@typescript-eslint/await-thenable": "warn",
    "@typescript-eslint/no-base-to-string": "warn",
    "@typescript-eslint/no-floating-promises": "warn",
    "@typescript-eslint/no-misused-promises": "warn",
    "@typescript-eslint/no-unnecessary-type-assertion": "warn",
    "@typescript-eslint/no-unsafe-argument": "warn",
    "@typescript-eslint/no-unsafe-assignment": "warn",
    "@typescript-eslint/no-unsafe-call": "warn",
    "@typescript-eslint/no-unsafe-member-access": "warn",
    "@typescript-eslint/no-unsafe-return": "warn",
    "@typescript-eslint/require-await": "warn",
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
        rules: {
            "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
            ...stagedTypeAwareRules,
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
            ...stagedTypeAwareRules,
            "@typescript-eslint/no-misused-promises": [
                "warn",
                {
                    checksVoidReturn: {
                        attributes: false,
                    },
                },
            ],
        },
    },
]);
