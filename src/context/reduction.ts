import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import type { ArtifactMetadata, ArtifactStore } from "../artifacts/store.js";
import { buildReceipt } from "../observations/virtualization.js";

type AgentMessage = ContextEvent["messages"][number];

export interface ReductionOptions {
  store: ArtifactStore;
  messages: AgentMessage[];
  sessionId: string;
  systemPrompt: string;
  contextWindowTokens: number;
  hotObservationCount: number;
  softContextRatio: number;
  targetContextRatio: number;
  receiptMaxBytes: number;
}

export interface ReductionResult {
  messages: AgentMessage[];
  triggered: boolean;
  targetReached: boolean;
  reducedCount: number;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
}

/**
 * Deliberately conservative approximation: one token per three UTF-8 bytes,
 * including JSON structure and the effective system prompt.
 */
export function estimateContextTokens(messages: readonly AgentMessage[], systemPrompt: string): number {
  const bytes = Buffer.byteLength(systemPrompt, "utf8") + Buffer.byteLength(JSON.stringify(messages), "utf8");
  return Math.ceil(bytes / 3);
}

function isReceiptText(text: string): boolean {
  try {
    const value = JSON.parse(text) as { type?: unknown };
    return value.type === "context_vault_observation_receipt";
  } catch {
    return false;
  }
}

function textContent(message: Extract<AgentMessage, { role: "toolResult" }>): string | undefined {
  const text = message.content.filter((block) => block.type === "text").map((block) => block.text);
  return text.length === 0 ? undefined : text.join("\n");
}

function pairedToolCallIds(messages: readonly AgentMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const block of message.content) if (block.type === "toolCall") ids.add(block.id);
  }
  return ids;
}

async function receiptFor(
  store: ArtifactStore,
  metadata: ArtifactMetadata,
  isError: boolean,
  receiptMaxBytes: number,
): Promise<string> {
  const sanitizedContent = await store.read(metadata.artifactId);
  return buildReceipt({
    observationId: metadata.observationId,
    metadata,
    toolName: metadata.toolName,
    isError,
    sanitizedContent,
    maxBytes: receiptMaxBytes,
  });
}

function withReceipt(message: Extract<AgentMessage, { role: "toolResult" }>, receipt: string): AgentMessage {
  return {
    ...message,
    content: [{ type: "text", text: receipt }, ...message.content.filter((block) => block.type !== "text")],
  };
}

export async function reduceContext(options: ReductionOptions): Promise<ReductionResult> {
  const estimatedTokensBefore = estimateContextTokens(options.messages, options.systemPrompt);
  const triggerTokens = options.contextWindowTokens * options.softContextRatio;
  const targetTokens = options.contextWindowTokens * options.targetContextRatio;
  if (estimatedTokensBefore < triggerTokens) {
    return {
      messages: options.messages,
      triggered: false,
      targetReached: estimatedTokensBefore <= targetTokens,
      reducedCount: 0,
      estimatedTokensBefore,
      estimatedTokensAfter: estimatedTokensBefore,
    };
  }

  const toolResultIndexes = options.messages
    .map((message, index) => (message.role === "toolResult" ? index : -1))
    .filter((index) => index >= 0);
  const hot = new Set(toolResultIndexes.slice(-options.hotObservationCount));
  const paired = pairedToolCallIds(options.messages);
  const metadataByToolCallId = new Map<string, ArtifactMetadata>();
  let metadataEntries: ArtifactMetadata[];
  try {
    metadataEntries = await options.store.listMetadata();
  } catch {
    return {
      messages: options.messages,
      triggered: true,
      targetReached: false,
      reducedCount: 0,
      estimatedTokensBefore,
      estimatedTokensAfter: estimatedTokensBefore,
    };
  }
  for (const metadata of metadataEntries) {
    if (metadata.sessionId === options.sessionId && metadata.toolCallId !== undefined) {
      metadataByToolCallId.set(metadata.toolCallId, metadata);
    }
  }
  let messages = options.messages;
  let estimatedTokensAfter = estimatedTokensBefore;
  let reducedCount = 0;

  // Oldest archived raw results are cold. Existing receipts are warm and the
  // newest configured result count is hot. We only replace message content;
  // chronology and the call/result envelope remain untouched.
  for (const index of toolResultIndexes) {
    if (estimatedTokensAfter <= targetTokens) break;
    if (hot.has(index)) continue;
    const message = messages[index];
    if (message?.role !== "toolResult" || !paired.has(message.toolCallId)) continue;
    const text = textContent(message);
    if (text === undefined || isReceiptText(text)) continue;

    const metadata = metadataByToolCallId.get(message.toolCallId);
    if (metadata === undefined) continue;
    try {
      const receipt = await receiptFor(options.store, metadata, message.isError, options.receiptMaxBytes);
      if (Buffer.byteLength(receipt, "utf8") >= Buffer.byteLength(text, "utf8")) continue;
      if (messages === options.messages) messages = [...options.messages];
      messages[index] = withReceipt(message, receipt);
      reducedCount += 1;
      estimatedTokensAfter = estimateContextTokens(messages, options.systemPrompt);
    } catch {
      // A metadata record without readable evidence is not recoverable. Keep the
      // original model-visible result rather than producing a broken receipt.
    }
  }

  return {
    messages,
    triggered: true,
    targetReached: estimatedTokensAfter <= targetTokens,
    reducedCount,
    estimatedTokensBefore,
    estimatedTokensAfter,
  };
}
