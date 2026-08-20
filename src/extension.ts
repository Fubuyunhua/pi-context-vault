import { createHash } from "node:crypto";
import { relative, sep } from "node:path";
import type {
  ContextEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ArtifactStore } from "./artifacts/store.js";
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

function boundedMapCapsule(query: string, result: RepoMapRuntimeQuery, maxBytes: number): string {
  const fallbackEvidence = result.fallbackEvidence.slice(0, 3).map((evidence) => ({
    ...evidence,
    excerpt: evidence.excerpt.slice(0, 1024),
  }));
  if (result.freshness === "stale" && fallbackEvidence.length === 0) {
    fallbackEvidence.push({
      kind: "source",
      excerpt: "Direct source/read/grep fallback is required because the map is stale.",
    });
  }
  const payload = {
    type: "context_vault_repo_map_capsule",
    trust: "untrusted-derived-navigation-data",
    query,
    freshness: result.freshness,
    generation: result.generation,
    gitHead: result.gitHead,
    workspaceRevision: result.workspaceRevision,
    pendingFiles: [...result.pendingFiles],
    results: result.results.map((entry) => ({
      path: entry.path,
      kind: entry.kind,
      matchedSymbols: entry.matchedSymbols,
      symbols: entry.symbols.slice(0, 8),
      dependencies: entry.dependencies.slice(0, 12),
    })),
    fallbackEvidence,
    ...(result.error ? { error: result.error.slice(0, 512) } : {}),
  };
  const render = () => `CONTEXT_VAULT_REPO_MAP\n${JSON.stringify(payload)}`;
  while (Buffer.byteLength(render()) > maxBytes && payload.results.length > 0) payload.results.pop();
  while (Buffer.byteLength(render()) > maxBytes && payload.pendingFiles.length > 0) payload.pendingFiles.pop();
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
      evidence.excerpt = evidence.excerpt.slice(0, Math.max(96, evidence.excerpt.length / 2));
  }
  const rendered = render();
  if (Buffer.byteLength(rendered, "utf8") <= maxBytes) return rendered;

  // Configuration enforces a 512-byte minimum. This compact, valid JSON form
  // retains the consistency fields even when untrusted excerpts/errors are huge.
  const revision = utf8Prefix(result.workspaceRevision, 64);
  const minimal = {
    type: "context_vault_repo_map_capsule",
    freshness: result.freshness,
    workspaceRevision: revision,
    ...(revision !== result.workspaceRevision ? { workspaceRevisionTruncated: true } : {}),
    fallbackEvidence:
      result.freshness === "stale" ? [{ kind: result.fallbackEvidence[0]?.kind ?? "source", truncated: true }] : [],
    truncated: true,
  };
  return `CONTEXT_VAULT_REPO_MAP\n${JSON.stringify(minimal)}`;
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
      next.observations = new ObservationRuntime({
        store: next.store,
        archiveThresholdBytes: next.config.archiveThresholdBytes,
        receiptMaxBytes: next.config.receiptMaxBytes,
        projectId: next.state.projectId,
        projectRoot: next.state.projectRoot,
        sessionId: ctx.sessionManager.getSessionId(),
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
            result = await runtime.repoMap.query(query, { limit: 8 });
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
          const capsule: Extract<ContextEvent["messages"][number], { role: "custom" }> = {
            role: "custom",
            customType: MAP_CAPSULE_TYPE,
            content: boundedMapCapsule(query, result, runtime.config.mapContextMaxBytes),
            display: false,
            details: { persistent: false, freshness: result.freshness, workspaceRevision: result.workspaceRevision },
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
          const artifacts = await runtime.store.garbageCollect({
            retentionDays: runtime.config.retentionDays,
            quotaBytes: runtime.config.projectQuotaBytes,
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
