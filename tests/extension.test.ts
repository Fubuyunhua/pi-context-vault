// biome-ignore-all lint/suspicious/noExplicitAny: heterogeneous Pi callback capture is isolated to this test harness.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "../src/artifacts/store.js";
import { REBUILD_MIGRATION_MESSAGE, type RegisterContextVaultOptions, registerContextVault } from "../src/extension.js";
import { LEGACY_REPO_CONFIG_WARNING } from "../src/state/config.js";
import { resolveProjectState } from "../src/state/project-state.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface CapturedTool {
  name: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: any;
  execute: (...args: any[]) => Promise<any>;
}

async function harness(config: Record<string, unknown> = {}, options: RegisterContextVaultOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "context-vault-extension-"));
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

  it("advertises term search metadata and supports the returned search-to-get handoff", async () => {
    const target = await harness({ archivePolicy: "all", archiveMinBytes: 0, replacementThresholdBytes: 1 });
    const searchTool = target.tools.get("context_vault_obs_search");
    const getTool = target.tools.get("context_vault_obs_get");
    expect(searchTool?.description).toContain("whitespace-separated literal terms");
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
    expect(hit.observationId).toMatch(/^obs_[a-f0-9]{24}$/u);
    expect(hit.nextAction).toEqual({
      tool: "context_vault_obs_get",
      arguments: { id: hit.observationId },
    });
    const fetched = await getTool?.execute("get", hit.nextAction.arguments, undefined, undefined, target.ctx);
    expect(fetched.isError).toBeUndefined();
    expect(fetched.details.evidence.text).toContain("parse_config");
    expect(fetched.details.evidence.text).toContain("legacy_api");
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

  it("emits one Vault-only telemetry frame in headless status-json/shutdown", async () => {
    const target = await harness();
    const headless = { ...target.ctx, hasUI: false };
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await target.handlers.get("session_start")?.({}, headless);
    await target.commands.get("context-vault")?.handler("status-json", headless);
    await target.handlers.get("session_shutdown")?.({}, headless);
    const frames = log.mock.calls.flat().filter((value) => String(value).includes("@@CONTEXT_VAULT_TELEMETRY_V1@@"));
    expect(frames).toHaveLength(1);
    expect(String(frames[0])).not.toContain("repoMap");
  });
});
