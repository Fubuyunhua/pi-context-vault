import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    sessionManager: {
      getSessionId: () => "session-1",
      getEntries: () => [],
      getBranch: () => [],
    },
    model: { contextWindow: 12_000 },
    getSystemPrompt: () => "system contract",
  };
  return { handlers, tools, commands, pi, ctx, setStatus, notify, project, root };
}

describe("extension observation adapter", () => {
  it("registers lifecycle hooks and bounded retrieval tools", async () => {
    const { handlers, tools, pi, ctx, setStatus } = await harness();
    expect(pi.on).toHaveBeenCalledTimes(5);
    expect([...tools.keys()]).toEqual(["context_vault_obs_get", "context_vault_obs_search", "context_vault_status"]);
    expect(pi.registerCommand).toHaveBeenCalledWith("context-vault", expect.any(Object));

    await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
    expect([...tools.keys()]).toContain("context_vault_repo_map");
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
    // The capsule is frozen after the latest user message, never at index 0.
    expect(transformed.messages[0]).toEqual(messages[0]);
    expect(transformed.messages[1]).toMatchObject({
      role: "custom",
      customType: "context-vault-repo-map",
      display: false,
    });
    expect(Buffer.byteLength(String(transformed.messages[1]?.content))).toBeLessThanOrEqual(6 * 1024);
    expect(transformed.messages[2]).toEqual(messages[1]);
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
    // The capsule is frozen after the latest user message, never at index 0.
    expect(transformed.messages[0]).toEqual(canonical[0]);
    const capsule = transformed.messages[1] as { content: string; details: Record<string, unknown> };
    expect(Buffer.byteLength(capsule.content)).toBeLessThanOrEqual(6 * 1024);
    const payload = JSON.parse(capsule.content.slice(capsule.content.indexOf("\n") + 1));
    expect(payload).toMatchObject({
      captureSemantics: "turn-start-snapshot",
      freshnessAtCapture: "stale",
      workspaceRevisionAtCapture: "revision-7",
      generationAtCapture: 7,
      gitHeadAtCapture: "abc123",
      pendingFilesAtCapture: ["src/auth.ts"],
      error: "index activation failed",
    });
    expect(payload.description).toMatch(/not live|does not reflect/u);
    expect(payload).not.toHaveProperty("freshness");
    expect(payload).not.toHaveProperty("workspaceRevision");
    expect(capsule.details).toMatchObject({
      persistent: false,
      captureSemantics: "turn-start-snapshot",
      freshnessAtCapture: "stale",
      workspaceRevisionAtCapture: "revision-7",
      generationAtCapture: 7,
      gitHeadAtCapture: "abc123",
      pendingFilesAtCapture: ["src/auth.ts"],
    });

    // A same-turn repeat must reuse the frozen capsule without re-querying.
    const repeated = (await handlers.get("context")?.({ type: "context", messages: transformed.messages }, ctx)) as {
      messages: Array<Record<string, unknown>>;
    };
    expect(repeated.messages.filter((message) => message.customType === "context-vault-repo-map")).toHaveLength(1);
    expect(runtime.query).toHaveBeenCalledTimes(1);
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
        gitHead: "a".repeat(200),
        workspaceRevision: "revision-minimal".repeat(20),
        pendingFiles: ["src/oversized.ts"],
        dirtyFiles: ["src/oversized.ts"],
        error: "failure ".repeat(200),
      })),
      query: vi.fn(async () => ({
        results: [
          {
            path: "src/oversized.ts",
            kind: "semantic" as const,
            score: 1,
            matchedSymbols: ["oversized"],
            symbols: [],
            dependencies: [],
          },
        ],
        freshness: "stale" as const,
        generation: 9,
        gitHead: "a".repeat(200),
        workspaceRevision: "revision-minimal".repeat(20),
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
    const content = transformed.messages[1]?.content ?? "";
    expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(512);
    const payload = JSON.parse(content.slice(content.indexOf("\n") + 1));
    expect(payload).toMatchObject({
      captureSemantics: "turn-start-snapshot",
      freshnessAtCapture: "stale",
      generationAtCapture: 9,
      pendingFileCountAtCapture: 30,
    });
    expect(payload.description).toMatch(/not live/u);
    expect(payload).not.toHaveProperty("freshness");
    expect(payload).not.toHaveProperty("workspaceRevision");
    expect(payload.workspaceRevisionAtCapture.length).toBeGreaterThan(0);
    expect(payload.gitHeadAtCapture.length).toBeGreaterThan(0);
    expect(payload.error.length).toBeGreaterThan(0);
    expect("failure ".repeat(2_000).startsWith(payload.error)).toBe(true);
    expect(payload.fallbackEvidence).toHaveLength(1);
    expect(payload.truncatedFields).toEqual(
      expect.arrayContaining([
        "workspaceRevisionAtCapture",
        "gitHeadAtCapture",
        "query",
        "error",
        "fallbackEvidence",
        "results",
        "pendingFilesAtCapture",
      ]),
    );
  });

  it("labels the first capture, freezes its bytes after same-turn mutation, and rebuilds next turn", async () => {
    let liveState: {
      freshness: "fresh" | "dirty";
      generation: number;
      gitHead: string;
      workspaceRevision: string;
      pendingFiles: string[];
    } = {
      freshness: "fresh",
      generation: 3,
      gitHead: "head-1",
      workspaceRevision: "revision-1",
      pendingFiles: [],
    };
    const query = vi.fn(async () => ({ results: [], ...liveState, fallbackEvidence: [] }));
    const runtime = {
      start: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      ensureFresh: vi.fn(async () => undefined),
      rebuild: vi.fn(async () => undefined),
      status: vi.fn(() => ({ ...liveState, dirtyFiles: liveState.pendingFiles })),
      query,
    };
    const { handlers, ctx } = await harness({ repoMapRuntimeFactory: () => runtime });
    await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);

    const turnStart = [{ role: "user", content: "fix auth", timestamp: 10 }];
    const first = (await handlers.get("context")?.({ type: "context", messages: turnStart }, ctx)) as {
      messages: Array<Record<string, unknown>>;
    };
    expect(first.messages[0]).toEqual(turnStart[0]);
    const capsule = first.messages[1] as { content: string; details: Record<string, unknown> };
    const firstPayload = JSON.parse(capsule.content.slice(capsule.content.indexOf("\n") + 1));
    expect(firstPayload).toMatchObject({
      captureSemantics: "turn-start-snapshot",
      freshnessAtCapture: "fresh",
      workspaceRevisionAtCapture: "revision-1",
      generationAtCapture: 3,
      gitHeadAtCapture: "head-1",
      pendingFilesAtCapture: [],
    });
    expect(firstPayload.description).toMatch(/not live|does not reflect/u);
    expect(capsule).toMatchObject({ role: "custom", customType: "context-vault-repo-map", display: false });
    expect(query).toHaveBeenCalledTimes(1);

    // A tool edit changes the live workspace, but same-turn context must retain
    // the exact capture bytes and must not imply that its old freshness is live.
    liveState = {
      freshness: "dirty",
      generation: 4,
      gitHead: "head-2",
      workspaceRevision: "revision-2",
      pendingFiles: ["src/auth.ts"],
    };
    const grown = [
      ...turnStart,
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "write", arguments: {} }],
        timestamp: 11,
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "write",
        content: [{ type: "text", text: "ok" }],
        isError: false,
        timestamp: 12,
      },
    ];
    const second = (await handlers.get("context")?.({ type: "context", messages: grown }, ctx)) as {
      messages: Array<Record<string, unknown>>;
    };
    const repeatedCapsule = second.messages[1] as { content: string };
    expect(repeatedCapsule.content).toBe(capsule.content);
    expect(second.messages[1]).toEqual(capsule);
    expect(query).toHaveBeenCalledTimes(1);

    await handlers.get("before_agent_start")?.({ type: "before_agent_start" }, ctx);
    const third = (await handlers.get("context")?.({ type: "context", messages: turnStart }, ctx)) as {
      messages: Array<Record<string, unknown>>;
    };
    const nextPayload = JSON.parse(String(third.messages[1]?.content).split("\n").slice(1).join("\n"));
    expect(nextPayload).toMatchObject({
      captureSemantics: "turn-start-snapshot",
      freshnessAtCapture: "dirty",
      workspaceRevisionAtCapture: "revision-2",
      generationAtCapture: 4,
      gitHeadAtCapture: "head-2",
      pendingFilesAtCapture: ["src/auth.ts"],
    });
    expect(third.messages[1]).not.toEqual(capsule);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("refreshes once per turn and queries the already-coherent snapshot for automatic context", async () => {
    const query = vi.fn(async () => ({
      results: [],
      freshness: "fresh" as const,
      generation: 1,
      gitHead: "h",
      workspaceRevision: "r",
      pendingFiles: [],
      fallbackEvidence: [],
    }));
    const queryCurrent = vi.fn(async () => ({
      results: [],
      freshness: "fresh" as const,
      generation: 1,
      gitHead: "h",
      workspaceRevision: "r",
      pendingFiles: [],
      fallbackEvidence: [],
    }));
    const runtime = {
      start: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      ensureFresh: vi.fn(async () => undefined),
      rebuild: vi.fn(async () => undefined),
      status: vi.fn(() => ({
        freshness: "fresh" as const,
        generation: 1,
        gitHead: "h",
        workspaceRevision: "r",
        pendingFiles: [],
        dirtyFiles: [],
      })),
      query,
      queryCurrent,
    };
    const { handlers, ctx } = await harness({ repoMapRuntimeFactory: () => runtime });
    await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);

    await handlers.get("before_agent_start")?.({ type: "before_agent_start" }, ctx);
    await handlers.get("context")?.(
      { type: "context", messages: [{ role: "user", content: "map query", timestamp: 1 }] },
      ctx,
    );

    expect(runtime.ensureFresh).toHaveBeenCalledTimes(1);
    expect(queryCurrent).toHaveBeenCalledTimes(1);
    expect(query).not.toHaveBeenCalled();
  });

  it("keeps explicit repository-map tool queries on the live freshness path", async () => {
    let liveResult = {
      results: [],
      freshness: "fresh" as "fresh" | "dirty",
      generation: 1,
      gitHead: "head-1",
      workspaceRevision: "revision-1",
      pendingFiles: [] as string[],
      fallbackEvidence: [],
    };
    const runtime = {
      start: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      ensureFresh: vi.fn(async () => undefined),
      rebuild: vi.fn(async () => undefined),
      status: vi.fn(() => ({ ...liveResult, dirtyFiles: liveResult.pendingFiles })),
      query: vi.fn(async () => liveResult),
      queryCurrent: vi.fn(async () => liveResult),
    };
    const { handlers, tools, ctx } = await harness({ repoMapRuntimeFactory: () => runtime });
    await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
    await handlers.get("context")?.(
      { type: "context", messages: [{ role: "user", content: "capture", timestamp: 1 }] },
      ctx,
    );

    liveResult = {
      results: [],
      freshness: "dirty",
      generation: 2,
      gitHead: "head-2",
      workspaceRevision: "revision-2",
      pendingFiles: ["src/edited.ts"],
      fallbackEvidence: [],
    };
    const result = (await tools.get("context_vault_repo_map")?.execute("map-1", { query: "explicit" })) as ToolResult;
    const parsed = JSON.parse(result.content[0].text);

    expect(runtime.query).toHaveBeenCalledWith("explicit", { limit: undefined });
    expect(runtime.queryCurrent).toHaveBeenCalledTimes(1);
    expect(parsed).toEqual(liveResult);
    expect(parsed).toMatchObject({ freshness: "dirty", workspaceRevision: "revision-2" });
    expect(parsed).not.toHaveProperty("captureSemantics");
    expect(parsed).not.toHaveProperty("freshnessAtCapture");
  });

  it("resets the turn sequence and freeze on session lifecycle", async () => {
    const query = vi.fn(async () => ({
      results: [],
      freshness: "fresh" as const,
      generation: 1,
      gitHead: "h",
      workspaceRevision: "r",
      pendingFiles: [],
      fallbackEvidence: [],
    }));
    const runtime = {
      start: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      ensureFresh: vi.fn(async () => undefined),
      rebuild: vi.fn(async () => undefined),
      status: vi.fn(() => ({
        freshness: "fresh" as const,
        generation: 1,
        gitHead: "h",
        workspaceRevision: "r",
        pendingFiles: [],
        dirtyFiles: [],
      })),
      query,
    };
    const { handlers, ctx } = await harness({ repoMapRuntimeFactory: () => runtime });
    await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);

    // Turn 1 builds and freezes.
    const messages = [{ role: "user", content: "fix auth", timestamp: 10 }];
    await handlers.get("context")?.({ type: "context", messages }, ctx);
    expect(query).toHaveBeenCalledTimes(1);

    // Session lifecycle resets turnSequence and the freeze; a fresh turn must
    // build again instead of reusing the previous session's capsule.
    await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);
    await handlers.get("session_start")?.({ type: "session_start", reason: "new" }, ctx);
    await handlers.get("before_agent_start")?.({ type: "before_agent_start" }, ctx);
    const rebuilt = (await handlers.get("context")?.({ type: "context", messages }, ctx)) as {
      messages: Array<Record<string, unknown>>;
    };
    expect(rebuilt.messages[1]).toMatchObject({ role: "custom", customType: "context-vault-repo-map" });
    expect(query).toHaveBeenCalledTimes(2);

    // Same turn, no before_agent_start: reuse, no additional query.
    await handlers.get("context")?.({ type: "context", messages }, ctx);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("captures bounded, non-live details on every LLM call in every-llm-call mode", async () => {
    let capture = {
      results: [],
      freshness: "fresh" as "fresh" | "dirty",
      generation: 1,
      gitHead: "head-1",
      workspaceRevision: "revision-1",
      pendingFiles: [] as string[],
      fallbackEvidence: [] as Array<{ kind: "source"; path: string; excerpt: string }>,
    };
    const queryCurrent = vi.fn(async () => capture);
    const runtime = {
      start: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      ensureFresh: vi.fn(async () => undefined),
      rebuild: vi.fn(async () => undefined),
      status: vi.fn(() => ({ ...capture, dirtyFiles: capture.pendingFiles })),
      query: vi.fn(async () => capture),
      queryCurrent,
    };
    const { handlers, ctx } = await harness(
      { repoMapRuntimeFactory: () => runtime },
      { mapInjectionMode: "every-llm-call", mapContextMaxBytes: 1024 },
    );
    await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);

    const messages = [{ role: "user", content: "fix auth", timestamp: 10 }];
    const first = (await handlers.get("context")?.({ type: "context", messages }, ctx)) as {
      messages: Array<Record<string, unknown>>;
    };
    const firstCapsule = first.messages[0] as { content: string; details: Record<string, unknown> };
    const firstPayload = JSON.parse(firstCapsule.content.slice(firstCapsule.content.indexOf("\n") + 1));
    expect(firstCapsule).toMatchObject({ role: "custom", customType: "context-vault-repo-map" });
    expect(Buffer.byteLength(firstCapsule.content, "utf8")).toBeLessThanOrEqual(1024);
    expect(firstPayload).toMatchObject({
      captureSemantics: "context-call-snapshot",
      freshnessAtCapture: "fresh",
      workspaceRevisionAtCapture: "revision-1",
      generationAtCapture: 1,
      gitHeadAtCapture: "head-1",
      pendingFilesAtCapture: [],
    });
    expect(firstPayload.description).toMatch(/not live/u);
    expect(firstPayload).not.toHaveProperty("freshness");
    expect(firstPayload).not.toHaveProperty("workspaceRevision");
    expect(firstPayload).not.toHaveProperty("gitHead");
    expect(firstPayload).not.toHaveProperty("pendingFiles");
    expect(firstCapsule.details).toEqual({
      persistent: false,
      captureSemantics: "context-call-snapshot",
      freshnessAtCapture: "fresh",
      workspaceRevisionAtCapture: "revision-1",
      generationAtCapture: 1,
      gitHeadAtCapture: "head-1",
      pendingFilesAtCapture: [],
    });
    expect(firstCapsule.details).not.toHaveProperty("freshness");
    expect(firstCapsule.details).not.toHaveProperty("workspaceRevision");
    expect(queryCurrent).toHaveBeenCalledTimes(1);

    capture = {
      results: [],
      freshness: "dirty",
      generation: 2,
      gitHead: "head-2",
      workspaceRevision: "revision-2",
      pendingFiles: ["src/auth.ts"],
      fallbackEvidence: [{ kind: "source", path: "src/auth.ts", excerpt: "captured evidence" }],
    };
    const grown = [
      ...messages,
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "c", name: "read", arguments: {} }],
        timestamp: 11,
      },
      {
        role: "toolResult",
        toolCallId: "c",
        toolName: "read",
        content: [{ type: "text", text: "ok" }],
        isError: false,
        timestamp: 12,
      },
    ];
    const second = (await handlers.get("context")?.({ type: "context", messages: grown }, ctx)) as {
      messages: Array<Record<string, unknown>>;
    };
    const secondCapsule = second.messages[0] as { content: string; details: Record<string, unknown> };
    const secondPayload = JSON.parse(secondCapsule.content.slice(secondCapsule.content.indexOf("\n") + 1));
    expect(secondCapsule).toMatchObject({ role: "custom", customType: "context-vault-repo-map" });
    expect(Buffer.byteLength(secondCapsule.content, "utf8")).toBeLessThanOrEqual(1024);
    expect(secondPayload).toMatchObject({
      captureSemantics: "context-call-snapshot",
      freshnessAtCapture: "dirty",
      workspaceRevisionAtCapture: "revision-2",
      generationAtCapture: 2,
      gitHeadAtCapture: "head-2",
      pendingFilesAtCapture: ["src/auth.ts"],
    });
    expect(secondPayload.description).toMatch(/not live/u);
    expect(secondPayload).not.toHaveProperty("freshness");
    expect(secondPayload).not.toHaveProperty("workspaceRevision");
    expect(secondCapsule.details).toMatchObject({
      persistent: false,
      captureSemantics: "context-call-snapshot",
      freshnessAtCapture: "dirty",
      workspaceRevisionAtCapture: "revision-2",
      generationAtCapture: 2,
      gitHeadAtCapture: "head-2",
      pendingFilesAtCapture: ["src/auth.ts"],
    });
    expect(secondCapsule.details).not.toHaveProperty("freshness");
    expect(secondCapsule.details).not.toHaveProperty("workspaceRevision");
    expect(queryCurrent).toHaveBeenCalledTimes(2);
    expect(runtime.query).not.toHaveBeenCalled();
  });

  it("injects no automatic capsule in off mode", async () => {
    const query = vi.fn(async () => ({
      results: [],
      freshness: "fresh" as const,
      generation: 1,
      gitHead: "h",
      workspaceRevision: "r",
      pendingFiles: [],
      fallbackEvidence: [],
    }));
    const runtime = {
      start: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      ensureFresh: vi.fn(async () => undefined),
      rebuild: vi.fn(async () => undefined),
      status: vi.fn(() => ({
        freshness: "fresh" as const,
        generation: 1,
        gitHead: "h",
        workspaceRevision: "r",
        pendingFiles: [],
        dirtyFiles: [],
      })),
      query,
    };
    const { handlers, ctx } = await harness({ repoMapRuntimeFactory: () => runtime }, { mapInjectionMode: "off" });
    await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);

    const messages = [{ role: "user", content: "fix auth", timestamp: 10 }];
    const result = await handlers.get("context")?.({ type: "context", messages }, ctx);
    expect(result).toBeUndefined();
    expect(query).not.toHaveBeenCalled();
  });

  it("does not resurrect a frozen capsule after the map becomes unavailable", async () => {
    const query = vi.fn(async () => ({
      results: [],
      freshness: "fresh" as const,
      generation: 1,
      gitHead: "h",
      workspaceRevision: "r",
      pendingFiles: [],
      fallbackEvidence: [],
    }));
    const runtime = {
      start: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      ensureFresh: vi.fn(async () => undefined),
      rebuild: vi.fn(async () => undefined),
      status: vi.fn(() => ({
        freshness: "fresh" as const,
        generation: 1,
        gitHead: "h",
        workspaceRevision: "r",
        pendingFiles: [],
        dirtyFiles: [],
      })),
      query,
    };
    const failing = {
      start: vi.fn(async () => {
        throw new Error("map failed");
      }),
      close: vi.fn(async () => undefined),
      ensureFresh: vi.fn(async () => undefined),
      rebuild: vi.fn(async () => undefined),
      status: vi.fn(() => ({
        freshness: "stale" as const,
        generation: 0,
        gitHead: "h",
        workspaceRevision: "r",
        pendingFiles: [],
        dirtyFiles: [],
      })),
      query: vi.fn(),
    };
    let factoryCalls = 0;
    const { handlers, ctx } = await harness({
      repoMapRuntimeFactory: () => {
        factoryCalls += 1;
        return factoryCalls === 1 ? runtime : failing;
      },
    });
    await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);

    const messages = [{ role: "user", content: "fix auth", timestamp: 10 }];
    const first = (await handlers.get("context")?.({ type: "context", messages }, ctx)) as {
      messages: Array<Record<string, unknown>>;
    };
    expect(first.messages[1]).toMatchObject({ customType: "context-vault-repo-map" });

    await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);
    await handlers.get("session_start")?.({ type: "session_start", reason: "new" }, ctx);
    const second = await handlers.get("context")?.({ type: "context", messages }, ctx);
    expect(second).toBeUndefined();
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

  it("registers before archiving and releases only its session lease on shutdown", async () => {
    const { handlers, ctx, project, root } = await harness();
    const projectId = createHash("sha256").update(project).digest("hex").slice(0, 32);
    const registryPath = join(root, "pi", "context-vault", "projects", projectId, "metadata", "active-sessions.json");

    await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
    expect(JSON.parse(await readFile(registryPath, "utf8")).leases).toMatchObject([
      { sessionId: "session-1", pid: process.pid },
    ]);

    await handlers.get("tool_result")?.({
      type: "tool_result",
      toolCallId: "registered-first",
      toolName: "read",
      input: {},
      content: [{ type: "text", text: "archived only after registration" }],
      isError: false,
    });
    await handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, ctx);
    expect(JSON.parse(await readFile(registryPath, "utf8")).leases).toEqual([]);
  });

  it("runs repository-map maintenance together with artifact garbage collection", async () => {
    const maintenance = vi.fn(async () => ({
      activeGeneration: 1,
      deletedGenerations: [2],
      bytesFreed: 100,
      remainingGenerations: 1,
      remainingBytes: 200,
      quotaSatisfied: true,
    }));
    const { handlers, commands, ctx, notify } = await harness({
      repoMapRuntimeFactory: () => ({
        start: async () => undefined,
        close: async () => undefined,
        ensureFresh: async () => undefined,
        rebuild: async () => undefined,
        maintenance,
        status: () => ({
          freshness: "fresh" as const,
          generation: 1,
          gitHead: "no-head",
          workspaceRevision: "revision",
          pendingFiles: [],
          dirtyFiles: [],
        }),
        query: async () => ({
          results: [],
          freshness: "fresh" as const,
          generation: 1,
          gitHead: "no-head",
          workspaceRevision: "revision",
          pendingFiles: [],
          fallbackEvidence: [],
        }),
      }),
    });
    await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);

    await commands.get("context-vault")?.handler("gc", ctx);

    expect(maintenance).toHaveBeenCalledOnce();
    expect(JSON.parse(String(notify.mock.calls.at(-1)?.[0]))).toMatchObject({
      artifacts: { quotaSatisfied: true },
      repoMap: { activeGeneration: 1, deletedGenerations: [2], quotaSatisfied: true },
    });
  });

  it("protects receipts from the resumed session tree/current branch, shared hashes, and current-session metadata", async () => {
    const maintenance = vi.fn(async () => ({
      activeGeneration: 1,
      deletedGenerations: [],
      bytesFreed: 0,
      remainingGenerations: 1,
      remainingBytes: 1,
      quotaSatisfied: true,
    }));
    const { handlers, tools, commands, ctx, notify } = await harness(
      {
        repoMapRuntimeFactory: () => ({
          start: async () => undefined,
          close: async () => undefined,
          ensureFresh: async () => undefined,
          rebuild: async () => undefined,
          maintenance,
          status: () => ({
            freshness: "fresh" as const,
            generation: 1,
            gitHead: "head",
            workspaceRevision: "revision",
            pendingFiles: [],
            dirtyFiles: [],
          }),
          query: async () => ({
            results: [],
            freshness: "fresh" as const,
            generation: 1,
            gitHead: "head",
            workspaceRevision: "revision",
            pendingFiles: [],
            fallbackEvidence: [],
          }),
        }),
      },
      { replacementThresholdBytes: 1, projectQuotaBytes: 1, retentionDays: 30 },
    );
    const toolResult = async (toolCallId: string, text: string) =>
      (await handlers.get("tool_result")?.({
        type: "tool_result",
        toolCallId,
        toolName: "read",
        input: {},
        content: [{ type: "text", text }],
        isError: false,
      })) as ToolResult;

    await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
    const treeReceipt = await toolResult("tree", "tree evidence");
    const sharedReceipt = await toolResult("shared", "tree evidence");
    const branchReceipt = await toolResult("branch", "branch evidence");
    const unreferencedReceipt = await toolResult("unreferenced", "delete me");

    const resumedCtx = {
      ...ctx,
      sessionManager: {
        getSessionId: () => "session-2",
        getEntries: () => [
          {
            type: "message",
            id: "tree-entry",
            parentId: null,
            timestamp: new Date().toISOString(),
            message: {
              role: "toolResult",
              toolCallId: "tree",
              toolName: "read",
              content: [{ type: "text", text: treeReceipt.content[0]?.text }],
              isError: false,
              timestamp: 1,
            },
          },
        ],
        getBranch: () => [
          {
            type: "message",
            id: "branch-entry",
            parentId: null,
            timestamp: new Date().toISOString(),
            message: {
              role: "toolResult",
              toolCallId: "branch",
              toolName: "read",
              content: [{ type: "text", text: branchReceipt.content[0]?.text }],
              isError: false,
              timestamp: 2,
            },
          },
        ],
      },
    };
    await handlers.get("session_start")?.({ type: "session_start", reason: "resume" }, resumedCtx);
    const current = await toolResult("current", "current metadata evidence");

    await commands.get("context-vault")?.handler("gc", resumedCtx);

    const report = JSON.parse(String(notify.mock.calls.at(-1)?.[0]));
    expect(report.artifacts.quotaSatisfied).toBe(false);
    expect(maintenance).toHaveBeenCalledOnce();
    for (const receipt of [treeReceipt, sharedReceipt, branchReceipt, current]) {
      const id = JSON.parse(receipt.content[0]?.text ?? "{}").id;
      const fetched = (await tools.get("context_vault_obs_get")?.execute("get", { id })) as ToolResult;
      expect(fetched.isError).not.toBe(true);
    }
    const unreferencedId = JSON.parse(unreferencedReceipt.content[0]?.text ?? "{}").id;
    const deleted = (await tools.get("context_vault_obs_get")?.execute("get", { id: unreferencedId })) as ToolResult;
    expect(deleted.isError).toBe(true);
  });

  it("fails GC safely before deletion when active session references cannot be enumerated", async () => {
    const maintenance = vi.fn(async () => ({
      activeGeneration: 1,
      deletedGenerations: [],
      bytesFreed: 0,
      remainingGenerations: 1,
      remainingBytes: 0,
      quotaSatisfied: true,
    }));
    const { handlers, tools, commands, ctx, notify } = await harness(
      {
        repoMapRuntimeFactory: () => ({
          start: async () => undefined,
          close: async () => undefined,
          ensureFresh: async () => undefined,
          rebuild: async () => undefined,
          maintenance,
          status: () => ({
            freshness: "fresh" as const,
            generation: 1,
            gitHead: "head",
            workspaceRevision: "revision",
            pendingFiles: [],
            dirtyFiles: [],
          }),
          query: async () => ({
            results: [],
            freshness: "fresh" as const,
            generation: 1,
            gitHead: "head",
            workspaceRevision: "revision",
            pendingFiles: [],
            fallbackEvidence: [],
          }),
        }),
      },
      { replacementThresholdBytes: 1, projectQuotaBytes: 1 },
    );
    await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
    const receipt = (await handlers.get("tool_result")?.({
      type: "tool_result",
      toolCallId: "keep",
      toolName: "read",
      input: {},
      content: [{ type: "text", text: "must survive enumeration failure" }],
      isError: false,
    })) as ToolResult;
    const failingCtx = {
      ...ctx,
      sessionManager: {
        getSessionId: () => "different-session",
        getEntries: () => {
          throw new Error("session tree unavailable");
        },
        getBranch: () => [],
      },
    };

    await commands.get("context-vault")?.handler("gc", failingCtx);

    expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("session tree unavailable"), "error");
    expect(maintenance).not.toHaveBeenCalled();
    const id = JSON.parse(receipt.content[0]?.text ?? "{}").id;
    const fetched = (await tools.get("context_vault_obs_get")?.execute("get", { id })) as ToolResult;
    expect(fetched.isError).not.toBe(true);
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

  it("clears a frozen capsule across failed and successful rebuild boundaries in one turn", async () => {
    let rebuildAttempts = 0;
    let workspaceRevision = "revision-before";
    const query = vi.fn(async () => ({
      results: [],
      freshness: "fresh" as const,
      generation: rebuildAttempts + 1,
      gitHead: "head",
      workspaceRevision,
      pendingFiles: [],
      fallbackEvidence: [],
    }));
    const runtime = {
      start: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      ensureFresh: vi.fn(async () => undefined),
      rebuild: vi.fn(async () => {
        rebuildAttempts += 1;
        if (rebuildAttempts === 1) throw new Error("first rebuild failed");
        workspaceRevision = "revision-after";
      }),
      status: vi.fn(() => ({
        freshness: "fresh" as const,
        generation: rebuildAttempts + 1,
        gitHead: "head",
        workspaceRevision,
        pendingFiles: [],
        dirtyFiles: [],
      })),
      query,
    };
    const { handlers, commands, ctx } = await harness({ repoMapRuntimeFactory: () => runtime });
    await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
    const first = (await handlers.get("context")?.(
      { type: "context", messages: [{ role: "user", content: "inspect", timestamp: 1 }] },
      ctx,
    )) as { messages: Array<Record<string, unknown>> };

    await commands.get("context-vault")?.handler("rebuild", ctx);
    await commands.get("context-vault")?.handler("rebuild", ctx);
    const second = (await handlers.get("context")?.({ type: "context", messages: first.messages }, ctx)) as {
      messages: Array<Record<string, unknown>>;
    };

    expect(query).toHaveBeenCalledTimes(2);
    expect(second.messages).toHaveLength(2);
    expect(String(second.messages[1]?.content)).toContain('"workspaceRevisionAtCapture":"revision-after"');
    expect(second.messages[1]).not.toEqual(first.messages[1]);
  });

  it("contains capsule render failures, continues reduction, and counts failed automatic queries", async () => {
    const cyclicSymbol: Record<string, unknown> = { name: "cyclic" };
    cyclicSymbol.self = cyclicSymbol;
    const runtime = {
      start: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      ensureFresh: vi.fn(async () => undefined),
      rebuild: vi.fn(async () => undefined),
      status: vi.fn(() => ({
        freshness: "fresh" as const,
        generation: 1,
        gitHead: "head",
        workspaceRevision: "revision",
        pendingFiles: [],
        dirtyFiles: [],
      })),
      query: vi
        .fn()
        .mockRejectedValueOnce(new Error("query failed"))
        .mockResolvedValueOnce({
          results: [
            {
              path: "src/cyclic.ts",
              kind: "semantic",
              matchedSymbols: ["cyclic"],
              symbols: [cyclicSymbol],
              dependencies: [],
            },
          ],
          freshness: "fresh" as const,
          generation: 1,
          gitHead: "head",
          workspaceRevision: "revision",
          pendingFiles: [],
          fallbackEvidence: [],
        }),
    };
    const { handlers, tools, ctx } = await harness({ repoMapRuntimeFactory: () => runtime });
    await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);

    const failedQueryCapsule = (await handlers.get("context")?.(
      { type: "context", messages: [{ role: "user", content: "first", timestamp: 1 }] },
      ctx,
    )) as { messages: Array<{ content: string }> };
    const failedQueryPayload = JSON.parse(
      failedQueryCapsule.messages[1]?.content.split("\n").slice(1).join("\n") ?? "",
    );
    expect(failedQueryPayload).toMatchObject({
      captureSemantics: "turn-start-snapshot",
      freshnessAtCapture: "stale",
      workspaceRevisionAtCapture: "unavailable",
      generationAtCapture: 0,
      gitHeadAtCapture: "unavailable",
      pendingFilesAtCapture: [],
      error: "query failed",
    });
    expect(failedQueryPayload).not.toHaveProperty("freshness");
    await handlers.get("before_agent_start")?.({ type: "before_agent_start" }, ctx);
    await expect(
      handlers.get("context")?.(
        { type: "context", messages: [{ role: "user", content: "second", timestamp: 2 }] },
        ctx,
      ),
    ).resolves.toBeUndefined();

    const status = (await tools.get("context_vault_status")?.execute("status", {})) as ToolResult;
    const parsed = JSON.parse(status.content[0].text);
    expect(parsed.telemetry.repoMapAutomaticQueryCount).toBe(2);
    expect(parsed.telemetry.reductionInvocationCount).toBe(2);
    expect(parsed.telemetry.capsuleBuildCount).toBe(1);
    expect(parsed.failures).toEqual([
      expect.objectContaining({ component: "repo-map", error: expect.stringContaining("circular") }),
    ]);
    expect(parsed.failures[0].error.length).toBeLessThanOrEqual(512);
  });

  it("telemetry: context hook message structure is unchanged and capsule counters increase", async () => {
    const query = vi.fn(async () => ({
      results: [],
      freshness: "fresh" as const,
      generation: 1,
      gitHead: "h",
      workspaceRevision: "r",
      pendingFiles: [],
      fallbackEvidence: [],
    }));
    const runtime = {
      start: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      ensureFresh: vi.fn(async () => undefined),
      rebuild: vi.fn(async () => undefined),
      status: vi.fn(() => ({
        freshness: "fresh" as const,
        generation: 1,
        gitHead: "h",
        workspaceRevision: "r",
        pendingFiles: [],
        dirtyFiles: [],
      })),
      query,
    };
    const { handlers, tools, ctx } = await harness({ repoMapRuntimeFactory: () => runtime });
    await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);

    const turnStart = [{ role: "user", content: "fix auth", timestamp: 10 }];
    const first = (await handlers.get("context")?.({ type: "context", messages: turnStart }, ctx)) as {
      messages: Array<Record<string, unknown>>;
    };
    // Message structure is identical to the pre-telemetry behavior.
    expect(first.messages[0]).toEqual(turnStart[0]);
    expect(first.messages[1]).toMatchObject({ role: "custom", customType: "context-vault-repo-map", display: false });

    const grown = [
      ...turnStart,
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "c", name: "read", arguments: {} }],
        timestamp: 11,
      },
      {
        role: "toolResult",
        toolCallId: "c",
        toolName: "read",
        content: [{ type: "text", text: "ok" }],
        isError: false,
        timestamp: 12,
      },
    ];
    const second = (await handlers.get("context")?.({ type: "context", messages: grown }, ctx)) as {
      messages: Array<Record<string, unknown>>;
    };
    expect(second.messages[1]).toEqual(first.messages[1]);

    const status = (await tools.get("context_vault_status")?.execute("status", {})) as ToolResult;
    const telemetry = JSON.parse(status.content[0].text).telemetry;
    expect(telemetry.capsuleBuildCount).toBe(1);
    expect(telemetry.repoMapAutomaticQueryCount).toBe(1);
    expect(telemetry.capsuleInsertionIndex).toBe(1);
    expect(telemetry.capsuleBytes).toBeGreaterThan(0);
  });

  it("telemetry: capsule hash change increments across user turns", async () => {
    const query = vi.fn(async () => ({
      results: [],
      freshness: "fresh" as const,
      generation: 1,
      gitHead: "h",
      workspaceRevision: "r",
      pendingFiles: [],
      fallbackEvidence: [],
    }));
    const runtime = {
      start: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      ensureFresh: vi.fn(async () => undefined),
      rebuild: vi.fn(async () => undefined),
      status: vi.fn(() => ({
        freshness: "fresh" as const,
        generation: 1,
        gitHead: "h",
        workspaceRevision: "r",
        pendingFiles: [],
        dirtyFiles: [],
      })),
      query,
    };
    const { handlers, tools, ctx } = await harness({ repoMapRuntimeFactory: () => runtime });
    await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);

    await handlers.get("context")?.(
      { type: "context", messages: [{ role: "user", content: "first prompt", timestamp: 1 }] },
      ctx,
    );
    await handlers.get("before_agent_start")?.({ type: "before_agent_start" }, ctx);
    await handlers.get("context")?.(
      { type: "context", messages: [{ role: "user", content: "second prompt", timestamp: 2 }] },
      ctx,
    );

    const status = (await tools.get("context_vault_status")?.execute("status", {})) as ToolResult;
    const telemetry = JSON.parse(status.content[0].text).telemetry;
    expect(telemetry.capsuleBuildCount).toBe(2);
    expect(telemetry.capsuleHashChangeCount).toBe(1);
  });

  it("telemetry: reduction counters accumulate", async () => {
    const { handlers, tools, ctx } = await harness();
    await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);

    // Small context: reduceContext runs but does not trigger.
    await handlers.get("context")?.(
      { type: "context", messages: [{ role: "user", content: "hi", timestamp: 1 }] },
      ctx,
    );

    // Large context: reduction triggers.
    const narrowContext = { ...ctx, model: { contextWindow: 35_000 } };
    const messages: Array<Record<string, unknown>> = [{ role: "user", content: "big", timestamp: 0 }];
    for (let index = 0; index < 20; index += 1) {
      const text = `${index}:`.padEnd(8_000, "x");
      await handlers.get("tool_result")?.({
        type: "tool_result",
        toolCallId: `telemetry-call-${index}`,
        toolName: "read",
        input: {},
        content: [{ type: "text", text }],
        isError: false,
      });
      messages.push({
        role: "assistant",
        content: [{ type: "toolCall", id: `telemetry-call-${index}`, name: "read", arguments: {} }],
        timestamp: index * 2 + 1,
      });
      messages.push({
        role: "toolResult",
        toolCallId: `telemetry-call-${index}`,
        toolName: "read",
        content: [{ type: "text", text }],
        isError: false,
        timestamp: index * 2 + 2,
      });
    }
    await handlers.get("context")?.({ type: "context", messages }, narrowContext);

    const status = (await tools.get("context_vault_status")?.execute("status", {})) as ToolResult;
    const telemetry = JSON.parse(status.content[0].text).telemetry;
    expect(telemetry.reductionInvocationCount).toBe(2);
    expect(telemetry.reductionTriggeredCount).toBe(1);
    expect(telemetry.reducedObservationCount).toBeGreaterThan(0);
    expect(telemetry.estimatedTokensBeforeTotal).toBeGreaterThan(0);
    expect(telemetry.estimatedTokensAfterTotal).toBeGreaterThan(0);
    expect(telemetry.reductionDurationMsTotal).toBeGreaterThanOrEqual(0);
  }, 15_000);

  it("telemetry: status snapshot is a copy, bounded, and free of raw content", async () => {
    const query = vi.fn(async () => ({
      results: [],
      freshness: "fresh" as const,
      generation: 1,
      gitHead: "h",
      workspaceRevision: "r",
      pendingFiles: [],
      fallbackEvidence: [],
    }));
    const runtime = {
      start: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      ensureFresh: vi.fn(async () => undefined),
      rebuild: vi.fn(async () => undefined),
      status: vi.fn(() => ({
        freshness: "fresh" as const,
        generation: 1,
        gitHead: "h",
        workspaceRevision: "r",
        pendingFiles: [],
        dirtyFiles: [],
      })),
      query,
    };
    const { handlers, tools, ctx } = await harness({ repoMapRuntimeFactory: () => runtime });
    await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);

    await handlers.get("context")?.(
      { type: "context", messages: [{ role: "user", content: "fix auth", timestamp: 1 }] },
      ctx,
    );
    await handlers.get("tool_result")?.({
      type: "tool_result",
      toolCallId: "marker-call",
      toolName: "bash",
      input: {},
      content: [{ type: "text", text: "SECRET-TOOL-OUTPUT-MARKER-xyz" }],
      isError: false,
    });

    const first = (await tools.get("context_vault_status")?.execute("status", {})) as ToolResult;
    const firstStatus = JSON.parse(first.content[0].text);
    const snapshot = firstStatus.telemetry;
    snapshot.capsuleBuildCount = 999;
    snapshot.repoMapQueryCount = 999;

    const second = (await tools.get("context_vault_status")?.execute("status", {})) as ToolResult;
    const secondStatus = JSON.parse(second.content[0].text);
    expect(secondStatus.telemetry.capsuleBuildCount).toBe(1);
    expect(secondStatus.telemetry.repoMapQueryCount).toBe(0);

    // Bounded: every telemetry field is a finite number, no arrays or records.
    for (const [key, value] of Object.entries(secondStatus.telemetry)) {
      expect(typeof value, key).toBe("number");
      expect(Number.isFinite(value), key).toBe(true);
    }

    // Privacy: status never contains raw tool output.
    expect(first.content[0].text).not.toContain("SECRET-TOOL-OUTPUT-MARKER-xyz");
    expect(second.content[0].text).not.toContain("SECRET-TOOL-OUTPUT-MARKER-xyz");
  });

  it("telemetry: degraded state is unaffected by telemetry presence", async () => {
    const { handlers, tools, ctx } = await harness();
    await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);

    const status = (await tools.get("context_vault_status")?.execute("status", {})) as ToolResult;
    const parsed = JSON.parse(status.content[0].text);
    expect(parsed.degraded).toBe(false);
    expect(parsed.telemetry).toBeDefined();
    expect(parsed.components.observations.degraded).toBe(false);
  });
});
