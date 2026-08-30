import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { redactSecrets } from "../src/artifacts/redaction.js";
import { ArtifactStore } from "../src/artifacts/store.js";
import { Telemetry } from "../src/telemetry.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "context-vault-artifacts-"));
  roots.push(root);
  return root;
}

async function createDirectorySymlink(target: string, path: string): Promise<boolean> {
  try {
    await symlink(target, path, "junction");
    return true;
  } catch (error) {
    if (["EACCES", "ENOSYS", "ENOTSUP", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      return false;
    }
    throw error;
  }
}

function storeAt(root: string, now = () => new Date("2026-08-14T00:00:00.000Z")): ArtifactStore {
  return new ArtifactStore({
    artifactsRoot: join(root, "artifacts"),
    metadataRoot: join(root, "metadata"),
    now,
  });
}

describe("secret redaction", () => {
  it("redacts common credentials without changing ordinary text", () => {
    const result = redactSecrets(
      [
        "API_KEY=sk-test-super-secret-value",
        "OPENAI_API_KEY=organization-secret-value",
        "AWS_SECRET_ACCESS_KEY=aws-secret-value",
        "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature",
        '"password": "correct horse battery staple"',
        "status=healthy",
      ].join("\n"),
    );

    expect(result.content).not.toContain("sk-test-super-secret-value");
    expect(result.content).not.toContain("eyJhbGciOiJIUzI1NiJ9.payload.signature");
    expect(result.content).not.toContain("correct horse battery staple");
    expect(result.content).toContain("status=healthy");
    expect(result.content).not.toContain("organization-secret-value");
    expect(result.content).not.toContain("aws-secret-value");
    expect(result.redactionCount).toBe(5);
  });
});

describe("artifact store", () => {
  it("validates garbage collection boundaries", async () => {
    const root = await tempRoot();
    const store = storeAt(root);
    await expect(store.garbageCollect({ retentionDays: -1, quotaBytes: 1 })).rejects.toThrow("retentionDays");
    await expect(store.garbageCollect({ retentionDays: 1, quotaBytes: -1 })).rejects.toThrow("quotaBytes");
  });

  it("reports physical deduplicated artifact storage usage without changing evidence", async () => {
    const root = await tempRoot();
    const store = storeAt(root);
    const content = "shared quota evidence";
    const first = await store.archive({
      observationId: "usage-1",
      toolName: "read",
      sessionId: "session-1",
      content,
    });
    await store.archive({
      observationId: "usage-2",
      toolName: "read",
      sessionId: "session-2",
      content,
    });

    await expect(store.storageUsage()).resolves.toEqual({
      artifactCount: 1,
      usedBytes: Buffer.byteLength(content),
    });
    await expect(store.read(first.artifactId)).resolves.toBe(content);
    expect(await store.listMetadata()).toHaveLength(2);
  });

  it("redacts before hashing and persistence and records evidence metadata", async () => {
    const root = await tempRoot();
    const store = storeAt(root);
    const archived = await store.archive({
      observationId: "obs-1",
      toolCallId: "call-1",
      toolName: "exec_command",
      sessionId: "session-1",
      content: "TOKEN=secret-value-123456\nresult: passed",
    });

    expect(archived.metadata.redactionCount).toBe(1);
    expect(archived.metadata.observationId).toBe("obs-1");
    expect(archived.metadata.toolCallId).toBe("call-1");
    expect(archived.metadata.toolName).toBe("exec_command");
    expect(archived.metadata.sessionId).toBe("session-1");
    expect(archived.metadata.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(archived.metadata.originalBytes).toBeGreaterThan(archived.metadata.sanitizedBytes - 1);
    expect(archived.metadata.createdAt).toBe("2026-08-14T00:00:00.000Z");

    const persisted = await store.read(archived.artifactId);
    expect(persisted).toContain("[REDACTED]");
    expect(persisted).not.toContain("secret-value-123456");
    expect(await readFile(join(root, "metadata", "observations.jsonl"), "utf8")).not.toContain("secret-value-123456");
    expect(await store.getMetadataByToolCallId("session-1", "call-1")).toEqual(archived.metadata);
  });

  it("deduplicates sanitized content under concurrent writers and recovers after restart", async () => {
    const root = await tempRoot();
    const first = storeAt(root);
    const second = storeAt(root);
    const content = "PASSWORD=one-secret-value\nhello";

    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        (index % 2 === 0 ? first : second).archive({
          observationId: `obs-${index}`,
          toolName: "read",
          sessionId: "session-1",
          content,
        }),
      ),
    );

    expect(new Set(results.map((result) => result.artifactId))).toHaveLength(1);
    expect(await first.listMetadata()).toHaveLength(12);

    const restarted = storeAt(root);
    const artifactId = results[0]?.artifactId;
    expect(artifactId).toBeDefined();
    if (artifactId === undefined) throw new Error("archive did not return an artifact ID");
    const recovered = await restarted.getMetadata("obs-7");
    expect(recovered?.artifactId).toBe(artifactId);
    expect(await restarted.read(artifactId)).toContain("[REDACTED]");
  });

  it("keeps search candidates coherent across deduplication, upserts, and garbage-collection tombstones", async () => {
    const root = await tempRoot();
    const store = storeAt(root);
    const shared = await store.archive({
      observationId: "search-1",
      toolName: "read",
      sessionId: "session",
      content: "shared indexed evidence",
    });
    await store.archive({
      observationId: "search-2",
      toolName: "read",
      sessionId: "session",
      content: "shared indexed evidence",
    });
    expect(
      (await store.searchArtifacts([{ value: "indexed", collapseIdentifierSeparators: false }])).candidateArtifactIds,
    ).toEqual(new Set([shared.artifactId]));

    const updated = await store.archive({
      observationId: "search-1",
      toolName: "read",
      sessionId: "session",
      content: "replacement searchable evidence",
    });
    expect(
      (await store.searchArtifacts([{ value: "shared", collapseIdentifierSeparators: false }])).candidateArtifactIds,
    ).toEqual(new Set([shared.artifactId]));
    expect(
      (await store.searchArtifacts([{ value: "replacement", collapseIdentifierSeparators: false }]))
        .candidateArtifactIds,
    ).toEqual(new Set([updated.artifactId]));

    await store.garbageCollect({
      retentionDays: 0,
      quotaBytes: 0,
      referencedArtifactIds: new Set([updated.artifactId]),
    });
    expect(
      (await store.searchArtifacts([{ value: "shared", collapseIdentifierSeparators: false }])).candidateArtifactIds,
    ).toEqual(new Set());
    expect(
      (await store.searchArtifacts([{ value: "replacement", collapseIdentifierSeparators: false }]))
        .candidateArtifactIds,
    ).toEqual(new Set([updated.artifactId]));
  });

  it("enforces the configured global derived-index entry bound", async () => {
    const root = await tempRoot();
    const artifactsRoot = join(root, "artifacts");
    const metadataRoot = join(root, "metadata");
    const store = new ArtifactStore({ artifactsRoot, metadataRoot, searchIndexMaxEntries: 2 });
    const artifacts = [];
    for (let index = 0; index < 3; index += 1) {
      artifacts.push(
        await store.archive({
          observationId: `bounded-${index}`,
          toolName: "read",
          sessionId: "session",
          content: `bounded evidence ${index}`,
        }),
      );
    }
    await store.searchArtifacts([{ value: "missing-bound-query", collapseIdentifierSeparators: false }]);
    const persisted = JSON.parse(await readFile(join(metadataRoot, "observation-search-index-v1.json"), "utf8")) as {
      schemaVersion: number;
      algorithm: string;
      checksum: string;
      artifacts: Array<{ artifactId: string; bloom: string }>;
    };
    expect(persisted).toMatchObject({
      schemaVersion: 1,
      algorithm: "cv-search-bloom-v1",
      checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(persisted.artifacts).toHaveLength(2);
    expect(persisted.artifacts.every((entry) => Buffer.from(entry.bloom, "base64").length === 2_048)).toBe(true);

    const coldReads: string[] = [];
    const restarted = new ArtifactStore({
      artifactsRoot,
      metadataRoot,
      searchIndexMaxEntries: 2,
      onArtifactRead: (artifactId) => coldReads.push(artifactId),
    });
    const snapshot = await restarted.searchArtifacts([
      { value: "missing-bound-query", collapseIdentifierSeparators: false },
    ]);
    expect(coldReads).toEqual([artifacts[0]?.artifactId]);
    expect(snapshot.candidateArtifactIds).toEqual(new Set([artifacts[0]?.artifactId]));
  });

  it("publishes on flush and repairs stale snapshots while ignoring crash temp files", async () => {
    const root = await tempRoot();
    const artifactsRoot = join(root, "artifacts");
    const metadataRoot = join(root, "metadata");
    const first = new ArtifactStore({ artifactsRoot, metadataRoot });
    await first.archive({
      observationId: "flush-old",
      toolName: "read",
      sessionId: "session",
      content: "old flushed evidence",
    });
    await first.flushSearchIndex();
    const indexPath = join(metadataRoot, "observation-search-index-v1.json");
    await writeFile(`${indexPath}.crash-temp`, "uncommitted derived cache");

    const writer = new ArtifactStore({ artifactsRoot, metadataRoot });
    const newest = await writer.archive({
      observationId: "flush-new",
      toolName: "read",
      sessionId: "session",
      content: "new stale-boundary marker",
    });
    const reads: string[] = [];
    const repairing = new ArtifactStore({
      artifactsRoot,
      metadataRoot,
      onArtifactRead: (artifactId) => reads.push(artifactId),
    });
    const repaired = await repairing.searchArtifacts([
      { value: "stale-boundary", collapseIdentifierSeparators: false },
    ]);
    expect(repaired.contentByArtifact.get(newest.artifactId)).toContain("stale-boundary");
    expect(reads).toEqual([newest.artifactId, newest.artifactId]);

    reads.length = 0;
    const restarted = new ArtifactStore({
      artifactsRoot,
      metadataRoot,
      onArtifactRead: (artifactId) => reads.push(artifactId),
    });
    await restarted.searchArtifacts([{ value: "missing-after-repair", collapseIdentifierSeparators: false }]);
    expect(reads).toEqual([]);
  });

  it("collects expired and over-quota artifacts while preserving referenced content", async () => {
    const root = await tempRoot();
    let time = new Date("2026-01-01T00:00:00.000Z");
    const store = storeAt(root, () => time);
    const expired = await store.archive({
      observationId: "expired",
      toolName: "read",
      sessionId: "old-session",
      content: "x".repeat(80),
    });
    time = new Date("2026-01-20T00:00:00.000Z");
    const referenced = await store.archive({
      observationId: "referenced",
      toolName: "read",
      sessionId: "old-session",
      content: "y".repeat(80),
    });
    time = new Date("2026-02-10T00:00:00.000Z");
    const newest = await store.archive({
      observationId: "newest",
      toolName: "read",
      sessionId: "new-session",
      content: "z".repeat(80),
    });

    const result = await store.garbageCollect({
      retentionDays: 30,
      quotaBytes: 100,
      referencedArtifactIds: new Set([referenced.artifactId]),
    });

    expect(result.deletedArtifactIds).toContain(expired.artifactId);
    expect(result.deletedArtifactIds).toContain(newest.artifactId);
    expect(result.deletedArtifactIds).not.toContain(referenced.artifactId);
    await expect(store.read(expired.artifactId)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await store.read(referenced.artifactId)).toBe("y".repeat(80));
    expect((await store.listMetadata()).map((entry) => entry.observationId)).toEqual(["referenced"]);
  });

  it("never removes a referenced artifact even when quota cannot be satisfied", async () => {
    const root = await tempRoot();
    const store = storeAt(root);
    const artifact = await store.archive({
      observationId: "pinned",
      toolName: "read",
      sessionId: "session",
      content: "important".repeat(20),
    });

    const result = await store.garbageCollect({
      retentionDays: 1,
      quotaBytes: 1,
      referencedArtifactIds: new Set([artifact.artifactId]),
    });

    expect(result.quotaSatisfied).toBe(false);
    expect(await store.read(artifact.artifactId)).toContain("important");
  });

  it("protects metadata for two concurrent stores and active sessions under quota pressure", async () => {
    const root = await tempRoot();
    const first = storeAt(root);
    const second = storeAt(root);
    const [firstLease, secondLease] = await Promise.all([
      first.registerActiveSession("session-a"),
      second.registerActiveSession("session-b"),
    ]);
    const [firstArtifact, secondArtifact] = await Promise.all([
      first.archive({
        observationId: "active-a",
        toolName: "read",
        sessionId: "session-a",
        content: "a".repeat(80),
      }),
      second.archive({
        observationId: "active-b",
        toolName: "read",
        sessionId: "session-b",
        content: "b".repeat(80),
      }),
    ]);

    const protectedResult = await first.garbageCollect({ retentionDays: 0, quotaBytes: 1 });
    expect(protectedResult.quotaSatisfied).toBe(false);
    expect(await first.read(firstArtifact.artifactId)).toBe("a".repeat(80));
    expect(await first.read(secondArtifact.artifactId)).toBe("b".repeat(80));

    await second.releaseActiveSession(secondLease);
    const afterRelease = await first.garbageCollect({ retentionDays: 0, quotaBytes: 1 });
    expect(afterRelease.deletedArtifactIds).toContain(secondArtifact.artifactId);
    expect(afterRelease.deletedArtifactIds).not.toContain(firstArtifact.artifactId);
    await first.releaseActiveSession(firstLease);
  });

  it("keeps resumed-session owners independent and releases leases owner-safely", async () => {
    const root = await tempRoot();
    const original = storeAt(root);
    const resumed = storeAt(root);
    const originalLease = await original.registerActiveSession("resumed-session");
    const resumedLease = await resumed.registerActiveSession("resumed-session");
    const artifact = await resumed.archive({
      observationId: "resumed-observation",
      toolName: "read",
      sessionId: "resumed-session",
      content: "resumed evidence",
    });

    await original.releaseActiveSession(originalLease);
    expect((await resumed.garbageCollect({ retentionDays: 0, quotaBytes: 0 })).quotaSatisfied).toBe(false);
    expect(await resumed.read(artifact.artifactId)).toBe("resumed evidence");

    // Releasing an already-released owner cannot remove the resumed owner.
    await original.releaseActiveSession(originalLease);
    expect(JSON.parse(await readFile(join(root, "metadata", "active-sessions.json"), "utf8")).leases).toHaveLength(1);
    await resumed.releaseActiveSession(resumedLease);
  });

  it("protects a shared content hash and reports an unsatisfied quota", async () => {
    const root = await tempRoot();
    const active = storeAt(root);
    const inactive = storeAt(root);
    const lease = await active.registerActiveSession("active-session");
    const activeArtifact = await active.archive({
      observationId: "active-shared",
      toolName: "read",
      sessionId: "active-session",
      content: "shared content",
    });
    const inactiveArtifact = await inactive.archive({
      observationId: "inactive-shared",
      toolName: "read",
      sessionId: "inactive-session",
      content: "shared content",
    });
    expect(inactiveArtifact.artifactId).toBe(activeArtifact.artifactId);

    const result = await inactive.garbageCollect({ retentionDays: 0, quotaBytes: 0 });
    expect(result.quotaSatisfied).toBe(false);
    expect(result.deletedArtifactIds).not.toContain(activeArtifact.artifactId);
    expect((await inactive.listMetadata()).map((entry) => entry.observationId).sort()).toEqual([
      "active-shared",
      "inactive-shared",
    ]);
    await active.releaseActiveSession(lease);
  });

  it("serializes registration/archive with GC so no active-session evidence can fall through", async () => {
    const root = await tempRoot();
    const archiver = storeAt(root);
    const collector = storeAt(root);
    const lease = await archiver.registerActiveSession("ordered-session");

    const [artifact] = await Promise.all([
      archiver.archive({
        observationId: "ordered-observation",
        toolName: "read",
        sessionId: "ordered-session",
        content: "ordering evidence",
      }),
      collector.garbageCollect({ retentionDays: 0, quotaBytes: 0 }),
    ]);

    expect(await collector.read(artifact.artifactId)).toBe("ordering evidence");
    expect((await collector.listMetadata()).map((entry) => entry.observationId)).toContain("ordered-observation");
    await archiver.releaseActiveSession(lease);
  });

  it("cleans demonstrably dead leases but fails closed on malformed lease state", async () => {
    const root = await tempRoot();
    const store = new ArtifactStore({
      artifactsRoot: join(root, "artifacts"),
      metadataRoot: join(root, "metadata"),
      isProcessAlive: () => false,
    });
    await store.registerActiveSession("dead-session");
    const artifact = await store.archive({
      observationId: "dead-observation",
      toolName: "read",
      sessionId: "dead-session",
      content: "collect after owner death",
    });
    const collected = await store.garbageCollect({ retentionDays: 0, quotaBytes: 0 });
    expect(collected.deletedArtifactIds).toContain(artifact.artifactId);
    expect(JSON.parse(await readFile(join(root, "metadata", "active-sessions.json"), "utf8")).leases).toEqual([]);

    const survivor = await store.archive({
      observationId: "malformed-survivor",
      toolName: "read",
      sessionId: "inactive-session",
      content: "must survive malformed registry",
    });
    await writeFile(join(root, "metadata", "active-sessions.json"), "{malformed");
    await expect(store.garbageCollect({ retentionDays: 0, quotaBytes: 0 })).rejects.toThrow(
      "Invalid active session registry",
    );
    expect(await store.read(survivor.artifactId)).toBe("must survive malformed registry");

    const registryPath = join(root, "metadata", "active-sessions.json");
    await rm(registryPath);
    await mkdir(registryPath);
    await expect(store.garbageCollect({ retentionDays: 0, quotaBytes: 0 })).rejects.toThrow();
    expect(await store.read(survivor.artifactId)).toBe("must survive malformed registry");
  });

  it("fails archive and GC on artifact shard symlinks into both repository roots", async () => {
    for (const kind of ["legacy", "new"] as const) {
      const root = await tempRoot();
      const content = `symlink-protected-${kind}`;
      const artifactId = createHash("sha256").update(content).digest("hex");
      const target =
        kind === "legacy"
          ? join(root, "context-vault", "projects", "project", "repo-map")
          : join(root, "pi-repo-context", "projects", "project", "repo-map");
      await mkdir(join(root, "artifacts"), { recursive: true });
      await mkdir(join(root, "metadata"), { recursive: true });
      await mkdir(target, { recursive: true });
      await writeFile(join(target, "sentinel"), `${kind}-sentinel`);
      if (!(await createDirectorySymlink(target, join(root, "artifacts", artifactId.slice(0, 2))))) return;
      const store = storeAt(root);
      await expect(
        store.archive({ observationId: `obs-${kind}`, toolName: "read", sessionId: "session", content }),
      ).rejects.toThrow(/symbolic-link|Unsafe/u);
      await expect(store.garbageCollect({ retentionDays: 0, quotaBytes: 0 })).rejects.toThrow("Unsafe artifact shard");
      expect(await readFile(join(target, "sentinel"), "utf8")).toBe(`${kind}-sentinel`);
      await expect(stat(join(target, `${artifactId}.txt`))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("records a Vault-owned artifact GC failure when unlink fails", async () => {
    const root = await tempRoot();
    const telemetry = new Telemetry();
    let artifactPath = "";
    const store = new ArtifactStore({
      artifactsRoot: join(root, "artifacts"),
      metadataRoot: join(root, "metadata"),
      telemetry,
      now: () => new Date("2026-08-14T00:00:00.000Z"),
      faultHook: async (point) => {
        if (point !== "after-gc-tombstone-sync") return;
        await rm(artifactPath);
        await mkdir(artifactPath);
      },
    });
    const archived = await store.archive({
      observationId: "gc-unlink-failure",
      toolName: "read",
      sessionId: "inactive",
      content: "unlink must fail",
    });
    artifactPath = join(root, "artifacts", archived.artifactId.slice(0, 2), `${archived.artifactId}.txt`);
    await expect(store.garbageCollect({ retentionDays: 0, quotaBytes: 0 })).rejects.toThrow();
    expect(telemetry.snapshot().artifactGcFailureCount).toBe(1);
    expect(telemetry.snapshot()).not.toHaveProperty("maintenanceFailureCount");
  });

  it("throws persistence failures so callers can keep the original tool result", async () => {
    const root = await tempRoot();
    const invalidRoot = join(root, "not-a-directory");
    await writeFile(invalidRoot, "file");
    const store = new ArtifactStore({
      artifactsRoot: join(invalidRoot, "artifacts"),
      metadataRoot: join(root, "metadata"),
    });

    await expect(
      store.archive({
        observationId: "obs-fail",
        toolName: "exec",
        sessionId: "session",
        content: "must remain in the caller",
      }),
    ).rejects.toThrow();
    await expect(stat(join(root, "metadata", "observations.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("telemetry: metadata read/write timers accumulate", async () => {
    const root = await tempRoot();
    const telemetry = new Telemetry();
    const store = new ArtifactStore({
      artifactsRoot: join(root, "artifacts"),
      metadataRoot: join(root, "metadata"),
      telemetry,
    });
    await store.archive({ observationId: "obs-telemetry-1", toolName: "read", sessionId: "s", content: "a" });
    await store.archive({ observationId: "obs-telemetry-2", toolName: "read", sessionId: "s", content: "b" });

    const snapshot = telemetry.snapshot();
    expect(Number.isFinite(snapshot.metadataReadDurationMsTotal)).toBe(true);
    expect(Number.isFinite(snapshot.metadataWriteDurationMsTotal)).toBe(true);
    expect(snapshot.metadataReadDurationMsTotal).toBeGreaterThanOrEqual(0);
    expect(snapshot.metadataWriteDurationMsTotal).toBeGreaterThanOrEqual(0);

    await store.archive({ observationId: "obs-telemetry-3", toolName: "read", sessionId: "s", content: "c" });
    const after = telemetry.snapshot();
    expect(after.metadataReadDurationMsTotal).toBeGreaterThanOrEqual(snapshot.metadataReadDurationMsTotal);
    expect(after.metadataWriteDurationMsTotal).toBeGreaterThanOrEqual(snapshot.metadataWriteDurationMsTotal);
  });
});
