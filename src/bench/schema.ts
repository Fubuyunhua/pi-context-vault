import { canonicalHash } from "./canonical.js";
import { assertSafePersistedIdentifier, containsCredentialMaterial, containsHostPath } from "./safety.js";

export const EXPERIMENT_SCHEMA_VERSION = "context-vault-ablation-experiment/v1" as const;
export const TASK_SCHEMA_VERSION = "context-vault-ablation-task/v1" as const;
export const PLAN_SCHEMA_VERSION = "context-vault-ablation-plan/v1" as const;
export const ATTEMPT_SCHEMA_VERSION = "context-vault-ablation-attempt/v1" as const;

export type ArmId = "A" | "B" | "C" | "D" | "E" | "F";
export type RepoMapStratum = "lexical" | "semantic" | "mixed";
export type CacheSupport = "reported" | "not-reported" | "unknown";
export type AttemptStatus = "complete" | "task-failed" | "timed-out" | "infrastructure-failed" | "partial";

const RESERVED_ENV = new Set([
  "BASH_ENV",
  "ENV",
  "HOME",
  "IFS",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "JAVA_TOOL_OPTIONS",
  "JDK_JAVA_OPTIONS",
  "_JAVA_OPTIONS",
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_REPL_EXTERNAL_MODULE",
  "PERL5OPT",
  "PATH",
  "PI_CODING_AGENT_DIR",
  "PYTHONPATH",
  "PYTHONINSPECT",
  "PYTHONSTARTUP",
  "RUBYOPT",
  "SHELLOPTS",
  "PROMPT_COMMAND",
  "CDPATH",
  "CV_BENCH_SESSION_DIR",
]);

export function assertSafeArg(value: string, label: string): string {
  if (value.includes("\0") || containsCredentialMaterial(value))
    throw new Error(`${label} contains a credential flag or credential material`);
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) throw new Error(`${label} contains URL userinfo`);
  } catch (error) {
    if (error instanceof Error && error.message.includes("URL userinfo")) throw error;
  }
  return value;
}

function credentialEnv(value: unknown, label: string): string {
  const key = string(value, label);
  if (!/^[A-Z][A-Z0-9_]*$/u.test(key)) throw new Error(`${label} must be an uppercase environment name`);
  if (
    RESERVED_ENV.has(key) ||
    /^(?:DYLD_|LD_|GIT_|NPM_|npm_|SSH_|PYTHON|PERL|RUBY|NODE_|JAVA_|JDK_|BASH_|ZDOTDIR$|SHELL$|COMSPEC$|PATHEXT$|SYSTEMROOT$|AWS_(?:CONFIG_FILE|PROFILE|SHARED_CREDENTIALS_FILE|WEB_IDENTITY_TOKEN_FILE)$)/u.test(
      key,
    )
  )
    throw new Error(`${label} is reserved or can alter code execution`);
  return key;
}

export interface ArmDefinition {
  id: ArmId;
  extensionEnabled: boolean;
  config: {
    archivePolicy: "all" | "errors-and-large" | "off";
    repoMapEnabled: boolean;
    reductionEnabled: boolean;
    mapInjectionMode: "off" | "once-per-user-turn" | "every-llm-call";
  };
}

export const ABLATION_ARMS: Readonly<Record<ArmId, ArmDefinition>> = Object.freeze({
  A: {
    id: "A",
    extensionEnabled: false,
    config: { archivePolicy: "off", repoMapEnabled: false, reductionEnabled: false, mapInjectionMode: "off" },
  },
  B: {
    id: "B",
    extensionEnabled: true,
    config: { archivePolicy: "all", repoMapEnabled: false, reductionEnabled: false, mapInjectionMode: "off" },
  },
  C: {
    id: "C",
    extensionEnabled: true,
    config: { archivePolicy: "all", repoMapEnabled: false, reductionEnabled: true, mapInjectionMode: "off" },
  },
  D: {
    id: "D",
    extensionEnabled: true,
    config: { archivePolicy: "off", repoMapEnabled: true, reductionEnabled: false, mapInjectionMode: "off" },
  },
  E: {
    id: "E",
    extensionEnabled: true,
    config: {
      archivePolicy: "all",
      repoMapEnabled: true,
      reductionEnabled: true,
      mapInjectionMode: "once-per-user-turn",
    },
  },
  F: {
    id: "F",
    extensionEnabled: true,
    config: { archivePolicy: "all", repoMapEnabled: true, reductionEnabled: true, mapInjectionMode: "every-llm-call" },
  },
});

