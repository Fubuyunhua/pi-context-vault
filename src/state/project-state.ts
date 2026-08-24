import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { durableMkdir } from "./atomic.js";

export const STATE_SCHEMA_VERSION = 1;

export interface ProjectStatePaths {
  projectId: string;
  projectRoot: string;
  stateRoot: string;
  artifactsRoot: string;
  mapRoot: string;
  metadataRoot: string;
}

export async function resolveProjectState(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProjectStatePaths> {
  const projectRoot = await realpath(resolve(cwd));
  const projectId = createHash("sha256").update(projectRoot).digest("hex").slice(0, 32);
  const piRoot = resolve(env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"));
  const stateRoot = join(piRoot, "context-vault", "projects", projectId);
  const artifactsRoot = join(stateRoot, "artifacts");
  const mapRoot = join(stateRoot, "repo-map");
  const metadataRoot = join(stateRoot, "metadata");
  await durableMkdir(stateRoot);
  await Promise.all([durableMkdir(artifactsRoot), durableMkdir(mapRoot), durableMkdir(metadataRoot)]);
  return { projectId, projectRoot, stateRoot, artifactsRoot, mapRoot, metadataRoot };
}
