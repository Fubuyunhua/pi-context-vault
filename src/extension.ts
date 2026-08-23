import { createHash } from "node:crypto";
import { relative, sep } from "node:path";
import type {
  ContextEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type ActiveSessionLease, ArtifactStore } from "./artifacts/store.js";
import { reduceContext } from "./context/reduction.js";
import {
  MAX_QUERY_LENGTH,
  MAX_RETRIEVAL_BYTES,
  MAX_SEARCH_RESULTS,
  ObservationRuntime,
} from "./observations/virtualization.js";
import { RepoMapRuntime, type RepoMapRuntimeOptions, type RepoMapRuntimeQuery } from "./repo-map/runtime.js";
import { type ContextVaultConfig, loadConfig } from "./state/config.js";
import { type ProjectStatePaths, resolveProjectState } from "./state/project-state.js";
import { Telemetry } from "./telemetry.js";

export const EXTENSION_ID = "context-vault";
export const EXTENSION_VERSION = "0.1.0";
const MAP_CAPSULE_TYPE = "context-vault-repo-map";

interface RepoMapController {
  start(): Promise<void>;
  close(): Promise<void>;
  ensureFresh(): Promise<void>;
  rebuild(): Promise<void>;
  maintenance?: RepoMapRuntime["maintenance"];
  /** Optional for backward-compatible injected controllers; automatic context prefers it when available. */
  queryCurrent?(query: string, options?: { limit?: number }): Promise<RepoMapRuntimeQuery>;
  query(query: string, options?: { limit?: number }): Promise<RepoMapRuntimeQuery>;
  status(): ReturnType<RepoMapRuntime["status"]>;
}

export interface RegisterContextVaultOptions {
  env?: NodeJS.ProcessEnv;
  repoMapRuntimeFactory?: (options: RepoMapRuntimeOptions) => RepoMapController;
}

interface RuntimeState {
  initialized: boolean;
  state?: ProjectStatePaths;
  config?: ContextVaultConfig;
  store?: ArtifactStore;
  activeSessionLease?: ActiveSessionLease;
  observations?: ObservationRuntime;
  repoMap?: RepoMapController;
  repoMapAvailable: boolean;
  failures: Array<{ component: string; error: string }>;
  /** Bounded runtime telemetry; reset with the session lifecycle. */
  telemetry: Telemetry;
  /** Monotonic user-turn sequence, advanced only by before_agent_start. */
  turnSequence: number;
  /** Frozen per-user-turn capsule: re-inserted byte-for-byte without re-querying. */
  mapCapsule?: FrozenMapCapsule;
}

interface FrozenMapCapsule {
  /** User-turn sequence at which this capsule was built. */
  turn: number;
  /** Insertion index captured at freeze time, relative to messages without a capsule. */
  index: number;
  /** The complete custom message object; re-inserted as-is on reuse. */
  message: Extract<ContextEvent["messages"][number], { role: "custom" }>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toolResponse(operation: () => Promise<unknown>) {
  return operation()
    .then((value) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], details: value }))
    .catch((error) => ({
      content: [{ type: "text" as const, text: errorMessage(error) }],
      details: {},
      isError: true,
    }));
}

function textContent(event: ToolResultEvent): string | undefined {
  const blocks = event.content.filter(
    (block): block is Extract<(typeof event.content)[number], { type: "text" }> => block.type === "text",
  );
  if (blocks.length === 0) return undefined;
  return blocks.map((block) => block.text).join("\n");
}

const ARTIFACT_ID_PATTERN = /^[a-f0-9]{64}$/;

function receiptArtifactIds(value: unknown, target: Set<string>, seen = new Set<object>()): void {
  if (typeof value === "string") {
    try {
      receiptArtifactIds(JSON.parse(value) as unknown, target, seen);
    } catch {
      // Canonical receipts are complete JSON text blocks. Other strings cannot
      // carry a structured receipt reference.
    }
    return;
  }
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) receiptArtifactIds(item, target, seen);
    return;
  }
  const record = value as Record<string, unknown>;
  if (record.type === "context_vault_observation_receipt") {
    const evidence = record.evidence;
    if (evidence !== null && typeof evidence === "object") {
      const artifactId = (evidence as Record<string, unknown>).artifactId;
      if (typeof artifactId === "string" && ARTIFACT_ID_PATTERN.test(artifactId)) target.add(artifactId);
    }
    if (typeof record.hash === "string" && ARTIFACT_ID_PATTERN.test(record.hash)) target.add(record.hash);
  }
  for (const child of Object.values(record)) receiptArtifactIds(child, target, seen);
}