export interface Experiment {
  schemaVersion: typeof EXPERIMENT_SCHEMA_VERSION;
  experimentId: string;
  seed: number;
  repeats: number;
  provider: string;
  model: string;
  thinking: string;
  tools: string[];
  piCommit: string;
  extensionCommit: string;
  packageLockHash: string;
  timeoutMs: number;
  maxInfrastructureRetries: number;
  cacheSupport: CacheSupport;
  extensionPath: string;
  allowedCredentialEnv: string[];
  arms: ArmDefinition[];
  publicationFields: string[];
}

export interface BenchmarkTask {
  schemaVersion: typeof TASK_SCHEMA_VERSION;
  taskId: string;
  assetHash: string;
  repository: string;
  baseCommit: string;
  promptPath: string;
  promptHash: string;
  language: string;
  repoMapStratum: RepoMapStratum;
  evaluator: { kind: "command"; command: string; args: string[]; timeoutMs: number; imageDigest?: string };
}

export interface PlannedRun {
  runId: string;
  taskId: string;
  arm: ArmId;
  repeat: number;
  scheduleIndex: number;
  blockIndex: number;
}

export interface ExperimentPlan {
  schemaVersion: typeof PLAN_SCHEMA_VERSION;
  experimentHash: string;
  tasksHash: string;
  seed: number;
  runs: PlannedRun[];
}

export interface UsageNumbers {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
}

export interface RawAttempt {
  schemaVersion: typeof ATTEMPT_SCHEMA_VERSION;
  experimentHash: string;
  planHash: string;
  runId: string;
  attempt: number;
  taskId: string;
  arm: ArmId;
  repeat: number;
  scheduleIndex: number;
  status: AttemptStatus;
  failure?: { stage: string; code: string };
  requestedProvider: string;
  requestedModel: string;
  responseModels: string[];
  integrity: {
    modelDrift: boolean;
    lifecycleDegraded?: boolean;
    sessionUsageAmbiguous?: boolean;
    sessionUsageCorrupt?: boolean;
  };
  timingMs: { provisioning: number; agent: number; evaluation: number; total: number };
  usage: unknown;
  telemetry: unknown | null;
  disk: unknown;
  evaluator: unknown;
  treatmentDose: Record<string, number>;
  finalDiffHash: string | null;
  evaluatorOutputHash: string | null;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || Array.isArray(value) || typeof value !== "object")
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}
function integer(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum)
    throw new Error(`${label} must be an integer >= ${minimum}`);
  return value as number;
}
function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((entry, index) => string(entry, `${label}[${index}]`));
}
function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) throw new Error(`${label} has unknown field ${key}`);
}

