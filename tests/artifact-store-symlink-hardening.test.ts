import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { type ArtifactMetadata, ArtifactStore } from "../src/artifacts/store.js";
import { reduceContext } from "../src/context/reduction.js";
import { ObservationRuntime } from "../src/observations/virtualization.js";

type AgentMessage = ContextEvent["messages"][number];
type RepoKind = "legacy-context-vault-repo-map" | "pi-repo-context";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "context-vault-symlink-hardening-"));
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

function paths(root: string, kind: RepoKind) {
  const piRoot = join(root, "pi");
  const stateRoot = join(piRoot, "context-vault", "projects", "project-id");
  const repoRoot =
    kind === "legacy-context-vault-repo-map"
      ? join(stateRoot, "repo-map")
      : join(piRoot, "pi-repo-context", "projects", "project-id", "repo-map");
  return {
    piRoot,
    stateRoot,
    artifactsRoot: join(stateRoot, "artifacts"),
    metadataRoot: join(stateRoot, "metadata"),
    repoRoot,
  };
}

async function prepare(root: string, kind: RepoKind) {
  const value = paths(root, kind);
  await mkdir(value.artifactsRoot, { recursive: true });
  await mkdir(value.metadataRoot);
  await mkdir(value.repoRoot, { recursive: true });
  await writeFile(join(value.repoRoot, "sentinel.txt"), `repo-sentinel:${kind}`);
  return value;
}

async function treeSnapshot(root: string, relative = ""): Promise<string[]> {
  const result: string[] = [];
  for (const name of (await readdir(join(root, relative))).sort()) {
    const childRelative = join(relative, name);
    const child = join(root, childRelative);
    const info = await lstat(child);
    if (info.isDirectory() && !info.isSymbolicLink()) {
      result.push(`d:${childRelative}`);
      result.push(...(await treeSnapshot(root, childRelative)));
    } else if (info.isFile()) {
      result.push(`f:${childRelative}:${(await readFile(child)).toString("base64")}`);
    } else {
      result.push(`other:${childRelative}`);
    }
  }
  return result;
}

function metadataFor(artifactId: string): ArtifactMetadata {
  return {
    schemaVersion: 1,
    artifactId,
    observationId: `obs_${"a".repeat(24)}`,
    toolCallId: "repo-call",
    toolName: "read",
    sessionId: "session",
    contentHash: artifactId,
    originalBytes: 0,
    sanitizedBytes: 0,
    redactionCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

async function writeMetadata(path: string, metadata: ArtifactMetadata): Promise<void> {
  await writeFile(path, `${JSON.stringify({ schemaVersion: 2, recordType: "upsert", metadata })}\n`);
}

function runtime(store: ArtifactStore): ObservationRuntime {
  return new ObservationRuntime({
    store,
    archiveThresholdBytes: 1,
    receiptMaxBytes: 512,
    projectId: "project-id",
    projectRoot: "/project",
    sessionId: "session",
  });
}

function reductionMessages(): AgentMessage[] {
  return [
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "repo-call", name: "read", arguments: {} }],
      timestamp: 1,
    } as AgentMessage,
    {
      role: "toolResult",
      toolCallId: "repo-call",
      toolName: "read",
      content: [{ type: "text", text: "caller-owned evidence".repeat(200) }],
      isError: false,
      timestamp: 2,
    } as AgentMessage,
  ];
}

