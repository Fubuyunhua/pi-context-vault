import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EXTENSION_ID, EXTENSION_VERSION, registerContextVault } from "../src/extension.js";

type Handler = (...args: unknown[]) => unknown;
type ToolResult = { content: Array<{ text: string }>; isError?: boolean };
type Tool = { name: string; execute: (...args: unknown[]) => Promise<unknown> };
type Command = { handler: (args: string, ctx: unknown) => Promise<void> };
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function harness(
  options: Parameters<typeof registerContextVault>[1] = {},
  projectConfig?: Record<string, unknown>,
) {
  const root = await mkdtemp(join(tmpdir(), "context-vault-extension-"));
  const project = join(root, "project");
  await mkdir(project);
  if (projectConfig) {
    await mkdir(join(project, ".pi"));
    await writeFile(join(project, ".pi", "context-vault.json"), JSON.stringify(projectConfig));
  }
  roots.push(root);
  const handlers = new Map<string, Handler>();
  const tools = new Map<string, Tool>();
  const commands = new Map<string, Command>();
  const pi = {
    on: vi.fn((event: string, handler: Handler) => handlers.set(event, handler)),
    registerTool: vi.fn((tool: Tool) => tools.set(tool.name, tool)),
    registerCommand: vi.fn((name: string, command: Command) => commands.set(name, command)),
  };
  registerContextVault(pi as never, { env: { PI_CODING_AGENT_DIR: join(root, "pi") }, ...options });
  const setStatus = vi.fn();
  const notify = vi.fn();
  const ctx = {
    cwd: project,
    hasUI: true,
    ui: { setStatus, notify },
    sessionManager: { getSessionId: () => "session-1" },
    model: { contextWindow: 12_000 },
    getSystemPrompt: () => "system contract",
  };
  return { handlers, tools, commands, pi, ctx, setStatus, notify, project };
}

