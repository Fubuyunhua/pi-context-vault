import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "../src/artifacts/store.js";
import { ObservationRuntime, type ObservationRuntimeOptions } from "../src/observations/virtualization.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(overrides: Partial<ObservationRuntimeOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), "context-vault-policy-"));
  roots.push(root);
  await mkdir(join(root, "artifacts"));
  const store = new ArtifactStore({ artifactsRoot: join(root, "artifacts"), metadataRoot: join(root, "metadata") });
  const runtime = new ObservationRuntime({
    store,
    archivePolicy: "all",
    archiveMinBytes: 16,
    replacementThresholdBytes: 32,
    archiveErrorsAlways: true,
    receiptMaxBytes: 512,
    projectId: "project",
    projectRoot: "/project",
    sessionId: "session",
    ...overrides,
  });
  return { runtime, store };
}

async function virtualize(runtime: ObservationRuntime, id: string, text: string, isError = false) {
  return runtime.virtualize({ toolCallId: id, toolName: "read", text, isError });
}

describe("observation archive policy", () => {
  it("covers all, errors-and-large, error override, and off without calling storage for ineligible results", async () => {
    const all = await setup({ archivePolicy: "all", archiveMinBytes: 100 });
    await virtualize(all.runtime, "all-short", "x");
    expect(await all.store.listMetadata()).toHaveLength(1);

    const selective = await setup({ archivePolicy: "errors-and-large", archiveMinBytes: 4 });
    const archive = vi.spyOn(selective.store, "archive");
    await virtualize(selective.runtime, "short", "é"); // two UTF-8 bytes
    expect(archive).not.toHaveBeenCalled();
    await virtualize(selective.runtime, "exact", "éé"); // exactly four UTF-8 bytes
    expect(archive).toHaveBeenCalledTimes(1);
    await virtualize(selective.runtime, "short-error", "!", true);
    expect(archive).toHaveBeenCalledTimes(2);

    const noErrorOverride = await setup({
      archivePolicy: "errors-and-large",
      archiveMinBytes: 4,
      archiveErrorsAlways: false,
    });
    const noErrorArchive = vi.spyOn(noErrorOverride.store, "archive");
    await virtualize(noErrorOverride.runtime, "short-error", "!", true);
    expect(noErrorArchive).not.toHaveBeenCalled();

    const off = await setup({ archivePolicy: "off", archiveMinBytes: 1 });
    const offArchive = vi.spyOn(off.store, "archive");
    await virtualize(off.runtime, "large-error", "é".repeat(100), true);
    expect(offArchive).not.toHaveBeenCalled();
  });

  it("uses UTF-8 byte boundaries and replaces only above the independent threshold", async () => {
    const { runtime, store } = await setup({
      archivePolicy: "errors-and-large",
      archiveMinBytes: 4,
      replacementThresholdBytes: 4,
    });

    const exact = await virtualize(runtime, "exact", "éé");
    expect(exact.replacement).toBeUndefined();
    expect(await store.getMetadata(exact.observationId)).toBeDefined();

    const above = await virtualize(runtime, "above", "ééx");
    expect(above.replacement).toBeDefined();
    expect(await store.getMetadata(above.observationId)).toBeDefined();
  });

  it("keeps ineligible evidence model-visible and absent from retrieval and later reduction metadata", async () => {
    const { runtime, store } = await setup({ archivePolicy: "errors-and-large", archiveMinBytes: 100 });
    const result = await virtualize(runtime, "unarchived", "visible raw result");

    expect(result.replacement).toBeUndefined();
    expect(await store.getMetadata(result.observationId)).toBeUndefined();
    expect(await runtime.search({ query: "visible" })).toMatchObject({ results: [] });
    expect(runtime.status()).toMatchObject({ archived: 0, replaced: 0, degraded: false });
  });
});