describe("ArtifactStore symlink-swap hardening", () => {
  for (const kind of ["legacy-context-vault-repo-map", "pi-repo-context"] as const) {
    for (const timing of ["static", "post-start"] as const) {
      it(`fails closed for ${timing} artifact-shard redirects into ${kind} across read/get/search/reduction`, async () => {
        const root = await tempRoot();
        const value = await prepare(root, kind);
        const repoEvidence = `Repo evidence must not escape:${kind}:${timing}`;
        const artifactId = createHash("sha256").update(repoEvidence).digest("hex");
        const metadata = metadataFor(artifactId);
        await writeMetadata(join(value.metadataRoot, "observations.jsonl"), metadata);
        const targetShard = join(value.repoRoot, "matching-shard");
        await mkdir(targetShard);
        await writeFile(join(targetShard, `${artifactId}.txt`), repoEvidence);
        const before = await treeSnapshot(value.repoRoot);
        const store = new ArtifactStore({ artifactsRoot: value.artifactsRoot, metadataRoot: value.metadataRoot });
        if (timing === "post-start") await expect(store.listMetadata()).resolves.toHaveLength(1);
        const shard = join(value.artifactsRoot, artifactId.slice(0, 2));
        await rm(shard, { recursive: true, force: true });
        if (!(await createDirectorySymlink(targetShard, shard))) return;

        await expect(store.read(artifactId)).rejects.toThrow(/Unsafe|symbolic|replaced/u);
        await expect(runtime(store).get({ id: metadata.observationId })).rejects.toThrow(/Unsafe|symbolic|replaced/u);
        await expect(runtime(store).search({ query: "Repo evidence" })).rejects.toThrow("Observation search failed.");
        const messages = reductionMessages();
        const reduced = await reduceContext({
          store,
          messages,
          sessionId: "session",
          systemPrompt: "",
          contextWindowTokens: 100,
          hotObservationCount: 0,
          softContextRatio: 0.1,
          targetContextRatio: 0.05,
          receiptMaxBytes: 512,
        });
        expect(reduced.reducedCount).toBe(0);
        expect(JSON.stringify(reduced.messages)).not.toContain(repoEvidence);
        expect(await treeSnapshot(value.repoRoot)).toEqual(before);

        await rm(shard);
        await mkdir(shard);
        await writeFile(join(shard, `${artifactId}.txt`), repoEvidence);
        const restarted = new ArtifactStore({ artifactsRoot: value.artifactsRoot, metadataRoot: value.metadataRoot });
        await expect(restarted.read(artifactId)).resolves.toBe(repoEvidence);
      });

      it(`rejects ${timing} artifact final-file symlinks into ${kind}`, async () => {
        const root = await tempRoot();
        const value = await prepare(root, kind);
        const content = `matching final target:${kind}:${timing}`;
        const artifactId = createHash("sha256").update(content).digest("hex");
        const shard = join(value.artifactsRoot, artifactId.slice(0, 2));
        await mkdir(shard);
        const target = join(value.repoRoot, `${artifactId}.txt`);
        await writeFile(target, content);
        const before = await treeSnapshot(value.repoRoot);
        const store = new ArtifactStore({ artifactsRoot: value.artifactsRoot, metadataRoot: value.metadataRoot });
        if (timing === "post-start") await expect(store.listMetadata()).resolves.toEqual([]);
        const artifactPath = join(shard, `${artifactId}.txt`);
        await symlink(target, artifactPath, "file");

        await expect(store.read(artifactId)).rejects.toThrow(/Unsafe|symbolic|state file/u);
        await expect(
          store.archive({ observationId: "obs-final", toolName: "read", sessionId: "session", content }),
        ).rejects.toThrow(/Unsafe|symbolic|state file/u);
        await expect(store.garbageCollect({ retentionDays: 0, quotaBytes: 0 })).rejects.toThrow(/Unsafe/u);
        expect(await treeSnapshot(value.repoRoot)).toEqual(before);
      });

      it(`rejects ${timing} metadata-log symlinks for reads and appends into ${kind}`, async () => {
        const root = await tempRoot();
        const value = await prepare(root, kind);
        const repoEvidence = `metadata Repo evidence:${kind}:${timing}`;
        const artifactId = createHash("sha256").update(repoEvidence).digest("hex");
        const target = join(value.repoRoot, "observations.jsonl");
        await writeMetadata(target, metadataFor(artifactId));
        const before = await treeSnapshot(value.repoRoot);
        const store = new ArtifactStore({ artifactsRoot: value.artifactsRoot, metadataRoot: value.metadataRoot });
        if (timing === "post-start") await expect(store.listMetadata()).resolves.toEqual([]);
        const metadataPath = join(value.metadataRoot, "observations.jsonl");
        await rm(metadataPath, { force: true });
        await symlink(target, metadataPath, "file");

        await expect(store.listMetadata()).rejects.toThrow(/Unsafe|symbolic|state file/u);
        await expect(runtime(store).search({ query: "Repo evidence" })).rejects.toThrow("Observation search failed.");
        await expect(
          store.archive({ observationId: "obs-append", toolName: "read", sessionId: "session", content: "safe" }),
        ).rejects.toThrow(/Unsafe|symbolic|state file/u);
        expect(await treeSnapshot(value.repoRoot)).toEqual(before);
      });

      it(`rejects ${timing} active-session symlinks for read/write/release into ${kind}`, async () => {
        const root = await tempRoot();
        const value = await prepare(root, kind);
        const target = join(value.repoRoot, "active-sessions.json");
        await writeFile(target, JSON.stringify({ schemaVersion: 1, leases: [] }));
        const before = await treeSnapshot(value.repoRoot);
        const store = new ArtifactStore({ artifactsRoot: value.artifactsRoot, metadataRoot: value.metadataRoot });
        const existing =
          timing === "post-start" ? await store.registerActiveSession("existing") : { sessionId: "x", ownerId: "y" };
        const activePath = join(value.metadataRoot, "active-sessions.json");
        await rm(activePath, { force: true });
        await symlink(target, activePath, "file");

        await expect(store.registerActiveSession("new-session")).rejects.toThrow(/Unsafe|symbolic|state file/u);
        await expect(store.releaseActiveSession(existing)).rejects.toThrow(/Unsafe|symbolic|state file/u);
        await expect(store.garbageCollect({ retentionDays: 1, quotaBytes: 1 })).rejects.toThrow(
          /Unsafe|symbolic|state file/u,
        );
        expect(await treeSnapshot(value.repoRoot)).toEqual(before);
      });
    }

    it(`detects every owned ancestor/root replacement after startup before touching ${kind}`, async () => {
      for (const component of ["context-vault", "projects", "project-id", "artifacts", "metadata"] as const) {
        const root = await tempRoot();
        const value = await prepare(root, kind);
        const store = new ArtifactStore({ artifactsRoot: value.artifactsRoot, metadataRoot: value.metadataRoot });
        const archived = await store.archive({
          observationId: `obs-${component}`,
          toolName: "read",
          sessionId: "session",
          content: `normal-before-${component}`,
        });
        const owned =
          component === "context-vault"
            ? join(value.piRoot, component)
            : component === "projects"
              ? join(value.piRoot, "context-vault", component)
              : component === "project-id"
                ? value.stateRoot
                : join(value.stateRoot, component);
        const backup = `${owned}.backup`;
        const redirect = join(root, `redirect-${kind}-${component}`);
        await mkdir(redirect);
        await writeFile(join(redirect, "sentinel.txt"), `unchanged:${kind}:${component}`);
        const before = await treeSnapshot(redirect);
        await rename(owned, backup);
        if (!(await createDirectorySymlink(redirect, owned))) return;

        await expect(store.listMetadata()).rejects.toThrow(/Unsafe|replaced|symbolic/u);
        await expect(store.read(archived.artifactId)).rejects.toThrow(/Unsafe|replaced|symbolic/u);
        expect(await treeSnapshot(redirect)).toEqual(before);

        await rm(owned);
        await rename(backup, owned);
        const restarted = new ArtifactStore({ artifactsRoot: value.artifactsRoot, metadataRoot: value.metadataRoot });
        await expect(restarted.read(archived.artifactId)).resolves.toBe(`normal-before-${component}`);
      }
    });
  }
});
