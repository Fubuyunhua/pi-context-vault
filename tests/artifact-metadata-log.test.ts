import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ArtifactMetadata, ArtifactStore, MAX_METADATA_RECORD_BYTES } from "../src/artifacts/store.js";
import { Telemetry } from "../src/telemetry.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; metadataPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "context-vault-log-"));
  roots.push(root);
  const metadataPath = join(root, "metadata", "observations.jsonl");
  await mkdir(join(root, "metadata"), { recursive: true });
  return { root, metadataPath };
}

function metadata(observationId: string, content: string, toolCallId?: string): ArtifactMetadata {
  const artifactId = createHash("sha256").update(content).digest("hex");
  return {
    schemaVersion: 1,
    artifactId,
    observationId,
    ...(toolCallId === undefined ? {} : { toolCallId }),
    toolName: "read",
    sessionId: "session",
    contentHash: artifactId,
    originalBytes: Buffer.byteLength(content),
    sanitizedBytes: Buffer.byteLength(content),
    redactionCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function storeAt(
  root: string,
  options: ConstructorParameters<typeof ArtifactStore>[0] = {
    artifactsRoot: "",
    metadataRoot: "",
  },
): ArtifactStore {
  return new ArtifactStore({
    ...options,
    artifactsRoot: join(root, "artifacts"),
    metadataRoot: join(root, "metadata"),
    now: () => new Date("2026-02-01T00:00:00.000Z"),
  });
}

describe("append-only observation metadata", () => {
  it("reads duplicate legacy v1 records last-record-wins and lazily appends v2", async () => {
    const { root, metadataPath } = await fixture();
    const first = metadata("same", "first");
    const second = metadata("same", "second");
    await writeFile(metadataPath, `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`);
    const store = storeAt(root);

    expect(await store.listMetadata()).toEqual([second]);
    await store.archive({ observationId: "new", toolName: "read", sessionId: "session", content: "third" });

    const lines = (await readFile(metadataPath, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0] ?? "").schemaVersion).toBe(1);
    expect(JSON.parse(lines[2] ?? "")).toMatchObject({ schemaVersion: 2, recordType: "upsert" });
  });

  it("ignores an unterminated valid or invalid tail and truncates it before the next append", async () => {
    const { root, metadataPath } = await fixture();
    const legacy = metadata("legacy", "one");
    await writeFile(metadataPath, `${JSON.stringify(legacy)}\n${JSON.stringify(metadata("uncommitted", "two"))}`);
    const telemetry = new Telemetry();
    const store = storeAt(root, { artifactsRoot: "", metadataRoot: "", telemetry });

    expect((await store.listMetadata()).map((entry) => entry.observationId)).toEqual(["legacy"]);
    await store.archive({ observationId: "committed", toolName: "read", sessionId: "session", content: "three" });
    const source = await readFile(metadataPath, "utf8");
    expect(source).not.toContain("uncommitted");
    expect(source.endsWith("\n")).toBe(true);
    expect(telemetry.snapshot().metadataTornTailRecoveryCount).toBe(1);

    await writeFile(metadataPath, `${source}{not-json`);
    expect((await store.listMetadata()).map((entry) => entry.observationId)).toEqual(["legacy", "committed"]);
  });

  it("fails closed on newline-committed corruption", async () => {
    const { root, metadataPath } = await fixture();
    await writeFile(metadataPath, "{malformed}\n");
    const store = storeAt(root);
    await expect(store.listMetadata()).rejects.toThrow("Invalid artifact metadata");
    await expect(
      store.archive({ observationId: "nope", toolName: "read", sessionId: "session", content: "x" }),
    ).rejects.toThrow("Invalid artifact metadata");
    expect(await readFile(metadataPath, "utf8")).toBe("{malformed}\n");
  });

  it("supports tombstone, resurrection, and previous tool-call fallback", async () => {
    const { root, metadataPath } = await fixture();
    const older = metadata("older", "one", "call");
    const newer = metadata("newer", "two", "call");
    const tombstone = {
      schemaVersion: 2,
      recordType: "tombstone",
      observationId: newer.observationId,
      artifactId: newer.artifactId,
      deletedAt: "2026-01-02T00:00:00.000Z",
      reason: "garbage-collection",
    };
    await writeFile(
      metadataPath,
      `${JSON.stringify(older)}\n${JSON.stringify({ schemaVersion: 2, recordType: "upsert", metadata: newer })}\n${JSON.stringify(tombstone)}\n`,
    );
    const store = storeAt(root);
    expect(await store.getMetadataByToolCallId("session", "call")).toEqual(older);
    expect(await store.getMetadata("newer")).toBeUndefined();

    await store.archive({
      observationId: "newer",
      toolCallId: "call",
      toolName: "read",
      sessionId: "session",
      content: "resurrected",
    });
    expect((await store.getMetadataByToolCallId("session", "call"))?.observationId).toBe("newer");
  });

  it("reads only a newly appended tail after its cache is primed", async () => {
    const { root, metadataPath } = await fixture();
    const telemetry = new Telemetry();
    const first = storeAt(root, { artifactsRoot: "", metadataRoot: "", telemetry });
    const second = storeAt(root);
    await first.archive({ observationId: "one", toolName: "read", sessionId: "session", content: "one" });
    await first.listMetadata();
    const before = telemetry.snapshot();
    await second.archive({ observationId: "two", toolName: "read", sessionId: "session", content: "two" });
    const fileBytes = Buffer.byteLength(await readFile(metadataPath, "utf8"));
    expect(await first.listMetadata()).toHaveLength(2);
    const bytesRead = telemetry.snapshot().metadataTailBytesRead - before.metadataTailBytesRead;
    expect(bytesRead).toBeGreaterThan(0);
    expect(bytesRead).toBeLessThan(fileBytes);
  });

  it("rereads an equal-length replacement of its cached torn suffix before appending", async () => {
    const { root, metadataPath } = await fixture();
    const first = metadata("first", "first");
    const replacementMetadata = {
      ...metadata("replacement", "replacement"),
      createdAt: "2026-02-01T00:00:00.000Z",
      updatedAt: "2026-02-01T00:00:00.000Z",
    };
    const replacement = `${JSON.stringify({ schemaVersion: 2, recordType: "upsert", metadata: replacementMetadata })}\n`;
    const prefix = `${JSON.stringify(first)}\n`;
    const torn = "x".repeat(Buffer.byteLength(replacement));
    await writeFile(metadataPath, `${prefix}${torn}`);

    const telemetry = new Telemetry();
    const reader = storeAt(root, { artifactsRoot: "", metadataRoot: "", telemetry });
    const writer = storeAt(root);
    expect((await reader.listMetadata()).map((entry) => entry.observationId)).toEqual(["first"]);
    const unchangedBytes = Buffer.byteLength(prefix) + Buffer.byteLength(torn);

    await writer.archive({
      observationId: "replacement",
      toolName: "read",
      sessionId: "session",
      content: "replacement",
    });
    expect(Buffer.byteLength(await readFile(metadataPath, "utf8"))).toBe(unchangedBytes);
    const before = telemetry.snapshot().metadataTailBytesRead;
    await reader.archive({ observationId: "after", toolName: "read", sessionId: "session", content: "after" });

    expect((await reader.listMetadata()).map((entry) => entry.observationId)).toEqual([
      "first",
      "replacement",
      "after",
    ]);
    expect(telemetry.snapshot().metadataTailBytesRead - before).toBe(Buffer.byteLength(replacement));
  });

  it("retries safely when a concurrent writer truncates an oversized tail at a read boundary", async () => {
    const { root, metadataPath } = await fixture();
    const prefix = `${JSON.stringify(metadata("first", "first"))}\n`;
    await writeFile(metadataPath, `${prefix}${"x".repeat(MAX_METADATA_RECORD_BYTES * 8)}`);
    const reader = storeAt(root);
    const writer = storeAt(root);

    const reading = reader.listMetadata();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const publishing = writer.archive({
      observationId: "second",
      toolName: "read",
      sessionId: "session",
      content: "second",
    });
    await expect(Promise.all([reading, publishing])).resolves.toBeDefined();
    expect((await reader.listMetadata()).map((entry) => entry.observationId)).toEqual(["first", "second"]);
  });

  it("streams a huge legacy log without allocating a whole-file read buffer", async () => {
    const { root, metadataPath } = await fixture();
    const line = `${JSON.stringify(metadata("same", "legacy"))}\n`;
    const source = line.repeat(Math.ceil((MAX_METADATA_RECORD_BYTES * 6) / Buffer.byteLength(line)));
    await writeFile(metadataPath, source);
    const allocation = vi.spyOn(Buffer, "allocUnsafe");
    try {
      expect((await storeAt(root).listMetadata()).map((entry) => entry.observationId)).toEqual(["same"]);
      expect(Math.max(...allocation.mock.calls.map(([size]) => size))).toBeLessThanOrEqual(MAX_METADATA_RECORD_BYTES);
      expect(allocation.mock.calls.some(([size]) => size < Buffer.byteLength(source))).toBe(true);
    } finally {
      allocation.mockRestore();
    }
  });

  it("ignores and recovers a huge unterminated suffix with bounded record buffering", async () => {
    const { root, metadataPath } = await fixture();
    const telemetry = new Telemetry();
    const prefix = `${JSON.stringify(metadata("first", "first"))}\n`;
    const tailBytes = MAX_METADATA_RECORD_BYTES * 5;
    await writeFile(metadataPath, `${prefix}${"x".repeat(tailBytes)}`);
    const store = storeAt(root, { artifactsRoot: "", metadataRoot: "", telemetry });

    expect((await store.listMetadata()).map((entry) => entry.observationId)).toEqual(["first"]);
    await store.archive({ observationId: "second", toolName: "read", sessionId: "session", content: "second" });
    expect(telemetry.snapshot().metadataTornBytesDiscarded).toBe(tailBytes);
    expect(await readFile(metadataPath, "utf8")).not.toContain("xxxx");
  });

  it("accepts a maximum-size record but fails closed when its LF commits one extra byte", async () => {
    const { root, metadataPath } = await fixture();
    const base = { ...metadata("boundary", "boundary"), padding: "" };
    const baseBytes = Buffer.byteLength(JSON.stringify(base));
    const atLimit = { ...base, padding: "x".repeat(MAX_METADATA_RECORD_BYTES - baseBytes) };
    const atLimitSource = JSON.stringify(atLimit);
    expect(Buffer.byteLength(atLimitSource)).toBe(MAX_METADATA_RECORD_BYTES);
    await writeFile(metadataPath, `${atLimitSource}\n`);
    expect((await storeAt(root).listMetadata()).map((entry) => entry.observationId)).toEqual(["boundary"]);

    const oversized = `${atLimitSource} \n`;
    await writeFile(metadataPath, oversized);
    await expect(storeAt(root).listMetadata()).rejects.toThrow("record exceeds");
    expect(await readFile(metadataPath, "utf8")).toBe(oversized);
  });

  it("rejects an oversized archive record before publishing an artifact, log bytes, or index state", async () => {
    const { root, metadataPath } = await fixture();
    const store = storeAt(root);
    await store.archive({ observationId: "first", toolName: "read", sessionId: "session", content: "first" });
    const before = await readFile(metadataPath);
    const oversizedContent = "oversized artifact content";
    const artifactId = createHash("sha256").update(oversizedContent).digest("hex");

    await expect(
      store.archive({
        observationId: "x".repeat(MAX_METADATA_RECORD_BYTES),
        toolName: "read",
        sessionId: "session",
        content: oversizedContent,
      }),
    ).rejects.toThrow("record exceeds");

    expect(await readFile(metadataPath)).toEqual(before);
    expect((await store.listMetadata()).map((entry) => entry.observationId)).toEqual(["first"]);
    await expect(stat(store.artifactPath(artifactId))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(storeAt(root).listMetadata()).resolves.toHaveLength(1);
  });

  it("skips compaction when a live legacy record cannot fit its v2 envelope", async () => {
    const { root, metadataPath } = await fixture();
    const base = { ...metadata("large-live", "large"), padding: "" };
    const paddingBytes = MAX_METADATA_RECORD_BYTES - Buffer.byteLength(JSON.stringify(base));
    const largeLegacy = { ...base, padding: "x".repeat(paddingBytes) };
    const original = `${JSON.stringify(largeLegacy)}\n${JSON.stringify(metadata("same", "one"))}\n`;
    expect(Buffer.byteLength(JSON.stringify(largeLegacy))).toBe(MAX_METADATA_RECORD_BYTES);
    await writeFile(metadataPath, original);
    const telemetry = new Telemetry();
    const store = storeAt(root, {
      artifactsRoot: "",
      metadataRoot: "",
      telemetry,
      metadataCompactionThresholdBytes: 0,
      metadataCompactionThresholdObsoleteRecords: 1,
      metadataCompactionThresholdObsoleteRatio: 0,
    });

    await store.archive({ observationId: "same", toolName: "read", sessionId: "session", content: "two" });

    const source = await readFile(metadataPath, "utf8");
    expect(source.startsWith(original)).toBe(true);
    expect(source.trim().split("\n")).toHaveLength(3);
    expect(telemetry.snapshot()).toMatchObject({
      metadataCompactionCount: 0,
      metadataCompactionFailureCount: 1,
      artifactGcFailureCount: 0,
    });
    await expect(storeAt(root).listMetadata()).resolves.toEqual([
      largeLegacy,
      expect.objectContaining({ observationId: "same" }),
    ]);
  });

  it("detects an atomic compaction replacement in another store and fully rebuilds", async () => {
    const { root } = await fixture();
    const telemetry = new Telemetry();
    const reader = storeAt(root, { artifactsRoot: "", metadataRoot: "", telemetry });
    const compactor = storeAt(root, {
      artifactsRoot: "",
      metadataRoot: "",
      metadataCompactionThresholdBytes: 0,
      metadataCompactionThresholdObsoleteRecords: 1,
      metadataCompactionThresholdObsoleteRatio: 0,
    });
    await reader.archive({ observationId: "same", toolName: "read", sessionId: "session", content: "one" });
    await reader.listMetadata();
    const before = telemetry.snapshot().metadataFullRebuildCount;

    await compactor.archive({ observationId: "same", toolName: "read", sessionId: "session", content: "two" });
    expect((await reader.getMetadata("same"))?.artifactId).toBe(createHash("sha256").update("two").digest("hex"));
    expect(telemetry.snapshot().metadataFullRebuildCount).toBeGreaterThan(before);
  });

  it("leaves only an orphan when a fault follows artifact publication", async () => {
    const { root } = await fixture();
    const store = storeAt(root, {
      artifactsRoot: "",
      metadataRoot: "",
      faultHook: (point) => {
        if (point === "after-artifact-publication") throw new Error("simulated crash");
      },
    });
    const artifactId = createHash("sha256").update("orphan content").digest("hex");
    await expect(
      store.archive({ observationId: "orphan", toolName: "read", sessionId: "session", content: "orphan content" }),
    ).rejects.toThrow("simulated crash");
    expect(await store.read(artifactId)).toBe("orphan content");
    expect(await store.listMetadata()).toEqual([]);
  });

  it("recovers a record committed before an injected post-sync archive fault", async () => {
    const { root } = await fixture();
    let inject = true;
    const store = storeAt(root, {
      artifactsRoot: "",
      metadataRoot: "",
      faultHook: (point) => {
        if (inject && point === "after-metadata-sync") throw new Error("simulated crash");
      },
    });
    await expect(
      store.archive({ observationId: "committed", toolName: "read", sessionId: "session", content: "committed" }),
    ).rejects.toThrow("simulated crash");
    inject = false;
    expect((await store.getMetadata("committed"))?.observationId).toBe("committed");
  });

  it("keeps a committed archive successful when post-commit compaction maintenance fails", async () => {
    const { root } = await fixture();
    const telemetry = new Telemetry();
    let failCompaction = false;
    const store = storeAt(root, {
      artifactsRoot: "",
      metadataRoot: "",
      telemetry,
      metadataCompactionThresholdBytes: 0,
      metadataCompactionThresholdObsoleteRecords: 1,
      metadataCompactionThresholdObsoleteRatio: 0,
      faultHook: (point) => {
        if (failCompaction && point === "before-compaction-replace") throw new Error("injected compaction failure");
      },
    });
    await store.archive({ observationId: "same", toolName: "read", sessionId: "session", content: "one" });
    failCompaction = true;
    await expect(
      store.archive({ observationId: "same", toolName: "read", sessionId: "session", content: "two" }),
    ).resolves.toBeDefined();
    expect((await store.getMetadata("same"))?.artifactId).toBe(createHash("sha256").update("two").digest("hex"));
    expect(telemetry.snapshot().metadataCompactionFailureCount).toBe(1);
  });

  it("recovers from a replacement-complete compaction fault on the next read", async () => {
    const { root } = await fixture();
    const telemetry = new Telemetry();
    let inject = false;
    const store = storeAt(root, {
      artifactsRoot: "",
      metadataRoot: "",
      telemetry,
      metadataCompactionThresholdBytes: 0,
      metadataCompactionThresholdObsoleteRecords: 1,
      metadataCompactionThresholdObsoleteRatio: 0,
      faultHook: (point) => {
        if (inject && point === "after-compaction-replace") throw new Error("replacement complete");
      },
    });
    await store.archive({ observationId: "same", toolName: "read", sessionId: "session", content: "one" });
    inject = true;
    await store.archive({ observationId: "same", toolName: "read", sessionId: "session", content: "two" });
    expect((await store.getMetadata("same"))?.artifactId).toBe(createHash("sha256").update("two").digest("hex"));
    expect(telemetry.snapshot().metadataCompactionFailureCount).toBe(1);
  });

  it("durably hides every shared-hash observation before a GC unlink fault", async () => {
    const { root, metadataPath } = await fixture();
    let inject = false;
    const store = storeAt(root, {
      artifactsRoot: "",
      metadataRoot: "",
      faultHook: (point) => {
        if (inject && point === "after-gc-tombstone-sync") throw new Error("simulated crash");
      },
    });
    const first = await store.archive({ observationId: "one", toolName: "read", sessionId: "old", content: "shared" });
    await store.archive({ observationId: "two", toolName: "read", sessionId: "old", content: "shared" });
    inject = true;
    await expect(store.garbageCollect({ retentionDays: 0, quotaBytes: 0 })).rejects.toThrow("simulated crash");

    expect(await store.listMetadata()).toEqual([]);
    expect(await store.read(first.artifactId)).toBe("shared");
    const records = (await readFile(metadataPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records.filter((record) => record.recordType === "tombstone")).toHaveLength(2);
  });

  it("tombstones every selected observation before a fault after the first GC unlink", async () => {
    const { root } = await fixture();
    let inject = false;
    const store = storeAt(root, {
      artifactsRoot: "",
      metadataRoot: "",
      faultHook: (point) => {
        if (inject && point === "after-gc-unlink") throw new Error("simulated partial unlink crash");
      },
    });
    await store.archive({ observationId: "one", toolName: "read", sessionId: "old", content: "one" });
    await store.archive({ observationId: "two", toolName: "read", sessionId: "old", content: "two" });
    inject = true;
    await expect(store.garbageCollect({ retentionDays: 0, quotaBytes: 0 })).rejects.toThrow("partial unlink");
    expect(await store.listMetadata()).toEqual([]);
  });

  it("compacts only after all injectable thresholds trigger and emits v2 live state", async () => {
    const { root, metadataPath } = await fixture();
    const store = storeAt(root, {
      artifactsRoot: "",
      metadataRoot: "",
      metadataCompactionThresholdBytes: 0,
      metadataCompactionThresholdObsoleteRecords: 1,
      metadataCompactionThresholdObsoleteRatio: 0,
    });
    await store.archive({ observationId: "same", toolName: "read", sessionId: "session", content: "one" });
    await store.archive({ observationId: "same", toolName: "read", sessionId: "session", content: "two" });

    const lines = (await readFile(metadataPath, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({
      schemaVersion: 2,
      recordType: "upsert",
      metadata: { observationId: "same" },
    });
    expect((await store.listMetadata()).map((entry) => entry.observationId)).toEqual(["same"]);
  });
});
