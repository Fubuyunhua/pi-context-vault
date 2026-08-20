import type { PathLike } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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

import { atomicWriteFile } from "../src/state/atomic.js";

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

  it("ignores unsupported parent-directory sync errors after a successful rename", async () => {
    const root = await mkdtemp(join(tmpdir(), "context-vault-atomic-unsupported-"));
    roots.push(root);
    const target = join(root, "state.json");
    directorySyncError.code = "EINVAL";

    await expect(atomicWriteFile(target, "portable")).resolves.toBeUndefined();
    expect(await readFile(target, "utf8")).toBe("portable");
    expect(directorySync).toHaveBeenCalledWith(root);
  });
});
