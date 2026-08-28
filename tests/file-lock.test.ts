import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename as realRename,
  rmdir as realRmdir,
  rm,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

const fsControls = vi.hoisted(() => ({
  renameErrors: [] as string[],
  renameGate: undefined as undefined | { reached: () => void; wait: Promise<void> },
  rmdirGate: undefined as undefined | { reached: () => void; wait: Promise<void> },
  ownerLstatSwap: undefined as undefined | ((path: string) => Promise<void>),
  lstatErrors: undefined as undefined | { path: string; codes: string[] },
  openErrors: undefined as undefined | { path: string; codes: string[] },
  lockReaddirErrors: undefined as undefined | { path: string; codes: string[] },
  disappearTargetOnRenameError: false,
  replaceLegacyFileOnRename: false,
  publicationRenameAttempts: 0,
  directorySyncAttempts: [] as string[],
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (path: string, flags: string | number, mode?: number) => {
      if (flags === "r") fsControls.directorySyncAttempts.push(path);
      const injected = fsControls.openErrors;
      if (injected?.path === path) {
        const code = injected.codes.shift();
        if (code !== undefined) {
          const error = new Error(`mocked open ${code}`) as NodeJS.ErrnoException;
          error.code = code;
          throw error;
        }
      }
      return actual.open(path, flags as "r", mode);
    },
    lstat: async (path: string, options?: { bigint?: boolean }) => {
      const injected = fsControls.lstatErrors;
      if (injected?.path === path) {
        const code = injected.codes.shift();
        if (code !== undefined) {
          const error = new Error(`mocked lstat ${code}`) as NodeJS.ErrnoException;
          error.code = code;
          throw error;
        }
      }
      const result = options?.bigint ? await actual.lstat(path, { bigint: true }) : await actual.lstat(path);
      const swap = fsControls.ownerLstatSwap;
      if (swap !== undefined && /owner-[0-9a-f-]{36}\.json$/.test(path)) {
        fsControls.ownerLstatSwap = undefined;
        await swap(path);
      }
      return result;
    },
    readdir: async (path: string) => {
      const injected = fsControls.lockReaddirErrors;
      if (injected?.path === path) {
        const code = injected.codes.shift();
        if (code !== undefined) {
          const error = new Error(`mocked readdir ${code}`) as NodeJS.ErrnoException;
          error.code = code;
          throw error;
        }
      }
      return actual.readdir(path);
    },
    rename: async (oldPath: string, newPath: string) => {
      if (oldPath.includes(".prepare-")) {
        fsControls.publicationRenameAttempts += 1;
        const code = fsControls.renameErrors.shift();
        if (code !== undefined) {
          if (fsControls.disappearTargetOnRenameError) {
            fsControls.disappearTargetOnRenameError = false;
            await actual.mkdir(newPath);
            await actual.rmdir(newPath);
          }
          const error = new Error(`mocked rename ${code}`) as NodeJS.ErrnoException;
          error.code = code;
          throw error;
        }
        if (fsControls.replaceLegacyFileOnRename) {
          await actual.rm(newPath, { force: true });
        }
        const gate = fsControls.renameGate;
        if (gate !== undefined) {
          fsControls.renameGate = undefined;
          gate.reached();
          await gate.wait;
        }
      }
      await actual.rename(oldPath, newPath);
    },
    rmdir: async (path: string) => {
      const gate = fsControls.rmdirGate;
      if (gate !== undefined && !path.includes(".prepare-")) {
        fsControls.rmdirGate = undefined;
        gate.reached();
        await gate.wait;
      }
      await actual.rmdir(path);
    },
  };
});

import { withFileLock } from "../src/state/atomic.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "context-vault-file-lock-"));
  roots.push(root);
  return root;
}

async function writeOwner(lockPath: string, owner: string, pid: number, ageMs = 120_000): Promise<string> {
  await mkdir(lockPath);
  const ownerPath = join(lockPath, `owner-${owner}.json`);
  await writeOwnerFile(ownerPath, owner, pid, ageMs);
  return ownerPath;
}

