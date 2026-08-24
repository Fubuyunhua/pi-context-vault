import { createHash } from "node:crypto";
import type { ArchivedArtifact, ArtifactMetadata, ArtifactStore } from "../artifacts/store.js";
import type { ArchivePolicy } from "../state/config.js";
import type { Telemetry } from "../telemetry.js";

export const MAX_QUERY_LENGTH = 512;
export const MAX_RETRIEVAL_BYTES = 32 * 1024;
export const MAX_SEARCH_RESULTS = 20;

export interface ObservationRuntimeStatus {
  projectId: string;
  projectRoot: string;
  sessionId: string;
  archived: number;
  replaced: number;
  degraded: boolean;
  failures: Array<{ observationId: string; message: string }>;
}

export interface VirtualizeInput {
  toolCallId: string;
  toolName: string;
  text: string;
  isError: boolean;
}

export interface VirtualizeResult {
  observationId: string;
  replacement?: string;
}

export interface ObservationRuntimeOptions {
  store: ArtifactStore;
  archivePolicy?: ArchivePolicy;
  archiveMinBytes?: number;
  replacementThresholdBytes?: number;
  archiveErrorsAlways?: boolean;
  /** @deprecated Use replacementThresholdBytes. */
  archiveThresholdBytes?: number;
  receiptMaxBytes: number;
  projectId: string;
  projectRoot: string;
  sessionId: string;
  telemetry?: Telemetry;
}

export interface ObservationGetResult {
  observation: ArtifactMetadata;
  query?: string;
  evidence?: {
    /** Compatibility alias for requestedByteOffset. */
    byteOffset: number;
    requestedByteOffset: number;
    byteStart: number;
    byteEnd: number;
    text: string;
    truncated: boolean;
  };
  matches?: Array<{ line: number; text: string }>;
  truncated?: boolean;
}

export interface ObservationSearchResult {
  query: string;
  results: Array<{ observation: ArtifactMetadata; matches: Array<{ line: number; text: string }> }>;
  truncated: boolean;
}

interface Utf8Slice {
  byteStart: number;
  byteEnd: number;
  text: string;
}

function isContinuationByte(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80;
}

function byteSlice(value: string, offset: number, limit: number): Utf8Slice {
  const source = Buffer.from(value, "utf8");
  let byteStart = Math.min(offset, source.length);
  while (byteStart < source.length && isContinuationByte(source[byteStart])) byteStart += 1;

  const requestedEnd = Math.min(source.length, offset + limit);
  let byteEnd = Math.max(byteStart, requestedEnd);
  while (byteEnd > byteStart && isContinuationByte(source[byteEnd])) byteEnd -= 1;
  return { byteStart, byteEnd, text: source.subarray(byteStart, byteEnd).toString("utf8") };
}

function clipped(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  return byteSlice(value, 0, maxBytes).text;
}

function literalCaseInsensitivePattern(query: string): RegExp {
  return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu");
}

function matchingExcerpt(line: string, pattern: RegExp, maxBytes: number): string | undefined {
  const match = pattern.exec(line);
  if (match === null) return undefined;
  const sourceBytes = Buffer.byteLength(line, "utf8");
  if (sourceBytes <= maxBytes) return line;

  const matchStart = Buffer.byteLength(line.slice(0, match.index), "utf8");
  const matchBytes = Buffer.byteLength(match[0], "utf8");
  const contextBefore = Math.max(0, Math.floor((maxBytes - Math.min(matchBytes, maxBytes)) / 2));
  const desiredStart = Math.min(Math.max(0, matchStart - contextBefore), sourceBytes - maxBytes);
  return byteSlice(line, desiredStart, maxBytes).text;
}

function matchingLines(
  content: string,
  pattern: RegExp,
  offset: number,
  limit: number,
  excerptBytes: number,
): { matches: Array<{ line: number; text: string }>; truncated: boolean } {
  const matches: Array<{ line: number; text: string }> = [];
  let matchingIndex = 0;
  let lineStart = 0;
  let lineNumber = 1;
  while (lineStart <= content.length) {
    const newline = content.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? content.length : newline;
    const line = content.slice(lineStart, lineEnd);
    const text = matchingExcerpt(line, pattern, excerptBytes);
    if (text !== undefined) {
      if (matchingIndex >= offset) {
        if (matches.length >= limit) return { matches, truncated: true };
        matches.push({ line: lineNumber, text });
      }
      matchingIndex += 1;
    }
    if (newline === -1) break;
    lineStart = newline + 1;
    lineNumber += 1;
  }
  return { matches, truncated: false };
}

export function observationId(sessionId: string, toolCallId: string): string {
  return `obs_${createHash("sha256").update(sessionId).update("\0").update(toolCallId).digest("hex").slice(0, 24)}`;
}

