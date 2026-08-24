import type { PathLike } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const directorySync = vi.hoisted(() => vi.fn());
const directorySyncError = vi.hoisted(() => ({ code: undefined as string | undefined }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (path: PathLike, flags: string | number, mode?: number) => {
      const handle = await actual.open(path, flags, mode);
      if (flags !== "r") return handle;
      return {
        close: () => handle.close(),
        sync: async () => {
          directorySync(path);
          if (directorySyncError.code) {
            throw Object.assign(new Error("directory sync unsupported"), { code: directorySyncError.code });
          }
          await handle.sync();
        },
      };
    },
  };
});

import { ArtifactStore } from "../src/artifacts/store.js";
import { atomicWriteFile, durableMkdir } from "../src/state/atomic.js";
import { resolveProjectState } from "../src/state/project-state.js";

const roots: string[] = [];

afterEach(async () => {
  directorySync.mockClear();
  directorySyncError.code = undefined;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("atomic write crash durability", () => {
  it("syncs the parent directory after replacing the destination", async () => {
    const root = await mkdtemp(join(tmpdir(), "context-vault-atomic-durability-"));
    roots.push(root);
    const target = join(root, "state.json");

    await atomicWriteFile(target, "durable");

    expect(await readFile(target, "utf8")).toBe("durable");
    expect(directorySync).toHaveBeenCalledWith(root);
  });

  it("durably creates each missing directory before publishing a nested file", async () => {
    const root = await mkdtemp(join(tmpdir(), "context-vault-atomic-nested-"));
    roots.push(root);
    const first = join(root, "artifacts");
    const second = join(first, "ab");
    const target = join(second, "artifact.txt");

    await atomicWriteFile(target, "nested");

    expect(await readFile(target, "utf8")).toBe("nested");
    expect(directorySync.mock.calls.map(([path]) => path)).toEqual([root, first, second]);
  });

  it("ignores portable unsupported sync errors throughout nested directory creation", async () => {
    const root = await mkdtemp(join(tmpdir(), "context-vault-atomic-unsupported-"));
    roots.push(root);
    const target = join(root, "one", "two", "state.json");
    directorySyncError.code = "EINVAL";

    await expect(atomicWriteFile(target, "portable")).resolves.toBeUndefined();
    expect(await readFile(target, "utf8")).toBe("portable");
    expect(directorySync.mock.calls.map(([path]) => path)).toEqual([root, join(root, "one"), join(root, "one", "two")]);
  });

  it("syncs an existing directory entry instead of letting EEXIST bypass durability", async () => {
    const root = await mkdtemp(join(tmpdir(), "context-vault-durable-mkdir-existing-"));
    roots.push(root);
    const target = join(root, "existing");
    await mkdir(target);

    await durableMkdir(target);
    expect(directorySync.mock.calls.map(([path]) => path)).toEqual([root]);

    directorySync.mockClear();
    directorySyncError.code = "ENOTSUP";
    await expect(durableMkdir(target)).resolves.toBeUndefined();
    expect(directorySync.mock.calls.map(([path]) => path)).toEqual([root]);
  });

  it("durably precreates production state paths before archive metadata publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "context-vault-production-durability-"));
    roots.push(root);
    const project = join(root, "project");
    const piRoot = join(root, "pi");
    await mkdir(project);

    const state = await resolveProjectState(project, { PI_CODING_AGENT_DIR: piRoot });
    const resolveSyncs = directorySync.mock.calls.map(([path]) => path);
    expect(resolveSyncs).toEqual([
      root,
      piRoot,
      join(piRoot, "context-vault"),
      join(piRoot, "context-vault", "projects"),
      state.stateRoot,
      state.stateRoot,
      state.stateRoot,
    ]);

    const store = new ArtifactStore({
      artifactsRoot: state.artifactsRoot,
      metadataRoot: state.metadataRoot,
      faultHook: (point) => {
        if (point !== "after-artifact-publication") return;
        expect(directorySync.mock.calls.slice(0, resolveSyncs.length).map(([path]) => path)).toEqual(resolveSyncs);
        throw new Error("stop before metadata publication");
      },
    });
    await expect(
      store.archive({ observationId: "observation", toolName: "read", sessionId: "session", content: "content" }),
    ).rejects.toThrow("stop before metadata publication");
    await expect(readFile(join(state.metadataRoot, "observations.jsonl"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
