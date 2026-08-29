import { isAbsolute, relative, sep } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type ActiveSessionLease, ArtifactStore } from "./artifacts/store.js";
import { reduceContext } from "./context/reduction.js";
import {
  MAX_QUERY_LENGTH,
  MAX_RETRIEVAL_BYTES,
  MAX_SEARCH_RESULTS,
  MAX_SEARCH_TERMS,
  ObservationRuntime,
} from "./observations/virtualization.js";
import { type ContextVaultConfig, loadConfigWithDiagnostics } from "./state/config.js";
import { type ProjectStatePaths, resolveProjectState } from "./state/project-state.js";
import { Telemetry } from "./telemetry.js";
import { frameTelemetry } from "./telemetry-frame.js";

export const EXTENSION_ID = "context-vault" as const;
export const EXTENSION_VERSION = "0.3.0" as const;
export const REBUILD_MIGRATION_MESSAGE =
  "Repository rebuild has moved to pi-repo-context.\nInstall pi-repo-context and use /repo-context rebuild." as const;

export interface RegisterContextVaultOptions {
  env?: NodeJS.ProcessEnv;
  reductionFactory?: typeof reduceContext;
}

interface RuntimeState {
  initialized: boolean;
  state?: ProjectStatePaths;
  config?: ContextVaultConfig;
  store?: ArtifactStore;
  activeSessionLease?: ActiveSessionLease;
  observations?: ObservationRuntime;
  warnings: string[];
  failures: Array<{ component: string; error: string }>;
  telemetry: Telemetry;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function toolResponse(operation: () => Promise<unknown>) {
  const value = await operation();
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], details: value };
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
      // Non-JSON text cannot carry a canonical structured receipt reference.
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

