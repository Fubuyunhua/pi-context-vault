// biome-ignore-all lint/suspicious/noExplicitAny: heterogeneous Pi callback capture is isolated to this test harness.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "../src/artifacts/store.js";
import {
  PROJECT_QUOTA_EXCEEDED_WARNING,
  REBUILD_MIGRATION_MESSAGE,
  type RegisterContextVaultOptions,
  registerContextVault,
} from "../src/extension.js";
import { LEGACY_REPO_CONFIG_WARNING } from "../src/state/config.js";
import { resolveProjectState } from "../src/state/project-state.js";
import { extractTelemetryFrame } from "../src/telemetry-frame.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface CapturedTool {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: any;
  execute: (...args: any[]) => Promise<any>;
}

async function harness(config: Record<string, unknown> = {}, options: RegisterContextVaultOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "context-vault-private-home-marker-"));
  roots.push(root);
  const project = join(root, "project");
  const piRoot = join(root, "pi");
  await mkdir(join(project, ".pi"), { recursive: true });
  await writeFile(join(project, ".pi", "context-vault.json"), JSON.stringify(config));
  const handlers = new Map<string, (...args: any[]) => Promise<any>>();
  const tools = new Map<string, CapturedTool>();
  const commands = new Map<string, { handler: (...args: any[]) => Promise<void> }>();
  const notifications: Array<{ text: string; type: string }> = [];
  const statuses: Array<{ key: string; value: string | undefined }> = [];
  const pi = {
    on: (event: string, handler: (...args: any[]) => Promise<any>) => handlers.set(event, handler),
    registerTool: (tool: CapturedTool) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: { handler: (...args: any[]) => Promise<void> }) =>
      commands.set(name, command),
  };
  registerContextVault(pi as never, { env: { PI_CODING_AGENT_DIR: piRoot }, ...options });
  const ctx = {
    cwd: project,
    hasUI: true,
    ui: {
      notify: (text: string, type: string) => notifications.push({ text, type }),
      setStatus: (key: string, value: string | undefined) => statuses.push({ key, value }),
    },
    sessionManager: {
      getSessionId: () => "session-one",
      getEntries: () => [],
      getBranch: () => [],
    },
    model: { contextWindow: 10_000 },
    getSystemPrompt: () => "system",
  };
  return { root, project, piRoot, handlers, tools, commands, notifications, statuses, ctx };
}

async function digestTree(root: string): Promise<string> {
  const rows: string[] = [];
  async function visit(path: string): Promise<void> {
    for (const name of (await readdir(path)).sort()) {
      const child = join(path, name);
      const info = await stat(child);
      if (info.isDirectory()) await visit(child);
      else
        rows.push(
          `${relative(root, child)}\0${createHash("sha256")
            .update(await readFile(child))
            .digest("hex")}`,
        );
    }
  }
  await visit(root);
  return createHash("sha256").update(rows.join("\n")).digest("hex");
}

async function createDirectorySymlink(target: string, path: string): Promise<boolean> {
  try {
    await symlink(target, path, "junction");
    return true;
  } catch (error) {
    if (["EACCES", "ENOSYS", "ENOTSUP", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      return false;
    }
    throw error;
  }
}

function toolEvent(toolName: string, text = "large external evidence") {
  return {
    toolName,
    toolCallId: `call-${toolName}`,
    content: [{ type: "text", text }],
    isError: false,
  };
}

function expectRecursivelyPrivate(value: unknown, privateMarkers: string[]): void {
  if (typeof value === "string") {
    for (const marker of privateMarkers) expect(value).not.toContain(marker);
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) expectRecursivelyPrivate(item, privateMarkers);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    expect(["root", "stateRoot", "projectRoot"]).not.toContain(key);
    expectRecursivelyPrivate(child, privateMarkers);
  }
}

function expectModelStatusPrivate(result: any, privateMarkers: string[]): any {
  expect(result.content).toEqual([{ type: "text", text: expect.any(String) }]);
  const parsed = JSON.parse(result.content[0].text);
  expectRecursivelyPrivate(parsed, privateMarkers);
  expectRecursivelyPrivate(result.details, privateMarkers);
  for (const marker of privateMarkers) expect(result.content[0].text).not.toContain(marker);
  return parsed;
}

async function executeStatus(target: Awaited<ReturnType<typeof harness>>): Promise<any> {
  return target.tools.get("context_vault_status")?.execute("call", {}, undefined, undefined, target.ctx);
}