function explicitArtifactReferences(sessionManager: ExtensionCommandContext["sessionManager"]): Set<string> {
  // getEntries covers every branch in the canonical session file; getBranch
  // explicitly covers the current leaf path. If either cannot be enumerated,
  // propagate the error so GC performs no deletion. Active-session metadata is
  // added by ArtifactStore while holding the same lock used for deletion.
  const entries = sessionManager.getEntries();
  const branch = sessionManager.getBranch();
  if (!Array.isArray(entries) || !Array.isArray(branch)) throw new Error("active session references are unavailable");

  const referenced = new Set<string>();
  receiptArtifactIds(entries, referenced);
  receiptArtifactIds(branch, referenced);
  return referenced;
}

function activeObservation(state: RuntimeState): ObservationRuntime {
  if (state.observations === undefined)
    throw new Error("Context Vault observations are not initialized for this session");
  return state.observations;
}

function activeMap(state: RuntimeState): RepoMapController {
  if (state.repoMap === undefined || !state.repoMapAvailable) {
    throw new Error("Context Vault repository map is not available for this session");
  }
  return state.repoMap;
}

function messageText(message: ContextEvent["messages"][number]): string {
  if (message.role !== "user") return "";
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function mapQuery(messages: ContextEvent["messages"]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const text = messageText(messages[index] as ContextEvent["messages"][number]).trim();
    if (text) return text.slice(0, MAX_QUERY_LENGTH);
  }
  return "repository structure";
}

function lastUserMessageIndex(messages: ContextEvent["messages"]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if ((messages[index] as ContextEvent["messages"][number]).role === "user") return index;
  }
  return -1;
}

function utf8Prefix(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let prefix = Buffer.from(value, "utf8").subarray(0, maxBytes).toString("utf8");
  while (Buffer.byteLength(prefix, "utf8") > maxBytes) prefix = prefix.slice(0, -1);
  return prefix;
}

function recordRuntimeFailure(state: RuntimeState, component: string, error: unknown): void {
  state.failures.push({ component, error: utf8Prefix(errorMessage(error), 512) });
  state.failures.splice(0, Math.max(0, state.failures.length - 20));
}

type MapCapsuleCaptureSemantics = "turn-start-snapshot" | "context-call-snapshot";