export function parseExperiment(value: unknown): Experiment {
  const input = object(value, "experiment");
  exactKeys(
    input,
    [
      "schemaVersion",
      "experimentId",
      "seed",
      "repeats",
      "provider",
      "model",
      "thinking",
      "tools",
      "piCommit",
      "extensionCommit",
      "packageLockHash",
      "timeoutMs",
      "maxInfrastructureRetries",
      "cacheSupport",
      "extensionPath",
      "allowedCredentialEnv",
      "arms",
      "publicationFields",
    ],
    "experiment",
  );
  if (input.schemaVersion !== EXPERIMENT_SCHEMA_VERSION)
    throw new Error(`Unsupported experiment schema: ${String(input.schemaVersion)}`);
  if (!Array.isArray(input.arms) || input.arms.length !== 6)
    throw new Error("experiment.arms must contain A-F exactly once");
  const arms = input.arms.map((arm) => parseArm(arm));
  for (const id of Object.keys(ABLATION_ARMS) as ArmId[]) {
    const arm = arms.find((candidate) => candidate.id === id);
    if (!arm || JSON.stringify(arm) !== JSON.stringify(ABLATION_ARMS[id]))
      throw new Error(`experiment arm ${id} does not match the isolation contract`);
  }
  if (!["reported", "not-reported", "unknown"].includes(String(input.cacheSupport)))
    throw new Error("Invalid cacheSupport");
  return {
    schemaVersion: EXPERIMENT_SCHEMA_VERSION,
    experimentId: string(input.experimentId, "experimentId"),
    seed: integer(input.seed, "seed"),
    repeats: integer(input.repeats, "repeats", 1),
    provider: assertSafeArg(string(input.provider, "provider"), "provider"),
    model: assertSafeArg(string(input.model, "model"), "model"),
    thinking: assertSafeArg(string(input.thinking, "thinking"), "thinking"),
    tools: strings(input.tools, "tools").map((value, index) => assertSafeArg(value, `tools[${index}]`)),
    piCommit: string(input.piCommit, "piCommit"),
    extensionCommit: string(input.extensionCommit, "extensionCommit"),
    packageLockHash: string(input.packageLockHash, "packageLockHash"),
    timeoutMs: integer(input.timeoutMs, "timeoutMs", 1),
    maxInfrastructureRetries: integer(input.maxInfrastructureRetries, "maxInfrastructureRetries"),
    cacheSupport: input.cacheSupport as CacheSupport,
    extensionPath: assertSafeArg(string(input.extensionPath, "extensionPath"), "extensionPath"),
    allowedCredentialEnv: strings(input.allowedCredentialEnv, "allowedCredentialEnv").map((value, index) =>
      credentialEnv(value, `allowedCredentialEnv[${index}]`),
    ),
    arms,
    publicationFields: strings(input.publicationFields, "publicationFields"),
  };
}

function parseArm(value: unknown): ArmDefinition {
  const input = object(value, "arm");
  exactKeys(input, ["id", "extensionEnabled", "config"], "arm");
  if (!["A", "B", "C", "D", "E", "F"].includes(String(input.id))) throw new Error("Invalid arm id");
  if (typeof input.extensionEnabled !== "boolean") throw new Error("arm.extensionEnabled must be boolean");
  const config = object(input.config, "arm.config");
  exactKeys(config, ["archivePolicy", "repoMapEnabled", "reductionEnabled", "mapInjectionMode"], "arm.config");
  if (!["all", "errors-and-large", "off"].includes(String(config.archivePolicy)))
    throw new Error("Invalid archivePolicy");
  if (typeof config.repoMapEnabled !== "boolean" || typeof config.reductionEnabled !== "boolean")
    throw new Error("Arm gates must be boolean");
  if (!["off", "once-per-user-turn", "every-llm-call"].includes(String(config.mapInjectionMode)))
    throw new Error("Invalid mapInjectionMode");
  return { id: input.id as ArmId, extensionEnabled: input.extensionEnabled, config: config as ArmDefinition["config"] };
}

export function parseTask(value: unknown): BenchmarkTask {
  const input = object(value, "task");
  exactKeys(
    input,
    [
      "schemaVersion",
      "taskId",
      "assetHash",
      "repository",
      "baseCommit",
      "promptPath",
      "promptHash",
      "language",
      "repoMapStratum",
      "evaluator",
    ],
    "task",
  );
  if (input.schemaVersion !== TASK_SCHEMA_VERSION)
    throw new Error(`Unsupported task schema: ${String(input.schemaVersion)}`);
  if (!["lexical", "semantic", "mixed"].includes(String(input.repoMapStratum)))
    throw new Error("Invalid repoMapStratum");
  const evaluator = object(input.evaluator, "task.evaluator");
  exactKeys(evaluator, ["kind", "command", "args", "timeoutMs", "imageDigest"], "task.evaluator");
  if (evaluator.kind !== "command") throw new Error("Unsupported evaluator kind");
  return {
    schemaVersion: TASK_SCHEMA_VERSION,
    taskId: assertSafePersistedIdentifier(string(input.taskId, "taskId"), "taskId"),
    assetHash: string(input.assetHash, "assetHash"),
    repository: assertSafeArg(string(input.repository, "repository"), "repository"),
    baseCommit: assertSafeArg(string(input.baseCommit, "baseCommit"), "baseCommit"),
    promptPath: assertSafeArg(string(input.promptPath, "promptPath"), "promptPath"),
    promptHash: string(input.promptHash, "promptHash"),
    language: string(input.language, "language"),
    repoMapStratum: input.repoMapStratum as RepoMapStratum,
    evaluator: {
      kind: "command",
      command: assertSafeArg(string(evaluator.command, "evaluator.command"), "evaluator.command"),
      args: strings(evaluator.args, "evaluator.args").map((value, index) =>
        assertSafeArg(value, `evaluator.args[${index}]`),
      ),
      timeoutMs: integer(evaluator.timeoutMs, "evaluator.timeoutMs", 1),
      ...(evaluator.imageDigest === undefined
        ? {}
        : { imageDigest: string(evaluator.imageDigest, "evaluator.imageDigest") }),
    },
  };
}