describe("observation-only extension", () => {
  it("registers only Vault lifecycle surfaces and creates no repository state", async () => {
    const target = await harness({ reductionEnabled: false });
    expect([...target.handlers.keys()].sort()).toEqual(["context", "session_shutdown", "session_start", "tool_result"]);
    expect([...target.tools.keys()].sort()).toEqual([
      "context_vault_obs_get",
      "context_vault_obs_search",
      "context_vault_status",
    ]);
    expect([...target.commands.keys()]).toEqual(["context-vault"]);

    await target.handlers.get("session_start")?.({}, target.ctx);
    const projects = join(target.piRoot, "context-vault", "projects");
    const [projectId] = await readdir(projects);
    const stateRoot = join(projects, projectId as string);
    expect((await readdir(stateRoot)).sort()).toEqual(["artifacts", "metadata"]);
    await expect(stat(join(stateRoot, "repo-map"))).rejects.toMatchObject({ code: "ENOENT" });

    const status = await target.tools
      .get("context_vault_status")
      ?.execute("call", {}, undefined, undefined, target.ctx);
    expect(status.details.components).toEqual({ observations: expect.objectContaining({ available: true }) });
    expect(status.details).not.toHaveProperty("repoMap");
    expect(status.details.telemetry).not.toHaveProperty("repoMapQueryCount");
    await target.handlers.get("session_shutdown")?.({}, target.ctx);
  });

  it("keeps pre-start model status recursively private in content and details", async () => {
    const target = await harness();
    const result = await executeStatus(target);
    const parsed = expectModelStatusPrivate(result, ["private-home-marker", target.project, target.piRoot]);
    expect(parsed).toMatchObject({ initialized: false, degraded: false });
    expect(parsed).not.toHaveProperty("project");
    expect(parsed.components.observations).toEqual({ available: false });
  });

  it("keeps healthy model status recursively private in content and details", async () => {
    const target = await harness();
    await target.handlers.get("session_start")?.({}, target.ctx);
    const result = await executeStatus(target);
    const parsed = expectModelStatusPrivate(result, ["private-home-marker", target.project, target.piRoot]);
    expect(parsed.project).toEqual({ id: expect.any(String) });
    expect(parsed.storage).toEqual({
      available: true,
      enforcement: "manual-gc",
      artifactCount: 0,
      usedBytes: 0,
      targetBytes: 512 * 1024 * 1024,
      retentionDays: 30,
      overBudget: false,
    });
    expect(parsed.components.observations).toMatchObject({ available: true, degraded: false, failures: [] });
  });

  it("reports a manual GC target breach without deleting Observation evidence", async () => {
    const target = await harness({
      archivePolicy: "all",
      archiveMinBytes: 0,
      replacementThresholdBytes: 1,
      projectQuotaBytes: 32,
      retentionDays: 7,
    });
    await target.handlers.get("session_start")?.({}, target.ctx);
    await target.handlers.get("tool_result")?.(toolEvent("read", "quota evidence ".repeat(20)), target.ctx);

    const projects = join(target.piRoot, "context-vault", "projects");
    const [projectId] = await readdir(projects);
    const stateRoot = join(projects, projectId as string);
    const store = new ArtifactStore({
      artifactsRoot: join(stateRoot, "artifacts"),
      metadataRoot: join(stateRoot, "metadata"),
    });
    const [metadata] = await store.listMetadata();
    expect(metadata).toBeDefined();
    if (metadata === undefined) throw new Error("archived Observation metadata is missing");
    const evidenceBeforeStatus = await store.read(metadata.artifactId);

    const result = await executeStatus(target);
    const parsed = expectModelStatusPrivate(result, ["private-home-marker", target.project, target.piRoot]);
    expect(parsed).toMatchObject({ degraded: true, warnings: [PROJECT_QUOTA_EXCEEDED_WARNING] });
    expect(parsed.storage).toEqual({
      available: true,
      enforcement: "manual-gc",
      artifactCount: 1,
      usedBytes: Buffer.byteLength(evidenceBeforeStatus),
      targetBytes: 32,
      retentionDays: 7,
      overBudget: true,
    });
    await expect(store.read(metadata.artifactId)).resolves.toBe(evidenceBeforeStatus);

    await target.commands.get("context-vault")?.handler("status", target.ctx);
    const localStatus = JSON.parse(target.notifications.at(-1)?.text ?? "null");
    expect(target.notifications.at(-1)?.type).toBe("warning");
    expect(localStatus.storage).toEqual(parsed.storage);
  });

  it("keeps storage healthy at the exact manual GC target boundary", async () => {
    const evidence = "exact-quota-boundary-evidence";
    const targetBytes = Buffer.byteLength(evidence);
    const target = await harness({
      archivePolicy: "all",
      archiveMinBytes: 0,
      replacementThresholdBytes: 1,
      projectQuotaBytes: targetBytes,
    });
    await target.handlers.get("session_start")?.({}, target.ctx);
    await target.handlers.get("tool_result")?.(toolEvent("read", evidence), target.ctx);

    const result = await executeStatus(target);
    const parsed = expectModelStatusPrivate(result, ["private-home-marker", target.project, target.piRoot]);
    expect(parsed).toMatchObject({ degraded: false });
    expect(parsed.storage).toMatchObject({
      available: true,
      usedBytes: targetBytes,
      targetBytes,
      overBudget: false,
    });
    expect(parsed.warnings).not.toContain(PROJECT_QUOTA_EXCEEDED_WARNING);
  });

  it("keeps storage usage failures useful locally and private in model-visible status", async () => {
    const target = await harness();
    await target.handlers.get("session_start")?.({}, target.ctx);
    const rawFailure = `${target.piRoot}/private-storage-path-marker`;
    const publicWarning = "Context Vault artifact storage usage is unavailable.";
    vi.spyOn(ArtifactStore.prototype, "storageUsage").mockRejectedValue(new Error(rawFailure));

    await target.commands.get("context-vault")?.handler("status", target.ctx);
    const localStatus = JSON.parse(target.notifications.at(-1)?.text ?? "null");
    expect(target.notifications.at(-1)?.type).toBe("warning");
    expect(localStatus).toMatchObject({
      degraded: true,
      storage: { available: false, error: rawFailure },
      warnings: [publicWarning],
    });

    const result = await executeStatus(target);
    const parsed = expectModelStatusPrivate(result, [
      "private-home-marker",
      "private-storage-path-marker",
      rawFailure,
      target.project,
      target.piRoot,
    ]);
    expect(parsed).toMatchObject({
      degraded: true,
      storage: { available: false, error: publicWarning },
      warnings: [publicWarning],
    });
  });

  it("replaces initialization errors in model status while retaining raw local diagnostics", async () => {
    const target = await harness();
    const configPath = join(target.project, ".pi", "context-vault.json");
    await writeFile(configPath, "{");
    await target.handlers.get("session_start")?.({}, target.ctx);

    const result = await executeStatus(target);
    const parsed = expectModelStatusPrivate(result, ["private-home-marker", target.project, target.piRoot]);
    expect(parsed.components.observations).toEqual({
      available: false,
      error: "Context Vault initialization failed.",
    });
    expect(parsed.failures).toEqual([{ component: "initialization", error: "Context Vault initialization failed." }]);

    result.details.components.observations.error = "mutated model error";
    result.details.failures[0].component = "mutated-component";
    result.details.failures[0].error = "mutated model failure";
    await target.commands.get("context-vault")?.handler("status", target.ctx);
    const localStatus = JSON.parse(target.notifications.at(-1)?.text ?? "null");
    expect(localStatus.components.observations.error).toContain(configPath);
    expect(localStatus.failures[0].component).toBe("initialization");
    expect(localStatus.failures[0].error).toContain(configPath);
    const repeated = await executeStatus(target);
    expect(repeated.details.components.observations.error).toBe("Context Vault initialization failed.");
    expect(repeated.details.failures[0].error).toBe("Context Vault initialization failed.");
  });

  it("sanitizes degraded Observation failures and isolates model detail mutations", async () => {
    const target = await harness({ archivePolicy: "all", archiveMinBytes: 0 });
    await target.handlers.get("session_start")?.({}, target.ctx);
    const rawFailure = `${target.piRoot}/private-observation-error`;
    vi.spyOn(ArtifactStore.prototype, "archive").mockRejectedValueOnce(new Error(rawFailure));
    await target.handlers.get("tool_result")?.(toolEvent("bash"), target.ctx);

    const result = await executeStatus(target);
    const parsed = expectModelStatusPrivate(result, ["private-home-marker", target.project, target.piRoot, rawFailure]);
    expect(parsed.components.observations).toMatchObject({
      available: true,
      degraded: true,
      failures: [
        {
          observationId: expect.stringMatching(/^obs_[a-f0-9]{24}$/u),
          message: "Context Vault observation processing failed.",
        },
      ],
    });

    result.details.extension.id = "mutated-extension";
    result.details.project.id = "mutated-project";
    result.details.components.observations.failures[0].observationId = "mutated-observation";
    result.details.components.observations.failures[0].message = "mutated-message";
    result.details.components.observations.failures.push({ observationId: "extra", message: "extra" });
    result.details.warnings.push("mutated-warning");
    result.details.telemetry.archiveFailureCount = 999;

    const repeated = await executeStatus(target);
    expect(repeated.details.extension.id).toBe("context-vault");
    expect(repeated.details.project.id).not.toBe("mutated-project");
    expect(repeated.details.components.observations.failures).toEqual([
      {
        observationId: expect.stringMatching(/^obs_[a-f0-9]{24}$/u),
        message: "Context Vault observation processing failed.",
      },
    ]);
    expect(repeated.details.warnings).toEqual([]);
    expect(repeated.details.telemetry.archiveFailureCount).toBe(1);

    await target.commands.get("context-vault")?.handler("status", target.ctx);
    const localStatus = JSON.parse(target.notifications.at(-1)?.text ?? "null");
    expect(localStatus.extension.id).toBe("context-vault");
    expect(localStatus.project.id).not.toBe("mutated-project");
    expect(localStatus.warnings).toEqual([]);
    expect(localStatus.telemetry.archiveFailureCount).toBe(1);
    expect(localStatus.components.observations.failures).toEqual([
      { observationId: expect.stringMatching(/^obs_[a-f0-9]{24}$/u), message: rawFailure },
    ]);
  });

  it("advertises term search metadata and supports the returned search-to-get handoff", async () => {
    const target = await harness({ archivePolicy: "all", archiveMinBytes: 0, replacementThresholdBytes: 1 });
    const searchTool = target.tools.get("context_vault_obs_search");
    const getTool = target.tools.get("context_vault_obs_get");
    expect(searchTool?.description).toContain("ranks observations that match at least one");
    expect(searchTool?.description).toContain("code-identifier separators");
    expect(searchTool?.description).toContain("relevance score");
    expect(searchTool?.promptSnippet).toContain("Search archived observations");
    expect(getTool?.promptSnippet).toContain("observation or artifact ID");
    expect(searchTool?.promptGuidelines).toEqual([expect.stringContaining("context_vault_obs_search")]);
    expect(searchTool?.promptGuidelines?.[0]).toContain("context_vault_obs_get");
    expect(searchTool?.promptGuidelines?.[0]).toContain("nextAction.arguments.id");
    expect(searchTool?.promptGuidelines?.[0]).toContain("phrase mode is only for contiguous literal matching");
    expect(searchTool?.parameters.properties.matchMode).toMatchObject({ default: "terms" });
    expect(searchTool?.parameters.properties.matchMode.anyOf).toEqual([
      expect.objectContaining({ const: "terms" }),
      expect.objectContaining({ const: "phrase" }),
    ]);

    await target.handlers.get("session_start")?.({}, target.ctx);
    await target.handlers.get("tool_result")?.(
      toolEvent("bash", "parse_config appears here\nlegacy_api appears later"),
      target.ctx,
    );
    const searched = await searchTool?.execute(
      "search",
      { query: "legacy_api parse_config" },
      undefined,
      undefined,
      target.ctx,
    );
    expect(searched.isError).toBeUndefined();
    const hit = searched.details.results[0];
    expect(hit).toMatchObject({
      observationId: expect.stringMatching(/^obs_[a-f0-9]{24}$/u),
      score: 1,
      matchedTerms: ["legacy_api", "parse_config"],
    });
    expect(hit.nextAction).toEqual({
      tool: "context_vault_obs_get",
      arguments: { id: hit.observationId },
    });
    const fetched = await getTool?.execute("get", hit.nextAction.arguments, undefined, undefined, target.ctx);
    expect(fetched.isError).toBeUndefined();
    expect(fetched.details.evidence.text).toContain("parse_config");
    expect(fetched.details.evidence.text).toContain("legacy_api");
  });

  it("throws tool failures so the Pi agent runtime marks failed gets as errors", async () => {
    const target = await harness();
    await target.handlers.get("session_start")?.({}, target.ctx);
    const getTool = target.tools.get("context_vault_obs_get");
    if (!getTool) throw new Error("get tool was not registered");

    await expect(
      getTool.execute("direct-failure", { id: `obs_${"f".repeat(24)}` }, undefined, undefined, target.ctx),
    ).rejects.toThrow("Observation not found");

    const model = {
      id: "wrapped-runtime-test",
      name: "Wrapped runtime test",
      api: "openai-completions",
      provider: "openai",
      baseUrl: "http://127.0.0.1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 10_000,
      maxTokens: 1_000,
    };
    const modelRuntime = await ModelRuntime.create({
      authPath: join(target.root, "wrapped-auth.json"),
      modelsPath: null,
      refreshOnCreate: false,
    });
    await modelRuntime.setRuntimeApiKey(model.provider, "test-key");
    const { session } = await createAgentSession({
      cwd: target.project,
      agentDir: join(target.root, "wrapped-agent"),
      model: model as never,
      modelRuntime,
      noTools: "builtin",
      customTools: [getTool],
      sessionManager: SessionManager.inMemory(target.project),
    });
    const responses = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "wrapped-failure",
            name: "context_vault_obs_get",
            arguments: { id: `obs_${"f".repeat(24)}` },
          },
        ],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: Date.now(),
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      },
    ];
    session.agent.streamFunction = vi.fn(async () => {
      const response = responses.shift();
      if (!response) throw new Error("unexpected model turn");
      return {
        async *[Symbol.asyncIterator]() {},
        result: async () => response,
      } as never;
    });

    try {
      await session.prompt("retrieve missing evidence");
      const wrappedResult = session.messages.find(
        (message) => message.role === "toolResult" && message.toolCallId === "wrapped-failure",
      );
      expect(wrappedResult).toMatchObject({
        role: "toolResult",
        toolName: "context_vault_obs_get",
        isError: true,
        content: [{ type: "text", text: expect.stringContaining("Observation not found") }],
      });
    } finally {
      session.dispose();
    }
  });

  it("ignores all legacy repository keys of arbitrary types and reports one fixed warning", async () => {
    const target = await harness({
      repoMapEnabled: "not-a-boolean",
      mapInjectionMode: { arbitrary: true },
      mapContextMaxBytes: null,
      mapDebounceMs: [],
      mapGenerationRetention: -1,
      mapQuotaBytes: "large",
      mapExcludePatterns: 42,
      debugRequestFingerprints: { enabled: true },
    });
    await target.handlers.get("session_start")?.({}, target.ctx);
    const result = await target.tools
      .get("context_vault_status")
      ?.execute("call", {}, undefined, undefined, target.ctx);
    expect(result.details.initialized).toBe(true);
    expect(result.details.warnings).toEqual([LEGACY_REPO_CONFIG_WARNING]);
    expect(JSON.stringify(result.details).match(new RegExp(LEGACY_REPO_CONFIG_WARNING, "gu"))).toHaveLength(1);

    await target.commands.get("context-vault")?.handler("doctor", target.ctx);
    const report = JSON.parse(target.notifications.at(-1)?.text ?? "null");
    expect(report.warnings).toEqual([LEGACY_REPO_CONFIG_WARNING]);
    expect(JSON.stringify(report).match(new RegExp(LEGACY_REPO_CONFIG_WARNING, "gu"))).toHaveLength(1);
  });

  it("does not archive either plugin namespace and still archives eligible external results", async () => {
    const target = await harness({ archivePolicy: "all", archiveMinBytes: 0, replacementThresholdBytes: 1 });
    await target.handlers.get("session_start")?.({}, target.ctx);
    await expect(
      target.handlers.get("tool_result")?.(toolEvent("context_vault_status"), target.ctx),
    ).resolves.toBeUndefined();
    await expect(
      target.handlers.get("tool_result")?.(toolEvent("repo_context_search"), target.ctx),
    ).resolves.toBeUndefined();
    const external = await target.handlers.get("tool_result")?.(toolEvent("bash", "external evidence"), target.ctx);
    expect(external?.content[0]?.text).toContain("context_vault_observation_receipt");
    const status = await target.tools
      .get("context_vault_status")
      ?.execute("call", {}, undefined, undefined, target.ctx);
    expect(status.details.telemetry.archiveAttemptCount).toBe(1);
  });

  it("runs only context reduction and respects reductionEnabled", async () => {
    const reductionFactory = vi.fn(async (input: any) => ({
      messages: input.messages,
      triggered: false,
      reducedCount: 0,
      estimatedTokensBefore: 10,
      estimatedTokensAfter: 10,
      targetReached: true,
    }));
    const enabled = await harness({}, { reductionFactory: reductionFactory as never });
    await enabled.handlers.get("session_start")?.({}, enabled.ctx);
    const messages = [{ role: "user", content: "hello", timestamp: 1 }];
    await enabled.handlers.get("context")?.({ messages }, enabled.ctx);
    expect(reductionFactory).toHaveBeenCalledOnce();

    const disabledFactory = vi.fn();
    const disabled = await harness({ reductionEnabled: false }, { reductionFactory: disabledFactory as never });
    await disabled.handlers.get("session_start")?.({}, disabled.ctx);
    await disabled.handlers.get("context")?.({ messages }, disabled.ctx);
    expect(disabledFactory).not.toHaveBeenCalled();
  });

  it("keeps rebuild inert and Vault GC cannot touch legacy or Repo Context state", async () => {
    const target = await harness({ projectQuotaBytes: 1024 * 1024, retentionDays: 30 });
    await target.handlers.get("session_start")?.({}, target.ctx);
    const projects = join(target.piRoot, "context-vault", "projects");
    const [projectId] = await readdir(projects);
    const legacyRoot = join(projects, projectId as string, "repo-map");
    const repoRoot = join(target.piRoot, "pi-repo-context", "projects", projectId as string, "repo-map");
    await mkdir(legacyRoot, { recursive: true });
    await mkdir(repoRoot, { recursive: true });
    await writeFile(join(legacyRoot, "sentinel"), "legacy-bytes");
    await writeFile(join(repoRoot, "sentinel"), "repo-bytes");

    const beforeRebuild = await digestTree(target.piRoot);
    await target.commands.get("context-vault")?.handler("rebuild", target.ctx);
    expect(target.notifications.at(-1)).toEqual({ text: REBUILD_MIGRATION_MESSAGE, type: "warning" });
    expect(await digestTree(target.piRoot)).toBe(beforeRebuild);

    await target.commands.get("context-vault")?.handler("gc", target.ctx);
    expect(await readFile(join(legacyRoot, "sentinel"), "utf8")).toBe("legacy-bytes");
    expect(await readFile(join(repoRoot, "sentinel"), "utf8")).toBe("repo-bytes");
    expect(target.notifications.at(-1)?.text).toContain('"artifacts"');
  });

  it("protects explicit receipts from all entries and the current branch during extension GC", async () => {
    const target = await harness({ retentionDays: 1, projectQuotaBytes: 1 });
    await target.handlers.get("session_start")?.({}, target.ctx);
    const projects = join(target.piRoot, "context-vault", "projects");
    const [projectId] = await readdir(projects);
    const stateRoot = join(projects, projectId as string);
    const oldStore = new ArtifactStore({
      artifactsRoot: join(stateRoot, "artifacts"),
      metadataRoot: join(stateRoot, "metadata"),
      now: () => new Date("2020-01-01T00:00:00.000Z"),
    });
    const fromEntries = await oldStore.archive({
      observationId: "from-all-entries",
      toolName: "read",
      sessionId: "old-session",
      content: "all-entry evidence",
    });
    const fromBranch = await oldStore.archive({
      observationId: "from-current-branch",
      toolName: "read",
      sessionId: "old-session",
      content: "branch evidence",
    });
    const unreferenced = await oldStore.archive({
      observationId: "unreferenced",
      toolName: "read",
      sessionId: "old-session",
      content: "delete this evidence",
    });
    const receipt = (artifactId: string) => ({
      type: "context_vault_observation_receipt",
      evidence: { artifactId },
    });
    (target.ctx.sessionManager as any).getEntries = () => [{ message: receipt(fromEntries.artifactId) }];
    (target.ctx.sessionManager as any).getBranch = () => [{ message: receipt(fromBranch.artifactId) }];

    await target.commands.get("context-vault")?.handler("gc", target.ctx);
    await expect(oldStore.read(fromEntries.artifactId)).resolves.toBe("all-entry evidence");
    await expect(oldStore.read(fromBranch.artifactId)).resolves.toBe("branch evidence");
    await expect(oldStore.read(unreferenced.artifactId)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("aborts GC before deletion when an explicit receipt source is unreadable", async () => {
    const target = await harness({ retentionDays: 1, projectQuotaBytes: 1 });
    await target.handlers.get("session_start")?.({}, target.ctx);
    const projects = join(target.piRoot, "context-vault", "projects");
    const [projectId] = await readdir(projects);
    const stateRoot = join(projects, projectId as string);
    const oldStore = new ArtifactStore({
      artifactsRoot: join(stateRoot, "artifacts"),
      metadataRoot: join(stateRoot, "metadata"),
      now: () => new Date("2020-01-01T00:00:00.000Z"),
    });
    const survivor = await oldStore.archive({
      observationId: "receipt-source-failure",
      toolName: "read",
      sessionId: "old-session",
      content: "must remain after source failure",
    });
    (target.ctx.sessionManager as any).getEntries = () => {
      throw new Error("entry tree unreadable");
    };
    await target.commands.get("context-vault")?.handler("gc", target.ctx);
    expect(target.notifications.at(-1)).toEqual({ text: "gc failed: entry tree unreadable", type: "error" });
    await expect(oldStore.read(survivor.artifactId)).resolves.toBe("must remain after source failure");
  });

  it("releases only its exact lease and clears only the Context Vault UI key on shutdown", async () => {
    const target = await harness();
    await target.handlers.get("session_start")?.({}, target.ctx);
    const projects = join(target.piRoot, "context-vault", "projects");
    const [projectId] = await readdir(projects);
    const stateRoot = join(projects, projectId as string);
    const other = new ArtifactStore({
      artifactsRoot: join(stateRoot, "artifacts"),
      metadataRoot: join(stateRoot, "metadata"),
    });
    const otherLease = await other.registerActiveSession("session-one");
    await target.handlers.get("session_shutdown")?.({}, target.ctx);
    const registry = JSON.parse(await readFile(join(stateRoot, "metadata", "active-sessions.json"), "utf8"));
    expect(registry.leases).toHaveLength(1);
    expect(registry.leases[0].ownerId).toBe(otherLease.ownerId);
    expect(target.statuses.every((row) => row.key === "context-vault")).toBe(true);
    expect(target.statuses.at(-1)).toEqual({ key: "context-vault", value: undefined });
    await other.releaseActiveSession(otherLease);
  });

  it("fails closed on state-root symlinks and reports degraded status without mutating Repo roots", async () => {
    const target = await harness();
    const projectRoot = await realpath(target.project);
    const projectId = createHash("sha256").update(projectRoot).digest("hex").slice(0, 32);
    const stateRoot = join(target.piRoot, "context-vault", "projects", projectId);
    const legacyRoot = join(stateRoot, "repo-map");
    const repoRoot = join(target.piRoot, "pi-repo-context", "projects", projectId, "repo-map");
    await mkdir(legacyRoot, { recursive: true });
    await mkdir(repoRoot, { recursive: true });
    await writeFile(join(legacyRoot, "sentinel"), "legacy-safe");
    await writeFile(join(repoRoot, "sentinel"), "repo-safe");
    if (!(await createDirectorySymlink(legacyRoot, join(stateRoot, "artifacts")))) return;
    if (!(await createDirectorySymlink(repoRoot, join(stateRoot, "metadata")))) return;

    await target.handlers.get("session_start")?.({}, target.ctx);
    const status = await target.tools
      .get("context_vault_status")
      ?.execute("call", {}, undefined, undefined, target.ctx);
    expect(status.details.degraded).toBe(true);
    expect(status.details.components.observations.available).toBe(false);
    await expect(
      target.handlers.get("tool_result")?.(toolEvent("bash", "original result"), target.ctx),
    ).resolves.toBeUndefined();
    await target.commands.get("context-vault")?.handler("doctor", target.ctx);
    expect(JSON.parse(target.notifications.at(-1)?.text ?? "null").status).toBe("degraded");
    await expect(target.handlers.get("session_shutdown")?.({}, target.ctx)).resolves.toBeUndefined();
    expect(await readFile(join(legacyRoot, "sentinel"), "utf8")).toBe("legacy-safe");
    expect(await readFile(join(repoRoot, "sentinel"), "utf8")).toBe("repo-safe");
  });

  it("rejects symlinked product namespace components during startup without changing Repo Context targets", async () => {
    for (const component of ["context-vault", "projects"] as const) {
      const target = await harness();
      const repoTarget = join(
        target.piRoot,
        "pi-repo-context",
        "projects",
        `startup-redirect-${component}`,
        "repo-map",
      );
      await mkdir(join(repoTarget, "nested"), { recursive: true });
      await writeFile(join(repoTarget, "sentinel"), `${component}-startup-safe`);
      await writeFile(join(repoTarget, "nested", "evidence"), `${component}-startup-nested-safe`);
      const before = await digestTree(repoTarget);
      const owned =
        component === "context-vault"
          ? join(target.piRoot, "context-vault")
          : join(target.piRoot, "context-vault", "projects");
      if (component === "projects") await mkdir(join(target.piRoot, "context-vault"));
      if (!(await createDirectorySymlink(repoTarget, owned))) return;

      await target.handlers.get("session_start")?.({}, target.ctx);
      const status = await target.tools
        .get("context_vault_status")
        ?.execute("call", {}, undefined, undefined, target.ctx);
      expect(status.details.initialized).toBe(false);
      expect(status.details.degraded).toBe(true);
      expect(status.details.components.observations.available).toBe(false);
      await expect(target.handlers.get("session_shutdown")?.({}, target.ctx)).resolves.toBeUndefined();
      expect(await digestTree(repoTarget)).toBe(before);
      expect(await readFile(join(repoTarget, "sentinel"), "utf8")).toBe(`${component}-startup-safe`);
    }
  });

  it("keeps config initialization failure degraded and cannot mutate seeded repository roots", async () => {
    const target = await harness({ unknownVaultOption: true });
    const projectRoot = await realpath(target.project);
    const projectId = createHash("sha256").update(projectRoot).digest("hex").slice(0, 32);
    const legacyRoot = join(target.piRoot, "context-vault", "projects", projectId, "repo-map");
    const repoRoot = join(target.piRoot, "pi-repo-context", "projects", projectId, "repo-map");
    await mkdir(legacyRoot, { recursive: true });
    await mkdir(repoRoot, { recursive: true });
    await writeFile(join(legacyRoot, "sentinel"), "legacy-config-safe");
    await writeFile(join(repoRoot, "sentinel"), "repo-config-safe");

    await target.handlers.get("session_start")?.({}, target.ctx);
    const status = await target.tools
      .get("context_vault_status")
      ?.execute("call", {}, undefined, undefined, target.ctx);
    expect(status.details.initialized).toBe(false);
    expect(status.details.degraded).toBe(true);
    expect(status.details.components.observations.available).toBe(false);
    await expect(
      target.handlers.get("tool_result")?.(toolEvent("bash", "original result"), target.ctx),
    ).resolves.toBeUndefined();
    await target.commands.get("context-vault")?.handler("doctor", target.ctx);
    expect(JSON.parse(target.notifications.at(-1)?.text ?? "null").status).toBe("degraded");
    await expect(target.handlers.get("session_shutdown")?.({}, target.ctx)).resolves.toBeUndefined();
    expect(await readFile(join(legacyRoot, "sentinel"), "utf8")).toBe("legacy-config-safe");
    expect(await readFile(join(repoRoot, "sentinel"), "utf8")).toBe("repo-config-safe");
  });

  it("preserves preexisting Observation artifact and metadata across lifecycle and failed initialization", async () => {
    const target = await harness();
    const state = await resolveProjectState(target.project, { PI_CODING_AGENT_DIR: target.piRoot });
    const store = new ArtifactStore({ artifactsRoot: state.artifactsRoot, metadataRoot: state.metadataRoot });
    const observationId = `obs_${"a".repeat(24)}`;
    const evidence = "preexisting observation evidence must remain unchanged";
    const archived = await store.archive({
      observationId,
      toolName: "read",
      sessionId: "preexisting-session",
      content: evidence,
    });
    const artifactPath = join(state.artifactsRoot, archived.artifactId.slice(0, 2), `${archived.artifactId}.txt`);
    const metadataPath = join(state.metadataRoot, "observations.jsonl");
    const originalArtifact = await readFile(artifactPath);
    const originalMetadata = await readFile(metadataPath);
    const expectUnchanged = async () => {
      expect(await readFile(artifactPath)).toEqual(originalArtifact);
      expect(await readFile(metadataPath)).toEqual(originalMetadata);
      await expect(store.read(archived.artifactId)).resolves.toBe(evidence);
    };
    const expectToolReadable = async () => {
      const result = await target.tools
        .get("context_vault_obs_get")
        ?.execute("call", { id: observationId }, undefined, undefined, target.ctx);
      expect(result.isError).not.toBe(true);
      expect(result.details.evidence.text).toBe(evidence);
    };

    await target.handlers.get("session_start")?.({}, target.ctx);
    await expectToolReadable();
    await expectUnchanged();
    await target.commands.get("context-vault")?.handler("rebuild", target.ctx);
    expect(target.notifications.at(-1)?.text).toBe(REBUILD_MIGRATION_MESSAGE);
    await expectUnchanged();
    await target.handlers.get("session_shutdown")?.({}, target.ctx);
    await expectUnchanged();

    await writeFile(join(target.project, ".pi", "context-vault.json"), JSON.stringify({ unknownVaultOption: true }));
    await target.handlers.get("session_start")?.({}, target.ctx);
    const degraded = await target.tools
      .get("context_vault_status")
      ?.execute("call", {}, undefined, undefined, target.ctx);
    expect(degraded.details.initialized).toBe(false);
    expect(degraded.details.degraded).toBe(true);
    await expectUnchanged();

    await writeFile(join(target.project, ".pi", "context-vault.json"), "{}");
    await target.handlers.get("session_start")?.({}, target.ctx);
    await expectToolReadable();
    await target.handlers.get("session_shutdown")?.({}, target.ctx);
    await expectUnchanged();
  });

  it("reports healthy status and doctor results for a normal Vault startup", async () => {
    const target = await harness();
    await target.handlers.get("session_start")?.({}, target.ctx);
    await target.commands.get("context-vault")?.handler("status", target.ctx);
    expect(JSON.parse(target.notifications.at(-1)?.text ?? "null").degraded).toBe(false);
    expect(target.notifications.at(-1)?.type).toBe("info");
    await target.commands.get("context-vault")?.handler("doctor", target.ctx);
    expect(JSON.parse(target.notifications.at(-1)?.text ?? "null").status).toBe("healthy");
    expect(target.notifications.at(-1)?.type).toBe("info");
  });

  it("retains raw paths and failures in local status, doctor, status-json, and shutdown telemetry", async () => {
    const target = await harness({ archivePolicy: "all", archiveMinBytes: 0 });
    await target.handlers.get("session_start")?.({}, target.ctx);
    const rawFailure = `${target.piRoot}/operator-observation-error`;
    const archive = vi.spyOn(ArtifactStore.prototype, "archive").mockRejectedValueOnce(new Error(rawFailure));
    await target.handlers.get("tool_result")?.(toolEvent("bash"), target.ctx);

    await target.commands.get("context-vault")?.handler("status", target.ctx);
    const localStatus = JSON.parse(target.notifications.at(-1)?.text ?? "null");
    expect(localStatus.project.root).toBe(target.project);
    expect(localStatus.project.stateRoot).toContain(target.piRoot);
    expect(localStatus.components.observations.projectRoot).toBe(target.project);
    expect(localStatus.components.observations.failures[0].message).toBe(rawFailure);

    await target.commands.get("context-vault")?.handler("doctor", target.ctx);
    const doctor = JSON.parse(target.notifications.at(-1)?.text ?? "null");
    expect(doctor.project.root).toBe(target.project);
    expect(doctor.project.stateRoot).toContain(target.piRoot);
    expect(doctor.components.observations.failures[0].message).toBe(rawFailure);

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const headless = { ...target.ctx, hasUI: false };
    await target.commands.get("context-vault")?.handler("status-json", headless);
    const statusJson = extractTelemetryFrame(String(log.mock.calls[0]?.[0])) as any;
    expect(statusJson.project.root).toBe(target.project);
    expect(statusJson.project.stateRoot).toContain(target.piRoot);
    expect(statusJson.components.observations.failures[0].message).toBe(rawFailure);

    const shutdownTarget = await harness({ archivePolicy: "all", archiveMinBytes: 0 });
    const shutdownHeadless = { ...shutdownTarget.ctx, hasUI: false };
    await shutdownTarget.handlers.get("session_start")?.({}, shutdownHeadless);
    const shutdownFailure = `${shutdownTarget.piRoot}/shutdown-observation-error`;
    archive.mockRejectedValueOnce(new Error(shutdownFailure));
    await shutdownTarget.handlers.get("tool_result")?.(toolEvent("bash"), shutdownHeadless);
    log.mockClear();
    await shutdownTarget.handlers.get("session_shutdown")?.({}, shutdownHeadless);
    expect(log.mock.calls).toHaveLength(1);
    const shutdownFrame = extractTelemetryFrame(String(log.mock.calls[0]?.[0])) as any;
    expect(shutdownFrame.project.root).toBe(shutdownTarget.project);
    expect(shutdownFrame.project.stateRoot).toContain(shutdownTarget.piRoot);
    expect(shutdownFrame.components.observations.failures[0].message).toBe(shutdownFailure);
  });
});