function boundedMapCapsule(
  query: string,
  result: RepoMapRuntimeQuery,
  maxBytes: number,
  captureSemantics: MapCapsuleCaptureSemantics,
): string {
  const description =
    captureSemantics === "turn-start-snapshot"
      ? "Frozen repository-map data captured at turn start; it does not reflect later tool edits."
      : "Repository-map data captured for this context call; it is not live state.";
  const completeFallbackEvidence = result.fallbackEvidence.map((evidence) => ({ ...evidence }));
  if (result.freshness === "stale" && completeFallbackEvidence.length === 0) {
    completeFallbackEvidence.push({
      kind: "source",
      excerpt: "Direct source/read/grep fallback is required because the map was stale at capture time.",
    });
  }
  const completeResults = result.results.map((entry) => ({
    path: entry.path,
    kind: entry.kind,
    matchedSymbols: entry.matchedSymbols,
    symbols: entry.symbols,
    dependencies: entry.dependencies,
  }));
  const payload = {
    type: "context_vault_repo_map_capsule",
    trust: "untrusted-derived-navigation-data",
    captureSemantics,
    description,
    query,
    freshnessAtCapture: result.freshness,
    generationAtCapture: result.generation,
    gitHeadAtCapture: result.gitHead,
    workspaceRevisionAtCapture: result.workspaceRevision,
    pendingFilesAtCapture: [...result.pendingFiles],
    results: completeResults.map((entry) => ({
      ...entry,
      symbols: entry.symbols.slice(0, 8),
      dependencies: entry.dependencies.slice(0, 12),
    })),
    fallbackEvidence: completeFallbackEvidence.slice(0, 3).map((evidence) => ({
      ...evidence,
      excerpt: utf8Prefix(evidence.excerpt, 1024),
    })),
    ...(result.error !== undefined ? { error: utf8Prefix(result.error, 512) } : {}),
  };
  const sameJson = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
  const truncatedFields = (
    renderedQuery: string,
    renderedError: string | undefined,
    renderedRevision: string,
    renderedHead: string,
    renderedPendingFiles: string[],
    renderedEvidence: unknown[],
    renderedResults: unknown[],
  ): string[] => {
    const fields: string[] = [];
    if (renderedRevision !== result.workspaceRevision) fields.push("workspaceRevisionAtCapture");
    if (renderedHead !== result.gitHead) fields.push("gitHeadAtCapture");
    if (renderedQuery !== query) fields.push("query");
    if (renderedError !== result.error) fields.push("error");
    if (!sameJson(renderedEvidence, completeFallbackEvidence)) fields.push("fallbackEvidence");
    if (!sameJson(renderedResults, completeResults)) fields.push("results");
    if (!sameJson(renderedPendingFiles, result.pendingFiles)) fields.push("pendingFilesAtCapture");
    return fields;
  };
  const render = () => {
    const fields = truncatedFields(
      payload.query,
      payload.error,
      payload.workspaceRevisionAtCapture,
      payload.gitHeadAtCapture,
      payload.pendingFilesAtCapture,
      payload.fallbackEvidence,
      payload.results,
    );
    return `CONTEXT_VAULT_REPO_MAP\n${JSON.stringify({
      ...payload,
      ...(fields.length > 0 ? { truncatedFields: fields } : {}),
    })}`;
  };
  while (Buffer.byteLength(render()) > maxBytes && payload.results.length > 0) payload.results.pop();
  while (Buffer.byteLength(render()) > maxBytes && payload.pendingFilesAtCapture.length > 0)
    payload.pendingFilesAtCapture.pop();
  while (Buffer.byteLength(render()) > maxBytes && payload.fallbackEvidence.length > 1) {
    payload.fallbackEvidence.pop();
  }
  while (Buffer.byteLength(render()) > maxBytes && payload.query.length > 64)
    payload.query = payload.query.slice(0, -32);
  while (
    Buffer.byteLength(render()) > maxBytes &&
    payload.fallbackEvidence.some((entry) => entry.excerpt.length > 96)
  ) {
    for (const evidence of payload.fallbackEvidence)
      evidence.excerpt = evidence.excerpt.slice(0, Math.max(96, Math.floor(evidence.excerpt.length / 2)));
  }
  const rendered = render();
  if (Buffer.byteLength(rendered, "utf8") <= maxBytes) return rendered;

  // Configuration enforces a 512-byte minimum. This compact form retains the
  // capture provenance, a bounded error when present, and explicit final-loss flags.
  let revision = utf8Prefix(result.workspaceRevision, 64);
  let head = utf8Prefix(result.gitHead, 40);
  let boundedError = result.error !== undefined ? utf8Prefix(result.error, 64) : undefined;
  const minimalEvidence =
    completeFallbackEvidence.length > 0 ? [{ kind: completeFallbackEvidence[0]?.kind ?? "source" }] : [];
  const minimal = {
    type: "context_vault_repo_map_capsule",
    captureSemantics,
    description: "Snapshot, not live.",
    freshnessAtCapture: result.freshness,
    workspaceRevisionAtCapture: revision,
    generationAtCapture: result.generation,
    gitHeadAtCapture: head,
    pendingFileCountAtCapture: result.pendingFiles.length,
    fallbackEvidence: minimalEvidence,
    ...(boundedError !== undefined ? { error: boundedError } : {}),
  };
  const renderMinimal = () => {
    const fields = truncatedFields("", boundedError, revision, head, [], minimalEvidence, []);
    return `CONTEXT_VAULT_REPO_MAP\n${JSON.stringify({ ...minimal, truncatedFields: fields })}`;
  };
  while (
    Buffer.byteLength(renderMinimal()) > maxBytes &&
    boundedError !== undefined &&
    Buffer.byteLength(boundedError, "utf8") > 1
  ) {
    boundedError = utf8Prefix(boundedError, Math.max(1, Buffer.byteLength(boundedError, "utf8") - 8));
    minimal.error = boundedError;
  }
  while (Buffer.byteLength(renderMinimal()) > maxBytes && Buffer.byteLength(revision, "utf8") > 8) {
    revision = utf8Prefix(revision, Math.max(8, Buffer.byteLength(revision, "utf8") - 8));
    minimal.workspaceRevisionAtCapture = revision;
  }
  while (Buffer.byteLength(renderMinimal()) > maxBytes && Buffer.byteLength(head, "utf8") > 8) {
    head = utf8Prefix(head, Math.max(8, Buffer.byteLength(head, "utf8") - 8));
    minimal.gitHeadAtCapture = head;
  }
  return renderMinimal();
}