export function buildReceipt(input: {
  observationId: string;
  metadata: ArtifactMetadata;
  toolName: string;
  isError: boolean;
  sanitizedContent: string;
  maxBytes: number;
}): string {
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 512) {
    throw new Error("receipt maxBytes must be an integer of at least 512");
  }
  const fixed = {
    type: "context_vault_observation_receipt",
    id: input.observationId,
    hash: input.metadata.contentHash,
    tool: clipped(input.toolName.replace(/[^\x20-\x7e]/g, "?"), 64),
    originalBytes: input.metadata.originalBytes,
    sanitizedBytes: input.metadata.sanitizedBytes,
    redactions: input.metadata.redactionCount,
    error: input.isError,
    evidence: { artifactId: input.metadata.artifactId, byteOffset: 0, preview: "" },
  };
  const empty = JSON.stringify(fixed);
  if (Buffer.byteLength(empty) > input.maxBytes) return clipped(empty, input.maxBytes);

  let low = 0;
  let high = Math.min(Buffer.byteLength(input.sanitizedContent), input.maxBytes);
  let best = empty;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    fixed.evidence.preview = byteSlice(input.sanitizedContent, 0, middle).text;
    const candidate = JSON.stringify(fixed);
    if (Buffer.byteLength(candidate) <= input.maxBytes) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

function validateQuery(query: string | undefined): string | undefined {
  if (query === undefined) return undefined;
  const normalized = query.trim();
  if (normalized.length === 0) throw new Error("query must not be empty");
  if (normalized.length > MAX_QUERY_LENGTH) throw new Error(`query must not exceed ${MAX_QUERY_LENGTH} characters`);
  return normalized;
}

export class ObservationRuntime {
  readonly #store: ArtifactStore;
  readonly #archivePolicy: ArchivePolicy;
  readonly #archiveMinBytes: number;
  readonly #replacementThresholdBytes: number;
  readonly #archiveErrorsAlways: boolean;
  readonly #receiptMaxBytes: number;
  readonly #status: ObservationRuntimeStatus;
  readonly #telemetry?: Telemetry;

  constructor(options: ObservationRuntimeOptions) {
    const archivePolicy = options.archivePolicy ?? "all";
    const archiveMinBytes = options.archiveMinBytes ?? 16 * 1024;
    const replacementThresholdBytes = options.replacementThresholdBytes ?? options.archiveThresholdBytes ?? 16 * 1024;
    const archiveErrorsAlways = options.archiveErrorsAlways ?? true;
    if (
      options.archiveThresholdBytes !== undefined &&
      (!Number.isSafeInteger(options.archiveThresholdBytes) || options.archiveThresholdBytes <= 0)
    ) {
      throw new Error("archiveThresholdBytes must be a positive safe integer");
    }
    if (!(["all", "errors-and-large", "off"] as const).includes(archivePolicy)) {
      throw new Error("archivePolicy must be one of all, errors-and-large, off");
    }
    if (!Number.isSafeInteger(archiveMinBytes) || archiveMinBytes < 0) {
      throw new Error("archiveMinBytes must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(replacementThresholdBytes) || replacementThresholdBytes <= 0) {
      throw new Error("replacementThresholdBytes must be a positive safe integer");
    }
    if (typeof archiveErrorsAlways !== "boolean") {
      throw new Error("archiveErrorsAlways must be a boolean");
    }
    if (!Number.isSafeInteger(options.receiptMaxBytes) || options.receiptMaxBytes < 512) {
      throw new Error("receiptMaxBytes must be an integer of at least 512");
    }
    this.#store = options.store;
    this.#archivePolicy = archivePolicy;
    this.#archiveMinBytes = archiveMinBytes;
    this.#replacementThresholdBytes = replacementThresholdBytes;
    this.#archiveErrorsAlways = archiveErrorsAlways;
    this.#receiptMaxBytes = options.receiptMaxBytes;
    this.#telemetry = options.telemetry;
    this.#status = {
      projectId: options.projectId,
      projectRoot: options.projectRoot,
      sessionId: options.sessionId,
      archived: 0,
      replaced: 0,
      degraded: false,
      failures: [],
    };
  }