async function writeOwnerFile(ownerPath: string, owner: string, pid: number, ageMs: number): Promise<void> {
  await writeFile(
    ownerPath,
    JSON.stringify({
      schemaVersion: 1,
      owner,
      pid,
      hostname: hostname(),
      createdAt: new Date(Date.now() - ageMs).toISOString(),
    }),
  );
  const old = new Date(Date.now() - ageMs);
  await utimes(ownerPath, old, old);
}

async function writePreparation(lockPath: string, owner: string, pid: number, ageMs: number): Promise<string> {
  const preparation = `${lockPath}.prepare-${owner}`;
  await mkdir(preparation);
  await writeOwnerFile(join(preparation, `owner-${owner}.json`), owner, pid, ageMs);
  return preparation;
}

async function missingPid(): Promise<number> {
  for (let pid = 2_147_483_647; pid > 2_147_483_600; pid -= 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return pid;
    }
  }
  throw new Error("Could not find a demonstrably absent PID");
}

type InspectionFaultPoint = "fixed-target lstat" | "lock-directory readdir" | "owner-file lstat" | "owner-file open";

const INSPECTION_FAULT_POINTS: InspectionFaultPoint[] = [
  "fixed-target lstat",
  "lock-directory readdir",
  "owner-file lstat",
  "owner-file open",
];
const WINDOWS_TRANSIENT_INSPECTION_ERRORS = ["EPERM", "EBUSY", "EACCES"];

function injectInspectionErrors(
  point: InspectionFaultPoint,
  lockPath: string,
  ownerPath: string,
  codes: string[],
): void {
  if (point === "owner-file open") {
    fsControls.openErrors = { path: ownerPath, codes };
    return;
  }
  if (point === "lock-directory readdir") {
    fsControls.lockReaddirErrors = { path: lockPath, codes };
    return;
  }
  fsControls.lstatErrors = { path: point === "fixed-target lstat" ? lockPath : ownerPath, codes };
}

