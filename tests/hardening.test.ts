import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ArtifactStore } from "../src/artifacts/store.js";
import { loadConfig } from "../src/state/config.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("fails closed on corrupt artifact metadata and configuration without losing evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "context-vault-corrupt-metadata-"));
  roots.push(root);
  const store = new ArtifactStore({ artifactsRoot: join(root, "artifacts"), metadataRoot: join(root, "metadata") });
  const archived = await store.archive({
    observationId: "obs-safe",
    toolName: "exec",
    sessionId: "session-safe",
    content: "API_KEY=release-secret-value\nverified evidence",
  });
  expect(await store.read(archived.artifactId)).toBe("API_KEY=[REDACTED]\nverified evidence");
  await writeFile(join(root, "metadata", "observations.jsonl"), '{"schemaVersion":1,"artifactId":"../escape"}\n');
  await expect(store.listMetadata()).rejects.toThrow("Invalid artifact metadata");
  expect(await store.read(archived.artifactId)).toContain("verified evidence");

  await mkdir(join(root, "project", ".pi"), { recursive: true });
  await writeFile(join(root, "project", ".pi", "context-vault.json"), "{not-json");
  await expect(loadConfig(join(root, "project"))).rejects.toThrow("Unable to read");
});
