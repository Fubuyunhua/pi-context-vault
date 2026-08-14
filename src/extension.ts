import type { ExtensionAPI, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ArtifactStore } from "./artifacts/store.js";
import {
  MAX_QUERY_LENGTH,
  MAX_RETRIEVAL_BYTES,
  MAX_SEARCH_RESULTS,
  ObservationRuntime,
} from "./observations/virtualization.js";
import { loadConfig } from "./state/config.js";
import { resolveProjectState } from "./state/project-state.js";

export const EXTENSION_ID = "context-vault";
export const EXTENSION_VERSION = "0.1.0";

export interface RegisterContextVaultOptions {
  env?: NodeJS.ProcessEnv;
}

function toolResponse(operation: () => Promise<unknown>) {
  return operation()
    .then((value) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], details: value }))
    .catch((error) => ({
      content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
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

function activeRuntime(runtime: ObservationRuntime | undefined): ObservationRuntime {
  if (runtime === undefined) throw new Error("Context Vault is not initialized for this session");
  return runtime;
}

export function registerContextVault(pi: ExtensionAPI, options: RegisterContextVaultOptions = {}): void {
  let runtime: ObservationRuntime | undefined;

  pi.on("session_start", async (_event, ctx) => {
    const state = await resolveProjectState(ctx.cwd, options.env ?? process.env);
    const config = await loadConfig(state.projectRoot);
    runtime = new ObservationRuntime({
      store: new ArtifactStore({ artifactsRoot: state.artifactsRoot, metadataRoot: state.metadataRoot }),
      archiveThresholdBytes: config.archiveThresholdBytes,
      receiptMaxBytes: config.receiptMaxBytes,
      projectId: state.projectId,
      projectRoot: state.projectRoot,
      sessionId: ctx.sessionManager.getSessionId(),
    });
    if (ctx.hasUI) ctx.ui.setStatus(EXTENSION_ID, `vault v${EXTENSION_VERSION}`);
  });

  pi.on("tool_result", async (event) => {
    if (event.toolName.startsWith("context_vault_")) return;
    const text = textContent(event);
    if (text === undefined || runtime === undefined) return;
    const result = await runtime.virtualize({
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

  pi.on("session_shutdown", async (_event, ctx) => {
    runtime = undefined;
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
      return toolResponse(() => activeRuntime(runtime).get(params));
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
      return toolResponse(() => activeRuntime(runtime).search(params));
    },
  });

  pi.registerTool({
    name: "context_vault_status",
    label: "Context Vault Status",
    description: "Report Context Vault project identity, counters, and degraded persistence failures.",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute() {
      return toolResponse(async () => activeRuntime(runtime).status());
    },
  });
}
