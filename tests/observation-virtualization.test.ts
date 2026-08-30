import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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

async function setup(
  options: {
    threshold?: number;
    receiptMax?: number;
    searchPreviewMax?: number;
    invalid?: boolean;
    onArtifactRead?: (artifactId: string) => void;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "context-vault-observations-"));
  roots.push(root);
  const artifactsRoot = join(root, "artifacts");
  const metadataRoot = join(root, "metadata");
  if (options.invalid) await writeFile(artifactsRoot, "not a directory");
  else await mkdir(artifactsRoot);
  const store = new ArtifactStore({ artifactsRoot, metadataRoot, onArtifactRead: options.onArtifactRead });
  return {
    root,
    artifactsRoot,
    metadataRoot,
    store,
    runtime: new ObservationRuntime({
      store,
      archiveThresholdBytes: options.threshold ?? 16,
      receiptMaxBytes: options.receiptMax ?? 512,
      searchPreviewMaxBytes: options.searchPreviewMax,
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
    expect(
      () =>
        new ObservationRuntime({
          ...base,
          archiveThresholdBytes: 1,
          receiptMaxBytes: 512,
          searchPreviewMaxBytes: 4095,
        }),
    ).toThrow("searchPreviewMaxBytes");
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

  it("collapses duplicate artifacts before applying the result limit", async () => {
    let artifactReads = 0;
    const { runtime } = await setup({
      threshold: 1,
      onArtifactRead: () => {
        artifactReads += 1;
      },
    });
    const unique = await runtime.virtualize({
      toolCallId: "unique-older",
      toolName: "bash",
      text: "shared-search-marker unique-diagnostic-evidence",
      isError: false,
    });
    const duplicates = [];
    for (let index = 0; index < 20; index += 1) {
      duplicates.push(
        await runtime.virtualize({
          toolCallId: `duplicate-${index}`,
          toolName: "bash",
          text: "shared-search-marker repeated-diagnostic-evidence",
          isError: false,
        }),
      );
    }
    artifactReads = 0;
    const searched = await runtime.search({ query: "shared-search-marker", limit: 10 });

    expect(searched).toMatchObject({ truncated: false });
    expect(searched.results).toHaveLength(2);
    expect(new Set(searched.results.map((hit) => hit.observation.artifactId))).toHaveLength(2);
    expect(searched.results.map((hit) => hit.observationId)).toContain(unique.observationId);
    expect(searched.results[0]).toMatchObject({
      observationId: duplicates.at(-1)?.observationId,
      occurrenceCount: 20,
      recentObservationIds: duplicates
        .slice(-5)
        .reverse()
        .map((result) => result.observationId),
    });
    expect(searched.results[1]).toMatchObject({
      observationId: unique.observationId,
      occurrenceCount: 1,
      recentObservationIds: [unique.observationId],
    });
    expect(artifactReads).toBe(2);
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

  it("bounds artifact reads for indexed searches across 1,000 Observations", async () => {
    const root = await mkdtemp(join(tmpdir(), "context-vault-observations-scale-"));
    roots.push(root);
    const artifactsRoot = join(root, "artifacts");
    const metadataRoot = join(root, "metadata");
    await Promise.all([mkdir(artifactsRoot), mkdir(metadataRoot)]);
    const records: string[] = [];
    await Promise.all(
      Array.from({ length: 1_000 }, async (_, index) => {
        const content =
          index === 999 ? `background evidence ${index} unique-newest-marker` : `background evidence ${index}`;
        const artifactId = createHash("sha256").update(content).digest("hex");
        await mkdir(join(artifactsRoot, artifactId.slice(0, 2)), { recursive: true });
        await writeFile(join(artifactsRoot, artifactId.slice(0, 2), `${artifactId}.txt`), content);
        records[index] = JSON.stringify({
          schemaVersion: 1,
          artifactId,
          observationId: observationId("scale", `call-${index}`),
          toolName: "read",
          sessionId: "scale",
          contentHash: artifactId,
          originalBytes: Buffer.byteLength(content),
          sanitizedBytes: Buffer.byteLength(content),
          redactionCount: 0,
          createdAt: "2026-08-30T00:00:00.000Z",
          updatedAt: "2026-08-30T00:00:00.000Z",
        });
      }),
    );
    await writeFile(join(metadataRoot, "observations.jsonl"), `${records.join("\n")}\n`);
    let warmReads = 0;
    const warmingStore = new ArtifactStore({
      artifactsRoot,
      metadataRoot,
      onArtifactRead: () => {
        warmReads += 1;
      },
    });
    await warmingStore.searchArtifacts([{ value: "index-hydration", collapseIdentifierSeparators: false }]);
    expect(warmReads).toBe(1_000);

    const coldReads: string[] = [];
    const restartedStore = new ArtifactStore({
      artifactsRoot,
      metadataRoot,
      onArtifactRead: (artifactId) => coldReads.push(artifactId),
    });
    const runtime = new ObservationRuntime({
      store: restartedStore,
      receiptMaxBytes: 512,
      projectId: "project",
      projectRoot: "/project",
      sessionId: "scale",
    });
    const startedAt = performance.now();
    await expect(runtime.search({ query: "missing-scale-marker" })).resolves.toMatchObject({ results: [] });
    const newest = await runtime.search({ query: "unique-newest-marker" });
    const durationMs = performance.now() - startedAt;

    expect(newest.results).toHaveLength(1);
    expect(newest.results[0]?.matches[0]?.text).toContain("unique-newest-marker");
    expect(coldReads).toEqual([newest.results[0]?.observation.artifactId]);
    expect(durationMs).toBeLessThan(1_000);
  }, 30_000);

  it("persists bounded candidates for large artifacts without repeated miss scans", async () => {
    const { runtime, artifactsRoot, metadataRoot } = await setup({ threshold: 10 * 1024 * 1024 });
    const diverse = "large-content-line\n".repeat(32_000);
    const archived = await runtime.virtualize({
      toolCallId: "large-persistent-index",
      toolName: "read",
      text: `${diverse}\nlarge-persistent-marker`,
      isError: false,
    });
    await runtime.search({ query: "large-persistent-marker" });

    const reads: string[] = [];
    const restarted = new ObservationRuntime({
      store: new ArtifactStore({
        artifactsRoot,
        metadataRoot,
        onArtifactRead: (artifactId) => reads.push(artifactId),
      }),
      receiptMaxBytes: 512,
      projectId: "project",
      projectRoot: "/project",
      sessionId: "session",
    });
    await expect(restarted.search({ query: "definitely-missing-large-query" })).resolves.toMatchObject({ results: [] });
    expect(reads).toEqual([]);
    await expect(restarted.search({ query: "large-persistent-marker" })).resolves.toMatchObject({
      results: [{ observationId: archived.observationId }],
    });
    expect(reads).toHaveLength(1);
  });

  it("isolates corrupt derived indexes and individual artifacts", async () => {
    const { runtime, store, artifactsRoot, metadataRoot } = await setup({ threshold: 1_000_000 });
    const healthy = await runtime.virtualize({
      toolCallId: "healthy-corruption-peer",
      toolName: "read",
      text: "shared-corruption-query healthy evidence",
      isError: false,
    });
    const corrupt = await runtime.virtualize({
      toolCallId: "corrupt-evidence",
      toolName: "read",
      text: "shared-corruption-query corrupt evidence",
      isError: false,
    });
    await runtime.search({ query: "shared-corruption-query" });
    const corruptMetadata = await store.getMetadata(corrupt.observationId);
    if (corruptMetadata === undefined) throw new Error("expected corrupt fixture metadata");
    await writeFile(store.artifactPath(corruptMetadata.artifactId), "tampered evidence");
    await writeFile(join(metadataRoot, "observation-search-index-v1.json"), "{broken");

    const reads: string[] = [];
    const restarted = new ObservationRuntime({
      store: new ArtifactStore({
        artifactsRoot,
        metadataRoot,
        onArtifactRead: (artifactId) => reads.push(artifactId),
      }),
      receiptMaxBytes: 512,
      projectId: "project",
      projectRoot: "/project",
      sessionId: "session",
    });
    await expect(restarted.search({ query: "shared-corruption-query" })).resolves.toMatchObject({
      results: [{ observationId: healthy.observationId }],
      partial: true,
      warnings: ["Some archived evidence was unavailable."],
    });
    const readsAfterRecovery = reads.length;
    await expect(restarted.search({ query: "absent-after-corruption" })).resolves.toMatchObject({ results: [] });
    expect(reads).toHaveLength(readsAfterRecovery);
  });

  it("returns a fixed path-free error when search state becomes unavailable", async () => {
    const { runtime, metadataRoot, root } = await setup({ threshold: 1_000_000 });
    await runtime.virtualize({ toolCallId: "privacy", toolName: "read", text: "privacy evidence", isError: false });
    await rm(metadataRoot, { recursive: true, force: true });

    let message = "";
    try {
      await runtime.search({ query: "privacy" });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("Observation search failed.");
    expect(message).not.toContain(root);
  });

  it("fails closed with a path-free error for an unsafe search-index symlink", async () => {
    const { runtime, artifactsRoot, metadataRoot, root } = await setup({ threshold: 1_000_000 });
    await runtime.virtualize({ toolCallId: "symlink", toolName: "read", text: "symlink evidence", isError: false });
    await runtime.search({ query: "symlink" });
    const indexPath = join(metadataRoot, "observation-search-index-v1.json");
    const target = join(root, "unsafe-index-target.json");
    await writeFile(target, "{}");
    await rm(indexPath);
    try {
      await symlink(target, indexPath);
    } catch (error) {
      if (["EACCES", "ENOSYS", "ENOTSUP", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
      throw error;
    }
    const restarted = new ObservationRuntime({
      store: new ArtifactStore({ artifactsRoot, metadataRoot }),
      receiptMaxBytes: 512,
      projectId: "project",
      projectRoot: "/project",
      sessionId: "session",
    });
    let message = "";
    try {
      await restarted.search({ query: "symlink" });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("Observation search failed.");
    expect(message).not.toContain(root);
  });

  it("serializes search snapshots with concurrent garbage collection", async () => {
    const root = await mkdtemp(join(tmpdir(), "context-vault-observations-concurrency-"));
    roots.push(root);
    const artifactsRoot = join(root, "artifacts");
    const metadataRoot = join(root, "metadata");
    await mkdir(artifactsRoot);
    let releaseTombstones = (): void => undefined;
    const tombstonesReleased = new Promise<void>((resolve) => {
      releaseTombstones = resolve;
    });
    let reportTombstones = (): void => undefined;
    const tombstonesWritten = new Promise<void>((resolve) => {
      reportTombstones = resolve;
    });
    const store = new ArtifactStore({
      artifactsRoot,
      metadataRoot,
      faultHook: async (point) => {
        if (point === "after-gc-tombstone-sync") {
          reportTombstones();
          await tombstonesReleased;
        }
      },
    });
    const runtime = new ObservationRuntime({
      store,
      receiptMaxBytes: 512,
      projectId: "project",
      projectRoot: "/project",
      sessionId: "session",
    });
    await runtime.virtualize({
      toolCallId: "concurrent-gc",
      toolName: "read",
      text: "concurrent-search-evidence",
      isError: false,
    });

    const collection = store.garbageCollect({ retentionDays: 0, quotaBytes: 0 });
    await tombstonesWritten;
    const search = runtime.search({ query: "concurrent-search-evidence" });
    releaseTombstones();
    await expect(collection).resolves.toMatchObject({ quotaSatisfied: true });
    await expect(search).resolves.toMatchObject({ results: [] });
  });

  it("serializes search snapshots with concurrent observation upserts", async () => {
    const root = await mkdtemp(join(tmpdir(), "context-vault-observations-upsert-"));
    roots.push(root);
    const artifactsRoot = join(root, "artifacts");
    const metadataRoot = join(root, "metadata");
    await mkdir(artifactsRoot);
    let gateUpsert = false;
    let releaseUpsert = (): void => undefined;
    const upsertReleased = new Promise<void>((resolve) => {
      releaseUpsert = resolve;
    });
    let reportUpsert = (): void => undefined;
    const upsertWritten = new Promise<void>((resolve) => {
      reportUpsert = resolve;
    });
    const store = new ArtifactStore({
      artifactsRoot,
      metadataRoot,
      faultHook: async (point) => {
        if (gateUpsert && point === "after-metadata-sync") {
          reportUpsert();
          await upsertReleased;
        }
      },
    });
    const runtime = new ObservationRuntime({
      store,
      receiptMaxBytes: 512,
      projectId: "project",
      projectRoot: "/project",
      sessionId: "session",
    });
    await runtime.virtualize({ toolCallId: "upsert", toolName: "read", text: "old-upsert-marker", isError: false });
    gateUpsert = true;
    const upsert = runtime.virtualize({
      toolCallId: "upsert",
      toolName: "read",
      text: "new-upsert-marker",
      isError: false,
    });
    await upsertWritten;
    const search = runtime.search({ query: "new-upsert-marker" });
    releaseUpsert();
    await upsert;
    await expect(search).resolves.toMatchObject({ results: [{ matches: [{ text: "new-upsert-marker" }] }] });
  });

  it("conservatively verifies short and Unicode queries", async () => {
    let reads = 0;
    const { runtime } = await setup({
      threshold: 1_000_000,
      onArtifactRead: () => {
        reads += 1;
      },
    });
    await runtime.virtualize({ toolCallId: "fallback-a", toolName: "read", text: "x marker", isError: false });
    await runtime.virtualize({ toolCallId: "fallback-b", toolName: "read", text: "界 marker", isError: false });
    reads = 0;
    await expect(runtime.search({ query: "x" })).resolves.toMatchObject({ results: [expect.any(Object)] });
    await expect(runtime.search({ query: "界" })).resolves.toMatchObject({ results: [expect.any(Object)] });
    expect(reads).toBe(4);
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

  it("ranks partial keyword matches and normalizes code identifiers", async () => {
    const { runtime } = await setup({ threshold: 1 });
    const archived = await runtime.virtualize({
      toolCallId: "issue-53-fixture",
      toolName: "read",
      text: [
        'benchmark: "legacylib-parse-config"',
        "Expand values from the environment while leaving unresolved variables unchanged.",
        "Return an extra metadata key with the unresolved count.",
      ].join("\n"),
      isError: false,
    });
    const recentNoise = await runtime.virtualize({
      toolCallId: "issue-53-recent-noise",
      toolName: "read",
      text: "A recent note mentions config but contains none of the archived behavior.",
      isError: false,
    });

    for (const query of [
      "parse_config",
      "parse_config legacy_api",
      "parse_config env expansion unresolved variable",
      "config metadata unresolved",
      "_unresolved",
    ]) {
      const searched = await runtime.search({ query });
      expect(searched).toMatchObject({ matchMode: "terms", truncated: false });
      expect(searched.results[0]).toMatchObject({
        observationId: archived.observationId,
        score: expect.any(Number),
        matchedTerms: expect.any(Array),
      });
      expect(searched.results[0]?.score).toBeGreaterThan(0);
    }

    const partial = await runtime.search({ query: "parse_config legacy_api" });
    expect(partial.results).toHaveLength(1);
    expect(partial.results[0]).toMatchObject({
      observationId: archived.observationId,
      score: 0.5,
      matchedTerms: ["parse_config"],
      matches: [{ line: 1, text: expect.stringContaining("legacylib-parse-config") }],
    });
    expect(partial.results.map((hit) => hit.observationId)).not.toContain(recentNoise.observationId);
    await expect(runtime.search({ query: "missing absent" })).resolves.toMatchObject({ results: [] });
  });

  it("keeps compound identifiers whole and handles separator-only terms literally", async () => {
    const { runtime } = await setup({ threshold: 1 });
    const falsePositive = await runtime.virtualize({
      toolCallId: "identifier-components-only",
      toolName: "read",
      text: "legacylib mentions isolated api and py tokens; a token then b token",
      isError: false,
    });
    const compound = await runtime.virtualize({
      toolCallId: "identifier-compound",
      toolName: "read",
      text: "legacy-api.py calls a-b and preserves ___ plus +++ markers",
      isError: false,
    });

    for (const query of ["legacy_api.py", "a_b"]) {
      const searched = await runtime.search({ query });
      expect(searched.results).toEqual([
        expect.objectContaining({
          observationId: compound.observationId,
          score: 1,
          matchedTerms: [query],
          matches: expect.arrayContaining([expect.objectContaining({ line: 1 })]),
        }),
      ]);
      expect(searched.results.map((hit) => hit.observationId)).not.toContain(falsePositive.observationId);
    }

    for (const query of ["___", "+++"]) {
      const searched = await runtime.search({ query });
      expect(searched.results.map((hit) => hit.observationId)).toEqual([compound.observationId]);
      expect(searched.results[0]).toMatchObject({ score: 1, matchedTerms: [query] });
    }
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

  it("preserves Unicode case-fold equivalence in phrase fallback", async () => {
    const { runtime } = await setup({ threshold: 1_000_000 });
    const archived = await runtime.virtualize({
      toolCallId: "unicode-phrase-fold",
      toolName: "read",
      text: [...Array.from({ length: 5 }, (_, index) => `ſay decoy ${index}`), "say actual terms match"].join("\n"),
      isError: false,
    });
    await expect(runtime.search({ query: "say", matchMode: "terms" })).resolves.toMatchObject({
      results: [{ observationId: archived.observationId, matches: [{ line: 6, text: "say actual terms match" }] }],
    });
    const phrase = await runtime.search({ query: "say", matchMode: "phrase" });
    expect(phrase.results[0]).toMatchObject({ observationId: archived.observationId });
    expect(phrase.results[0]?.matches[0]).toEqual({ line: 1, text: "ſay decoy 0" });
    expect(phrase.results[0]?.matches).toHaveLength(5);
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

  it("caps a 10-hit by 5-match search preview deterministically and preserves get handoffs", async () => {
    const { runtime, store } = await setup({ threshold: 1 });
    for (let resultIndex = 0; resultIndex < 10; resultIndex += 1) {
      await runtime.virtualize({
        toolCallId: `byte-budget-${resultIndex}`,
        toolName: "read",
        text: Array.from(
          { length: 5 },
          (_, matchIndex) => `budget-marker result-${resultIndex} match-${matchIndex} ${"界".repeat(240)}`,
        ).join("\n"),
        isError: false,
      });
    }
    const unboundedRuntime = new ObservationRuntime({
      store,
      receiptMaxBytes: 512,
      searchPreviewMaxBytes: 128 * 1024,
      projectId: "project",
      projectRoot: "/project",
      sessionId: "session",
    });

    const before = await unboundedRuntime.search({ query: "budget-marker", limit: 10 });
    const after = await runtime.search({ query: "budget-marker", limit: 10 });
    const repeated = await runtime.search({ query: "budget-marker", limit: 10 });
    const beforeBytes = Buffer.byteLength(JSON.stringify(before, null, 2), "utf8");
    const afterJson = JSON.stringify(after, null, 2);
    const afterBytes = Buffer.byteLength(afterJson, "utf8");

    expect(before.results).toHaveLength(10);
    expect(before.results.every((hit) => hit.matches.length === 5)).toBe(true);
    expect(beforeBytes).toBeGreaterThan(afterBytes);
    expect(afterBytes).toBe(after.totalBytes);
    expect(afterBytes).toBeLessThanOrEqual(8 * 1024);
    expect(JSON.parse(afterJson)).toEqual(after);
    expect(repeated).toEqual(after);
    expect(after).toMatchObject({
      byteBudget: 8 * 1024,
      truncated: true,
      omittedResultCount: expect.any(Number),
      omittedMatchCount: expect.any(Number),
    });
    expect(after.omittedResultCount + after.results.length).toBe(10);
    expect(after.omittedMatchCount).toBeGreaterThan(0);
    expect(after.results.map((hit) => hit.observationId)).toEqual(
      before.results.slice(0, after.results.length).map((hit) => hit.observationId),
    );
    for (const hit of after.results) {
      expect(hit).toMatchObject({
        observationId: expect.stringMatching(/^obs_[a-f0-9]{24}$/u),
        occurrenceCount: 1,
        score: 1,
        nextAction: { tool: "context_vault_obs_get", arguments: { id: hit.observationId } },
      });
      await expect(runtime.get(hit.nextAction.arguments)).resolves.toMatchObject({
        observation: { observationId: hit.observationId },
      });
    }
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