export function parsePlan(value: unknown): ExperimentPlan {
  const input = object(value, "plan");
  exactKeys(input, ["schemaVersion", "experimentHash", "tasksHash", "seed", "runs"], "plan");
  if (input.schemaVersion !== PLAN_SCHEMA_VERSION)
    throw new Error(`Unsupported plan schema: ${String(input.schemaVersion)}`);
  if (!Array.isArray(input.runs)) throw new Error("plan.runs must be an array");
  const plan = {
    schemaVersion: PLAN_SCHEMA_VERSION,
    experimentHash: string(input.experimentHash, "experimentHash"),
    tasksHash: string(input.tasksHash, "tasksHash"),
    seed: integer(input.seed, "seed"),
    runs: input.runs.map((run, index) => parseRun(run, index)),
  };
  if (new Set(plan.runs.map((run) => run.runId)).size !== plan.runs.length) throw new Error("Duplicate plan runId");
  if (new Set(plan.runs.map((run) => run.scheduleIndex)).size !== plan.runs.length)
    throw new Error("Duplicate plan scheduleIndex");
  for (const run of plan.runs) {
    const identity = {
      experimentHash: plan.experimentHash,
      tasksHash: plan.tasksHash,
      taskId: run.taskId,
      arm: run.arm,
      repeat: run.repeat,
      blockIndex: run.blockIndex,
      scheduleIndex: run.scheduleIndex,
    };
    if (run.runId !== canonicalHash(identity).slice(0, 32)) throw new Error(`Invalid immutable runId: ${run.runId}`);
  }
  return plan;
}
function parseRun(value: unknown, index: number): PlannedRun {
  const run = object(value, `run[${index}]`);
  exactKeys(run, ["runId", "taskId", "arm", "repeat", "scheduleIndex", "blockIndex"], `run[${index}]`);
  if (!["A", "B", "C", "D", "E", "F"].includes(String(run.arm))) throw new Error("Invalid planned arm");
  return {
    runId: string(run.runId, "runId"),
    taskId: string(run.taskId, "taskId"),
    arm: run.arm as ArmId,
    repeat: integer(run.repeat, "repeat"),
    scheduleIndex: integer(run.scheduleIndex, "scheduleIndex"),
    blockIndex: integer(run.blockIndex, "blockIndex"),
  };
}

function finite(value: unknown, label: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum)
    throw new Error(`${label} must be a finite number >= ${minimum}`);
  return value;
}

const USAGE_NUMBER_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost"] as const;
const TREE_NUMBER_FIELDS = ["files", "directories", "symlinksSkipped", "logicalBytes"] as const;
const DOSE_FIELDS = [
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

function assertFiniteNumbersDeep(value: unknown, label: string): void {
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error(`${label} contains a non-finite number`);
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) assertFiniteNumbersDeep(item, `${label}[${index}]`);
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>))
      assertFiniteNumbersDeep(item, `${label}.${key}`);
  }
}

