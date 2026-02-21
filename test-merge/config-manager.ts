// Configuration manager for application settings and environment handling.
// Supports loading from files, environment variables, and runtime overrides.

// ============================================================
// SECTION 1: Imports and Constants
// ============================================================
import * as fs from "fs";
import * as path from "path";
import * as yaml from "yaml";

const CONFIG_FILE_NAME = "app.config.yaml";
const ENV_PREFIX = "MYAPP_";
const MAX_CACHE_SIZE = 500;
const DEFAULT_LOG_LEVEL = "debug";

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

type ConfigOverride = Partial<AppConfig>;

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
    if (!fs.existsSync(this.configPath)) {
      console.warn(`Config file not found, using defaults: ${this.configPath}`);
      return this.config;
    }

    const raw = fs.readFileSync(this.configPath, "utf-8");
    const parsed = yaml.parse(raw) as Partial<AppConfig>;

    this.config = this.mergeConfig(this.config, parsed);
    return this.config;
  }

  private mergeConfig(base: AppConfig, override: Partial<AppConfig>): AppConfig {
    return {
      ...base,
      ...override,
      database: {
        ...base.database,
        ...(override.database ?? {}),
      },
      features: {
        ...base.features,
        ...(override.features ?? {}),
      },
    };
  }

  loadFromEnv(): void {
    const envPort = process.env[`${ENV_PREFIX}PORT`];
    if (envPort) {
      this.config.port = parseInt(envPort, 10);
    }

    const envHost = process.env[`${ENV_PREFIX}HOST`];
    if (envHost) {
      this.config.host = envHost;
    }

    const envLogLevel = process.env[`${ENV_PREFIX}LOG_LEVEL`];
    if (envLogLevel) {
      this.config.logLevel = envLogLevel as AppConfig["logLevel"];
    }

    const envDbUrl = process.env[`${ENV_PREFIX}DATABASE_URL`];
    if (envDbUrl) {
      this.config.database.url = envDbUrl;
    }
  }

  // ----------------------------------------------------------
  // SECTION 3b: Default configuration builder
  // ----------------------------------------------------------
  private loadDefaults(): AppConfig {
    return {
      port: 8080,
      host: "0.0.0.0",
      logLevel: DEFAULT_LOG_LEVEL as AppConfig["logLevel"],
      database: {
        url: "postgres://db.internal:5432/myapp_dev",
        poolSize: 25,
        timeout: 10000,
      },
      features: {
        darkMode: true,
        betaFeatures: false,
      },
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

  getOverride(key: string): unknown | undefined {
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
    return Object.freeze({ ...this.config });
  }

  getDatabaseConfig(): Readonly<AppConfig["database"]> {
    return Object.freeze({ ...this.config.database });
  }

  exportToYaml(): string {
    return yaml.stringify(this.config);
  }

  validate(): string[] {
    const errors: string[] = [];
    if (this.config.port < 1 || this.config.port > 65535) {
      errors.push("Port must be between 1 and 65535");
    }
    if (this.config.database.poolSize < 1) {
      errors.push("Database pool size must be at least 1");
    }
    return errors;
  }
}
