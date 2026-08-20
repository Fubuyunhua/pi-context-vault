import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type MapInjectionMode = "off" | "once-per-user-turn" | "every-llm-call";

export interface ContextVaultConfig {
  archiveThresholdBytes: number;
  receiptMaxBytes: number;
  hotObservationCount: number;
  softContextRatio: number;
  targetContextRatio: number;
  projectQuotaBytes: number;
  retentionDays: number;
  mapContextMaxBytes: number;
  mapDebounceMs: number;
  mapExcludePatterns: string[];
  mapInjectionMode: MapInjectionMode;
  /** Reserved for a later debug Spec; inert in this release. */
  debugRequestFingerprints: boolean;
}

export const DEFAULT_CONFIG: Readonly<ContextVaultConfig> = Object.freeze({
  archiveThresholdBytes: 16 * 1024,
  receiptMaxBytes: 4 * 1024,
  hotObservationCount: 6,
  softContextRatio: 0.75,
  targetContextRatio: 0.6,
  projectQuotaBytes: 512 * 1024 * 1024,
  retentionDays: 30,
  mapContextMaxBytes: 6 * 1024,
  mapDebounceMs: 300,
  mapExcludePatterns: [],
  mapInjectionMode: "once-per-user-turn",
  debugRequestFingerprints: false,
});

const MAP_INJECTION_MODES = new Set<MapInjectionMode>(["off", "once-per-user-turn", "every-llm-call"]);

const POSITIVE_INTEGERS = new Set<keyof ContextVaultConfig>([
  "archiveThresholdBytes",
  "receiptMaxBytes",
  "hotObservationCount",
  "projectQuotaBytes",
  "retentionDays",
  "mapContextMaxBytes",
  "mapDebounceMs",
]);

const STRING_ARRAYS = new Set<keyof ContextVaultConfig>(["mapExcludePatterns"]);

const BOOLEAN_OPTIONS = new Set<keyof ContextVaultConfig>(["debugRequestFingerprints"]);

export async function loadConfig(projectRoot: string): Promise<ContextVaultConfig> {
  const configPath = join(projectRoot, ".pi", "context-vault.json");
  let override: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await readFile(configPath, "utf8")) as unknown;
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new Error("configuration must be a JSON object");
    }
    override = parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`Unable to read ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const config = {
    ...DEFAULT_CONFIG,
    mapExcludePatterns: [...DEFAULT_CONFIG.mapExcludePatterns],
  } as ContextVaultConfig;
  for (const [key, value] of Object.entries(override)) {
    if (!(key in DEFAULT_CONFIG)) throw new Error(`Unknown Context Vault option: ${key}`);
    const typedKey = key as keyof ContextVaultConfig;
    if (STRING_ARRAYS.has(typedKey)) {
      if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
        throw new Error(`${key} must be an array of non-empty strings`);
      }
      config.mapExcludePatterns = [...value];
      continue;
    }
    if (typedKey === "mapInjectionMode") {
      if (typeof value !== "string" || !MAP_INJECTION_MODES.has(value as MapInjectionMode)) {
        throw new Error("mapInjectionMode must be one of off, once-per-user-turn, every-llm-call");
      }
      config.mapInjectionMode = value as MapInjectionMode;
      continue;
    }
    if (BOOLEAN_OPTIONS.has(typedKey)) {
      if (typeof value !== "boolean") {
        throw new Error(`${key} must be a boolean`);
      }
      (config[typedKey] as boolean) = value;
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${key} must be a finite number`);
    if (POSITIVE_INTEGERS.has(typedKey) && (!Number.isInteger(value) || value <= 0)) {
      throw new Error(`${key} must be a positive integer`);
    }
    if ((typedKey === "softContextRatio" || typedKey === "targetContextRatio") && (value <= 0 || value >= 1)) {
      throw new Error(`${key} must be between 0 and 1`);
    }
    (config[typedKey] as number) = value;
  }
  if (config.targetContextRatio >= config.softContextRatio) {
    throw new Error("targetContextRatio must be lower than softContextRatio");
  }
  if (config.receiptMaxBytes < 512) {
    throw new Error("receiptMaxBytes must be at least 512 bytes");
  }
  if (config.mapContextMaxBytes < 512) {
    throw new Error("mapContextMaxBytes must be at least 512 bytes");
  }
  return config;
}