function validateUsageNumbers(value: unknown, label: string): Record<string, unknown> {
  const input = object(value, label);
  exactKeys(input, USAGE_NUMBER_FIELDS, label);
  for (const field of USAGE_NUMBER_FIELDS) finite(input[field], `${label}.${field}`);
  return input;
}
function validateUsageRecord(value: unknown, label: string): void {
  const record = object(value, label);
  exactKeys(record, [...USAGE_NUMBER_FIELDS, "kind", "responseModel"], label);
  validateUsageNumbers(Object.fromEntries(USAGE_NUMBER_FIELDS.map((field) => [field, record[field]])), label);
  if (record.kind !== "assistant" && record.kind !== "auxiliary") throw new Error(`${label}.kind is invalid`);
  if (record.responseModel !== null) {
    const model = string(record.responseModel, `${label}.responseModel`);
    if (containsCredentialMaterial(model) || containsHostPath(model))
      throw new Error(`${label}.responseModel contains credential or host-path material`);
  }
}
function validateRawUsage(value: unknown): void {
  const usage = object(value, "usage");
  exactKeys(
    usage,
    [
      "mainAssistantCalls",
      "auxiliaryUsageRecords",
      "toolCalls",
      "toolResults",
      "toolNameCounts",
      "totals",
      "mainTotals",
      "auxiliaryTotals",
      "records",
      "firstRequest",
      "continuation",
      "cache",
      "responseModels",
    ],
    "usage",
  );
  for (const field of ["mainAssistantCalls", "auxiliaryUsageRecords", "toolCalls", "toolResults"])
    integer(usage[field], `usage.${field}`);
  for (const field of ["totals", "mainTotals", "auxiliaryTotals", "continuation"])
    validateUsageNumbers(usage[field], `usage.${field}`);
  if (usage.firstRequest !== null) validateUsageRecord(usage.firstRequest, "usage.firstRequest");
  const cache = object(usage.cache, "usage.cache");
  exactKeys(cache, ["support", "observed", "promptTokens", "uncachedPrompt", "hitRatio"], "usage.cache");
  if (!["reported", "not-reported", "unknown"].includes(String(cache.support)))
    throw new Error("usage.cache.support is invalid");
  if (typeof cache.observed !== "boolean") throw new Error("usage.cache.observed must be boolean");
  finite(cache.promptTokens, "usage.cache.promptTokens");
  finite(cache.uncachedPrompt, "usage.cache.uncachedPrompt");
  if (cache.hitRatio !== null) {
    const ratio = finite(cache.hitRatio, "usage.cache.hitRatio");
    if (ratio > 1) throw new Error("usage.cache.hitRatio must be <= 1");
  }
  if (!Array.isArray(usage.records)) throw new Error("usage.records must be an array");
  for (const [index, item] of usage.records.entries()) validateUsageRecord(item, `usage.records[${index}]`);
  const toolNameCounts = object(usage.toolNameCounts, "usage.toolNameCounts");
  for (const [name, count] of Object.entries(toolNameCounts)) {
    if (containsCredentialMaterial(name) || containsHostPath(name))
      throw new Error("usage.toolNameCounts contains credential or host-path material");
    integer(count, `usage.toolNameCounts.${name}`);
  }
  for (const [index, model] of strings(usage.responseModels, "usage.responseModels").entries())
    if (containsCredentialMaterial(model) || containsHostPath(model))
      throw new Error(`usage.responseModels[${index}] contains credential or host-path material`);
}
function validateTree(value: unknown, label: string): Record<string, unknown> {
  const tree = object(value, label);
  exactKeys(tree, [...TREE_NUMBER_FIELDS, "allocatedBytes"], label);
  for (const field of TREE_NUMBER_FIELDS) integer(tree[field], `${label}.${field}`);
  if (tree.allocatedBytes !== null) integer(tree.allocatedBytes, `${label}.allocatedBytes`);
  return tree;
}
function validateRawDisk(value: unknown): void {
  const disk = object(value, "disk");
  exactKeys(disk, ["total", "repoMap", "observations"], "disk");
  validateTree(disk.total, "disk.total");
  const repoMap = object(disk.repoMap, "disk.repoMap");
  exactKeys(
    repoMap,
    [...TREE_NUMBER_FIELDS, "allocatedBytes", "generationCount", "generationLogicalBytes", "generationAllocatedBytes"],
    "disk.repoMap",
  );
  for (const field of TREE_NUMBER_FIELDS) integer(repoMap[field], `disk.repoMap.${field}`);
  if (repoMap.allocatedBytes !== null) integer(repoMap.allocatedBytes, "disk.repoMap.allocatedBytes");
  integer(repoMap.generationCount, "disk.repoMap.generationCount");
  integer(repoMap.generationLogicalBytes, "disk.repoMap.generationLogicalBytes");
  if (repoMap.generationAllocatedBytes !== null)
    integer(repoMap.generationAllocatedBytes, "disk.repoMap.generationAllocatedBytes");
  const observations = object(disk.observations, "disk.observations");
  const observationFields = [
    "uniqueArtifacts",
    "uniqueLiveArtifacts",
    "liveRecords",
    "logRecords",
    "tombstones",
    "metadataBytes",
  ] as const;
  exactKeys(observations, [...TREE_NUMBER_FIELDS, "allocatedBytes", ...observationFields], "disk.observations");
  for (const field of TREE_NUMBER_FIELDS) integer(observations[field], `disk.observations.${field}`);
  if (observations.allocatedBytes !== null) integer(observations.allocatedBytes, "disk.observations.allocatedBytes");
  for (const field of observationFields) integer(observations[field], `disk.observations.${field}`);
}
function validateRawEvaluator(value: unknown): void {
  const evaluator = object(value, "evaluator");
  exactKeys(evaluator, ["status", "isolation", "passed", "exitCode", "f2p", "p2p", "durationMs"], "evaluator");
  if (
    !["passed", "test-failed", "timed-out", "malformed-assets", "infrastructure-failed", "not-run"].includes(
      String(evaluator.status),
    )
  )
    throw new Error("evaluator.status is invalid");
  if (evaluator.isolation !== undefined && evaluator.isolation !== "local-unisolated")
    throw new Error("evaluator.isolation is invalid");
  if (typeof evaluator.passed !== "boolean") throw new Error("evaluator.passed must be boolean");
  if (evaluator.exitCode !== undefined && evaluator.exitCode !== null && !Number.isSafeInteger(evaluator.exitCode))
    throw new Error("evaluator.exitCode must be an integer or null");
  if (evaluator.durationMs !== undefined) finite(evaluator.durationMs, "evaluator.durationMs");
  for (const field of ["f2p", "p2p"])
    if (evaluator[field] !== undefined && evaluator[field] !== null) {
      const counts = object(evaluator[field], `evaluator.${field}`);
      exactKeys(counts, ["passed", "total"], `evaluator.${field}`);
      integer(counts.passed, `evaluator.${field}.passed`);
      integer(counts.total, `evaluator.${field}.total`);
    }
}
export function validateTreatmentDose(
  value: unknown,
  armId: ArmId,
  status?: AttemptStatus,
  agentSucceeded = false,
): Record<string, number> {
  const input = object(value, "treatmentDose");
  exactKeys(input, DOSE_FIELDS, "treatmentDose");
  for (const field of DOSE_FIELDS) integer(input[field], `treatmentDose.${field}`);
  const dose = input as Record<(typeof DOSE_FIELDS)[number], number>;
  if (dose.reductionTriggered > dose.reductionInvocations)
    throw new Error("Treatment dose has more reduction triggers than invocations");
  if (dose.archiveSuccesses + dose.archiveFailures > dose.archiveAttempts)
    throw new Error("Treatment dose has more archive outcomes than attempts");
  const arm = ABLATION_ARMS[armId];
  if (!arm.config.repoMapEnabled && (dose.explicitMapQueries > 0 || dose.automaticMapQueries > 0))
    throw new Error(`Arm ${armId} forbids repository-map activity`);
  if (!arm.config.reductionEnabled && (dose.reductionInvocations > 0 || dose.reductionTriggered > 0))
    throw new Error(`Arm ${armId} forbids reduction activity`);
  if (
    arm.config.archivePolicy === "off" &&
    (dose.archiveAttempts > 0 || dose.archiveSuccesses > 0 || dose.archiveFailures > 0)
  )
    throw new Error(`Arm ${armId} forbids archive activity`);
  if (arm.config.mapInjectionMode === "off" && (dose.capsuleBuilds > 0 || dose.automaticMapQueries > 0))
    throw new Error(`Arm ${armId} forbids map injection activity`);
  const requiresActiveTreatment = agentSucceeded || status === "complete" || status === "task-failed";
  if (requiresActiveTreatment && arm.config.reductionEnabled && dose.reductionInvocations === 0)
    throw new Error(`Agent-success arm ${armId} requires active reduction treatment`);
  if (
    requiresActiveTreatment &&
    arm.config.mapInjectionMode !== "off" &&
    (dose.capsuleBuilds === 0 || dose.automaticMapQueries === 0)
  )
    throw new Error(`Agent-success arm ${armId} requires active automatic map/capsule treatment`);
  return dose;
}

