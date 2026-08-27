import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildRepoMap } from "../src/repo-map/index.js";
import { type RepoMapGitRunner, RepoMapRuntime } from "../src/repo-map/runtime.js";
import { atomicWriteFile } from "../src/state/atomic.js";
import { Telemetry } from "../src/telemetry.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(files: Record<string, string>): Promise<{ root: string; stateRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), "context-vault-capture-"));
  const stateRoot = await mkdtemp(join(tmpdir(), "context-vault-capture-state-"));
  roots.push(root, stateRoot);
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, content);
  }
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: root });
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync("git", ["commit", "-qm", "initial"], { cwd: root });
  return { root, stateRoot };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("repository map runtime snapshot capture", () => {
  it("calls ensureFresh exactly once and returns its synchronously selected checkpoint", async () => {
    const { root, stateRoot } = await fixture({ "src/a.ts": "export const captureValue = true;" });
    const telemetry = new Telemetry();
    const runtime = new RepoMapRuntime({ projectRoot: root, stateRoot, watch: false, telemetry });
    await runtime.start();
    const ensureFresh = vi.spyOn(runtime, "ensureFresh");
    const telemetryBefore = telemetry.snapshot().ensureFreshCount;
    const queryBefore = await runtime.queryCurrent("captureValue");

    const handle = await runtime.capture();

    expect(ensureFresh).toHaveBeenCalledTimes(1);
    expect(telemetry.snapshot().ensureFreshCount - telemetryBefore).toBe(1);
    expect(handle.snapshot.files[0]?.path).toBe("src/a.ts");
    const queryAfter = await runtime.queryCurrent("captureValue");
    expect(queryAfter.results).toEqual(queryBefore.results);
    expect(queryAfter).toMatchObject({
      freshness: queryBefore.freshness,
      generation: queryBefore.generation,
      gitHead: queryBefore.gitHead,
      workspaceRevision: queryBefore.workspaceRevision,
      pendingFiles: queryBefore.pendingFiles,
    });
    const liveQuery = await runtime.query("captureValue");
    expect(liveQuery.results).toEqual(queryBefore.results);

    ensureFresh.mockClear();
    await runtime.ensureFresh();
    const current = runtime.captureCurrent();
    expect(ensureFresh).toHaveBeenCalledTimes(1);
    expect(current.snapshotContentIdentity).toBe(handle.snapshotContentIdentity);
    await runtime.close();
  });

  it("maps a refresh rejection to the exact bounded public error", async () => {
    const { root, stateRoot } = await fixture({ "src/a.ts": "export const value = true;" });
    const runtime = new RepoMapRuntime({ projectRoot: root, stateRoot, watch: false });
    await runtime.start();
    const ensureFresh = vi.spyOn(runtime, "ensureFresh").mockRejectedValue(new Error("SECRET refresh failure"));

    await expect(runtime.capture()).rejects.toMatchObject({
      name: "RepositorySnapshotUnavailableError",
      reason: "ensure-fresh-failed",
      retryable: true,
      message: "repository snapshot unavailable: refresh failed",
    });
    expect(ensureFresh).toHaveBeenCalledTimes(1);
    await runtime.close();
  });

  it("keeps captureCurrent synchronous and performs no Git, filesystem, or search work", async () => {
    const { root, stateRoot } = await fixture({ "src/a.ts": "export const noIoCapture = true;" });
    let gitCalls = 0;
    let fileCalls = 0;
    let searchCalls = 0;
    const gitRunner: RepoMapGitRunner = async (cwd, args, encoding, maxBuffer) => {
      gitCalls += 1;
      const result = await execFileAsync("git", [...args], {
        cwd,
        encoding: encoding === "buffer" ? "buffer" : "utf8",
        ...(maxBuffer === undefined ? {} : { maxBuffer }),
      });
      return { stdout: result.stdout };
    };
    const runtime = new RepoMapRuntime({
      projectRoot: root,
      stateRoot,
      watch: false,
      gitRunner,
      indexFileSystem: {
        async lstat(path) {
          fileCalls += 1;
          const info = await lstat(path);
          return { isFile: () => info.isFile(), size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs };
        },
        async readFile(path) {
          fileCalls += 1;
          return readFile(path);
        },
      },
      searchFactory(snapshot) {
        searchCalls += 1;
        throw new Error(`unexpected search for ${snapshot.files.length} files`);
      },
    });
    await runtime.start();
    const counts = { gitCalls, fileCalls, searchCalls };

    const handle = runtime.captureCurrent();

    expect(handle).not.toBeInstanceOf(Promise);
    expect(handle.snapshot.files[0]?.path).toBe("src/a.ts");
    expect({ gitCalls, fileCalls, searchCalls }).toEqual(counts);
    await runtime.close();
  });

  it("publishes old complete content plus canonical pending paths while reconciliation is blocked", async () => {
    const { root, stateRoot } = await fixture({ "src/a.ts": "export const beforeBlockedFlush = true;" });
    const blocked = deferred();
    const release = deferred();
    let armed = false;
    let didBlock = false;
    const runtime = new RepoMapRuntime({
      projectRoot: root,
      stateRoot,
      watch: false,
      indexFileSystem: {
        lstat,
        async readFile(path) {
          if (armed && !didBlock && path === join(root, "src/a.ts")) {
            didBlock = true;
            blocked.resolve();
            await release.promise;
          }
          return readFile(path);
        },
      },
    });
    await runtime.start();
    const before = runtime.captureCurrent();
    await writeFile(join(root, "src/a.ts"), "export const afterBlockedFlush = true;");
    runtime.notify("change", "src/a.ts");
    armed = true;
    const flush = runtime.flush();
    await blocked.promise;
    runtime.notify("unlink", "./src/pending.ts");

    const during = runtime.captureCurrent();
    expect(during.freshness).toBe("stale");
    expect(during.pendingPaths).toEqual(["src/a.ts", "src/pending.ts"]);
    expect(during.generation).toBe(before.generation);
    expect(during.snapshotContentIdentity).toBe(before.snapshotContentIdentity);
    expect(during.snapshot.files[0]?.symbols[0]?.name).toBe("beforeBlockedFlush");

    release.resolve();
    await flush;
    const after = runtime.captureCurrent();
    expect(after.snapshot.files[0]?.symbols[0]?.name).toBe("afterBlockedFlush");
    expect(after.snapshotContentIdentity).not.toBe(before.snapshotContentIdentity);
    await runtime.close();
  });

  it("keeps cold invalid checkpoint publication bounded and unavailable", async () => {
    const { root, stateRoot } = await fixture({ "src/a.ts": "export const coldInvalid = true;" });
    const runtime = new RepoMapRuntime({
      projectRoot: root,
      stateRoot,
      watch: false,
      snapshotBuilder: async (options) => {
        const map = await buildRepoMap(options);
        if (map.files[0]) map.files[0].path = "../PRIVATE-cold-invalid.ts";
        return map;
      },
    });

    await runtime.start();

    expect(() => runtime.captureCurrent()).toThrow(expect.objectContaining({ reason: "invalid-checkpoint" }));
    expect(runtime.status()).toMatchObject({
      freshness: "stale",
      error: "repository snapshot checkpoint publication failed",
    });
    expect(JSON.stringify(runtime.status())).not.toContain("PRIVATE-cold-invalid");
    await runtime.close();
  });

  it("keeps cold base-build failure stale and without a falsely successful checkpoint", async () => {
    const { root, stateRoot } = await fixture({ "src/a.ts": "export const coldFailure = true;" });
    const runtime = new RepoMapRuntime({
      projectRoot: root,
      stateRoot,
      watch: false,
      snapshotBuilder: async () => {
        throw new Error("SECRET cold build failure");
      },
    });

    await runtime.start();

    expect(runtime.status()).toMatchObject({ freshness: "stale", generation: 0 });
    expect(() => runtime.captureCurrent()).toThrow(expect.objectContaining({ reason: "no-published-checkpoint" }));
    await runtime.close();
  });

  it("retains a hydrated complete checkpoint as stale when its startup rebuild fails", async () => {
    const { root, stateRoot } = await fixture({ "src/a.ts": "export const hydratedValue = true;" });
    const firstRuntime = new RepoMapRuntime({ projectRoot: root, stateRoot, watch: false });
    await firstRuntime.start();
    const original = firstRuntime.captureCurrent();
    await firstRuntime.close();

    const hydrated = new RepoMapRuntime({
      projectRoot: root,
      stateRoot,
      watch: false,
      snapshotBuilder: async () => {
        throw new Error("SECRET hydrated build failure");
      },
    });
    await hydrated.start();
    const retained = hydrated.captureCurrent();

    expect(retained.snapshotContentIdentity).toBe(original.snapshotContentIdentity);
    expect(retained.generation).toBe(original.generation);
    expect(retained.freshness).toBe("stale");
    expect(retained.errors).toContainEqual({
      severity: "error",
      code: "runtime-operation-error",
      phase: "runtime",
      message: "repository snapshot runtime operation failed",
      occurrenceCount: 1,
    });
    expect(JSON.stringify(retained)).not.toContain("SECRET");
    await hydrated.ensureFresh();
    expect(hydrated.captureCurrent().freshness).toBe("stale");
    await hydrated.close();
  });

  it("retains the last complete checkpoint across explicit rebuild failure", async () => {
    const { root, stateRoot } = await fixture({ "src/a.ts": "export const explicitValue = true;" });
    let failBuild = false;
    const runtime = new RepoMapRuntime({
      projectRoot: root,
      stateRoot,
      watch: false,
      snapshotBuilder: async (options) => {
        if (failBuild) throw new Error("SECRET explicit build failure");
        return buildRepoMap(options);
      },
    });
    await runtime.start();
    const before = runtime.captureCurrent();
    failBuild = true;

    await runtime.rebuild();

    const retained = runtime.captureCurrent();
    expect(retained.snapshotContentIdentity).toBe(before.snapshotContentIdentity);
    expect(retained.generation).toBe(before.generation);
    expect(retained.freshness).toBe("stale");
    expect(retained.errors[0]).toMatchObject({
      code: "runtime-operation-error",
      message: "repository snapshot runtime operation failed",
    });
    await runtime.ensureFresh();
    expect(runtime.captureCurrent().freshness).toBe("stale");
    await runtime.close();
  });

  it("falls back atomically after invalid checkpoint publication and recovers without exposing candidate input", async () => {
    const { root, stateRoot } = await fixture({ "src/a.ts": "export const recoveryValue = true;" });
    let invalid = false;
    const runtime = new RepoMapRuntime({
      projectRoot: root,
      stateRoot,
      watch: false,
      snapshotBuilder: async (options) => {
        const map = await buildRepoMap(options);
        if (invalid && map.files[0]) map.files[0].path = "../PRIVATE-invalid-checkpoint.ts";
        return map;
      },
    });
    await runtime.start();
    const beforeInvalid = runtime.captureCurrent();
    invalid = true;
    await runtime.rebuild();

    const fallback = runtime.captureCurrent();
    expect(fallback.snapshot).toEqual(beforeInvalid.snapshot);
    expect(JSON.stringify(fallback.snapshot)).toBe(JSON.stringify(beforeInvalid.snapshot));
    expect(fallback.snapshotContentIdentity).toBe(beforeInvalid.snapshotContentIdentity);
    expect(fallback.generation).toBe(beforeInvalid.generation);
    expect(fallback.workspaceRevision).toBe(beforeInvalid.workspaceRevision);
    expect(fallback.gitHead).toBe(beforeInvalid.gitHead);
    expect(fallback.freshness).toBe("stale");
    expect(fallback.errors).toContainEqual({
      severity: "error",
      code: "runtime-operation-error",
      phase: "runtime",
      message: "repository snapshot runtime operation failed",
      occurrenceCount: 1,
    });
    expect(runtime.status()).toMatchObject({
      freshness: "stale",
      error: "repository snapshot checkpoint publication failed",
    });
    expect(JSON.stringify(runtime.status())).not.toContain("PRIVATE-invalid-checkpoint");
    expect(JSON.stringify(fallback)).not.toContain("PRIVATE-invalid-checkpoint");

    invalid = false;
    await runtime.rebuild();
    const recovered = runtime.captureCurrent();
    expect(recovered.snapshot.files[0]?.path).toBe("src/a.ts");
    expect(recovered.freshness).toBe("fresh");
    expect(runtime.status()).toMatchObject({ freshness: "fresh" });
    expect(runtime.status().error).toBeUndefined();
    expect(JSON.stringify(recovered)).not.toContain("PRIVATE-invalid-checkpoint");

    const beforeDirtyInvalid = runtime.captureCurrent();
    invalid = true;
    await runtime.rebuild();
    const dirtyFallback = runtime.captureCurrent();
    expect(dirtyFallback.snapshotContentIdentity).toBe(beforeDirtyInvalid.snapshotContentIdentity);
    expect(dirtyFallback.snapshot).toEqual(beforeDirtyInvalid.snapshot);
    expect(dirtyFallback.freshness).toBe("stale");
    await writeFile(join(root, "src/a.ts"), "export const recoveredDirtyValue = true;");
    invalid = false;
    await runtime.rebuild();
    const recoveredDirty = runtime.captureCurrent();
    expect(recoveredDirty.freshness).toBe("dirty");
    expect(recoveredDirty.snapshotContentIdentity).not.toBe(dirtyFallback.snapshotContentIdentity);
    expect(recoveredDirty.snapshot.files[0]?.symbols[0]?.name).toBe("recoveredDirtyValue");
    expect(runtime.status()).toMatchObject({ freshness: "dirty" });
    expect(runtime.status().error).toBeUndefined();
    await runtime.close();
  });

  it("keeps previously returned handles deeply unchanged across watcher flush and rebuild", async () => {
    const { root, stateRoot } = await fixture({ "src/a.ts": "export const immutableBefore = true;" });
    const runtime = new RepoMapRuntime({ projectRoot: root, stateRoot, watch: false });
    await runtime.start();
    const earlier = runtime.captureCurrent();
    const saved = structuredClone(earlier);
    const serialized = JSON.stringify(earlier);

    await writeFile(join(root, "src/a.ts"), "export const immutableAfter = true;");
    runtime.notify("change", "src/a.ts");
    await runtime.flush();
    await runtime.rebuild();

    expect(earlier).toEqual(saved);
    expect(JSON.stringify(earlier)).toBe(serialized);
    expect(earlier.snapshot.files[0]?.symbols[0]?.name).toBe("immutableBefore");
    expect(runtime.captureCurrent().snapshot.files[0]?.symbols[0]?.name).toBe("immutableAfter");
    await runtime.close();
  });

  it("honestly publishes newer content with the old generation after activation failure", async () => {
    const { root, stateRoot } = await fixture({ "src/a.ts": "export const beforeFailure = true;" });
    let failActivation = false;
    const runtime = new RepoMapRuntime({
      projectRoot: root,
      stateRoot,
      watch: false,
      atomicWriter: async (path, content) => {
        if (failActivation && path === join(stateRoot, "active.json")) throw new Error("SECRET activation failure");
        await atomicWriteFile(path, content);
      },
    });
    await runtime.start();
    const before = runtime.captureCurrent();
    failActivation = true;
    await writeFile(join(root, "src/a.ts"), "export const afterFailure = true;");
    runtime.notify("change", "src/a.ts");
    await runtime.flush();

    const after = runtime.captureCurrent();
    expect(after.generation).toBe(before.generation);
    expect(after.snapshot.files[0]?.symbols[0]?.name).toBe("afterFailure");
    expect(after.snapshotContentIdentity).not.toBe(before.snapshotContentIdentity);
    expect(after.freshness).toBe("stale");
    expect(after.errors).toContainEqual({
      severity: "error",
      code: "runtime-operation-error",
      phase: "runtime",
      message: "repository snapshot runtime operation failed",
      occurrenceCount: 1,
    });
    expect(JSON.stringify(after)).not.toContain("SECRET");
    await runtime.close();
  });
});
