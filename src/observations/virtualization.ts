import { createHash } from "node:crypto";
import type { ArchivedArtifact, ArtifactMetadata, ArtifactStore } from "../artifacts/store.js";
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
  archiveThresholdBytes: number;
  receiptMaxBytes: number;
  projectId: string;
  projectRoot: string;
  sessionId: string;
  telemetry?: Telemetry;
}

export interface ObservationGetResult {
  observation: ArtifactMetadata;
  query?: string;
  evidence?: { byteOffset: number; text: string; truncated: boolean };
  matches?: Array<{ line: number; text: string }>;
  truncated?: boolean;
}

export interface ObservationSearchResult {
  query: string;
  results: Array<{ observation: ArtifactMetadata; matches: Array<{ line: number; text: string }> }>;
  truncated: boolean;
}

function byteSlice(value: string, offset: number, limit: number): string {
  const source = Buffer.from(value, "utf8");
  let end = Math.min(source.length, offset + limit);
  let result = source.subarray(offset, end).toString("utf8");
  while (end > offset && Buffer.byteLength(result) > limit) {
    end -= 1;
    result = source.subarray(offset, end).toString("utf8");
  }
  return result;
}

function clipped(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  return byteSlice(value, 0, maxBytes);
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
    fixed.evidence.preview = byteSlice(input.sanitizedContent, 0, middle);
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
  readonly #archiveThresholdBytes: number;
  readonly #receiptMaxBytes: number;
  readonly #status: ObservationRuntimeStatus;
  readonly #telemetry?: Telemetry;

  constructor(options: ObservationRuntimeOptions) {
    if (!Number.isSafeInteger(options.archiveThresholdBytes) || options.archiveThresholdBytes <= 0) {
      throw new Error("archiveThresholdBytes must be a positive integer");
    }
    if (!Number.isSafeInteger(options.receiptMaxBytes) || options.receiptMaxBytes < 512) {
      throw new Error("receiptMaxBytes must be an integer of at least 512");
    }
    this.#store = options.store;
    this.#archiveThresholdBytes = options.archiveThresholdBytes;
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
    if (Buffer.byteLength(input.text) <= this.#archiveThresholdBytes) return { observationId: id };
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
      return {
        observation: metadata,
        evidence: {
          byteOffset: offset,
          text: byteSlice(content, offset, limit),
          truncated: offset + limit < Buffer.byteLength(content),
        },
      };
    }
    const lines = content.split("\n");
    const needle = query.toLocaleLowerCase();
    const allMatches = lines
      .map((line, index) => ({ line: index + 1, text: clipped(line, 2 * 1024) }))
      .filter((entry) => entry.text.toLocaleLowerCase().includes(needle));
    const matches = allMatches.slice(offset, offset + Math.min(limit, MAX_SEARCH_RESULTS));
    return { observation: metadata, query, matches, truncated: offset + matches.length < allMatches.length };
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
    const needle = query.toLocaleLowerCase();
    const results: Array<{ observation: ArtifactMetadata; matches: Array<{ line: number; text: string }> }> = [];
    const entries = (await this.#store.listMetadata()).reverse();
    for (const metadata of entries) {
      if (params.toolName !== undefined && metadata.toolName !== params.toolName) continue;
      const content = await this.#store.read(metadata.artifactId);
      const matches = content
        .split("\n")
        .map((line, index) => ({ line: index + 1, text: clipped(line, 1024) }))
        .filter((entry) => entry.text.toLocaleLowerCase().includes(needle))
        .slice(0, 5);
      if (matches.length > 0) results.push({ observation: metadata, matches });
      if (results.length >= limit) break;
    }
    return { query, results, truncated: results.length >= limit };
  }
}
