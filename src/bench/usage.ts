import { containsCredentialMaterial, containsHostPath } from "./safety.js";
import type { CacheSupport, UsageNumbers } from "./schema.js";

export interface UsageRecord extends UsageNumbers {
  kind: "assistant" | "auxiliary";
  responseModel: string | null;
}
export interface UsageSummary {
  mainAssistantCalls: number;
  auxiliaryUsageRecords: number;
  toolCalls: number;
  toolResults: number;
  toolNameCounts: Record<string, number>;
  totals: UsageNumbers;
  mainTotals: UsageNumbers;
  auxiliaryTotals: UsageNumbers;
  records: UsageRecord[];
  firstRequest: UsageRecord | null;
  continuation: UsageNumbers;
  cache: {
    support: CacheSupport;
    observed: boolean;
    promptTokens: number;
    uncachedPrompt: number;
    hitRatio: number | null;
  };
  responseModels: string[];
}

const zero = (): UsageNumbers => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 });
function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function usage(value: unknown): UsageNumbers | null {
  if (value === null || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const costValue = input.cost;
  const cost =
    typeof costValue === "object" && costValue !== null
      ? number((costValue as Record<string, unknown>).total)
      : number(costValue);
  return {
    input: number(input.input),
    output: number(input.output),
    cacheRead: number(input.cacheRead),
    cacheWrite: number(input.cacheWrite),
    totalTokens: number(input.totalTokens),
    cost,
  };
}
function add(target: UsageNumbers, source: UsageNumbers): void {
  target.input += source.input;
  target.output += source.output;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  target.totalTokens += source.totalTokens;
  target.cost += source.cost;
}
function safeExtensionLabel(value: string): boolean {
  return (
    !containsCredentialMaterial(value) && !containsHostPath(value) && !/PLANTED_(?:SECRET|SOURCE|PATH)/u.test(value)
  );
}
function modelOf(value: Record<string, unknown>): string | null {
  for (const candidate of [value.responseModel, value.model])
    if (typeof candidate === "string" && candidate.length > 0 && safeExtensionLabel(candidate)) return candidate;
  return null;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function structurallyValidUsage(value: unknown): boolean {
  if (!record(value)) return false;
  for (const field of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"])
    if (value[field] !== undefined && (typeof value[field] !== "number" || !Number.isFinite(value[field])))
      return false;
  if (value.cost !== undefined) {
    if (typeof value.cost === "number") return Number.isFinite(value.cost);
    if (!record(value.cost)) return false;
    if (value.cost.total !== undefined && (typeof value.cost.total !== "number" || !Number.isFinite(value.cost.total)))
      return false;
  }
  return true;
}

export function parseSessionJsonlLine(line: string): Record<string, unknown> | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!record(value) || typeof value.type !== "string" || value.type.length === 0) return null;
  if (value.usage !== undefined && !structurallyValidUsage(value.usage)) return null;
  if (value.type === "message") {
    if (!record(value.message) || typeof value.message.role !== "string" || value.message.role.length === 0)
      return null;
    if (value.message.usage !== undefined && !structurallyValidUsage(value.message.usage)) return null;
    if (value.message.content !== undefined && !Array.isArray(value.message.content)) return null;
  } else if (value.message !== undefined && !record(value.message)) return null;
  return value;
}

function aggregateValidSessionEntries(entries: Record<string, unknown>[], cacheSupport: CacheSupport): UsageSummary {
  const records: UsageRecord[] = [];
  let observedCacheRecords = 0;
  let usageRecords = 0;
  let toolCalls = 0;
  let toolResults = 0;
  const toolNameCounts: Record<string, number> = {};
  for (const entry of entries) {
    const message =
      entry.message && typeof entry.message === "object" ? (entry.message as Record<string, unknown>) : undefined;
    const isAssistant = entry.type === "message" && message?.role === "assistant";
    if (entry.type === "message" && message?.role === "toolResult") toolResults += 1;
    if (isAssistant && Array.isArray(message.content)) {
      const calls = message.content.filter(
        (block) => block && typeof block === "object" && (block as Record<string, unknown>).type === "toolCall",
      ) as Array<Record<string, unknown>>;
      toolCalls += calls.length;
      for (const call of calls) {
        const name = typeof call.name === "string" && safeExtensionLabel(call.name) ? call.name : "redacted";
        toolNameCounts[name] = (toolNameCounts[name] ?? 0) + 1;
      }
    }
    const rawUsage = isAssistant ? message?.usage : (entry.usage ?? message?.usage);
    const found = usage(rawUsage);
    if (found) {
      usageRecords += 1;
      if (
        rawUsage &&
        typeof rawUsage === "object" &&
        Object.hasOwn(rawUsage as object, "cacheRead") &&
        Object.hasOwn(rawUsage as object, "cacheWrite")
      )
        observedCacheRecords += 1;
      records.push({
        ...found,
        kind: isAssistant ? "assistant" : "auxiliary",
        responseModel: modelOf(message ?? entry),
      });
    }
  }
  const totals = zero();
  const mainTotals = zero();
  const auxiliaryTotals = zero();
  for (const record of records) {
    add(totals, record);
    add(record.kind === "assistant" ? mainTotals : auxiliaryTotals, record);
  }
  const assistant = records.filter((record) => record.kind === "assistant");
  const firstRequest = assistant[0] ?? null;
  const continuation = zero();
  for (const record of assistant.slice(1)) add(continuation, record);
  const promptTokens = totals.input + totals.cacheRead + totals.cacheWrite;
  return {
    mainAssistantCalls: assistant.length,
    auxiliaryUsageRecords: records.length - assistant.length,
    toolCalls,
    toolResults,
    toolNameCounts,
    totals,
    mainTotals,
    auxiliaryTotals,
    records,
    firstRequest,
    continuation,
    cache: {
      support: cacheSupport,
      observed: usageRecords > 0 && observedCacheRecords === usageRecords,
      promptTokens,
      uncachedPrompt: totals.input + totals.cacheWrite,
      hitRatio:
        cacheSupport === "reported" && usageRecords > 0 && observedCacheRecords === usageRecords && promptTokens > 0
          ? totals.cacheRead / promptTokens
          : null,
    },
    responseModels: [...new Set(records.flatMap((record) => (record.responseModel ? [record.responseModel] : [])))],
  };
}

export function recoverSessionJsonl(
  text: string,
  cacheSupport: CacheSupport,
): { usage: UsageSummary; malformed: boolean } {
  const entries: Record<string, unknown>[] = [];
  let malformed = false;
  for (const line of text.split(/\r?\n/u)) {
    if (line.trim().length === 0) continue;
    const entry = parseSessionJsonlLine(line);
    if (entry) entries.push(entry);
    else malformed = true;
  }
  return { usage: aggregateValidSessionEntries(entries, cacheSupport), malformed };
}

export function aggregateSessionJsonl(text: string, cacheSupport: CacheSupport): UsageSummary {
  return recoverSessionJsonl(text, cacheSupport).usage;
}