  status(): ObservationRuntimeStatus {
    return { ...this.#status, failures: [...this.#status.failures] };
  }

  async virtualize(input: VirtualizeInput): Promise<VirtualizeResult> {
    const id = observationId(this.#status.sessionId, input.toolCallId);
    const originalBytes = Buffer.byteLength(input.text, "utf8");
    const eligible =
      this.#archivePolicy === "all" ||
      (this.#archivePolicy === "errors-and-large" &&
        (originalBytes >= this.#archiveMinBytes || (input.isError && this.#archiveErrorsAlways)));
    if (!eligible) return { observationId: id };

    this.#telemetry?.recordArchiveStarted();
    const startedAt = performance.now();
    let archived: ArchivedArtifact;
    try {
      archived = await this.#store.archive({
        observationId: id,
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        sessionId: this.#status.sessionId,
        content: input.text,
      });
    } catch (error) {
      this.#telemetry?.recordArchiveFailed(performance.now() - startedAt);
      this.#recordFailure(id, error);
      return { observationId: id };
    }

    this.#telemetry?.recordArchiveSucceeded(performance.now() - startedAt, archived.deduplicated);
    this.#status.archived += 1;
    if (originalBytes <= this.#replacementThresholdBytes) return { observationId: id };
    try {
      const sanitizedContent = await this.#store.read(archived.artifactId);
      const replacement = buildReceipt({
        observationId: id,
        metadata: archived.metadata,
        toolName: input.toolName,
        isError: input.isError,
        sanitizedContent,
        maxBytes: this.#receiptMaxBytes,
      });
      this.#status.replaced += 1;
      return { observationId: id, replacement };
    } catch (error) {
      // The durable archive already succeeded. Receipt materialization can
      // degrade replacement, but it must not also count as an archive failure.
      this.#recordFailure(id, error);
      return { observationId: id };
    }
  }

  #recordFailure(observationId: string, error: unknown): void {
    this.#status.degraded = true;
    this.#status.failures.push({
      observationId,
      message: error instanceof Error ? error.message : String(error),
    });
    this.#status.failures.splice(0, Math.max(0, this.#status.failures.length - 20));
  }

  async get(params: { id: string; query?: string; offset?: number; limit?: number }): Promise<ObservationGetResult> {
    if (!/^obs_[a-f0-9]{24}$/.test(params.id) && !/^[a-f0-9]{64}$/.test(params.id)) {
      throw new Error("id must be a Context Vault observation or artifact ID");
    }
    const query = validateQuery(params.query);
    if (params.offset !== undefined && (!Number.isSafeInteger(params.offset) || params.offset < 0)) {
      throw new Error("offset must be a non-negative integer");
    }
    if (params.limit !== undefined && (!Number.isSafeInteger(params.limit) || params.limit <= 0)) {
      throw new Error("limit must be a positive integer");
    }
    const metadata = /^[a-f0-9]{64}$/.test(params.id)
      ? (await this.#store.listMetadata()).find((entry) => entry.artifactId === params.id)
      : await this.#store.getMetadata(params.id);
    if (metadata === undefined) throw new Error(`Observation not found: ${params.id}`);
    const content = await this.#store.read(metadata.artifactId);
    const limit = Math.min(params.limit ?? 8 * 1024, MAX_RETRIEVAL_BYTES);
    const offset = params.offset ?? 0;
    if (query === undefined) {
      const contentBytes = Buffer.byteLength(content, "utf8");
      if (offset > contentBytes) throw new Error(`offset must not exceed content length (${contentBytes} bytes)`);
      const slice = byteSlice(content, offset, limit);
      return {
        observation: metadata,
        evidence: {
          byteOffset: offset,
          requestedByteOffset: offset,
          byteStart: slice.byteStart,
          byteEnd: slice.byteEnd,
          text: slice.text,
          truncated: slice.byteEnd < contentBytes,
        },
      };
    }
    const page = matchingLines(
      content,
      literalCaseInsensitivePattern(query),
      offset,
      Math.min(limit, MAX_SEARCH_RESULTS),
      2 * 1024,
    );
    return { observation: metadata, query, matches: page.matches, truncated: page.truncated };
  }

  async search(params: { query: string; toolName?: string; limit?: number }): Promise<ObservationSearchResult> {
    const query = validateQuery(params.query);
    if (query === undefined) throw new Error("query is required");
    if (params.toolName !== undefined && (params.toolName.length === 0 || params.toolName.length > 128)) {
      throw new Error("toolName must contain between 1 and 128 characters");
    }
    if (params.limit !== undefined && (!Number.isSafeInteger(params.limit) || params.limit <= 0)) {
      throw new Error("limit must be a positive integer");
    }
    const limit = Math.min(params.limit ?? 10, MAX_SEARCH_RESULTS);
    const pattern = literalCaseInsensitivePattern(query);
    const results: Array<{ observation: ArtifactMetadata; matches: Array<{ line: number; text: string }> }> = [];
    const entries = (await this.#store.listMetadata()).reverse();
    for (const metadata of entries) {
      if (params.toolName !== undefined && metadata.toolName !== params.toolName) continue;
      const content = await this.#store.read(metadata.artifactId);
      const matches = matchingLines(content, pattern, 0, 5, 1024).matches;
      if (matches.length === 0) continue;
      if (results.length >= limit) return { query, results, truncated: true };
      results.push({ observation: metadata, matches });
    }
    return { query, results, truncated: false };
  }
}
