import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EXTENSION_ID, EXTENSION_VERSION, registerContextVault } from "../src/extension.js";

type Handler = (...args: unknown[]) => unknown;
type ToolResult = { content: Array<{ text: string }>; isError?: boolean };
type Tool = { name: string; execute: (...args: unknown[]) => Promise<unknown> };
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function harness() {
  const root = await mkdtemp(join(tmpdir(), "context-vault-extension-"));
  const project = join(root, "project");
  await mkdir(project);
  roots.push(root);
  const handlers = new Map<string, Handler>();
  const tools = new Map<string, Tool>();
  const pi = {
    on: vi.fn((event: string, handler: Handler) => handlers.set(event, handler)),
    registerTool: vi.fn((tool: Tool) => tools.set(tool.name, tool)),
  };
  registerContextVault(pi as never, { env: { PI_CODING_AGENT_DIR: join(root, "pi") } });
  const setStatus = vi.fn();
  const ctx = {
    cwd: project,
    hasUI: true,
    ui: { setStatus },
    sessionManager: { getSessionId: () => "session-1" },
  };
  return { handlers, tools, pi, ctx, setStatus };
}

describe("extension observation adapter", () => {
  it("registers lifecycle hooks and bounded retrieval tools", async () => {
    const { handlers, tools, pi, ctx, setStatus } = await harness();
    expect(pi.on).toHaveBeenCalledTimes(3);
    expect([...tools.keys()]).toEqual(["context_vault_obs_get", "context_vault_obs_search", "context_vault_status"]);

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

    await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);
    expect(setStatus).toHaveBeenLastCalledWith(EXTENSION_ID, undefined);
    const status = (await tools.get("context_vault_status")?.execute("status-1", {})) as ToolResult;
    expect(status.isError).toBe(true);
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
});
