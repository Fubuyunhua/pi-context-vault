import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../src/artifacts/store.js";
import { estimateContextTokens, type ReductionOptions, reduceContext } from "../src/context/reduction.js";

type AgentMessage = ContextEvent["messages"][number];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "context-vault-reduction-"));
  roots.push(root);
  await mkdir(join(root, "artifacts"));
  return new ArtifactStore({ artifactsRoot: join(root, "artifacts"), metadataRoot: join(root, "metadata") });
}

function assistant(toolCallId: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id: toolCallId, name: "read", arguments: {} }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 1,
  } as AgentMessage;
}

function result(toolCallId: string, text: string): AgentMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "read",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 2,
  } as AgentMessage;
}

function conversation(count: number, bytes = 1_200): AgentMessage[] {
  const messages: AgentMessage[] = [
    { role: "user", content: "CONSTRAINT: never edit generated files", timestamp: 0 } as AgentMessage,
  ];
  for (let index = 0; index < count; index += 1) {
    messages.push(assistant(`call-${index}`), result(`call-${index}`, `${index}:`.padEnd(bytes, "x")));
  }
  return messages;
}

async function archive(store: ArtifactStore, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await store.archive({
      observationId: `obs_${index.toString(16).padStart(24, "0")}`,
      toolCallId: `call-${index}`,
      toolName: "read",
      sessionId: "session",
      content: `${index}:`.padEnd(1_200, "x"),
    });
  }
}

function options(
  store: ArtifactStore,
  messages: AgentMessage[],
  overrides: Partial<ReductionOptions> = {},
): ReductionOptions {
  return {
    store,
    messages,
    sessionId: "session",
    systemPrompt: "system contract",
    contextWindowTokens: 12_000,
    hotObservationCount: 6,
    softContextRatio: 0.75,
    targetContextRatio: 0.6,
    receiptMaxBytes: 512,
    ...overrides,
  };
}

describe("bounded context reduction", () => {
  it("uses a conservative deterministic size estimate", () => {
    const messages = conversation(20);
    expect(estimateContextTokens(messages, "system contract")).toBeGreaterThan(0);
    expect(estimateContextTokens(messages, "system contract")).toBe(
      estimateContextTokens(structuredClone(messages), "system contract"),
    );
    expect(
      estimateContextTokens([{ role: "user", content: "你".repeat(100), timestamp: 0 } as AgentMessage], ""),
    ).toBeGreaterThanOrEqual(100);
  });

  it("batch-reduces archived cold results to the target while retaining six hot results and chronology", async () => {
    const store = await setup();
    const messages = conversation(30);
    await archive(store, 30);
    const reduced = await reduceContext(options(store, messages, { contextWindowTokens: 19_500 }));

    expect(reduced.triggered).toBe(true);
    expect(reduced.reducedCount).toBeGreaterThan(1);
    expect(reduced.estimatedTokensAfter).toBeLessThanOrEqual(19_500 * 0.6);
    expect(reduced.messages).toHaveLength(messages.length);
    expect(reduced.messages[0]).toEqual(messages[0]);
    for (let index = 24; index < 30; index += 1) {
      const hot = reduced.messages.find(
        (message) => message.role === "toolResult" && message.toolCallId === `call-${index}`,
      );
      expect(hot).toEqual(result(`call-${index}`, `${index}:`.padEnd(1_200, "x")));
    }
    const rolesAndIds = reduced.messages.map((message) =>
      message.role === "toolResult" ? `${message.role}:${message.toolCallId}` : message.role,
    );
    expect(rolesAndIds).toEqual(
      messages.map((message) =>
        message.role === "toolResult" ? `${message.role}:${message.toolCallId}` : message.role,
      ),
    );
  }, 15_000);

  it("preserves tool pairing, custom/user constraints, and archived evidence retrievability", async () => {
    const store = await setup();
    const messages = conversation(24);
    const custom = { role: "policy", content: "CUSTOM CONSTRAINT" } as unknown as AgentMessage;
    messages.splice(1, 0, custom);
    await archive(store, 24);
    const reduced = await reduceContext(options(store, messages, { contextWindowTokens: 9_000 }));

    expect(reduced.messages[0]).toEqual(messages[0]);
    expect(reduced.messages[1]).toBe(custom);
    const calls = new Set<string>();
    for (const message of reduced.messages) {
      if (message.role === "assistant") {
        for (const block of message.content) if (block.type === "toolCall") calls.add(block.id);
      }
      if (message.role === "toolResult") expect(calls.has(message.toolCallId)).toBe(true);
    }
    const receiptMessage = reduced.messages.find(
      (message) =>
        message.role === "toolResult" &&
        message.content[0]?.type === "text" &&
        message.content[0].text.includes("context_vault_observation_receipt"),
    );
    expect(receiptMessage?.role).toBe("toolResult");
    if (receiptMessage?.role !== "toolResult" || receiptMessage.content[0]?.type !== "text")
      throw new Error("receipt missing");
    const receipt = JSON.parse(receiptMessage.content[0].text) as { id: string };
    const metadata = await store.getMetadata(receipt.id);
    expect(metadata?.toolCallId).toBe(receiptMessage.toolCallId);
    expect(await store.read(metadata?.artifactId ?? "")).toContain(`${Number(receiptMessage.toolCallId.slice(5))}:`);
  }, 15_000);

  it("applies hysteresis and is deterministic on repeated hooks", async () => {
    const store = await setup();
    const messages = conversation(20);
    await archive(store, 20);
    const belowTrigger = await reduceContext(options(store, messages, { contextWindowTokens: 20_000 }));
    expect(belowTrigger.triggered).toBe(false);
    expect(belowTrigger.messages).toBe(messages);

    const first = await reduceContext(options(store, messages, { contextWindowTokens: 8_000 }));
    const second = await reduceContext(options(store, first.messages, { contextWindowTokens: 8_000 }));
    expect(second.messages).toEqual(first.messages);
    expect(second.reducedCount).toBe(0);
  }, 15_000);

  it("keeps unarchived and unpaired results intact when the target cannot be reached", async () => {
    const store = await setup();
    const messages = conversation(20);
    await archive(store, 5);
    messages.push(result("orphan", "must survive".repeat(500)));
    const reduced = await reduceContext(options(store, messages, { contextWindowTokens: 5_000 }));

    expect(reduced.targetReached).toBe(false);
    expect(
      reduced.messages.find((message) => message.role === "toolResult" && message.toolCallId === "call-10"),
    ).toEqual(result("call-10", "10:".padEnd(1_200, "x")));
    expect(reduced.messages.at(-1)).toEqual(result("orphan", "must survive".repeat(500)));
  }, 15_000);
});