describe("extension observation adapter", () => {
  it("registers lifecycle hooks and bounded retrieval tools", async () => {
    const { handlers, tools, pi, ctx, setStatus } = await harness();
    expect(pi.on).toHaveBeenCalledTimes(5);
    expect([...tools.keys()]).toEqual([
      "context_vault_obs_get",
      "context_vault_obs_search",
      "context_vault_repo_map",
      "context_vault_status",
    ]);
    expect(pi.registerCommand).toHaveBeenCalledWith("context-vault", expect.any(Object));

    await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
    expect(setStatus).toHaveBeenCalledWith(EXTENSION_ID, `vault v${EXTENSION_VERSION}`);

    const original = "needle\n".repeat(4_000);
    const transformed = (await handlers.get("tool_result")?.({
      type: "tool_result",
      toolCallId: "call-1",
      toolName: "bash",
      input: {},
      content: [{ type: "text", text: original }],
      details: undefined,
      isError: false,
    })) as ToolResult;
    expect(Buffer.byteLength(transformed.content[0].text)).toBeLessThanOrEqual(4 * 1024);
    const receipt = JSON.parse(transformed.content[0].text);

    const getResult = (await tools
      .get("context_vault_obs_get")
      ?.execute("get-1", { id: receipt.id, limit: 100 })) as ToolResult;
    expect(JSON.parse(getResult.content[0].text).evidence.text).toContain("needle");
    const searchResult = (await tools
      .get("context_vault_obs_search")
      ?.execute("search-1", { query: "needle", limit: 2 })) as ToolResult;
    expect(JSON.parse(searchResult.content[0].text).results).toHaveLength(1);
    const mapResult = (await tools
      .get("context_vault_repo_map")
      ?.execute("map-1", { query: "project", limit: 3 })) as ToolResult;
    expect(JSON.parse(mapResult.content[0].text)).toMatchObject({
      freshness: expect.stringMatching(/^(fresh|dirty|unsupported)$/),
      workspaceRevision: expect.any(String),
      fallbackEvidence: [],
    });

    await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);
    expect(setStatus).toHaveBeenLastCalledWith(EXTENSION_ID, undefined);
    const status = (await tools.get("context_vault_status")?.execute("status-1", {})) as ToolResult;
    expect(JSON.parse(status.content[0].text)).toMatchObject({ initialized: false, degraded: false });
  });

  it("archives small results without replacing them and ignores non-text and its own tools", async () => {
    const { handlers, ctx } = await harness();
    await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
    const small = await handlers.get("tool_result")?.({
      type: "tool_result",
      toolCallId: "small",
      toolName: "read",
      input: {},
      content: [{ type: "text", text: "small evidence" }],
      isError: false,
    });
    expect(small).toBeUndefined();
    expect(
      await handlers.get("tool_result")?.({
        type: "tool_result",
        toolCallId: "image",
        toolName: "read",
        input: {},
        content: [{ type: "image", data: "abc", mimeType: "image/png" }],
        isError: false,
      }),
    ).toBeUndefined();
    expect(
      await handlers.get("tool_result")?.({
        type: "tool_result",
        toolCallId: "self",
        toolName: "context_vault_obs_get",
        input: {},
        content: [{ type: "text", text: "self result" }],
        isError: false,
      }),
    ).toBeUndefined();
  });

  it("stays inert before initialization and preserves image blocks when replacing text", async () => {
    const { handlers, ctx, setStatus } = await harness();
    const event = {
      type: "tool_result",
      toolCallId: "mixed",
      toolName: "bash",
      input: {},
      content: [
        { type: "text", text: "large\n".repeat(4_000) },
        { type: "image", data: "abc", mimeType: "image/png" },
      ],
      isError: false,
    };
    expect(await handlers.get("tool_result")?.(event)).toBeUndefined();

    const headless = { ...ctx, hasUI: false };
    await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, headless);
    const transformed = (await handlers.get("tool_result")?.(event)) as { content: Array<{ type: string }> };
    expect(transformed.content.map((block) => block.type)).toEqual(["text", "image"]);
    await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, headless);
    expect(setStatus).not.toHaveBeenCalled();
  });

  it("reduces archived old results through the context hook without persisting a capsule", async () => {
    const { handlers, ctx } = await harness();
    const narrowContext = { ...ctx, model: { contextWindow: 35_000 } };
    await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, narrowContext);
    const messages: Array<Record<string, unknown>> = [
      { role: "user", content: "CONSTRAINT: preserve chronology", timestamp: 0 },
    ];
    for (let index = 0; index < 20; index += 1) {
      const text = `${index}:`.padEnd(8_000, "x");
      await handlers.get("tool_result")?.({
        type: "tool_result",
        toolCallId: `context-call-${index}`,
        toolName: "read",
        input: {},
        content: [{ type: "text", text }],
        isError: false,
      });
      messages.push({
        role: "assistant",
        content: [{ type: "toolCall", id: `context-call-${index}`, name: "read", arguments: {} }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "test",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {} },
        stopReason: "toolUse",
        timestamp: index * 2 + 1,
      });
      messages.push({
        role: "toolResult",
        toolCallId: `context-call-${index}`,
        toolName: "read",
        content: [{ type: "text", text }],
        isError: false,
        timestamp: index * 2 + 2,
      });
    }

    const transformed = (await handlers.get("context")?.({ type: "context", messages }, narrowContext)) as {
      messages: Array<Record<string, unknown>>;
    };
    expect(transformed.messages).toHaveLength(messages.length + 1);
    expect(transformed.messages[0]).toMatchObject({
      role: "custom",
      customType: "context-vault-repo-map",
      display: false,
    });
    expect(Buffer.byteLength(String(transformed.messages[0]?.content))).toBeLessThanOrEqual(6 * 1024);
    expect(transformed.messages[1]).toEqual(messages[0]);
    expect(JSON.stringify(transformed.messages)).toContain("context_vault_observation_receipt");
    expect(JSON.stringify(transformed.messages.slice(-12))).not.toContain("context_vault_observation_receipt");

    const repeated = (await handlers.get("context")?.(
      { type: "context", messages: transformed.messages },
      narrowContext,
    )) as { messages: Array<Record<string, unknown>> };
    expect(repeated.messages.filter((message) => message.customType === "context-vault-repo-map")).toHaveLength(1);
  }, 15_000);

  it("keeps repository-map capsules ephemeral, bounded, revisioned, and honest when stale", async () => {
    const close = vi.fn(async () => undefined);
    const runtime = {
      start: vi.fn(async () => undefined),
      close,
      ensureFresh: vi.fn(async () => undefined),
      rebuild: vi.fn(async () => undefined),
      status: vi.fn(() => ({
        freshness: "stale" as const,
        generation: 7,
        gitHead: "abc123",
        workspaceRevision: "revision-7",
        pendingFiles: ["src/auth.ts"],
        dirtyFiles: ["src/auth.ts"],
        error: "index activation failed",
      })),
      query: vi.fn(async () => ({
        results: [],
        freshness: "stale" as const,
        generation: 7,
        gitHead: "abc123",
        workspaceRevision: "revision-7",
        pendingFiles: ["src/auth.ts"],
        fallbackEvidence: [{ kind: "git-diff" as const, excerpt: "+export const auth = true;" }],
        error: "index activation failed",
      })),
    };
    const { handlers, ctx, pi } = await harness({ repoMapRuntimeFactory: () => runtime });
    await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
    const canonical = [{ role: "user", content: "fix auth", timestamp: 10 }];
    const transformed = (await handlers.get("context")?.({ type: "context", messages: canonical }, ctx)) as {
      messages: Array<Record<string, unknown>>;
    };

    expect(canonical).toEqual([{ role: "user", content: "fix auth", timestamp: 10 }]);
    expect("appendEntry" in pi).toBe(false);
    const capsule = transformed.messages[0] as { content: string; details: Record<string, unknown> };
    expect(Buffer.byteLength(capsule.content)).toBeLessThanOrEqual(6 * 1024);
    expect(capsule.content).toContain('"freshness":"stale"');
    expect(capsule.content).toContain('"workspaceRevision":"revision-7"');
    expect(capsule.content).toContain('"fallbackEvidence"');
    expect(capsule.content).not.toContain('"freshness":"fresh"');
    expect(capsule.details).toMatchObject({ persistent: false, freshness: "stale" });
  });

  it("uses a valid minimal stale capsule when the configured 512-byte budget is exhausted", async () => {
    const runtime = {
      start: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      ensureFresh: vi.fn(async () => undefined),
      rebuild: vi.fn(async () => undefined),
      status: vi.fn(() => ({
        freshness: "stale" as const,
        generation: 9,
        gitHead: "a".repeat(40),
        workspaceRevision: "revision-minimal",
        pendingFiles: ["src/oversized.ts"],
        dirtyFiles: ["src/oversized.ts"],
        error: "failure ".repeat(200),
      })),
      query: vi.fn(async () => ({
        results: [],
        freshness: "stale" as const,
        generation: 9,
        gitHead: "a".repeat(40),
        workspaceRevision: "revision-minimal",
        pendingFiles: Array.from({ length: 30 }, (_, index) => `src/pending-${index}.ts`),
        fallbackEvidence: [
          { kind: "git-diff" as const, excerpt: "oversized evidence ".repeat(1_000) },
          { kind: "source" as const, path: "src/oversized.ts", excerpt: "source ".repeat(1_000) },
        ],
        error: "failure ".repeat(2_000),
      })),
    };
    const { handlers, ctx } = await harness({ repoMapRuntimeFactory: () => runtime }, { mapContextMaxBytes: 512 });
    await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);

    const transformed = (await handlers.get("context")?.(
      { type: "context", messages: [{ role: "user", content: "q".repeat(512), timestamp: 1 }] },
      ctx,
    )) as { messages: Array<{ content: string }> };
    const content = transformed.messages[0]?.content ?? "";
    expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(512);
    const payload = JSON.parse(content.slice(content.indexOf("\n") + 1));
    expect(payload).toMatchObject({
      freshness: "stale",
      workspaceRevision: "revision-minimal",
      truncated: true,
    });
    expect(payload.fallbackEvidence).toHaveLength(1);
  });

  it("initializes and disposes the map watcher idempotently across session lifecycle events", async () => {
    const runtimes: Array<{ start: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }> = [];
    const { handlers, ctx } = await harness({
      repoMapRuntimeFactory: () => {
        const runtime = {
          start: vi.fn(async () => undefined),
          close: vi.fn(async () => undefined),
          ensureFresh: vi.fn(async () => undefined),
          rebuild: vi.fn(async () => undefined),
          status: () => ({
            freshness: "fresh" as const,
            generation: 1,
            gitHead: "no-head",
            workspaceRevision: "revision",
            pendingFiles: [],
            dirtyFiles: [],
          }),
          query: vi.fn(async () => ({
            results: [],
            freshness: "fresh" as const,
            generation: 1,
            gitHead: "no-head",
            workspaceRevision: "revision",
            pendingFiles: [],
            fallbackEvidence: [],
          })),
        };
        runtimes.push(runtime);
        return runtime;
      },
    });

    await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
    await handlers.get("session_start")?.({ type: "session_start", reason: "reload" }, ctx);
    expect(runtimes).toHaveLength(2);
    expect(runtimes[0]?.close).toHaveBeenCalledOnce();
    await handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, ctx);
    expect(runtimes[1]?.close).toHaveBeenCalledOnce();
  });

  it("supports status, rebuild, gc, and doctor commands and reports degraded initialization safely", async () => {
    const { handlers, tools, commands, ctx, notify } = await harness({
      repoMapRuntimeFactory: () => ({
        start: async () => {
          throw new Error("watcher unavailable");
        },
        close: async () => undefined,
        ensureFresh: async () => undefined,
        rebuild: async () => undefined,
        status: () => ({
          freshness: "stale" as const,
          generation: 0,
          gitHead: "no-head",
          workspaceRevision: "unavailable",
          pendingFiles: [],
          dirtyFiles: [],
          error: "watcher unavailable",
        }),
        query: async () => {
          throw new Error("watcher unavailable");
        },
      }),
    });

    await expect(
      handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx),
    ).resolves.toBeUndefined();
    const status = (await tools.get("context_vault_status")?.execute("status", {})) as ToolResult;
    expect(JSON.parse(status.content[0].text)).toMatchObject({
      initialized: true,
      degraded: true,
      components: { repoMap: { available: false, error: "watcher unavailable" } },
    });

    for (const subcommand of ["status", "rebuild", "gc", "doctor"]) {
      await expect(commands.get("context-vault")?.handler(subcommand, ctx)).resolves.toBeUndefined();
    }
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("degraded"), expect.any(String));

    const headless = { ...ctx, hasUI: false };
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const tuiNotifyCount = notify.mock.calls.length;
      await expect(commands.get("context-vault")?.handler("doctor", headless)).resolves.toBeUndefined();
      // headless modes: report goes to console (redirected to stderr by pi's output guard), never silent
      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toMatchObject({ status: "degraded" });
      // and the UI channel stays untouched for the headless run
      expect(notify.mock.calls.length).toBe(tuiNotifyCount);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("keeps command reports on the UI notification channel only in TUI mode", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const { handlers, commands, ctx, notify } = await harness();
      await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
      await commands.get("context-vault")?.handler("status", ctx);
      expect(notify).toHaveBeenCalledWith(expect.stringContaining('"initialized": true'), "info");
      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
    }
  });

  it("prints the doctor report through console.log in headless modes without a UI context", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const { handlers, commands, ctx } = await harness();
      await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
      const headless = { ...ctx, hasUI: false };
      await commands.get("context-vault")?.handler("doctor", headless);
      expect(logSpy).toHaveBeenCalledTimes(1);
      const report = JSON.parse(String(logSpy.mock.calls[0][0]));
      expect(report).toMatchObject({ status: "healthy", initialized: true, stateOutsideProjectTree: true });
    } finally {
      logSpy.mockRestore();
    }
  });

  it("does not report a rebuild as available when the runtime remains stale", async () => {
    let stale = false;
    const runtime = {
      start: async () => undefined,
      close: async () => undefined,
      ensureFresh: async () => undefined,
      rebuild: vi.fn(async () => {
        stale = true;
      }),
      status: () => ({
        freshness: stale ? ("stale" as const) : ("fresh" as const),
        generation: 3,
        gitHead: "abc",
        workspaceRevision: "revision-rebuild",
        pendingFiles: [],
        dirtyFiles: [],
        ...(stale ? { error: "atomic activation failed" } : {}),
      }),
      query: async () => ({
        results: [],
        freshness: "fresh" as const,
        generation: 3,
        gitHead: "abc",
        workspaceRevision: "revision-rebuild",
        pendingFiles: [],
        fallbackEvidence: [],
      }),
    };
    const { handlers, tools, commands, ctx, notify } = await harness({ repoMapRuntimeFactory: () => runtime });
    await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);

    await commands.get("context-vault")?.handler("rebuild", ctx);

    const status = (await tools.get("context_vault_status")?.execute("status", {})) as ToolResult;
    expect(JSON.parse(status.content[0].text)).toMatchObject({
      degraded: true,
      components: { repoMap: { available: false, freshness: "stale", error: "atomic activation failed" } },
    });
    expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("rebuild failed"), "error");
  });
});
