import { canonicalJson } from "./canonical.js";
import { containsCredentialMaterial, containsHostPath } from "./safety.js";
import type { RawAttempt } from "./schema.js";

export const PUBLICATION_ALLOWLIST = [
  "schemaVersion",
  "experimentHash",
  "planHash",
  "runId",
  "attempt",
  "taskId",
  "arm",
  "repeat",
  "scheduleIndex",
  "status",
  "requestedProvider",
  "requestedModel",
  "responseModels",
  "integrity",
  "timingMs",
  "usage",
  "telemetry",
  "disk",
  "evaluator",
  "treatmentDose",
  "finalDiffHash",
  "evaluatorOutputHash",
] as const;

const USAGE_NUMBER_KEYS = ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost"] as const;
const TELEMETRY_KEYS = [
  "capsuleBuildCount",
  "repoMapAutomaticQueryCount",
  "reductionInvocationCount",
  "reductionTriggeredCount",
  "archiveAttemptCount",
  "archiveSuccessCount",
  "archiveFailureCount",
] as const;
const DOSE_KEYS = [
  "toolCalls",
  "explicitMapQueries",
  "capsuleBuilds",
  "automaticMapQueries",
  "reductionInvocations",
  "reductionTriggered",
  "archiveAttempts",
  "archiveSuccesses",
  "archiveFailures",
] as const;
const TREE_KEYS = ["files", "directories", "symlinksSkipped", "logicalBytes", "allocatedBytes"] as const;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
function pick(source: unknown, keys: readonly string[]): Record<string, unknown> {
  const input = record(source);
  return Object.fromEntries(keys.filter((key) => key in input).map((key) => [key, input[key]]));
}
function projectUsage(source: unknown): Record<string, unknown> {
  const usage = record(source);
  const first =
    usage.firstRequest === null ? null : pick(usage.firstRequest, [...USAGE_NUMBER_KEYS, "kind", "responseModel"]);
  return {
    ...pick(usage, ["mainAssistantCalls", "auxiliaryUsageRecords", "toolCalls", "toolResults"]),
    totals: pick(usage.totals, USAGE_NUMBER_KEYS),
    mainTotals: pick(usage.mainTotals, USAGE_NUMBER_KEYS),
    auxiliaryTotals: pick(usage.auxiliaryTotals, USAGE_NUMBER_KEYS),
    firstRequest: first,
    continuation: pick(usage.continuation, USAGE_NUMBER_KEYS),
    cache: pick(usage.cache, ["support", "observed", "promptTokens", "uncachedPrompt", "hitRatio"]),
  };
}
function projectTelemetry(source: unknown): Record<string, unknown> | null {
  if (source === null) return null;
  const outer = record(source);
  return {
    telemetry: pick(outer.telemetry ?? outer, TELEMETRY_KEYS),
    lifecycle: pick(outer.lifecycle, [
      "initialized",
      "degraded",
      "failureCount",
      "observationsAvailable",
      "repoMapAvailable",
    ]),
  };
}
function projectDisk(source: unknown): Record<string, unknown> {
  const disk = record(source);
  return {
    total: pick(disk.total, TREE_KEYS),
    repoMap: pick(disk.repoMap, [
      ...TREE_KEYS,
      "generationCount",
      "generationLogicalBytes",
      "generationAllocatedBytes",
    ]),
    observations: pick(disk.observations, [
      ...TREE_KEYS,
      "uniqueArtifacts",
      "uniqueLiveArtifacts",
      "liveRecords",
      "logRecords",
      "tombstones",
      "metadataBytes",
    ]),
  };
}

export function publicationRecord(attempt: RawAttempt): Record<string, unknown> {
  const result: Record<string, unknown> = {
    ...pick(attempt, PUBLICATION_ALLOWLIST.slice(0, 16)),
    integrity: pick(attempt.integrity, [
      "modelDrift",
      "lifecycleDegraded",
      "sessionUsageAmbiguous",
      "sessionUsageCorrupt",
    ]),
    timingMs: pick(attempt.timingMs, ["provisioning", "agent", "evaluation", "total"]),
    usage: projectUsage(attempt.usage),
    telemetry: projectTelemetry(attempt.telemetry),
    disk: projectDisk(attempt.disk),
    evaluator: pick(attempt.evaluator, ["status", "isolation", "passed", "exitCode", "f2p", "p2p", "durationMs"]),
    treatmentDose: pick(attempt.treatmentDose, DOSE_KEYS),
    finalDiffHash: attempt.finalDiffHash,
    evaluatorOutputHash: attempt.evaluatorOutputHash,
  };
  verifyPublicationRecord(result);
  return result;
}

