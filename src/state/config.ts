import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type ArchivePolicy = "all" | "errors-and-large" | "off";
export type MapInjectionMode = "off" | "once-per-user-turn" | "every-llm-call";

export interface ContextVaultConfig {
  /** Fully disables repository-map construction, watching, tools, and automatic injection. */
  repoMapEnabled: boolean;
  /** Fully disables context reduction while leaving archival policy independent. */
  reductionEnabled: boolean;
  archivePolicy: ArchivePolicy;
  archiveMinBytes: number;
  replacementThresholdBytes: number;
  archiveErrorsAlways: boolean;
  /** @deprecated Use replacementThresholdBytes. Kept normalized to the effective replacement threshold. */
  archiveThresholdBytes: number;
  receiptMaxBytes: number;
  hotObservationCount: number;
  softContextRatio: number;
  targetContextRatio: number;
  projectQuotaBytes: number;
  retentionDays: number;
  mapContextMaxBytes: number;
  mapDebounceMs: number;
  mapGenerationRetention: number;
  mapQuotaBytes: number;
  mapExcludePatterns: string[];
  mapInjectionMode: MapInjectionMode;
  /** Reserved for a later debug Spec; inert in this release. */
  debugRequestFingerprints: boolean;
}

export const DEFAULT_CONFIG: Readonly<ContextVaultConfig> = Object.freeze({
  repoMapEnabled: true,
  reductionEnabled: true,
  archivePolicy: "all",
  archiveMinBytes: 16 * 1024,
  replacementThresholdBytes: 16 * 1024,
  archiveErrorsAlways: true,
  archiveThresholdBytes: 16 * 1024,
  receiptMaxBytes: 4 * 1024,
  hotObservationCount: 6,
  softContextRatio: 0.75,
  targetContextRatio: 0.6,
  projectQuotaBytes: 512 * 1024 * 1024,
  retentionDays: 30,
  mapContextMaxBytes: 6 * 1024,
  mapDebounceMs: 300,
  mapGenerationRetention: 3,
  mapQuotaBytes: 128 * 1024 * 1024,
  mapExcludePatterns: [],
  mapInjectionMode: "once-per-user-turn",
  debugRequestFingerprints: false,
});

const ARCHIVE_POLICIES = new Set<ArchivePolicy>(["all", "errors-and-large", "off"]);
const MAP_INJECTION_MODES = new Set<MapInjectionMode>(["off", "once-per-user-turn", "every-llm-call"]);

const POSITIVE_INTEGERS = new Set<keyof ContextVaultConfig>([
  "receiptMaxBytes",
  "hotObservationCount",
  "projectQuotaBytes",
  "retentionDays",
  "mapContextMaxBytes",
  "mapDebounceMs",
  "mapGenerationRetention",
  "mapQuotaBytes",
]);

const POSITIVE_SAFE_INTEGERS = new Set<keyof ContextVaultConfig>([
  "archiveThresholdBytes",
  "replacementThresholdBytes",
  "mapGenerationRetention",
  "mapQuotaBytes",
]);

const STRING_ARRAYS = new Set<keyof ContextVaultConfig>(["mapExcludePatterns"]);

const BOOLEAN_OPTIONS = new Set<keyof ContextVaultConfig>([
  "repoMapEnabled",
  "reductionEnabled",
  "archiveErrorsAlways",
  "debugRequestFingerprints",
]);

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

  if ("archiveThresholdBytes" in override && "replacementThresholdBytes" in override) {
    throw new Error("archiveThresholdBytes and replacementThresholdBytes cannot both be configured");
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
    if (typedKey === "archivePolicy") {
      if (typeof value !== "string" || !ARCHIVE_POLICIES.has(value as ArchivePolicy)) {
        throw new Error("archivePolicy must be one of all, errors-and-large, off");
      }
      config.archivePolicy = value as ArchivePolicy;
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
    if (typedKey === "archiveMinBytes" && (!Number.isSafeInteger(value) || value < 0)) {
      throw new Error("archiveMinBytes must be a non-negative safe integer");
    }
    if (POSITIVE_SAFE_INTEGERS.has(typedKey) && (!Number.isSafeInteger(value) || value <= 0)) {
      throw new Error(`${key} must be a positive safe integer`);
    }
    if (POSITIVE_INTEGERS.has(typedKey) && (!Number.isInteger(value) || value <= 0)) {
      throw new Error(`${key} must be a positive integer`);
    }
    if ((typedKey === "softContextRatio" || typedKey === "targetContextRatio") && (value <= 0 || value >= 1)) {
      throw new Error(`${key} must be between 0 and 1`);
    }
    (config[typedKey] as number) = value;
  }

  if ("archiveThresholdBytes" in override) {
    config.replacementThresholdBytes = config.archiveThresholdBytes;
  } else if ("replacementThresholdBytes" in override) {
    config.archiveThresholdBytes = config.replacementThresholdBytes;
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
