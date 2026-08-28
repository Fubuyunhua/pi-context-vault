import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type ArchivePolicy = "all" | "errors-and-large" | "off";

export const LEGACY_REPO_CONFIG_WARNING = "Repository Map configuration has moved to pi-repo-context." as const;
export const LEGACY_REPO_CONFIG_KEYS = Object.freeze([
  "repoMapEnabled",
  "mapInjectionMode",
  "mapContextMaxBytes",
  "mapDebounceMs",
  "mapGenerationRetention",
  "mapQuotaBytes",
  "mapExcludePatterns",
  "debugRequestFingerprints",
] as const);
const LEGACY_KEYS = new Set<string>(LEGACY_REPO_CONFIG_KEYS);

export interface ContextVaultConfig {
  reductionEnabled: boolean;
  archivePolicy: ArchivePolicy;
  archiveMinBytes: number;
  replacementThresholdBytes: number;
  archiveErrorsAlways: boolean;
  /** @deprecated Use replacementThresholdBytes. */
  archiveThresholdBytes: number;
  receiptMaxBytes: number;
  hotObservationCount: number;
  softContextRatio: number;
  targetContextRatio: number;
  projectQuotaBytes: number;
  retentionDays: number;
}

export interface LoadedContextVaultConfig {
  config: ContextVaultConfig;
  warnings: string[];
}

export const DEFAULT_CONFIG: Readonly<ContextVaultConfig> = Object.freeze({
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
});

const ACTIVE_KEYS = new Set<keyof ContextVaultConfig>(Object.keys(DEFAULT_CONFIG) as Array<keyof ContextVaultConfig>);
const ARCHIVE_POLICIES = new Set<ArchivePolicy>(["all", "errors-and-large", "off"]);
const POSITIVE_INTEGERS = new Set<keyof ContextVaultConfig>([
  "receiptMaxBytes",
  "hotObservationCount",
  "projectQuotaBytes",
  "retentionDays",
]);
const POSITIVE_SAFE_INTEGERS = new Set<keyof ContextVaultConfig>([
  "archiveThresholdBytes",
  "replacementThresholdBytes",
]);
const BOOLEAN_OPTIONS = new Set<keyof ContextVaultConfig>(["reductionEnabled", "archiveErrorsAlways"]);

export async function loadConfigWithDiagnostics(projectRoot: string): Promise<LoadedContextVaultConfig> {
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

  const legacyPresent = Object.keys(override).some((key) => LEGACY_KEYS.has(key));
  const config = { ...DEFAULT_CONFIG } as ContextVaultConfig;
  for (const [key, value] of Object.entries(override)) {
    if (LEGACY_KEYS.has(key)) continue;
    if (!ACTIVE_KEYS.has(key as keyof ContextVaultConfig)) throw new Error(`Unknown Context Vault option: ${key}`);
    const typedKey = key as keyof ContextVaultConfig;
    if (typedKey === "archivePolicy") {
      if (typeof value !== "string" || !ARCHIVE_POLICIES.has(value as ArchivePolicy)) {
        throw new Error("archivePolicy must be one of all, errors-and-large, off");
      }
      config.archivePolicy = value as ArchivePolicy;
      continue;
    }
    if (BOOLEAN_OPTIONS.has(typedKey)) {
      if (typeof value !== "boolean") throw new Error(`${key} must be a boolean`);
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

  if ("archiveThresholdBytes" in override) config.replacementThresholdBytes = config.archiveThresholdBytes;
  else if ("replacementThresholdBytes" in override) config.archiveThresholdBytes = config.replacementThresholdBytes;
  if (config.targetContextRatio >= config.softContextRatio) {
    throw new Error("targetContextRatio must be lower than softContextRatio");
  }
  if (config.receiptMaxBytes < 512) throw new Error("receiptMaxBytes must be at least 512 bytes");
  return { config, warnings: legacyPresent ? [LEGACY_REPO_CONFIG_WARNING] : [] };
}

export async function loadConfig(projectRoot: string): Promise<ContextVaultConfig> {
  return (await loadConfigWithDiagnostics(projectRoot)).config;
}