export function verifyPublicationValue(value: unknown): void {
  if (value === null || typeof value === "boolean" || typeof value === "number") return;
  if (typeof value === "string") {
    if (containsCredentialMaterial(value) || containsHostPath(value) || /PLANTED_(?:SECRET|SOURCE|PATH)/u.test(value))
      throw new Error("Publication contains a credential, host path, or source marker");
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) verifyPublicationValue(item);
    return;
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      verifyPublicationValue(key);
      verifyPublicationValue(item);
    }
    return;
  }
  throw new Error(`Unsupported publication value: ${typeof value}`);
}

function exact(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) if (!keys.includes(key)) throw new Error(`${label} has unknown field ${key}`);
  return input;
}
function typed(
  input: Record<string, unknown>,
  keys: readonly string[],
  type: "number" | "boolean" | "string",
  label: string,
): void {
  for (const key of keys)
    if (key in input && typeof input[key] !== type) throw new Error(`${label}.${key} must be ${type}`);
}
function validateUsage(value: unknown): void {
  const usage = exact(
    value,
    [
      "mainAssistantCalls",
      "auxiliaryUsageRecords",
      "toolCalls",
      "toolResults",
      "totals",
      "mainTotals",
      "auxiliaryTotals",
      "firstRequest",
      "continuation",
      "cache",
    ],
    "usage",
  );
  typed(usage, ["mainAssistantCalls", "auxiliaryUsageRecords", "toolCalls", "toolResults"], "number", "usage");
  for (const key of ["totals", "mainTotals", "auxiliaryTotals", "continuation"]) {
    const numbers = exact(usage[key], USAGE_NUMBER_KEYS, `usage.${key}`);
    typed(numbers, USAGE_NUMBER_KEYS, "number", `usage.${key}`);
  }
  if (usage.firstRequest !== null) {
    const first = exact(usage.firstRequest, [...USAGE_NUMBER_KEYS, "kind", "responseModel"], "usage.firstRequest");
    typed(first, USAGE_NUMBER_KEYS, "number", "usage.firstRequest");
    typed(first, ["kind"], "string", "usage.firstRequest");
    if (first.responseModel !== undefined && first.responseModel !== null && typeof first.responseModel !== "string")
      throw new Error("usage.firstRequest.responseModel must be string or null");
  }
  const cache = exact(
    usage.cache,
    ["support", "observed", "promptTokens", "uncachedPrompt", "hitRatio"],
    "usage.cache",
  );
  typed(cache, ["support"], "string", "usage.cache");
  typed(cache, ["observed"], "boolean", "usage.cache");
  typed(cache, ["promptTokens", "uncachedPrompt"], "number", "usage.cache");
  if (cache.hitRatio !== undefined && cache.hitRatio !== null && typeof cache.hitRatio !== "number")
    throw new Error("usage.cache.hitRatio must be number or null");
}
function nullableNumber(input: Record<string, unknown>, keys: readonly string[], label: string): void {
  for (const key of keys)
    if (input[key] !== undefined && input[key] !== null && typeof input[key] !== "number")
      throw new Error(`${label}.${key} must be number or null`);
}
function validateDisk(value: unknown): void {
  const disk = exact(value, ["total", "repoMap", "observations"], "disk");
  const total = exact(disk.total, TREE_KEYS, "disk.total");
  const repoMap = exact(
    disk.repoMap,
    [...TREE_KEYS, "generationCount", "generationLogicalBytes", "generationAllocatedBytes"],
    "disk.repoMap",
  );
  const observations = exact(
    disk.observations,
    [
      ...TREE_KEYS,
      "uniqueArtifacts",
      "uniqueLiveArtifacts",
      "liveRecords",
      "logRecords",
      "tombstones",
      "metadataBytes",
    ],
    "disk.observations",
  );
  typed(
    total,
    TREE_KEYS.filter((key) => key !== "allocatedBytes"),
    "number",
    "disk.total",
  );
  typed(
    repoMap,
    [...TREE_KEYS.filter((key) => key !== "allocatedBytes"), "generationCount", "generationLogicalBytes"],
    "number",
    "disk.repoMap",
  );
  typed(
    observations,
    [
      ...TREE_KEYS.filter((key) => key !== "allocatedBytes"),
      "uniqueArtifacts",
      "uniqueLiveArtifacts",
      "liveRecords",
      "logRecords",
      "tombstones",
      "metadataBytes",
    ],
    "number",
    "disk.observations",
  );
  nullableNumber(total, ["allocatedBytes"], "disk.total");
  nullableNumber(repoMap, ["allocatedBytes", "generationAllocatedBytes"], "disk.repoMap");
  nullableNumber(observations, ["allocatedBytes"], "disk.observations");
}