function projectTreeContainsState(state: ProjectStatePaths): boolean {
  const path = relative(state.projectRoot, state.stateRoot);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}

function runtimeStatus(runtime: RuntimeState) {
  const observation = runtime.observations?.status();
  const repoMap = runtime.repoMap?.status();
  const degraded =
    runtime.failures.length > 0 ||
    observation?.degraded === true ||
    repoMap?.freshness === "stale" ||
    repoMap?.freshness === "unsupported" ||
    (repoMap?.maintenance !== undefined && "error" in repoMap.maintenance);
  return {
    extension: { id: EXTENSION_ID, version: EXTENSION_VERSION },
    initialized: runtime.initialized,
    degraded,
    project: runtime.state
      ? { id: runtime.state.projectId, root: runtime.state.projectRoot, stateRoot: runtime.state.stateRoot }
      : undefined,
    components: {
      observations: observation
        ? { available: true, ...observation }
        : {
            available: false,
            error: runtime.failures.find((failure) => failure.component === "initialization")?.error,
          },
      repoMap: repoMap
        ? {
            available: runtime.repoMapAvailable,
            ...repoMap,
            ...(runtime.failures.find((failure) => failure.component === "repo-map")
              ? { error: runtime.failures.find((failure) => failure.component === "repo-map")?.error }
              : {}),
          }
        : { available: false, error: runtime.failures.find((failure) => failure.component === "repo-map")?.error },
    },
    telemetry: runtime.telemetry.snapshot(),
    failures: [...runtime.failures],
  };
}

