// Configuration manager for application settings and environment handling.
// Supports loading from files, environment variables, and runtime overrides.

// ============================================================
// SECTION 1: Imports and Constants
// ============================================================
import * as fs from "fs";
import * as path from "path";

const CONFIG_FILE_NAME = "app.config.json";
const ENV_PREFIX = "APP_";
const MAX_CACHE_SIZE = 100;
const DEFAULT_LOG_LEVEL = "info";
const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

// ============================================================
// SECTION 2: Types
// ============================================================
interface AppConfig {
  port: number;
  host: string;
  logLevel: "debug" | "info" | "warn" | "error";
  database: {
    url: string;
    poolSize: number;
    timeout: number;
  };
  features: Record<string, boolean>;
}

// ============================================================
// SECTION 3: ConfigManager class
// ============================================================
export class ConfigManager {
  private config: AppConfig;
  private overrides: Map<string, unknown>;
  private configPath: string;

  constructor(basePath: string) {
    this.configPath = path.join(basePath, CONFIG_FILE_NAME);
    this.overrides = new Map();
    this.config = this.loadDefaults();
  }

  // ----------------------------------------------------------
  // SECTION 3a: Loading and parsing configuration
  // ----------------------------------------------------------
  loadFromFile(): AppConfig {
    let raw: string;
    let parsed: Partial<AppConfig>;
    try {
      raw = fs.readFileSync(this.configPath, "utf-8");
      parsed = JSON.parse(raw) as Partial<AppConfig>;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to load config from ${this.configPath}: ${message}`);
    }

    this.config = {
      ...this.config,
      ...parsed,
      database: {
        ...this.config.database,
        ...(parsed.database ?? {}),
      },
    };

    return this.config;
  }

  loadFromEnv(): void {
    const envPort = process.env[`${ENV_PREFIX}PORT`];
    if (envPort) {
      const trimmedPort = envPort.trim();
      const parsed = parseInt(trimmedPort, 10);
      if (/^\d+$/.test(trimmedPort) && Number.isFinite(parsed)) {
        this.config.port = parsed;
      } else {
        console.warn(`Ignoring invalid ${ENV_PREFIX}PORT value`);
      }
    }

    const envHost = process.env[`${ENV_PREFIX}HOST`];
    if (envHost) {
      this.config.host = envHost;
    }

    const envLogLevel = process.env[`${ENV_PREFIX}LOG_LEVEL`];
    if (envLogLevel) {
      if (isLogLevel(envLogLevel)) {
        this.config.logLevel = envLogLevel;
      } else {
        console.warn(`Ignoring invalid ${ENV_PREFIX}LOG_LEVEL value`);
      }
    }

    const envDbUrl = process.env[`${ENV_PREFIX}DATABASE_URL`];
    if (envDbUrl) {
      this.config.database.url = envDbUrl.trim();
    }
  }

  // ----------------------------------------------------------
  // SECTION 3b: Default configuration builder
  // ----------------------------------------------------------
  private loadDefaults(): AppConfig {
    return {
      port: 3000,
      host: "localhost",
      logLevel: DEFAULT_LOG_LEVEL,
      database: {
        url: "postgres://localhost:5432/app",
        poolSize: 10,
        timeout: 5000,
      },
      features: {},
    };
  }

  // ----------------------------------------------------------
  // SECTION 3c: Runtime overrides and feature flags
  // ----------------------------------------------------------
  setOverride(key: string, value: unknown): void {
    if (this.overrides.size >= MAX_CACHE_SIZE) {
      const firstKey = this.overrides.keys().next().value;
      if (firstKey !== undefined) {
        this.overrides.delete(firstKey);
      }
    }
    this.overrides.set(key, value);
  }

  getOverride(key: string): unknown {
    return this.overrides.get(key);
  }

  isFeatureEnabled(featureName: string): boolean {
    const override = this.overrides.get(`feature.${featureName}`);
    if (typeof override === "boolean") {
      return override;
    }
    return this.config.features[featureName] ?? false;
  }

  // ----------------------------------------------------------
  // SECTION 3d: Getters and export
  // ----------------------------------------------------------
  getConfig(): Readonly<AppConfig> {
    return deepFreeze(cloneAppConfig(this.config));
  }

  getDatabaseConfig(): Readonly<AppConfig["database"]> {
    return Object.freeze({ ...this.config.database });
  }

  exportToJson(): string {
    return JSON.stringify(this.config, null, 2);
  }
}

function isLogLevel(value: string): value is AppConfig["logLevel"] {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

function cloneAppConfig(config: AppConfig): AppConfig {
  return {
    ...config,
    database: { ...config.database },
    features: { ...config.features },
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nestedValue of Object.values(value as Record<string, unknown>)) {
      if (nestedValue && typeof nestedValue === "object") {
        deepFreeze(nestedValue);
      }
    }
  }
  return value;
}