export function verifyPublicationRecord(value: unknown): void {
  if (value && typeof value === "object" && !Array.isArray(value))
    for (const key of Object.keys(value as Record<string, unknown>))
      if (!(PUBLICATION_ALLOWLIST as readonly string[]).includes(key))
        throw new Error(`Publication field is not allowlisted: ${key}`);
  const top = exact(value, PUBLICATION_ALLOWLIST, "publication");
  typed(
    top,
    [
      "schemaVersion",
      "experimentHash",
      "planHash",
      "runId",
      "taskId",
      "arm",
      "status",
      "requestedProvider",
      "requestedModel",
    ],
    "string",
    "publication",
  );
  typed(top, ["attempt", "repeat", "scheduleIndex"], "number", "publication");
  if (
    top.responseModels !== undefined &&
    (!Array.isArray(top.responseModels) || top.responseModels.some((item) => typeof item !== "string"))
  )
    throw new Error("responseModels must be a string array");
  const integrity = exact(
    top.integrity,
    ["modelDrift", "lifecycleDegraded", "sessionUsageAmbiguous", "sessionUsageCorrupt"],
    "integrity",
  );
  typed(
    integrity,
    ["modelDrift", "lifecycleDegraded", "sessionUsageAmbiguous", "sessionUsageCorrupt"],
    "boolean",
    "integrity",
  );
  const timing = exact(top.timingMs, ["provisioning", "agent", "evaluation", "total"], "timingMs");
  typed(timing, ["provisioning", "agent", "evaluation", "total"], "number", "timingMs");
  validateUsage(top.usage);
  if (top.telemetry !== null) {
    const telemetry = exact(top.telemetry, ["telemetry", "lifecycle"], "telemetry");
    const snapshot = exact(telemetry.telemetry, TELEMETRY_KEYS, "telemetry.telemetry");
    typed(snapshot, TELEMETRY_KEYS, "number", "telemetry.telemetry");
    const lifecycle = exact(
      telemetry.lifecycle,
      ["initialized", "degraded", "failureCount", "observationsAvailable", "repoMapAvailable"],
      "telemetry.lifecycle",
    );
    typed(
      lifecycle,
      ["initialized", "degraded", "observationsAvailable", "repoMapAvailable"],
      "boolean",
      "telemetry.lifecycle",
    );
    typed(lifecycle, ["failureCount"], "number", "telemetry.lifecycle");
  }
  validateDisk(top.disk);
  const evaluator = exact(
    top.evaluator,
    ["status", "isolation", "passed", "exitCode", "f2p", "p2p", "durationMs"],
    "evaluator",
  );
  typed(evaluator, ["status", "isolation"], "string", "evaluator");
  typed(evaluator, ["passed"], "boolean", "evaluator");
  typed(evaluator, ["durationMs"], "number", "evaluator");
  nullableNumber(evaluator, ["exitCode"], "evaluator");
  for (const key of ["f2p", "p2p"])
    if (evaluator[key] !== undefined && evaluator[key] !== null) {
      const counts = exact(evaluator[key], ["passed", "total"], `evaluator.${key}`);
      typed(counts, ["passed", "total"], "number", `evaluator.${key}`);
    }
  const dose = exact(top.treatmentDose, DOSE_KEYS, "treatmentDose");
  typed(dose, DOSE_KEYS, "number", "treatmentDose");
  for (const key of ["finalDiffHash", "evaluatorOutputHash"])
    if (top[key] !== undefined && top[key] !== null && typeof top[key] !== "string")
      throw new Error(`${key} must be string or null`);
  verifyPublicationValue(value);
  canonicalJson(value);
}
