import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerContextVault } from "../src/extension.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function gatedHarness(config: Record<string, unknown>, options: Parameters<typeof registerContextVault>[1] = {}) {
  const root = await mkdtemp(join(tmpdir(), "extension-gates-"));
  roots.push(root);
  const project = join(root, "project");
  await mkdir(join(project, ".pi"), { recursive: true });
  await writeFile(join(project, ".pi", "context-vault.json"), JSON.stringify(config));
  const handlers = new Map<string, (...args: never[]) => unknown>();
  const tools: string[] = [];
  const commands = new Map<string, { handler: (...args: never[]) => unknown }>();
  const pi = {
    on: (event: string, handler: (...args: never[]) => unknown) => handlers.set(event, handler),
    registerTool: (tool: { name: string }) => tools.push(tool.name),
    registerCommand: (name: string, command: { handler: (...args: never[]) => unknown }) => commands.set(name, command),
  };
  registerContextVault(pi as never, { env: { PI_CODING_AGENT_DIR: join(root, "pi") }, ...options });
  const ctx = {
    cwd: project,
    hasUI: false,
    sessionManager: { getSessionId: () => "session", getEntries: () => [], getBranch: () => [] },
    model: { contextWindow: 10_000 },
    getSystemPrompt: () => "system",
  };
  return { handlers, tools, commands, ctx, root };
}

describe("component isolation gates", () => {
  it("does not construct/start/watch/build or register an available map tool when disabled", async () => {
    const repoMapRuntimeFactory = vi.fn(() => {
      throw new Error("must not construct");
    });
    const harness = await gatedHarness({ repoMapEnabled: false }, { repoMapRuntimeFactory });
    expect(harness.tools).not.toContain("context_vault_repo_map");
    await harness.handlers.get("session_start")?.({} as never, harness.ctx as never);
    await harness.handlers.get("before_agent_start")?.({} as never, harness.ctx as never);
    await harness.handlers.get("context")?.({ messages: [] } as never, harness.ctx as never);
    expect(repoMapRuntimeFactory).not.toHaveBeenCalled();
    expect(harness.tools).not.toContain("context_vault_repo_map");
    const projects = join(harness.root, "pi", "context-vault", "projects");
    const [projectId] = await readdir(projects);
    await expect(stat(join(projects, projectId as string, "repo-map"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("does not invoke reduction when disabled", async () => {
    const reductionFactory = vi.fn(async () => {
      throw new Error("must not reduce");
    });
    const runtime = {
      start: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      ensureFresh: vi.fn(async () => undefined),
      rebuild: vi.fn(async () => undefined),
      query: vi.fn(),
      status: vi.fn(() => ({ freshness: "fresh" })),
    };
    const harness = await gatedHarness(
      { repoMapEnabled: false, reductionEnabled: false },
      { repoMapRuntimeFactory: () => runtime as never, reductionFactory: reductionFactory as never },
    );
    await harness.handlers.get("session_start")?.({} as never, harness.ctx as never);
    const messages = [{ role: "user", content: "hello", timestamp: 1 }];
    await expect(
      harness.handlers.get("context")?.({ messages } as never, harness.ctx as never),
    ).resolves.toBeUndefined();
    expect(reductionFactory).not.toHaveBeenCalled();
  });
  it("registers the map tool only after an enabled map starts successfully", async () => {
    const runtime = {
      start: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      ensureFresh: vi.fn(async () => undefined),
      rebuild: vi.fn(async () => undefined),
      query: vi.fn(),
      status: vi.fn(() => ({ freshness: "fresh" })),
    };
    const harness = await gatedHarness(
      { repoMapEnabled: true, reductionEnabled: false },
      { repoMapRuntimeFactory: () => runtime as never },
    );
    expect(harness.tools).not.toContain("context_vault_repo_map");
    await harness.handlers.get("session_start")?.({} as never, harness.ctx as never);
    expect(runtime.start).toHaveBeenCalledOnce();
    expect(harness.tools).toContain("context_vault_repo_map");
  });
  it("fails a later session whose config disables an already registered map tool", async () => {
    const runtime = {
      start: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      ensureFresh: vi.fn(async () => undefined),
      rebuild: vi.fn(async () => undefined),
      query: vi.fn(),
      status: vi.fn(() => ({ freshness: "fresh" })),
    };
    const harness = await gatedHarness({ repoMapEnabled: true }, { repoMapRuntimeFactory: () => runtime as never });
    await harness.handlers.get("session_start")?.({} as never, harness.ctx as never);
    await writeFile(join(harness.ctx.cwd, ".pi", "context-vault.json"), JSON.stringify({ repoMapEnabled: false }));
    await expect(harness.handlers.get("session_start")?.({} as never, harness.ctx as never)).rejects.toThrow(
      "session-config-drift",
    );
  });
  it("emits exactly one telemetry frame when status-json precedes headless shutdown", async () => {
    const harness = await gatedHarness({ repoMapEnabled: false });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await harness.handlers.get("session_start")?.({} as never, harness.ctx as never);
    await harness.commands.get("context-vault")?.handler("status-json" as never, harness.ctx as never);
    await harness.handlers.get("session_shutdown")?.({} as never, harness.ctx as never);
    expect(
      log.mock.calls.flat().filter((value) => String(value).includes("@@CONTEXT_VAULT_TELEMETRY_V1@@")),
    ).toHaveLength(1);
    log.mockRestore();
  });
});
