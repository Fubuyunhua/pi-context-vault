import { lstat, opendir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

export interface DiskTreeSnapshot {
  files: number;
  directories: number;
  symlinksSkipped: number;
  logicalBytes: number;
  allocatedBytes: number | null;
}
export interface VaultDiskSnapshot {
  total: DiskTreeSnapshot;
  repoMap: DiskTreeSnapshot & {
    generationCount: number;
    generationLogicalBytes: number;
    generationAllocatedBytes: number | null;
    activePointer: unknown | null;
  };
  observations: DiskTreeSnapshot & {
    uniqueArtifacts: number;
    uniqueLiveArtifacts: number;
    liveRecords: number;
    logRecords: number;
    tombstones: number;
    metadataBytes: number;
  };
}

function empty(): DiskTreeSnapshot {
  return { files: 0, directories: 0, symlinksSkipped: 0, logicalBytes: 0, allocatedBytes: 0 };
}
function add(target: DiskTreeSnapshot, source: DiskTreeSnapshot): void {
  target.files += source.files;
  target.directories += source.directories;
  target.symlinksSkipped += source.symlinksSkipped;
  target.logicalBytes += source.logicalBytes;
  target.allocatedBytes =
    target.allocatedBytes === null || source.allocatedBytes === null
      ? null
      : target.allocatedBytes + source.allocatedBytes;
}

export async function scanDiskTree(root: string): Promise<DiskTreeSnapshot> {
  const result = empty();
  const visit = async (path: string): Promise<void> => {
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (info.isSymbolicLink()) {
      result.symlinksSkipped += 1;
      return;
    }
    if (info.isFile()) {
      result.files += 1;
      result.logicalBytes += info.size;
      const blocks = (info as typeof info & { blocks?: number }).blocks;
      result.allocatedBytes =
        result.allocatedBytes === null || blocks === undefined ? null : result.allocatedBytes + blocks * 512;
      return;
    }
    if (!info.isDirectory()) return;
    result.directories += 1;
    const directory = await opendir(path);
    for await (const entry of directory) await visit(join(path, entry.name));
  };
  await visit(root);
  return result;
}

async function safeJson(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
}

export async function scanVaultState(stateRoot: string): Promise<VaultDiskSnapshot> {
  const mapRoot = join(stateRoot, "repo-map");
  const artifactsRoot = join(stateRoot, "artifacts");
  const metadataRoot = join(stateRoot, "metadata");
  const [total, repoMapTree, generations, artifacts, metadata] = await Promise.all([
    scanDiskTree(stateRoot),
    scanDiskTree(mapRoot),
    scanDiskTree(join(mapRoot, "generations")),
    scanDiskTree(artifactsRoot),
    scanDiskTree(metadataRoot),
  ]);
  let generationCount = 0;
  try {
    const directory = await opendir(join(mapRoot, "generations"));
    for await (const entry of directory) if (entry.isFile() && /^\d+\.json$/u.test(entry.name)) generationCount += 1;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const observations = empty();
  add(observations, artifacts);
  add(observations, metadata);
  const metadataLog = await metadataCounts(join(metadataRoot, "observations.jsonl"));
  return {
    total,
    repoMap: {
      ...repoMapTree,
      generationCount,
      generationLogicalBytes: generations.logicalBytes,
      generationAllocatedBytes: generations.allocatedBytes,
      activePointer: await safeJson(join(mapRoot, "active.json")),
    },
    observations: {
      ...observations,
      uniqueArtifacts: artifacts.files,
      ...metadataLog,
      metadataBytes: metadata.logicalBytes,
    },
  };
}

async function metadataCounts(path: string): Promise<{
  uniqueLiveArtifacts: number;
  liveRecords: number;
  logRecords: number;
  tombstones: number;
}> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { uniqueLiveArtifacts: 0, liveRecords: 0, logRecords: 0, tombstones: 0 };
    throw error;
  }
  const live = new Map<string, string>();
  let logRecords = 0;
  let tombstones = 0;
  for (const line of text.split("\n")) {
    if (!line) continue;
    const record = JSON.parse(line) as Record<string, unknown>;
    logRecords += 1;
    if (record.schemaVersion === 2 && record.recordType === "tombstone") {
      tombstones += 1;
      if (typeof record.observationId === "string") live.delete(record.observationId);
      continue;
    }
    const metadata = record.schemaVersion === 2 ? record.metadata : record;
    if (metadata && typeof metadata === "object") {
      const item = metadata as Record<string, unknown>;
      if (typeof item.observationId === "string" && typeof item.artifactId === "string")
        live.set(item.observationId, item.artifactId);
    }
  }
  return {
    uniqueLiveArtifacts: new Set(live.values()).size,
    liveRecords: live.size,
    logRecords,
    tombstones,
  };
}

export function isWithin(root: string, path: string): boolean {
  const local = relative(root, path);
  return local === "" || (local !== ".." && !local.startsWith(`..${sep}`));
}