function validateRawTelemetry(value: unknown): void {
  const outer = object(value, "telemetry");
  exactKeys(outer, ["telemetry", "lifecycle"], "telemetry");
  const telemetry = object(outer.telemetry, "telemetry.telemetry");
  const telemetryFields = [
    "capsuleBuildCount",
    "repoMapAutomaticQueryCount",
    "reductionInvocationCount",
    "reductionTriggeredCount",
    "archiveAttemptCount",
    "archiveSuccessCount",
    "archiveFailureCount",
  ] as const;
  exactKeys(telemetry, telemetryFields, "telemetry.telemetry");
  for (const field of telemetryFields) integer(telemetry[field], `telemetry.telemetry.${field}`);
  const lifecycle = object(outer.lifecycle, "telemetry.lifecycle");
  exactKeys(
    lifecycle,
    ["initialized", "degraded", "failureCount", "observationsAvailable", "repoMapAvailable"],
    "telemetry.lifecycle",
  );
  for (const field of ["initialized", "degraded", "observationsAvailable", "repoMapAvailable"])
    if (typeof lifecycle[field] !== "boolean") throw new Error(`telemetry.lifecycle.${field} must be boolean`);
  integer(lifecycle.failureCount, "telemetry.lifecycle.failureCount");
}

export function parseRawAttempt(value: unknown): RawAttempt {
  const input = object(value, "attempt");
  exactKeys(
    input,
    [
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
      "failure",
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
    ],
    "attempt",
  );
  if (input.schemaVersion !== ATTEMPT_SCHEMA_VERSION)
    throw new Error(`Unsupported attempt schema: ${String(input.schemaVersion)}`);
  for (const field of ["experimentHash", "planHash", "runId", "requestedProvider", "requestedModel"] as const)
    string(input[field], field);
  assertSafePersistedIdentifier(string(input.taskId, "taskId"), "taskId");
  integer(input.attempt, "attempt");
  integer(input.repeat, "repeat");
  integer(input.scheduleIndex, "scheduleIndex");
  if (!["A", "B", "C", "D", "E", "F"].includes(String(input.arm))) throw new Error("Invalid attempt arm");
  if (!["complete", "task-failed", "timed-out", "infrastructure-failed", "partial"].includes(String(input.status)))
    throw new Error("Invalid attempt status");
  strings(input.responseModels, "responseModels");
  const integrity = object(input.integrity, "integrity");
  exactKeys(
    integrity,
    ["modelDrift", "lifecycleDegraded", "sessionUsageAmbiguous", "sessionUsageCorrupt"],
    "integrity",
  );
  if (typeof integrity.modelDrift !== "boolean") throw new Error("integrity.modelDrift must be boolean");
  for (const field of ["lifecycleDegraded", "sessionUsageAmbiguous", "sessionUsageCorrupt"])
    if (integrity[field] !== undefined && typeof integrity[field] !== "boolean")
      throw new Error(`integrity.${field} must be boolean`);
  const timing = object(input.timingMs, "timingMs");
  exactKeys(timing, ["provisioning", "agent", "evaluation", "total"], "timingMs");
  for (const field of ["provisioning", "agent", "evaluation", "total"])
    if (typeof timing[field] !== "number" || !Number.isFinite(timing[field]) || timing[field] < 0)
      throw new Error(`timingMs.${field} must be a non-negative finite number`);
  if (input.failure !== undefined) {
    const failure = object(input.failure, "failure");
    exactKeys(failure, ["stage", "code"], "failure");
    string(failure.stage, "failure.stage");
    string(failure.code, "failure.code");
  }
  for (const field of ["usage", "disk", "evaluator", "treatmentDose"] as const)
    assertFiniteNumbersDeep(input[field], field);
  validateRawUsage(input.usage);
  validateRawDisk(input.disk);
  validateRawEvaluator(input.evaluator);
  validateTreatmentDose(
    input.treatmentDose,
    input.arm as ArmId,
    input.status as AttemptStatus,
    input.status === "infrastructure-failed" &&
      input.failure !== undefined &&
      (input.failure as Record<string, unknown>).stage === "evaluator",
  );
  if (input.telemetry !== null) validateRawTelemetry(input.telemetry);
  for (const field of ["finalDiffHash", "evaluatorOutputHash"]) if (input[field] !== null) string(input[field], field);
  return input as unknown as RawAttempt;
}