function stateOutsideProjectTree(state: ProjectStatePaths): boolean {
  const path = relative(state.projectRoot, state.stateRoot);
  return isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`);
}

export function runtimeStatus(runtime: RuntimeState) {
  const observation = runtime.observations?.status();
  const degraded = runtime.failures.length > 0 || observation?.degraded === true;
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
    },
    warnings: [...runtime.warnings],
    telemetry: runtime.telemetry.snapshot(),
    failures: runtime.failures.map((failure) => ({ ...failure })),
  };
}

export function registerContextVault(pi: ExtensionAPI, options: RegisterContextVaultOptions = {}): void {
  let telemetryFrameEmitted = false;
  let runtime: RuntimeState = {
    initialized: false,
    warnings: [],
    failures: [],
    telemetry: new Telemetry(),
  };

  const dispose = async (): Promise<void> => {
    const store = runtime.store;
    const lease = runtime.activeSessionLease;
    runtime = { initialized: false, warnings: [], failures: [], telemetry: new Telemetry() };
    if (store && lease) {
      try {
        await store.releaseActiveSession(lease);
      } catch {
        // Failed release retains protection; later GC fails closed when registry state is unreadable.
      }
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    await dispose();
    telemetryFrameEmitted = false;
    const next: RuntimeState = {
      initialized: false,
      warnings: [],
      failures: [],
      telemetry: new Telemetry(),
    };
    try {
      const loaded = await loadConfigWithDiagnostics(ctx.cwd);
      next.config = loaded.config;
      next.warnings = loaded.warnings;
      next.state = await resolveProjectState(ctx.cwd, options.env ?? process.env);
      next.store = new ArtifactStore({
        artifactsRoot: next.state.artifactsRoot,
        metadataRoot: next.state.metadataRoot,
        telemetry: next.telemetry,
      });
      const sessionId = ctx.sessionManager.getSessionId();
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

  pi.on("tool_result", async (event) => {
    if (event.toolName.startsWith("context_vault_") || event.toolName.startsWith("repo_context_")) return;
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
    if (!runtime.store || !runtime.config?.reductionEnabled || !runtime.observations || ctx.model === undefined) return;
    const startedAt = performance.now();
    const reduced = await (options.reductionFactory ?? reduceContext)({
      store: runtime.store,
      messages: event.messages,
      sessionId: runtime.observations.status().sessionId,
      systemPrompt: ctx.getSystemPrompt(),
      contextWindowTokens: ctx.model.contextWindow,
      hotObservationCount: runtime.config.hotObservationCount,
      softContextRatio: runtime.config.softContextRatio,
      targetContextRatio: runtime.config.targetContextRatio,
      receiptMaxBytes: runtime.config.receiptMaxBytes,
    });
    runtime.telemetry.recordReduction({
      durationMs: performance.now() - startedAt,
      triggered: reduced.triggered,
      reducedCount: reduced.reducedCount,
      estimatedTokensBefore: reduced.estimatedTokensBefore,
      estimatedTokensAfter: reduced.estimatedTokensAfter,
      targetReached: reduced.targetReached,
    });
    if (reduced.reducedCount > 0) return { messages: reduced.messages };
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (!ctx.hasUI && !telemetryFrameEmitted) {
      console.log(frameTelemetry(runtimeStatus(runtime)));
      telemetryFrameEmitted = true;
    }
    await dispose();
    if (ctx.hasUI) ctx.ui.setStatus(EXTENSION_ID, undefined);
  });

  pi.registerTool({
    name: "context_vault_obs_get",
    label: "Get Observation",
    description: "Retrieve bounded evidence from an archived Context Vault observation or artifact ID.",
    promptSnippet: "Retrieve more bounded evidence for a Context Vault observation or artifact ID",
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
    description: `Search sanitized archived observations. Default terms mode requires all (up to ${MAX_SEARCH_TERMS}) Unicode-whitespace-separated literal terms anywhere in an observation, in any order and across lines; phrase mode requires a contiguous literal match within one line. Returns at most five matching lines per observation.`,
    promptSnippet: "Search archived observations by literal terms or a contiguous literal phrase",
    promptGuidelines: [
      "Use context_vault_obs_search to find archived evidence, then execute its returned nextAction by calling context_vault_obs_get with nextAction.arguments.id for more bounded evidence; phrase mode is only for contiguous literal matching.",
    ],
    parameters: Type.Object(
      {
        query: Type.String({ minLength: 1, maxLength: MAX_QUERY_LENGTH }),
        matchMode: Type.Optional(
          Type.Union([Type.Literal("terms"), Type.Literal("phrase")], {
            default: "terms",
            description:
              "terms requires every literal term; phrase requires a contiguous literal match within one line",
          }),
        ),
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
    name: "context_vault_status",
    label: "Context Vault Status",
    description: "Report Context Vault Observation storage, reduction, and lifecycle status.",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute() {
      return toolResponse(async () => runtimeStatus(runtime));
    },
  });

  const notify = (ctx: ExtensionCommandContext, value: unknown, type: "info" | "warning" | "error" = "info") => {
    const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    if (ctx.hasUI) ctx.ui.notify(text, type);
    else console.log(text);
  };

  pi.registerCommand("context-vault", {
    description: "Context Vault status|status-json|rebuild|gc|doctor",
    getArgumentCompletions: (prefix) =>
      ["status", "status-json", "rebuild", "gc", "doctor"]
        .filter((command) => command.startsWith(prefix.trim()))
        .map((command) => ({ value: command, label: command })),
    async handler(args, ctx) {
      const subcommand = args.trim().split(/\s+/u)[0] || "status";
      if (subcommand === "status") {
        const status = runtimeStatus(runtime);
        notify(ctx, status, status.degraded ? "warning" : "info");
        return;
      }
      if (subcommand === "status-json") {
        if (!telemetryFrameEmitted) {
          notify(ctx, frameTelemetry(runtimeStatus(runtime)));
          telemetryFrameEmitted = true;
        }
        return;
      }
      if (subcommand === "rebuild") {
        notify(ctx, REBUILD_MIGRATION_MESSAGE, "warning");
        return;
      }
      if (subcommand === "gc") {
        try {
          if (!runtime.store || !runtime.config) throw new Error("artifact store is not initialized");
          const referencedArtifactIds = explicitArtifactReferences(ctx.sessionManager);
          const artifacts = await runtime.store.garbageCollect({
            retentionDays: runtime.config.retentionDays,
            quotaBytes: runtime.config.projectQuotaBytes,
            referencedArtifactIds,
          });
          notify(ctx, { artifacts });
        } catch (error) {
          notify(ctx, `gc failed: ${errorMessage(error)}`, "error");
        }
        return;
      }
      if (subcommand === "doctor") {
        const status = runtimeStatus(runtime);
        const report = {
          status: status.degraded ? "degraded" : "healthy",
          stateOutsideProjectTree: runtime.state ? stateOutsideProjectTree(runtime.state) : undefined,
          ...status,
        };
        notify(ctx, report, report.status === "degraded" ? "warning" : "info");
        return;
      }
      notify(ctx, "usage: /context-vault status|status-json|rebuild|gc|doctor", "error");
    },
  });
}
