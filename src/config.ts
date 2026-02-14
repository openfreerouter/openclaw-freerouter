/**
 * FreeRouter Config — OpenClaw Plugin Edition
 *
 * Reads config from plugin API (plugins.entries.freerouter.config)
 * instead of freerouter.config.json. Falls back to built-in defaults.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { logger } from "./logger.js";

// ═══ Config Types ═══

export type AuthConfig = {
  type: "openclaw" | "env" | "file" | "keychain";
  key?: string;
  profilesPath?: string;
  filePath?: string;
  service?: string;
  account?: string;
};

export type ProviderConfigEntry = {
  baseUrl: string;
  api: "anthropic" | "openai";
  headers?: Record<string, string>;
  auth?: AuthConfig;
};

export type TierMapping = {
  primary: string;
  fallback: string[];
};

export type ThinkingConfig = {
  adaptive?: string[];
  enabled?: { models: string[]; budget: number };
};

export type FreeRouterConfig = {
  port: number;
  host: string;
  providers: Record<string, ProviderConfigEntry>;
  tiers: Record<string, TierMapping>;
  agenticTiers?: Record<string, TierMapping>;
  tierBoundaries?: {
    simpleMedium: number;
    mediumComplex: number;
    complexReasoning: number;
  };
  thinking?: ThinkingConfig;
  auth: {
    default: string;
    [strategy: string]: unknown;
  };
  scoring?: Record<string, unknown>;
};

// ═══ Defaults ═══

const DEFAULT_CONFIG: FreeRouterConfig = {
  port: 18800,
  host: "127.0.0.1",
  providers: {
    anthropic: {
      baseUrl: "https://api.anthropic.com",
      api: "anthropic",
    },
    "kimi-coding": {
      baseUrl: "https://api.kimi.com/coding/v1",
      api: "openai",
      headers: { "User-Agent": "KimiCLI/0.77" },
    },
  },
  tiers: {
    SIMPLE:    { primary: "kimi-coding/kimi-for-coding", fallback: ["anthropic/claude-haiku-4-5"] },
    MEDIUM:    { primary: "anthropic/claude-sonnet-4-5", fallback: ["anthropic/claude-opus-4-6"] },
    COMPLEX:   { primary: "anthropic/claude-opus-4-6", fallback: ["anthropic/claude-haiku-4-5"] },
    REASONING: { primary: "anthropic/claude-opus-4-6", fallback: ["anthropic/claude-haiku-4-5"] },
  },
  agenticTiers: {
    SIMPLE:    { primary: "kimi-coding/kimi-for-coding", fallback: ["anthropic/claude-haiku-4-5"] },
    MEDIUM:    { primary: "anthropic/claude-sonnet-4-5", fallback: ["anthropic/claude-opus-4-6"] },
    COMPLEX:   { primary: "anthropic/claude-opus-4-6", fallback: ["anthropic/claude-haiku-4-5"] },
    REASONING: { primary: "anthropic/claude-opus-4-6", fallback: ["anthropic/claude-haiku-4-5"] },
  },
  thinking: {
    adaptive: ["claude-opus-4-6", "claude-opus-4.6"],
    enabled: { models: ["claude-sonnet-4-5"], budget: 4096 },
  },
  auth: {
    default: "openclaw",
    openclaw: {
      type: "openclaw",
      profilesPath: "~/.openclaw/agents/main/agent/auth-profiles.json",
    },
  },
};

// ═══ Singleton ═══

let _config: FreeRouterConfig | null = null;
let _configSource: string = "defaults";

/**
 * Deep-merge source into target (source wins). Arrays are replaced, not merged.
 */
function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const sv = source[key];
    const tv = target[key];
    if (sv && typeof sv === "object" && !Array.isArray(sv) && tv && typeof tv === "object" && !Array.isArray(tv)) {
      result[key] = deepMerge(tv as Record<string, unknown>, sv as Record<string, unknown>);
    } else {
      result[key] = sv;
    }
  }
  return result;
}

/**
 * Load config from plugin config object (passed from OpenClaw plugin API).
 * Merges with defaults — user only needs to specify overrides.
 */
export function loadConfigFromPlugin(pluginConfig: Record<string, unknown>): FreeRouterConfig {
  _config = deepMerge(
    DEFAULT_CONFIG as unknown as Record<string, unknown>,
    pluginConfig as unknown as Record<string, unknown>,
  ) as unknown as FreeRouterConfig;
  _configSource = "plugin";
  logger.info("Loaded config from OpenClaw plugin");
  logger.info(`  Providers: ${Object.keys(_config.providers).join(", ")}`);
  logger.info(`  Tiers: ${Object.keys(_config.tiers).join(", ")}`);
  return _config;
}

/**
 * Load config from file (standalone fallback).
 */
export function loadConfig(): FreeRouterConfig {
  // Try file-based config as fallback
  const paths = [
    process.env.FREEROUTER_CONFIG,
    join(process.cwd(), "freerouter.config.json"),
    join(homedir(), ".config", "freerouter", "config.json"),
  ].filter(Boolean) as string[];

  for (const p of paths) {
    if (existsSync(p)) {
      try {
        const raw = readFileSync(p, "utf-8");
        const fileConfig = JSON.parse(raw) as Partial<FreeRouterConfig>;
        _config = deepMerge(DEFAULT_CONFIG as unknown as Record<string, unknown>, fileConfig as unknown as Record<string, unknown>) as unknown as FreeRouterConfig;
        _configSource = p;
        logger.info(`Loaded config from ${p}`);
        return _config;
      } catch (err) {
        logger.error(`Failed to load config from ${p}:`, err);
      }
    }
  }

  logger.info("No config file found, using built-in defaults");
  _config = { ...DEFAULT_CONFIG };
  _configSource = "defaults";
  return _config;
}

export function reloadConfig(): FreeRouterConfig {
  _config = null;
  return loadConfig();
}

export function getConfig(): FreeRouterConfig {
  if (!_config) return loadConfig();
  return _config;
}

export function getConfigPath(): string | null {
  return _configSource === "defaults" ? null : _configSource;
}

export function getSanitizedConfig(): Record<string, unknown> {
  const cfg = getConfig();
  const sanitized = JSON.parse(JSON.stringify(cfg));
  if (sanitized.auth) {
    for (const [key, val] of Object.entries(sanitized.auth)) {
      if (key === "default") continue;
      if (val && typeof val === "object" && (val as any).profilesPath) {
        (val as any).profilesPath = "***";
      }
    }
  }
  for (const prov of Object.values(sanitized.providers ?? {})) {
    if ((prov as any).auth?.key) (prov as any).auth.key = "***";
  }
  return sanitized;
}

export function toInternalApiType(api: "anthropic" | "openai"): "anthropic-messages" | "openai-completions" {
  return api === "anthropic" ? "anthropic-messages" : "openai-completions";
}

export function supportsAdaptiveThinking(modelId: string): boolean {
  const cfg = getConfig();
  const patterns = cfg.thinking?.adaptive ?? ["claude-opus-4-6", "claude-opus-4.6"];
  return patterns.some(p => modelId.includes(p));
}

export function getThinkingBudget(modelId: string): number | null {
  const cfg = getConfig();
  const enabled = cfg.thinking?.enabled;
  if (!enabled) return null;
  if (enabled.models.some(m => modelId.includes(m))) return enabled.budget;
  return null;
}

export { DEFAULT_CONFIG };