export function registerContextVault(pi: ExtensionAPI, options: RegisterContextVaultOptions = {}): void {
  let runtime: RuntimeState = {
    initialized: false,
    repoMapAvailable: false,
    failures: [],
    telemetry: new Telemetry(),
    turnSequence: 0,
  };

  const dispose = async (): Promise<void> => {
    const map = runtime.repoMap;
    const store = runtime.store;
    const activeSessionLease = runtime.activeSessionLease;
    runtime = {
      initialized: false,
      repoMapAvailable: false,
      failures: [],
      telemetry: new Telemetry(),
      turnSequence: 0,
    };
    if (map) {
      try {
        await map.close();
      } catch {
        // Lifecycle cleanup is best effort and must not prevent Pi shutdown/reload.
      }
    }
    if (store && activeSessionLease) {
      try {
        await store.releaseActiveSession(activeSessionLease);
      } catch {
        // A failed release retains protection. Later GC fails closed if the
        // registry itself is unreadable, and demonstrably dead owners are cleaned.
      }
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    await dispose();
    const next: RuntimeState = {
      initialized: false,
      repoMapAvailable: false,
      failures: [],
      telemetry: new Telemetry(),
      turnSequence: 0,
    };
    try {
      next.state = await resolveProjectState(ctx.cwd, options.env ?? process.env);
      next.config = await loadConfig(next.state.projectRoot);
      next.store = new ArtifactStore({
        artifactsRoot: next.state.artifactsRoot,
        metadataRoot: next.state.metadataRoot,
        telemetry: next.telemetry,
      });
      const sessionId = ctx.sessionManager.getSessionId();
      // Register under the artifact metadata lock before ObservationRuntime can
      // archive anything for this current or resumed Pi session.
      next.activeSessionLease = await next.store.registerActiveSession(sessionId);
      next.observations = new ObservationRuntime({
        store: next.store,
        archivePolicy: next.config.archivePolicy,
        archiveMinBytes: next.config.archiveMinBytes,
        replacementThresholdBytes: next.config.replacementThresholdBytes,
        archiveErrorsAlways: next.config.archiveErrorsAlways,
        receiptMaxBytes: next.config.receiptMaxBytes,
        projectId: next.state.projectId,
        projectRoot: next.state.projectRoot,
        sessionId,
        telemetry: next.telemetry,
      });
      next.initialized = true;
      next.repoMap = (options.repoMapRuntimeFactory ?? ((mapOptions) => new RepoMapRuntime(mapOptions)))({
        projectRoot: next.state.projectRoot,
        stateRoot: next.state.mapRoot,
        exclude: next.config.mapExcludePatterns,
        mapDebounceMs: next.config.mapDebounceMs,
        mapGenerationRetention: next.config.mapGenerationRetention,
        mapQuotaBytes: next.config.mapQuotaBytes,
        telemetry: next.telemetry,
      });
      try {
        await next.repoMap.start();
        next.repoMapAvailable = true;
      } catch (error) {
        next.failures.push({ component: "repo-map", error: errorMessage(error) });
      }
    } catch (error) {
      next.failures.push({ component: "initialization", error: errorMessage(error) });
    }
    runtime = next;
    if (ctx.hasUI) {
      ctx.ui.setStatus(
        EXTENSION_ID,
        `vault v${EXTENSION_VERSION}${runtimeStatus(runtime).degraded ? " degraded" : ""}`,
      );
    }
  });

  pi.on("before_agent_start", async () => {
    runtime.turnSequence += 1;
    runtime.mapCapsule = undefined;
    if (!runtime.repoMapAvailable) return;
    try {
      await runtime.repoMap?.ensureFresh();
    } catch (error) {
      runtime.failures.push({ component: "repo-map", error: errorMessage(error) });
    }
  });

  pi.on("tool_result", async (event) => {
    if (event.toolName.startsWith("context_vault_")) return;
    const text = textContent(event);
    if (text === undefined || runtime.observations === undefined) return;
    const result = await runtime.observations.virtualize({
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      text,
      isError: event.isError,
    });
    if (result.replacement === undefined) return;
    return {
      content: [
        { type: "text" as const, text: result.replacement },
        ...event.content.filter((block) => block.type !== "text"),
      ],
    };
  });

  pi.on("context", async (event, ctx) => {
    const hasPreviousCapsule = event.messages.some(
      (message) => message.role === "custom" && message.customType === MAP_CAPSULE_TYPE,
    );
    let messages = hasPreviousCapsule
      ? event.messages.filter((message) => !(message.role === "custom" && message.customType === MAP_CAPSULE_TYPE))
      : event.messages;
    const injectionMode = runtime.config?.mapInjectionMode ?? "once-per-user-turn";
    if (runtime.repoMapAvailable && runtime.repoMap && runtime.config && injectionMode !== "off") {
      try {
        const frozen = runtime.mapCapsule;
        if (injectionMode === "once-per-user-turn" && frozen?.turn === runtime.turnSequence) {
          // Same user turn: re-insert the identical capsule at its frozen index
          // without re-querying the map or re-rendering the payload.
          const insertIndex = Math.min(frozen.index, messages.length);
          messages = [...messages.slice(0, insertIndex), frozen.message, ...messages.slice(insertIndex)];
        } else {
          const query = mapQuery(messages);
          let result: RepoMapRuntimeQuery;
          runtime.telemetry.recordAutomaticQuery();
          try {
            result = await (runtime.repoMap.queryCurrent ?? runtime.repoMap.query).call(runtime.repoMap, query, {
              limit: 8,
            });
          } catch (error) {
            result = {
              results: [],
              freshness: "stale",
              generation: 0,
              gitHead: "unavailable",
              workspaceRevision: "unavailable",
              pendingFiles: [],
              fallbackEvidence: [
                {
                  kind: "source",
                  excerpt: "Repository-map query failed; use direct source reads, grep, and Git diff.",
                },
              ],
              error: errorMessage(error),
            };
          }
          // Per-user-turn mode freezes the capsule after the latest user message;
          // every-llm-call mode keeps the legacy head-of-history placement.
          const freeze = injectionMode === "once-per-user-turn";
          const lastUserIndex = lastUserMessageIndex(messages);
          const insertIndex = freeze && lastUserIndex >= 0 ? Math.min(lastUserIndex + 1, messages.length) : 0;
          const timestamp =
            freeze && lastUserIndex >= 0
              ? (messages[lastUserIndex]?.timestamp ?? 0)
              : Math.max(0, (messages[0]?.timestamp ?? Date.now()) - 1);
          const captureSemantics: MapCapsuleCaptureSemantics = freeze ? "turn-start-snapshot" : "context-call-snapshot";
          const capsule: Extract<ContextEvent["messages"][number], { role: "custom" }> = {
            role: "custom",
            customType: MAP_CAPSULE_TYPE,
            content: boundedMapCapsule(query, result, runtime.config.mapContextMaxBytes, captureSemantics),
            display: false,
            details: {
              persistent: false,
              captureSemantics,
              freshnessAtCapture: result.freshness,
              workspaceRevisionAtCapture: result.workspaceRevision,
              generationAtCapture: result.generation,
              gitHeadAtCapture: result.gitHead,
              pendingFilesAtCapture: [...result.pendingFiles],
            },
            timestamp,
          };
          if (freeze) runtime.mapCapsule = { turn: runtime.turnSequence, index: insertIndex, message: capsule };
          if (typeof capsule.content === "string") {
            runtime.telemetry.recordCapsuleBuild(
              Buffer.byteLength(capsule.content, "utf8"),
              insertIndex,
              createHash("sha256").update(capsule.content, "utf8").digest("hex"),
            );
          }
          messages = [...messages.slice(0, insertIndex), capsule, ...messages.slice(insertIndex)];
        }
      } catch (error) {
        // Map capsules are advisory: malformed/unserializable query data must
        // never abort the context hook or prevent observation reduction.
        runtime.mapCapsule = undefined;
        recordRuntimeFailure(runtime, "repo-map", error);
      }
    }
    if (!runtime.store || !runtime.config || !runtime.observations || ctx.model === undefined) {
      return messages === event.messages ? undefined : { messages };
    }
    const reductionStartedAt = performance.now();
    const reduced = await reduceContext({
      store: runtime.store,
      messages,
      sessionId: runtime.observations.status().sessionId,
      systemPrompt: ctx.getSystemPrompt(),
      contextWindowTokens: ctx.model.contextWindow,
      hotObservationCount: runtime.config.hotObservationCount,
      softContextRatio: runtime.config.softContextRatio,
      targetContextRatio: runtime.config.targetContextRatio,
      receiptMaxBytes: runtime.config.receiptMaxBytes,
    });
    runtime.telemetry.recordReduction({
      durationMs: performance.now() - reductionStartedAt,
      triggered: reduced.triggered,
      reducedCount: reduced.reducedCount,
      estimatedTokensBefore: reduced.estimatedTokensBefore,
      estimatedTokensAfter: reduced.estimatedTokensAfter,
      targetReached: reduced.targetReached,
    });
    if (reduced.reducedCount > 0 || messages !== event.messages) return { messages: reduced.messages };
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    await dispose();
    if (ctx.hasUI) ctx.ui.setStatus(EXTENSION_ID, undefined);
  });

  pi.registerTool({
    name: "context_vault_obs_get",
    label: "Get Observation",
    description: "Retrieve bounded evidence from an archived Context Vault observation.",
    parameters: Type.Object(
      {
        id: Type.String({ minLength: 28, maxLength: 64 }),
        query: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_QUERY_LENGTH })),
        offset: Type.Optional(Type.Integer({ minimum: 0 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_RETRIEVAL_BYTES })),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params) {
      return toolResponse(() => activeObservation(runtime).get(params));
    },
  });

  pi.registerTool({
    name: "context_vault_obs_search",
    label: "Search Observations",
    description: "Search sanitized archived observations and return bounded evidence lines.",
    parameters: Type.Object(
      {
        query: Type.String({ minLength: 1, maxLength: MAX_QUERY_LENGTH }),
        toolName: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_SEARCH_RESULTS })),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params) {
      return toolResponse(() => activeObservation(runtime).search(params));
    },
  });

  pi.registerTool({
    name: "context_vault_repo_map",
    label: "Repository Map",
    description: "Query the revision-aware repository map with explicit freshness and fallback evidence.",
    parameters: Type.Object(
      {
        query: Type.String({ minLength: 1, maxLength: MAX_QUERY_LENGTH }),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_SEARCH_RESULTS })),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params) {
      return toolResponse(() => activeMap(runtime).query(params.query, { limit: params.limit }));
    },
  });

  pi.registerTool({
    name: "context_vault_status",
    label: "Context Vault Status",
    description: "Report Context Vault lifecycle, observation, repository-map, and degraded component status.",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute() {
      return toolResponse(async () => runtimeStatus(runtime));
    },
  });

  const notify = (ctx: ExtensionCommandContext, value: unknown, type: "info" | "warning" | "error" = "info") => {
    const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    if (ctx.hasUI) {
      ctx.ui.notify(text, type);
    } else {
      // Headless modes (print/json): pi redirects stdout to stderr via its output guard,
      // so this stays visible without polluting the TUI or the JSON protocol stream.
      console.log(text);
    }
  };

  pi.registerCommand("context-vault", {
    description: "Context Vault status|rebuild|gc|doctor",
    getArgumentCompletions: (prefix) =>
      ["status", "rebuild", "gc", "doctor"]
        .filter((command) => command.startsWith(prefix.trim()))
        .map((command) => ({ value: command, label: command })),
    async handler(args, ctx) {
      const subcommand = args.trim().split(/\s+/u)[0] || "status";
      if (subcommand === "status") {
        const status = runtimeStatus(runtime);
        notify(ctx, status, status.degraded ? "warning" : "info");
        return;
      }
      if (subcommand === "rebuild") {
        // A rebuild changes the map generation contract. Never reuse a capsule
        // frozen before or concurrently with either rebuild outcome.
        runtime.mapCapsule = undefined;
        try {
          if (!runtime.repoMap) throw new Error("repository map is not initialized");
          await runtime.repoMap.rebuild();
          const rebuilt = runtime.repoMap.status();
          if (rebuilt.freshness === "stale" || rebuilt.error) {
            throw new Error(rebuilt.error ?? "repository map remained stale after rebuild");
          }
          runtime.repoMapAvailable = true;
          runtime.failures = runtime.failures.filter((failure) => failure.component !== "repo-map");
          notify(ctx, { operation: "rebuild", status: rebuilt });
        } catch (error) {
          runtime.repoMapAvailable = false;
          runtime.failures = runtime.failures.filter((failure) => failure.component !== "repo-map");
          runtime.failures.push({ component: "repo-map", error: errorMessage(error) });
          notify(ctx, `rebuild failed: ${errorMessage(error)}`, "error");
        } finally {
          runtime.mapCapsule = undefined;
        }
        return;
      }
      if (subcommand === "gc") {
        try {
          if (!runtime.store || !runtime.config) throw new Error("artifact store is not initialized");
          if (!runtime.repoMap?.maintenance) throw new Error("repository map maintenance is not initialized");
          const referencedArtifactIds = explicitArtifactReferences(ctx.sessionManager);
          const artifacts = await runtime.store.garbageCollect({
            retentionDays: runtime.config.retentionDays,
            quotaBytes: runtime.config.projectQuotaBytes,
            referencedArtifactIds,
          });
          const repoMap = await runtime.repoMap.maintenance();
          notify(ctx, { artifacts, repoMap });
        } catch (error) {
          notify(ctx, `gc failed: ${errorMessage(error)}`, "error");
        }
        return;
      }
      if (subcommand === "doctor") {
        const status = runtimeStatus(runtime);
        const report = {
          status: status.degraded ? "degraded" : "healthy",
          stateOutsideProjectTree: runtime.state ? !projectTreeContainsState(runtime.state) : undefined,
          ...status,
        };
        notify(ctx, report, report.status === "degraded" ? "warning" : "info");
        return;
      }
      notify(ctx, "usage: /context-vault status|rebuild|gc|doctor", "error");
    },
  });
}