afterEach(async () => {
  vi.restoreAllMocks();
  fsControls.renameErrors.splice(0);
  fsControls.renameGate = undefined;
  fsControls.rmdirGate = undefined;
  fsControls.ownerLstatSwap = undefined;
  fsControls.lstatErrors = undefined;
  fsControls.openErrors = undefined;
  fsControls.lockReaddirErrors = undefined;
  fsControls.disappearTargetOnRenameError = false;
  fsControls.replaceLegacyFileOnRename = false;
  fsControls.publicationRenameAttempts = 0;
  fsControls.directorySyncAttempts.splice(0);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("race-safe file locks", () => {
  it("publishes only a fully initialized non-empty directory", async () => {
    const root = await tempRoot();
    const lockPath = join(root, "writer.lock");
    const renameReached = deferred();
    const releaseRename = deferred();
    fsControls.renameGate = { reached: renameReached.resolve, wait: releaseRename.promise };

    const holder = withFileLock(lockPath, async () => "held");
    await renameReached.promise;

    await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    const preparation = (await readdir(root)).find((entry) => entry.includes(".prepare-"));
    expect(preparation).toBeDefined();
    const files = await readdir(join(root, preparation as string));
    expect(files).toHaveLength(1);
    expect(JSON.parse(await readFile(join(root, preparation as string, files[0] as string), "utf8"))).toMatchObject({
      schemaVersion: 1,
      pid: process.pid,
    });

    releaseRename.resolve();
    await expect(holder).resolves.toBe("held");
  });

  it("lets two stale recoverers contend without overlapping holders", async () => {
    const root = await tempRoot();
    const lockPath = join(root, "writer.lock");
    await writeOwner(lockPath, "00000000-0000-4000-8000-000000000001", await missingPid());
    let holders = 0;
    let maximumHolders = 0;

    const enter = async () => {
      await withFileLock(
        lockPath,
        async () => {
          holders += 1;
          maximumHolders = Math.max(maximumHolders, holders);
          await new Promise((resolve) => setTimeout(resolve, 20));
          holders -= 1;
        },
        { retryMs: 2, staleMs: 10, timeoutMs: 1_000 },
      );
    };

    await Promise.all([enter(), enter()]);
    expect(maximumHolders).toBe(1);
  });

  it.each(
    INSPECTION_FAULT_POINTS.flatMap((point) =>
      WINDOWS_TRANSIENT_INSPECTION_ERRORS.map((code) => [point, code] as const),
    ),
  )("retries transient Windows %s %s errors", async (point, code) => {
    const root = await tempRoot();
    const lockPath = join(root, "writer.lock");
    const ownerPath = await writeOwner(lockPath, "00000000-0000-4000-8000-000000000021", await missingPid());
    injectInspectionErrors(point, lockPath, ownerPath, [code]);

    await expect(
      withFileLock(lockPath, async () => "recovered", { retryMs: 2, staleMs: 10, timeoutMs: 1_000 }),
    ).resolves.toBe("recovered");
  });

  it.each(
    INSPECTION_FAULT_POINTS.flatMap((point) =>
      WINDOWS_TRANSIENT_INSPECTION_ERRORS.map((code) => [point, code] as const),
    ),
  )("times out safely on persistent Windows %s %s errors", async (point, code) => {
    const root = await tempRoot();
    const lockPath = join(root, "writer.lock");
    const owner = "00000000-0000-4000-8000-000000000022";
    const ownerPath = await writeOwner(lockPath, owner, await missingPid());
    injectInspectionErrors(
      point,
      lockPath,
      ownerPath,
      Array.from({ length: 100 }, () => code),
    );
    let entered = false;

    await expect(
      withFileLock(
        lockPath,
        async () => {
          entered = true;
        },
        { retryMs: 2, staleMs: 10, timeoutMs: 20 },
      ),
    ).rejects.toThrow("Timed out waiting for state lock");
    expect(entered).toBe(false);
    await expect(readFile(ownerPath, "utf8")).resolves.toContain(owner);
  });

  it.each(INSPECTION_FAULT_POINTS)("propagates an unknown %s error without removing the owner", async (point) => {
    const root = await tempRoot();
    const lockPath = join(root, "writer.lock");
    const owner = "00000000-0000-4000-8000-000000000023";
    const ownerPath = await writeOwner(lockPath, owner, await missingPid());
    injectInspectionErrors(point, lockPath, ownerPath, ["EIO"]);
    let entered = false;

    await expect(
      withFileLock(
        lockPath,
        async () => {
          entered = true;
        },
        { retryMs: 2, staleMs: 10, timeoutMs: 20 },
      ),
    ).rejects.toMatchObject({ code: "EIO" });
    expect(entered).toBe(false);
    await expect(readFile(ownerPath, "utf8")).resolves.toContain(owner);
  });

  it("cannot remove a replacement owner during stale recovery", async () => {
    const root = await tempRoot();
    const lockPath = join(root, "writer.lock");
    const oldOwner = "00000000-0000-4000-8000-000000000002";
    await writeOwner(lockPath, oldOwner, await missingPid());
    const rmdirReached = deferred();
    const releaseRmdir = deferred();
    fsControls.rmdirGate = { reached: rmdirReached.resolve, wait: releaseRmdir.promise };

    const waiter = withFileLock(lockPath, async () => undefined, { retryMs: 2, staleMs: 10, timeoutMs: 50 });
    await rmdirReached.promise;
    await realRmdir(lockPath);
    const replacement = "00000000-0000-4000-8000-000000000003";
    const replacementPath = await writeOwner(lockPath, replacement, process.pid);
    releaseRmdir.resolve();

    await expect(waiter).rejects.toThrow("Timed out waiting for state lock");
    await expect(readFile(replacementPath, "utf8")).resolves.toContain(replacement);
  });

  it("recovers an empty directory left after an owner unlink", async () => {
    const root = await tempRoot();
    const lockPath = join(root, "writer.lock");
    await mkdir(lockPath);
    await expect(withFileLock(lockPath, async () => "recovered", { retryMs: 2 })).resolves.toBe("recovered");
  });

  it("ignores a crashed claimant preparation orphan", async () => {
    const root = await tempRoot();
    const lockPath = join(root, "writer.lock");
    const orphan = `${lockPath}.prepare-crashed`;
    await mkdir(orphan);
    await writeFile(join(orphan, "owner-crashed.json"), "crashed");

    await expect(withFileLock(lockPath, async () => "acquired")).resolves.toBe("acquired");
    await expect(readFile(join(orphan, "owner-crashed.json"), "utf8")).resolves.toBe("crashed");
  });

  it("conservatively removes an old preparation owned by a dead local process", async () => {
    const root = await tempRoot();
    const lockPath = join(root, "writer.lock");
    const owner = "00000000-0000-4000-8000-000000000011";
    const preparation = await writePreparation(lockPath, owner, await missingPid(), 2 * 24 * 60 * 60 * 1_000);

    await expect(withFileLock(lockPath, async () => "acquired")).resolves.toBe("acquired");
    await expect(stat(preparation)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains fresh or demonstrably active preparations", async () => {
    const root = await tempRoot();
    const lockPath = join(root, "writer.lock");
    const fresh = await writePreparation(lockPath, "00000000-0000-4000-8000-000000000012", await missingPid(), 60_000);
    const active = await writePreparation(
      lockPath,
      "00000000-0000-4000-8000-000000000013",
      process.pid,
      2 * 24 * 60 * 60 * 1_000,
    );

    await expect(withFileLock(lockPath, async () => "acquired")).resolves.toBe("acquired");
    await expect(stat(fresh)).resolves.toBeDefined();
    await expect(stat(active)).resolves.toBeDefined();
  });

  it("protects a live suspended owner and treats PID reuse conservatively", async () => {
    const root = await tempRoot();
    for (const name of ["suspended.lock", "reused.lock"]) {
      const lockPath = join(root, name);
      await writeOwner(
        lockPath,
        `00000000-0000-4000-8000-${name === "suspended.lock" ? "000000000004" : "000000000005"}`,
        process.pid,
      );
      await expect(
        withFileLock(lockPath, async () => undefined, { retryMs: 2, staleMs: 10, timeoutMs: 20 }),
      ).rejects.toThrow("Timed out waiting for state lock");
    }
  });

  it("protects an owner when PID liveness is permission-unknown", async () => {
    const root = await tempRoot();
    const lockPath = join(root, "writer.lock");
    const unknownPid = 1_234_567;
    await writeOwner(lockPath, "00000000-0000-4000-8000-000000000009", unknownPid);
    const originalKill = process.kill.bind(process);
    vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === unknownPid) {
        const error = new Error("permission unknown") as NodeJS.ErrnoException;
        error.code = "EPERM";
        throw error;
      }
      return originalKill(pid, signal);
    });

    await expect(
      withFileLock(lockPath, async () => undefined, { retryMs: 2, staleMs: 10, timeoutMs: 20 }),
    ).rejects.toThrow("Timed out waiting for state lock");
  });

  it("recovers a stale owner only when its local PID is demonstrably dead", async () => {
    const root = await tempRoot();
    const lockPath = join(root, "writer.lock");
    await writeOwner(lockPath, "00000000-0000-4000-8000-000000000006", await missingPid());
    await expect(
      withFileLock(lockPath, async () => "recovered", { retryMs: 2, staleMs: 10, timeoutMs: 200 }),
    ).resolves.toBe("recovered");
  });

  it("syncs the lock parent after stale recovery removes the old directory", async () => {
    const root = await tempRoot();
    const lockPath = join(root, "writer.lock");
    await writeOwner(lockPath, "00000000-0000-4000-8000-000000000018", await missingPid());
    let parentSyncsAtAcquisition = 0;

    await withFileLock(
      lockPath,
      async () => {
        parentSyncsAtAcquisition = fsControls.directorySyncAttempts.filter((path) => path === root).length;
      },
      { retryMs: 2, staleMs: 10, timeoutMs: 200 },
    );

    expect(parentSyncsAtAcquisition).toBeGreaterThanOrEqual(2);
  });

  it("preflights a legacy fixed lock file instead of allowing Windows-style rename replacement", async () => {
    const root = await tempRoot();
    const lockPath = join(root, "writer.lock");
    await writeFile(lockPath, "legacy");
    fsControls.replaceLegacyFileOnRename = true;

    await expect(
      withFileLock(lockPath, async () => undefined, { retryMs: 2, staleMs: 10, timeoutMs: 20 }),
    ).rejects.toThrow("Timed out waiting for state lock");
    expect(fsControls.publicationRenameAttempts).toBe(0);
    await expect(readFile(lockPath, "utf8")).resolves.toBe("legacy");
  });

  it("preflights a fixed-target symlink without publishing over it", async () => {
    const root = await tempRoot();
    const lockPath = join(root, "writer.lock");
    const targetPath = join(root, "symlink-target");
    await writeFile(targetPath, "target");
    await symlink(targetPath, lockPath, "file");
    fsControls.replaceLegacyFileOnRename = true;

    await expect(
      withFileLock(lockPath, async () => undefined, { retryMs: 2, staleMs: 10, timeoutMs: 20 }),
    ).rejects.toThrow("Timed out waiting for state lock");
    expect(fsControls.publicationRenameAttempts).toBe(0);
    await expect(readFile(lockPath, "utf8")).resolves.toBe("target");
  });

  it("fails safe on malformed owner metadata", async () => {
    const root = await tempRoot();
    const lockPath = join(root, "writer.lock");
    await mkdir(lockPath);
    const ownerPath = join(lockPath, "owner-not-a-uuid.json");
    await writeFile(ownerPath, "not json");
    const old = new Date(Date.now() - 120_000);
    await utimes(ownerPath, old, old);

    await expect(
      withFileLock(lockPath, async () => undefined, { retryMs: 2, staleMs: 10, timeoutMs: 20 }),
    ).rejects.toThrow("Timed out waiting for state lock");
    await expect(readFile(ownerPath, "utf8")).resolves.toBe("not json");
  });

  it.each(["file", "directory"] as const)("fails safe on an owner symlink to a %s", async (targetKind) => {
    const root = await tempRoot();
    const lockPath = join(root, "writer.lock");
    const owner = "00000000-0000-4000-8000-000000000014";
    const target = join(root, `symlink-target-${targetKind}`);
    if (targetKind === "directory") await mkdir(target);
    else await writeFile(target, "not owner metadata");
    await mkdir(lockPath);
    const ownerPath = join(lockPath, `owner-${owner}.json`);
    await symlink(target, ownerPath, targetKind === "directory" ? "junction" : "file");

    await expect(
      withFileLock(lockPath, async () => undefined, { retryMs: 2, staleMs: 10, timeoutMs: 20 }),
    ).rejects.toThrow("Timed out waiting for state lock");
    await expect(stat(ownerPath)).resolves.toBeDefined();
  });

  it("fails safe on oversized owner metadata", async () => {
    const root = await tempRoot();
    const lockPath = join(root, "writer.lock");
    const owner = "00000000-0000-4000-8000-000000000015";
    await mkdir(lockPath);
    const ownerPath = join(lockPath, `owner-${owner}.json`);
    await writeFile(ownerPath, "x".repeat(4 * 1024 + 1));
    const old = new Date(Date.now() - 120_000);
    await utimes(ownerPath, old, old);

    await expect(
      withFileLock(lockPath, async () => undefined, { retryMs: 2, staleMs: 10, timeoutMs: 20 }),
    ).rejects.toThrow("Timed out waiting for state lock");
    await expect(readFile(ownerPath, "utf8")).resolves.toHaveLength(4 * 1024 + 1);
  });

  it.skipIf(process.platform === "win32")(
    "rejects a FIFO owner without hanging",
    async () => {
      const root = await tempRoot();
      const lockPath = join(root, "writer.lock");
      const owner = "00000000-0000-4000-8000-000000000016";
      await mkdir(lockPath);
      const ownerPath = join(lockPath, `owner-${owner}.json`);
      await execFileAsync("mkfifo", [ownerPath]);

      await expect(
        withFileLock(lockPath, async () => undefined, { retryMs: 2, staleMs: 10, timeoutMs: 20 }),
      ).rejects.toThrow("Timed out waiting for state lock");
    },
    1_000,
  );

  it("fails safe when the owner file is swapped between validation and open", async () => {
    const root = await tempRoot();
    const lockPath = join(root, "writer.lock");
    const owner = "00000000-0000-4000-8000-000000000017";
    const ownerPath = await writeOwner(lockPath, owner, await missingPid());
    fsControls.ownerLstatSwap = async (path) => {
      await realRename(path, join(root, "original-owner.json"));
      await writeFile(path, "replacement must not be trusted");
    };

    await expect(
      withFileLock(lockPath, async () => undefined, { retryMs: 2, staleMs: 10, timeoutMs: 20 }),
    ).rejects.toThrow("Timed out waiting for state lock");
    await expect(readFile(ownerPath, "utf8")).resolves.toBe("replacement must not be trusted");
  });

  it("heartbeats the exact owner and releases without touching a replacement", async () => {
    const root = await tempRoot();
    const lockPath = join(root, "writer.lock");
    let originalOwner = "";
    let replacementPath = "";
    const beforeReplacement = new Date(Date.now() - 60_000);

    await withFileLock(
      lockPath,
      async () => {
        [originalOwner] = await readdir(lockPath);
        await new Promise((resolve) => setTimeout(resolve, 45));
        expect(Date.now() - (await stat(join(lockPath, originalOwner))).mtimeMs).toBeLessThan(40);
        await unlink(join(lockPath, originalOwner));
        await realRmdir(lockPath);
        await mkdir(lockPath);
        replacementPath = join(lockPath, "owner-00000000-0000-4000-8000-000000000007.json");
        await writeFile(replacementPath, "replacement");
        await utimes(replacementPath, beforeReplacement, beforeReplacement);
        await new Promise((resolve) => setTimeout(resolve, 45));
      },
      { staleMs: 60 },
    );

    expect(Math.abs((await stat(replacementPath)).mtimeMs - beforeReplacement.getTime())).toBeLessThan(2);
    await expect(readFile(replacementPath, "utf8")).resolves.toBe("replacement");
  });

  it.each(["EEXIST", "ENOTEMPTY", "EPERM"])("treats mocked Windows/Linux %s rename collisions safely", async (code) => {
    const root = await tempRoot();
    const lockPath = join(root, `${code}.lock`);
    await writeOwner(lockPath, "00000000-0000-4000-8000-000000000008", await missingPid());
    fsControls.renameErrors.push(code);

    await expect(
      withFileLock(lockPath, async () => "recovered", { retryMs: 2, staleMs: 10, timeoutMs: 300 }),
    ).resolves.toBe("recovered");
  });

  it("cleans its exact preparation after a timeout", async () => {
    const root = await tempRoot();
    const lockPath = join(root, "writer.lock");
    await writeOwner(lockPath, "00000000-0000-4000-8000-000000000010", process.pid);

    await expect(
      withFileLock(lockPath, async () => undefined, { retryMs: 2, staleMs: 10, timeoutMs: 20 }),
    ).rejects.toThrow("Timed out waiting for state lock");
    expect((await readdir(root)).filter((entry) => entry.includes(".prepare-"))).toEqual([]);
  });

  it("syncs the lock parent after a successful release", async () => {
    const root = await tempRoot();
    const lockPath = join(root, "writer.lock");

    await withFileLock(lockPath, async () => {
      fsControls.directorySyncAttempts.splice(0);
    });

    expect(fsControls.directorySyncAttempts).toContain(root);
  });

  it("retries EPERM when a contending target disappears before inspection", async () => {
    const root = await tempRoot();
    const lockPath = join(root, "transient-contention.lock");
    fsControls.renameErrors.push("EPERM");
    fsControls.disappearTargetOnRenameError = true;

    await expect(withFileLock(lockPath, async () => "acquired", { retryMs: 2, timeoutMs: 100 })).resolves.toBe(
      "acquired",
    );
    expect(fsControls.publicationRenameAttempts).toBe(2);
  });

  it("times out on persistent EPERM publication failures", async () => {
    const root = await tempRoot();
    const lockPath = join(root, "permission.lock");
    fsControls.renameErrors.push(...Array.from({ length: 100 }, () => "EPERM"));

    await expect(withFileLock(lockPath, async () => undefined, { retryMs: 2, timeoutMs: 20 })).rejects.toThrow(
      "Timed out waiting for state lock",
    );
  });
});
