import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { redactSecrets } from "../src/artifacts/redaction.js";
import { ArtifactStore } from "../src/artifacts/store.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "context-vault-artifacts-"));
  roots.push(root);
  return root;
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
  it("redacts before hashing and persistence and records evidence metadata", async () => {
    const root = await tempRoot();
    const store = storeAt(root);
    const archived = await store.archive({
      observationId: "obs-1",
      toolName: "exec_command",
      sessionId: "session-1",
      content: "TOKEN=secret-value-123456\nresult: passed",
    });

    expect(archived.metadata.redactionCount).toBe(1);
    expect(archived.metadata.observationId).toBe("obs-1");
    expect(archived.metadata.toolName).toBe("exec_command");
    expect(archived.metadata.sessionId).toBe("session-1");
    expect(archived.metadata.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(archived.metadata.originalBytes).toBeGreaterThan(archived.metadata.sanitizedBytes - 1);
    expect(archived.metadata.createdAt).toBe("2026-08-14T00:00:00.000Z");

    const persisted = await store.read(archived.artifactId);
    expect(persisted).toContain("[REDACTED]");
    expect(persisted).not.toContain("secret-value-123456");
    expect(await readFile(join(root, "metadata", "observations.jsonl"), "utf8")).not.toContain("secret-value-123456");
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
});
