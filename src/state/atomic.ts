import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink, utimes } from "node:fs/promises";
import { dirname } from "node:path";

const UNSUPPORTED_DIRECTORY_SYNC_ERRORS = new Set([
  "EBADF",
  "EINVAL",
  "EISDIR",
  "ENOSYS",
  "ENOTSUP",
  "EOPNOTSUPP",
  "EPERM",
]);

function isUnsupportedDirectorySyncError(error: unknown): boolean {
  return UNSUPPORTED_DIRECTORY_SYNC_ERRORS.has((error as NodeJS.ErrnoException).code ?? "");
}

async function syncParentDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(dirname(path), "r");
    await handle.sync();
  } catch (error) {
    if (!isUnsupportedDirectorySyncError(error)) throw error;
  } finally {
    await handle?.close();
  }
}

export async function atomicWriteFile(path: string, content: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  let handleClosed = false;
  try {
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handleClosed = true;
    await rename(temporary, path);
    await syncParentDirectory(path);
  } catch (error) {
    if (!handleClosed) await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export interface FileLockOptions {
  retryMs?: number;
  staleMs?: number;
  timeoutMs?: number;
}

async function releaseOwnedLock(path: string, owner: string): Promise<void> {
  let ownsLock = false;
  try {
    const lock = JSON.parse(await readFile(path, "utf8")) as { owner?: unknown };
    ownsLock = lock.owner === owner;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (ownsLock) {
    await unlink(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

export async function withFileLock<T>(
  path: string,
  operation: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const retryMs = options.retryMs ?? 10;
  const staleMs = options.staleMs ?? 30_000;
  const timeoutMs = options.timeoutMs ?? 5_000;
  if (!Number.isFinite(retryMs) || retryMs <= 0) throw new Error("retryMs must be greater than zero");
  if (!Number.isFinite(staleMs) || staleMs <= 0) throw new Error("staleMs must be greater than zero");
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error("timeoutMs must not be negative");

  const startedAt = Date.now();
  const owner = randomUUID();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });

  while (true) {
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        try {
          await handle.writeFile(JSON.stringify({ owner, pid: process.pid, createdAt: new Date().toISOString() }));
          await handle.sync();
        } finally {
          await handle.close();
        }
      } catch (error) {
        await unlink(path).catch(() => undefined);
        throw error;
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const info = await stat(path);
        if (Date.now() - info.mtimeMs > staleMs) {
          await unlink(path);
          continue;
        }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw statError;
      }
      if (Date.now() - startedAt >= timeoutMs) throw new Error(`Timed out waiting for state lock: ${path}`);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, retryMs));
    }
  }

  const heartbeat = setInterval(
    () => {
      const now = new Date();
      void utimes(path, now, now).catch(() => undefined);
    },
    Math.max(10, Math.floor(staleMs / 3)),
  );
  heartbeat.unref();

  try {
    return await operation();
  } finally {
    clearInterval(heartbeat);
    await releaseOwnedLock(path, owner);
  }
}
