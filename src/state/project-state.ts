import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { durableMkdir } from "./atomic.js";

export const STATE_SCHEMA_VERSION = 1;

export interface ProjectStatePaths {
  projectId: string;
  projectRoot: string;
  stateRoot: string;
  artifactsRoot: string;
  metadataRoot: string;
}

async function assertOwnedDirectory(
  path: string,
  canonicalStateRoot: string,
  expectedRelativePath: string,
): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Unsafe Context Vault state directory: ${path}`);
  const canonicalPath = await realpath(path);
  const relation = relative(canonicalStateRoot, canonicalPath);
  if (
    isAbsolute(relation) ||
    relation === ".." ||
    relation.startsWith(`..${sep}`) ||
    relation !== expectedRelativePath
  ) {
    throw new Error(`Context Vault state directory escapes its root: ${path}`);
  }
}

export async function resolveProjectState(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProjectStatePaths> {
  const projectRoot = await realpath(resolve(cwd));
  const projectId = createHash("sha256").update(projectRoot).digest("hex").slice(0, 32);
  const piRoot = resolve(env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"));
  const contextVaultRoot = join(piRoot, "context-vault");
  const projectsRoot = join(contextVaultRoot, "projects");
  const stateRoot = join(projectsRoot, projectId);
  const artifactsRoot = join(stateRoot, "artifacts");
  const metadataRoot = join(stateRoot, "metadata");

  await durableMkdir(contextVaultRoot);
  const canonicalPiRoot = await realpath(piRoot);
  await assertOwnedDirectory(contextVaultRoot, canonicalPiRoot, "context-vault");

  await durableMkdir(projectsRoot);
  const canonicalContextVaultRoot = await realpath(contextVaultRoot);
  await assertOwnedDirectory(projectsRoot, canonicalContextVaultRoot, "projects");

  await durableMkdir(stateRoot);
  const canonicalProjectsRoot = await realpath(projectsRoot);
  await assertOwnedDirectory(stateRoot, canonicalProjectsRoot, projectId);
  const canonicalStateRoot = await realpath(stateRoot);
  await Promise.all([durableMkdir(artifactsRoot), durableMkdir(metadataRoot)]);
  await Promise.all([
    assertOwnedDirectory(artifactsRoot, canonicalStateRoot, "artifacts"),
    assertOwnedDirectory(metadataRoot, canonicalStateRoot, "metadata"),
  ]);
  return { projectId, projectRoot, stateRoot, artifactsRoot, metadataRoot };
}
