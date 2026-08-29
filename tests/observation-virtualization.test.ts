import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "../src/artifacts/store.js";
import {
  buildReceipt,
  MAX_RETRIEVAL_BYTES,
  ObservationRuntime,
  observationId,
} from "../src/observations/virtualization.js";
import { Telemetry } from "../src/telemetry.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(options: { threshold?: number; receiptMax?: number; invalid?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "context-vault-observations-"));
  roots.push(root);
  const artifactsRoot = join(root, "artifacts");
  const metadataRoot = join(root, "metadata");
  if (options.invalid) await writeFile(artifactsRoot, "not a directory");
  else await mkdir(artifactsRoot);
  const store = new ArtifactStore({ artifactsRoot, metadataRoot });
  return {
    store,
    runtime: new ObservationRuntime({
      store,
      archiveThresholdBytes: options.threshold ?? 16,
      receiptMaxBytes: options.receiptMax ?? 512,
      projectId: "project",
      projectRoot: "/project",
      sessionId: "session",
    }),
  };
}

describe("observation virtualization", () => {
  it("validates runtime and receipt byte limits", async () => {
    const { store } = await setup();
    const base = {
      store,
      projectId: "project",
      projectRoot: "/project",
      sessionId: "session",
    };
    expect(() => new ObservationRuntime({ ...base, archiveThresholdBytes: 0, receiptMaxBytes: 512 })).toThrow(
      "archiveThresholdBytes",
    );
    expect(() => new ObservationRuntime({ ...base, archiveThresholdBytes: 1, receiptMaxBytes: 511 })).toThrow(
      "receiptMaxBytes",
    );
  });

  it("archives first, emits deterministic bounded receipts, and preserves error evidence", async () => {
    const { runtime, store } = await setup({ threshold: 8, receiptMax: 512 });
    const text = "TOKEN=long-secret-value\nError: exploded\n".repeat(10);
    const result = await runtime.virtualize({ toolCallId: "call", toolName: "bash", text, isError: true });
    expect(result.observationId).toBe(observationId("session", "call"));
    expect(Buffer.byteLength(result.replacement ?? "")).toBeLessThanOrEqual(512);
    const receipt = JSON.parse(result.replacement ?? "");
    expect(receipt).toMatchObject({ id: result.observationId, tool: "bash", error: true, redactions: 10 });
    expect(receipt.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.evidence.preview).not.toContain("long-secret-value");
    expect(await store.getMetadata(result.observationId)).toBeDefined();
  });

  it("isolates parallel tool calls and supports bounded get and search", async () => {
    const { runtime } = await setup({ threshold: 1 });
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        runtime.virtualize({
          toolCallId: `call-${index}`,
          toolName: index % 2 === 0 ? "read" : "bash",
          text: `line ${index}\nshared needle`,
          isError: false,
        }),
      ),
    );
    expect(new Set(results.map((result) => result.observationId))).toHaveLength(8);
    const fetched = await runtime.get({ id: results[3]?.observationId ?? "", offset: 0, limit: 6 });
    if (fetched.evidence === undefined) throw new Error("expected bounded evidence");
    expect(Buffer.byteLength(fetched.evidence.text)).toBeLessThanOrEqual(6);
    const searched = await runtime.search({ query: "needle", toolName: "read", limit: 3 });
    expect(searched.results).toHaveLength(3);
    expect(searched.results.every((result) => result.observation.toolName === "read")).toBe(true);
    expect(searched.truncated).toBe(true);

    const byHash = await runtime.get({ id: searched.results[0]?.observation.artifactId ?? "" });
    expect(byHash.observation.artifactId).toBe(searched.results[0]?.observation.artifactId);
    const matching = await runtime.get({ id: results[0]?.observationId ?? "", query: "needle", limit: 1 });
    expect(matching.matches).toHaveLength(1);
    expect(matching.truncated).toBe(false);
  });

  it("aligns byte retrieval to UTF-8 boundaries and reports requested and actual ranges", async () => {
    const { runtime } = await setup({ threshold: 1 });
    const archived = await runtime.virtualize({
      toolCallId: "utf8",
      toolName: "read",
      text: "Aé中🙂Z",
      isError: false,
    });

    const alignedStart = await runtime.get({ id: archived.observationId, offset: 2, limit: 8 });
    expect(alignedStart.evidence).toMatchObject({
      byteOffset: 2,
      requestedByteOffset: 2,
      byteStart: 3,
      byteEnd: 10,
      text: "中🙂",
      truncated: true,
    });
    expect(alignedStart.evidence?.text).not.toContain("�");

    const alignedEnd = await runtime.get({ id: archived.observationId, offset: 1, limit: 4 });
    expect(alignedEnd.evidence).toMatchObject({
      requestedByteOffset: 1,
      byteStart: 1,
      byteEnd: 3,
      text: "é",
      truncated: true,
    });
    const nextPage = await runtime.get({ id: archived.observationId, offset: alignedEnd.evidence?.byteEnd, limit: 3 });
    expect(nextPage.evidence).toMatchObject({ byteStart: 3, byteEnd: 6, text: "中", truncated: true });

    const tooSmall = await runtime.get({ id: archived.observationId, offset: 1, limit: 1 });
    expect(tooSmall.evidence).toMatchObject({ byteStart: 1, byteEnd: 1, text: "", truncated: true });
    expect(tooSmall.evidence?.text).not.toContain("�");
  });

  it("rejects byte offsets beyond content and keeps retrieval under the maximum byte limit", async () => {
    const { runtime } = await setup({ threshold: 1 });
    const archived = await runtime.virtualize({
      toolCallId: "maximum",
      toolName: "read",
      text: `${"x ".repeat((MAX_RETRIEVAL_BYTES + 100) / 2)}🙂`,
      isError: false,
    });

    const fetched = await runtime.get({ id: archived.observationId, limit: MAX_RETRIEVAL_BYTES + 1_000 });
    expect(Buffer.byteLength(fetched.evidence?.text ?? "", "utf8")).toBe(MAX_RETRIEVAL_BYTES);
    expect(fetched.evidence).toMatchObject({ byteStart: 0, byteEnd: MAX_RETRIEVAL_BYTES, truncated: true });

    const contentBytes = MAX_RETRIEVAL_BYTES + 104;
    const atEnd = await runtime.get({ id: archived.observationId, offset: contentBytes });
    expect(atEnd.evidence).toMatchObject({
      byteStart: contentBytes,
      byteEnd: contentBytes,
      text: "",
      truncated: false,
    });
    await expect(runtime.get({ id: archived.observationId, offset: contentBytes + 1 })).rejects.toThrow(
      "must not exceed content length",
    );
  });

  it("matches complete long lines before returning bounded match-centered excerpts", async () => {
    const { runtime } = await setup({ threshold: 10 * 1024 * 1024 });
    const lateLine = `${"a ".repeat(256 * 1024)}late-needle-${"界".repeat(2_000)}`;
    const archived = await runtime.virtualize({
      toolCallId: "long-line",
      toolName: "bash",
      text: `first line\n${lateLine}\nlast line`,
      isError: false,
    });

    const fetched = await runtime.get({ id: archived.observationId, query: "late-needle" });
    expect(fetched.matches).toHaveLength(1);
    expect(fetched.matches?.[0]).toMatchObject({ line: 2 });
    expect(fetched.matches?.[0]?.text).toContain("late-needle");
    expect(Buffer.byteLength(fetched.matches?.[0]?.text ?? "", "utf8")).toBeLessThanOrEqual(2 * 1024);
    expect(fetched.matches?.[0]?.text).not.toContain("�");

    const searched = await runtime.search({ query: "late-needle" });
    expect(searched.results).toHaveLength(1);
    expect(searched.results[0]?.matches[0]?.text).toContain("late-needle");
    expect(Buffer.byteLength(searched.results[0]?.matches[0]?.text ?? "", "utf8")).toBeLessThanOrEqual(1024);
    expect(searched.results[0]?.matches[0]?.text).not.toContain("�");
  });

  it("paginates query matches after full-line matching and reports truncation accurately", async () => {
    const { runtime } = await setup({ threshold: 1 });
    const archived = await runtime.virtualize({
      toolCallId: "pagination",
      toolName: "read",
      text: "needle one\nno match\nneedle two\nneedle three",
      isError: false,
    });

    const middle = await runtime.get({ id: archived.observationId, query: "needle", offset: 1, limit: 1 });
    expect(middle.matches).toEqual([{ line: 3, text: "needle two" }]);
    expect(middle.truncated).toBe(true);
    const last = await runtime.get({ id: archived.observationId, query: "needle", offset: 2, limit: 1 });
    expect(last.matches).toEqual([{ line: 4, text: "needle three" }]);
    expect(last.truncated).toBe(false);
    const pastEnd = await runtime.get({ id: archived.observationId, query: "needle", offset: 10, limit: 1 });
    expect(pastEnd.matches).toEqual([]);
    expect(pastEnd.truncated).toBe(false);
  });

  it("returns only sanitized bounded search evidence", async () => {
    const { runtime } = await setup({ threshold: 1 });
    const archived = await runtime.virtualize({
      toolCallId: "sanitized-search",
      toolName: "bash",
      text: `${"x ".repeat(2_000)}TOKEN=long-secret-value searchable-marker`,
      isError: false,
    });

    const fetched = await runtime.get({ id: archived.observationId, query: "searchable-marker" });
    expect(fetched.matches?.[0]?.text).toContain("searchable-marker");
    expect(fetched.matches?.[0]?.text).not.toContain("long-secret-value");
    expect(Buffer.byteLength(fetched.matches?.[0]?.text ?? "", "utf8")).toBeLessThanOrEqual(2 * 1024);
    const searched = await runtime.search({ query: "searchable-marker", toolName: "bash" });
    expect(searched.results[0]?.matches[0]?.text).not.toContain("long-secret-value");
    expect(Buffer.byteLength(searched.results[0]?.matches[0]?.text ?? "", "utf8")).toBeLessThanOrEqual(1024);
  });

  it("searches natural keyword queries with cross-line AND matching in any order", async () => {
    const { runtime } = await setup({ threshold: 1 });
    const archived = await runtime.virtualize({
      toolCallId: "issue-53-fixture",
      toolName: "read",
      text: [
        "The parse_config helper reads each config parser key.",
        "It preserves value identifiers while applying env expansion.",
        "Compatibility remains available through legacy_api.",
      ].join("\n"),
      isError: false,
    });

    for (const query of [
      "parse_config legacy_api",
      "legacy_api parse_config",
      "config parser key value env expansion",
    ]) {
      const searched = await runtime.search({ query });
      expect(searched).toMatchObject({ matchMode: "terms", truncated: false });
      expect(searched.results.map((hit) => hit.observationId)).toEqual([archived.observationId]);
    }
    await expect(runtime.search({ query: "parse_config missing" })).resolves.toMatchObject({ results: [] });
  });

  it("keeps phrase mode and get(query) on contiguous literal per-line matching", async () => {
    const { runtime } = await setup({ threshold: 1 });
    const archived = await runtime.virtualize({
      toolCallId: "phrase",
      toolName: "read",
      text: "Return an extra metadata key\nmetadata\nkey",
      isError: false,
    });

    await expect(runtime.search({ query: "metadata key", matchMode: "phrase" })).resolves.toMatchObject({
      matchMode: "phrase",
      results: [{ observationId: archived.observationId, matches: [{ line: 1 }] }],
    });
    await expect(runtime.search({ query: "extra key", matchMode: "phrase" })).resolves.toMatchObject({ results: [] });
    const fetched = await runtime.get({ id: archived.observationId, query: "extra key" });
    expect(fetched.matches).toEqual([]);
  });

  it("treats punctuation and identifiers as escaped literal terms", async () => {
    const { runtime } = await setup({ threshold: 1 });
    const archived = await runtime.virtualize({
      toolCallId: "literal-identifiers",
      toolName: "bash",
      text: "parse_config maps [legacy_api] to a+b without matching fooXbar; foo.bar is separate.",
      isError: false,
    });

    const searched = await runtime.search({ query: "parse_config [legacy_api] a+b foo.bar" });
    expect(searched.results.map((hit) => hit.observationId)).toEqual([archived.observationId]);
    await expect(runtime.search({ query: "a*b" })).resolves.toMatchObject({ results: [] });
  });

  it("splits terms on Unicode whitespace and case-folds astral Unicode literals", async () => {
    const { runtime } = await setup({ threshold: 1 });
    const archived = await runtime.virtualize({
      toolCallId: "unicode-terms",
      toolName: "read",
      text: "astral identifier 𐐨\naccented CAFÉ marker",
      isError: false,
    });

    const searched = await runtime.search({ query: "𐐀\u2003café" });
    expect(searched.results.map((hit) => hit.observationId)).toEqual([archived.observationId]);
    expect(searched.results[0]?.matches.map((match) => match.line)).toEqual([1, 2]);
  });

  it("uses an artifact ID for a retrievable legacy observation next action", async () => {
    const { runtime, store } = await setup({ threshold: 1 });
    const legacy = await store.archive({
      observationId: "legacy-observation-id",
      toolName: "read",
      sessionId: "legacy-session",
      content: "legacy searchable evidence",
    });

    const searched = await runtime.search({ query: "searchable legacy" });
    const hit = searched.results[0];
    expect(hit).toMatchObject({
      observationId: "legacy-observation-id",
      observation: { observationId: "legacy-observation-id" },
      nextAction: { tool: "context_vault_obs_get", arguments: { id: legacy.artifactId } },
    });
    if (hit === undefined) throw new Error("expected legacy search hit");
    const fetched = await runtime.get(hit.nextAction.arguments);
    expect(fetched.evidence?.text).toBe("legacy searchable evidence");
  });

  it("bounds terms and match lines while preserving observation truncation and get handoff", async () => {
    const { runtime } = await setup({ threshold: 1 });
    const terms = Array.from({ length: 32 }, (_, index) => `t${index}`);
    const first = await runtime.virtualize({
      toolCallId: "bounded-first",
      toolName: "read",
      text: `${terms.join(" ")}\n${Array.from({ length: 6 }, (_, index) => `t0 line ${index}`).join("\n")}`,
      isError: false,
    });
    const newest = await runtime.virtualize({
      toolCallId: "bounded-newest",
      toolName: "read",
      text: terms.join(" "),
      isError: false,
    });

    const bounded = await runtime.search({ query: terms.join(" "), limit: 1 });
    expect(bounded).toMatchObject({ matchMode: "terms", truncated: true });
    expect(bounded.results[0]).toMatchObject({
      observationId: newest.observationId,
      observation: { observationId: newest.observationId },
      matchesTruncated: false,
      nextAction: { tool: "context_vault_obs_get", arguments: { id: newest.observationId } },
    });
    expect(bounded.results[0]?.nextAction.arguments).not.toHaveProperty("query");

    const lineBound = await runtime.search({ query: "t0", limit: 2 });
    const firstHit = lineBound.results.find((hit) => hit.observationId === first.observationId);
    expect(firstHit?.matches).toHaveLength(5);
    expect(firstHit?.matchesTruncated).toBe(true);

    const thirtyThreeTerms = `${terms.join(" ")} t32`;
    await expect(runtime.search({ query: thirtyThreeTerms })).rejects.toThrow("32 terms");
    await expect(runtime.search({ query: thirtyThreeTerms, matchMode: "phrase" })).resolves.toMatchObject({
      matchMode: "phrase",
    });
    await expect(runtime.search({ query: "needle", matchMode: "invalid" as never })).rejects.toThrow("matchMode");
  });

  it("archives below-threshold evidence without replacement and returns defensive status", async () => {
    const { runtime } = await setup({ threshold: 100 });
    const result = await runtime.virtualize({ toolCallId: "small", toolName: "read", text: "small", isError: false });
    expect(result.replacement).toBeUndefined();
    const status = runtime.status();
    expect(status).toMatchObject({ archived: 1, replaced: 0, degraded: false });
    status.failures.push({ observationId: "fake", message: "fake" });
    expect(runtime.status().failures).toEqual([]);
  });

  it("keeps the original result available when archival fails and records degraded status", async () => {
    const { runtime } = await setup({ threshold: 1, invalid: true });
    const result = await runtime.virtualize({
      toolCallId: "failed-call",
      toolName: "bash",
      text: "important original",
      isError: false,
    });
    expect(result.replacement).toBeUndefined();
    expect(runtime.status()).toMatchObject({ archived: 0, replaced: 0, degraded: true });
    expect(runtime.status().failures[0]?.observationId).toBe(result.observationId);
  });

  it("rejects unsafe identifiers and oversized queries", async () => {
    const { runtime } = await setup();
    await expect(runtime.get({ id: "../../secret" })).rejects.toThrow("observation or artifact ID");
    await expect(runtime.search({ query: "x".repeat(513) })).rejects.toThrow("512");
    await expect(runtime.get({ id: "obs_1234567890abcdef12345678", offset: -1 })).rejects.toThrow("offset");
    await expect(runtime.get({ id: "obs_1234567890abcdef12345678", limit: 0 })).rejects.toThrow("limit");
    await expect(runtime.get({ id: "obs_1234567890abcdef12345678", query: "  " })).rejects.toThrow("empty");
    await expect(runtime.get({ id: "obs_1234567890abcdef12345678" })).rejects.toThrow("not found");
    await expect(runtime.search({ query: "needle", toolName: "" })).rejects.toThrow("toolName");
    await expect(runtime.search({ query: "needle", limit: 0 })).rejects.toThrow("limit");
  });

  it("buildReceipt is stable for the same persisted evidence", async () => {
    const { store } = await setup();
    const artifact = await store.archive({
      observationId: "obs_1234567890abcdef12345678",
      toolName: "read",
      sessionId: "session",
      content: "same evidence",
    });
    const input = {
      observationId: artifact.metadata.observationId,
      metadata: artifact.metadata,
      toolName: "read",
      isError: false,
      sanitizedContent: "same evidence",
      maxBytes: 512,
    };
    expect(buildReceipt(input)).toBe(buildReceipt(input));
    expect(() => buildReceipt({ ...input, maxBytes: 100 })).toThrow("at least 512");
  });

  it("telemetry: archive counters track attempts and outcomes without changing replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "context-vault-observations-telemetry-"));
    roots.push(root);
    const artifactsRoot = join(root, "artifacts");
    const metadataRoot = join(root, "metadata");
    await mkdir(artifactsRoot);
    const telemetry = new Telemetry();
    const store = new ArtifactStore({ artifactsRoot, metadataRoot, telemetry });
    const runtime = new ObservationRuntime({
      store,
      archiveThresholdBytes: 16,
      receiptMaxBytes: 512,
      projectId: "project",
      projectRoot: "/project",
      sessionId: "session",
      telemetry,
    });

    // Small text: archived without replacement, behavior unchanged.
    const small = await runtime.virtualize({ toolCallId: "a", toolName: "bash", text: "ok", isError: false });
    expect(small.replacement).toBeUndefined();
    // Large text: archived and replaced, behavior unchanged.
    const big = await runtime.virtualize({
      toolCallId: "b",
      toolName: "bash",
      text: "x".repeat(1_000),
      isError: false,
    });
    expect(big.replacement).toBeDefined();
    // Duplicate content: artifact deduplicated, metadata record still appended.
    await runtime.virtualize({ toolCallId: "c", toolName: "bash", text: "x".repeat(1_000), isError: false });

    let snapshot = telemetry.snapshot();
    expect(snapshot.archiveAttemptCount).toBe(3);
    expect(snapshot.archiveSuccessCount).toBe(3);
    expect(snapshot.archiveFailureCount).toBe(0);
    expect(snapshot.archiveDeduplicatedCount).toBe(1);
    expect(Number.isFinite(snapshot.archiveDurationMsTotal)).toBe(true);
    expect(snapshot.archiveDurationMsTotal).toBeGreaterThanOrEqual(0);

    // A durable archive followed by a receipt read/render failure remains one
    // archive success, never both a success and a failure for the same attempt.
    const read = vi.spyOn(store, "read").mockRejectedValueOnce(new Error("receipt read failed"));
    const receiptFailed = await runtime.virtualize({
      toolCallId: "receipt-failure",
      toolName: "bash",
      text: "y".repeat(1_000),
      isError: false,
    });
    expect(receiptFailed.replacement).toBeUndefined();
    snapshot = telemetry.snapshot();
    expect(snapshot.archiveAttemptCount).toBe(4);
    expect(snapshot.archiveSuccessCount).toBe(4);
    expect(snapshot.archiveFailureCount).toBe(0);
    expect(runtime.status()).toMatchObject({ archived: 4, replaced: 2, degraded: true });
    read.mockRestore();

    // Failure path: an unwritable artifacts root fails the archive but still
    // increments the failure counter and keeps the original result.
    await rm(artifactsRoot, { recursive: true, force: true });
    await writeFile(artifactsRoot, "not a directory");
    const failed = await runtime.virtualize({ toolCallId: "d", toolName: "bash", text: "boom", isError: false });
    expect(failed.replacement).toBeUndefined();
    snapshot = telemetry.snapshot();
    expect(snapshot.archiveAttemptCount).toBe(5);
    expect(snapshot.archiveFailureCount).toBe(1);
    expect(snapshot.archiveSuccessCount).toBe(4);
  });
});
