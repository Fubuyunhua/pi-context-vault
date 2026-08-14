import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../src/artifacts/store.js";
import { indexRepoMapFile } from "../src/repo-map/index.js";
import { loadActiveRepoMapGeneration, RepoMapRuntime } from "../src/repo-map/runtime.js";
import { loadConfig } from "../src/state/config.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporary(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

describe("release security and corrupt-state handling", () => {
  it("rejects repository-map traversal and does not follow a file symlink outside the project", async () => {
    const project = await temporary("context-vault-security-project-");
    const outside = await temporary("context-vault-security-outside-");
    await writeFile(join(outside, "secret.ts"), "export const leakedSecret = true;");

    await expect(indexRepoMapFile(project, "../context-vault-security-outside-/secret.ts")).rejects.toThrow(
      "project-relative",
    );
    await expect(indexRepoMapFile(project, join(outside, "secret.ts"))).rejects.toThrow("project-relative");

    await symlink(join(outside, "secret.ts"), join(project, "linked-secret.ts"));
    expect(await indexRepoMapFile(project, "linked-secret.ts")).toEqual({});
  });

  it("rejects corrupt active pointers and generation metadata", async () => {
    const stateRoot = await temporary("context-vault-corrupt-generation-");
    await mkdir(join(stateRoot, "generations"));
    await writeFile(join(stateRoot, "active.json"), JSON.stringify({ generation: 1, path: "../escape.json" }));
    await expect(loadActiveRepoMapGeneration(stateRoot)).rejects.toThrow("generation path");

    await writeFile(join(stateRoot, "active.json"), JSON.stringify({ generation: 7, path: "generations/7.json" }));
    await writeFile(
      join(stateRoot, "generations", "7.json"),
      JSON.stringify({ schemaVersion: 1, generation: 6, workspaceRevision: "forged", snapshot: {} }),
    );
    await expect(loadActiveRepoMapGeneration(stateRoot)).rejects.toThrow("generation metadata");
  });

  it("fails closed on corrupt artifact metadata and project configuration without losing evidence", async () => {
    const root = await temporary("context-vault-corrupt-metadata-");
    const store = new ArtifactStore({
      artifactsRoot: join(root, "artifacts"),
      metadataRoot: join(root, "metadata"),
    });
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

  it("serializes concurrent runtimes into distinct coherent generations", async () => {
    const project = await temporary("context-vault-concurrent-project-");
    const stateRoot = await temporary("context-vault-concurrent-state-");
    await mkdir(join(project, "src"));
    await writeFile(join(project, "src", "index.ts"), "export const concurrentValue = true;");

    const first = new RepoMapRuntime({ projectRoot: project, stateRoot, watch: false });
    const second = new RepoMapRuntime({ projectRoot: project, stateRoot, watch: false });
    await Promise.all([first.start(), second.start()]);

    const generations = [first.status().generation, second.status().generation].sort((left, right) => left - right);
    expect(generations).toEqual([1, 2]);
    const active = await loadActiveRepoMapGeneration(stateRoot);
    expect(active.generation).toBe(2);
    expect(active.snapshot.files[0]?.path).toBe("src/index.ts");
    expect(JSON.parse(await readFile(join(stateRoot, "active.json"), "utf8"))).toEqual({
      generation: 2,
      path: "generations/2.json",
    });

    await Promise.all([first.close(), second.close()]);
  });
});
