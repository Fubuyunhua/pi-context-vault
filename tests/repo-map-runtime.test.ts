import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  isWatcherIgnoredPath,
  loadActiveRepoMapGeneration,
  type RepoMapChangeEvent,
  RepoMapRuntime,
  type RepoMapScheduler,
  type RepoMapWatcher,
} from "../src/repo-map/runtime.js";
import { atomicWriteFile } from "../src/state/atomic.js";
import { Telemetry } from "../src/telemetry.js";

function tickingClock(): () => number {
  let tick = 0;
  return () => tick++;
}

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class ManualScheduler implements RepoMapScheduler {
  tasks = new Set<() => void>();
  schedule(_delayMs: number, task: () => void): unknown {
    this.tasks.add(task);
    return task;
  }
  cancel(handle: unknown): void {
    this.tasks.delete(handle as () => void);
  }
  run(): void {
    const tasks = [...this.tasks];
    this.tasks.clear();
    for (const task of tasks) task();
  }
}

class FakeWatcher implements RepoMapWatcher {
  listeners = new Map<RepoMapChangeEvent, Array<(path: string) => void>>();
  closed = false;
  on(event: RepoMapChangeEvent, listener: (path: string) => void): RepoMapWatcher {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return this;
  }
  emit(event: RepoMapChangeEvent, path: string): void {
    for (const listener of this.listeners.get(event) ?? []) listener(path);
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("isWatcherIgnoredPath", () => {
  it("ignores git internals regardless of path separator style", () => {
    // Windows-style paths (backslashes) are what chokidar previously failed to
    // split on, causing it to watch `.git` lock files and crash with EPERM.
    expect(isWatcherIgnoredPath("C:\\JavaProjects\\slothub\\.git\\t88JaC0")).toBe(true);
    expect(isWatcherIgnoredPath("C:\\JavaProjects\\slothub\\.git\\index")).toBe(true);
    expect(isWatcherIgnoredPath("C:/JavaProjects/slothub/.git/t88JaC0")).toBe(true);
    expect(isWatcherIgnoredPath("/home/dev/project/.git/HEAD")).toBe(true);
    expect(isWatcherIgnoredPath("/home/dev/project/.pi/agent/state.json")).toBe(true);
    expect(isWatcherIgnoredPath("/home/dev/project/node_modules/pkg/index.js")).toBe(true);
    expect(isWatcherIgnoredPath("/home/dev/project/build/out.class")).toBe(true);
  });

  it("keeps ordinary project paths visible", () => {
    expect(isWatcherIgnoredPath("C:\\JavaProjects\\slothub\\src\\Main.java")).toBe(false);
    expect(isWatcherIgnoredPath("/home/dev/project/src/index.ts")).toBe(false);
    expect(isWatcherIgnoredPath("/home/dev/project/gitnotes.txt")).toBe(false);
    expect(isWatcherIgnoredPath("/home/dev/project/.gitignore")).toBe(false);
  });
});

async function fixture(files: Record<string, string>, git = true): Promise<{ root: string; stateRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), "context-vault-runtime-"));
  const stateRoot = await mkdtemp(join(tmpdir(), "context-vault-runtime-state-"));
  roots.push(root, stateRoot);
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, content);
  }
  if (git) {
    await execFileAsync("git", ["init", "-q"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: root });
    await execFileAsync("git", ["add", "."], { cwd: root });
    await execFileAsync("git", ["commit", "-qm", "initial"], { cwd: root });
  }
  return { root, stateRoot };
}

describe("incremental repository map runtime", () => {
  it("attaches watcher observation before initial non-Git enumeration", async () => {
    const { root, stateRoot } = await fixture(
      { "src/existing.ts": "export const beforeWatcherAttachment = true;" },
      false,
    );
    const fakeWatcher = new FakeWatcher();
    const runtime = new RepoMapRuntime({
      projectRoot: root,
      stateRoot,
      watcherFactory() {
        writeFileSync(join(root, "src/existing.ts"), "export const changedDuringWatcherAttachment = true;");
        writeFileSync(join(root, "src/created.ts"), "export const createdDuringWatcherAttachment = true;");
        return fakeWatcher;
      },
    });

    await runtime.start();

    expect((await runtime.query("changedDuringWatcherAttachment")).results[0]?.path).toBe("src/existing.ts");
    expect((await runtime.query("createdDuringWatcherAttachment")).results[0]?.path).toBe("src/created.ts");
    await runtime.close();
  });

  it("keeps an explicit query behind watcher work notified during reconciliation", async () => {
    const { root, stateRoot } = await fixture({
      "src/a.ts": "export const initialA = true;",
      "src/b.ts": "export const initialB = true;",
    });
    const reconciliationRead = deferred();
    const releaseReconciliation = deferred();
    let armed = false;
    let readsAfterArm = 0;
    const runtime = new RepoMapRuntime({
      projectRoot: root,
      stateRoot,
      watch: false,
      indexFileSystem: {
        async lstat(path) {
          const info = await lstat(path);
          return { isFile: () => info.isFile(), size: info.size, mtimeMs: 1, ctimeMs: 1 };
        },
        async readFile(path) {
          if (armed && path === join(root, "src/a.ts") && ++readsAfterArm === 2) {
            reconciliationRead.resolve();
            await releaseReconciliation.promise;
          }
          return readFile(path);
        },
      },
    });
    await runtime.start();
    await writeFile(join(root, "src/a.ts"), "export const changedA = true;");
    runtime.notify("change", "src/a.ts");
    armed = true;

    const query = runtime.query("queuedDuringReconciliation");
    await reconciliationRead.promise;
    await writeFile(join(root, "src/b.ts"), "export const queuedDuringReconciliation = true;");
    runtime.notify("change", "src/b.ts");
    releaseReconciliation.resolve();

    await expect(query).resolves.toMatchObject({
      freshness: "dirty",
      pendingFiles: [],
      results: [{ path: "src/b.ts" }],
    });
    await runtime.close();
  });

  it("keeps queryCurrent fallback evidence coherent while a flush interleaves", async () => {
    const { root, stateRoot } = await fixture({ "src/value.ts": "export const capturedBeforeFlush = true;" });
    const flushRead = deferred();
    const releaseFlush = deferred();
    let blockFlush = false;
    let flushBlocked = false;
    const runtime = new RepoMapRuntime({
      projectRoot: root,
      stateRoot,
      watch: false,
      indexFileSystem: {
        lstat,
        async readFile(path) {
          if (blockFlush && !flushBlocked && path === join(root, "src/value.ts")) {
            flushBlocked = true;
            flushRead.resolve();
            await releaseFlush.promise;
          }
          return readFile(path);
        },
      },
    });
    await runtime.start();
    await writeFile(join(root, "src/value.ts"), "export const capturedAfterFlush = true;");
    runtime.notify("change", "src/value.ts");
    const capturedStatus = runtime.status();
    blockFlush = true;

    const flush = runtime.flush();
    await flushRead.promise;
    const result = await runtime.queryCurrent("capturedBeforeFlush");
    releaseFlush.resolve();
    await flush;
    const currentStatus = runtime.status();

    expect(result).toMatchObject({
      freshness: capturedStatus.freshness,
      generation: capturedStatus.generation,
      gitHead: capturedStatus.gitHead,
      workspaceRevision: capturedStatus.workspaceRevision,
      pendingFiles: capturedStatus.pendingFiles,
      results: [{ path: "src/value.ts" }],
    });
    expect(result.error).toBe(capturedStatus.error);
    expect(result.fallbackEvidence).toEqual([expect.objectContaining({ kind: "source", path: "src/value.ts" })]);
    expect(result.fallbackEvidence[0]?.excerpt).toContain("capturedbeforeflush");
    expect(result.fallbackEvidence[0]?.excerpt).not.toContain("capturedAfterFlush");
    expect(currentStatus).toMatchObject({ freshness: "dirty", pendingFiles: [] });
    expect(currentStatus.generation).toBeGreaterThan(result.generation);
    expect((await runtime.queryCurrent("capturedAfterFlush")).results[0]?.path).toBe("src/value.ts");
    await runtime.close();
  });

  it("bounds flush under a sustained watcher-event storm and later converges", async () => {
    const { root, stateRoot } = await fixture({ "src/storm.ts": "export const beforeStorm = true;" });
    const scheduler = new ManualScheduler();
    let stormEvents = 100;
    let armed = false;
    let runtime!: RepoMapRuntime;
    runtime = new RepoMapRuntime({
      projectRoot: root,
      stateRoot,
      watch: false,
      scheduler,
      indexFileSystem: {
        lstat,
        async readFile(path) {
          const content = await readFile(path);
          if (armed && stormEvents > 0 && path === join(root, "src/storm.ts")) {
            stormEvents -= 1;
            runtime.notify("change", "src/storm.ts");
          }
          return content;
        },
      },
    });
    await runtime.start();
    await writeFile(join(root, "src/storm.ts"), "export const duringStorm = true;");
    armed = true;
    runtime.notify("change", "src/storm.ts");

    await runtime.flush();

    expect(stormEvents).toBeGreaterThan(0);
    expect(runtime.status()).toMatchObject({ freshness: "stale", pendingFiles: ["src/storm.ts"] });
    expect(scheduler.tasks.size).toBeGreaterThan(0);

    armed = false;
    scheduler.run();
    await runtime.flush();
    expect(runtime.status()).toMatchObject({ freshness: "dirty", pendingFiles: [] });
    await runtime.close();
  });

  it("bounds ensureFresh under watcher starvation and preserves scheduled convergence", async () => {
    const { root, stateRoot } = await fixture({ "src/starved.ts": "export const beforeStarvation = true;" });
    const scheduler = new ManualScheduler();
    let stormEvents = 100;
    let armed = false;
    let runtime!: RepoMapRuntime;
    runtime = new RepoMapRuntime({
      projectRoot: root,
      stateRoot,
      watch: false,
      scheduler,
      indexFileSystem: {
        lstat,
        async readFile(path) {
          const content = await readFile(path);
          if (armed && stormEvents > 0 && path === join(root, "src/starved.ts")) {
            stormEvents -= 1;
            runtime.notify("change", "src/starved.ts");
          }
          return content;
        },
      },
    });
    await runtime.start();
    await writeFile(join(root, "src/starved.ts"), "export const duringStarvation = true;");
    armed = true;
    runtime.notify("change", "src/starved.ts");

    await runtime.ensureFresh();

    expect(stormEvents).toBeGreaterThan(0);
    expect(runtime.status()).toMatchObject({ freshness: "stale", pendingFiles: ["src/starved.ts"] });
    expect(scheduler.tasks.size).toBeGreaterThan(0);

    armed = false;
    scheduler.run();
    await runtime.flush();
    expect(runtime.status()).toMatchObject({ freshness: "dirty", pendingFiles: [] });
    await runtime.close();
  });

  it("keeps rebuild behind watcher work notified during activation", async () => {
    const { root, stateRoot } = await fixture({ "src/a.ts": "export const initialA = true;" });
    const activationWrite = deferred();
    const releaseActivation = deferred();
    const queuedRead = deferred();
    const releaseQueuedRead = deferred();
    let gateActivation = false;
    let gateQueuedRead = false;
    const runtime = new RepoMapRuntime({
      projectRoot: root,
      stateRoot,
      watch: false,
      atomicWriter: async (path, content) => {
        if (gateActivation && path === join(stateRoot, "active.json")) {
          gateActivation = false;
          activationWrite.resolve();
          await releaseActivation.promise;
        }
        await atomicWriteFile(path, content);
      },
      indexFileSystem: {
        lstat,
        async readFile(path) {
          if (gateQueuedRead && path === join(root, "src/queued.ts")) {
            gateQueuedRead = false;
            queuedRead.resolve();
            await releaseQueuedRead.promise;
          }
          return readFile(path);
        },
      },
    });
    await runtime.start();
    await writeFile(join(root, "src/a.ts"), "export const rebuiltA = true;");
    gateActivation = true;
    gateQueuedRead = true;

    let rebuildSettled = false;
    const rebuild = runtime.rebuild().then(() => {
      rebuildSettled = true;
    });
    await activationWrite.promise;
    await writeFile(join(root, "src/queued.ts"), "export const queuedDuringActivation = true;");
    runtime.notify("add", "src/queued.ts");
    releaseActivation.resolve();
    await queuedRead.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(rebuildSettled).toBe(false);
    releaseQueuedRead.resolve();
    await rebuild;

    expect((await runtime.queryCurrent("queuedDuringActivation")).results[0]?.path).toBe("src/queued.ts");
    expect(
      (await loadActiveRepoMapGeneration(stateRoot)).snapshot.files.some(({ path }) => path === "src/queued.ts"),
    ).toBe(true);
    await runtime.close();
  });

  it("fast-updates a changed signature and deep-flushes a deterministic dirty revision", async () => {
    const { root, stateRoot } = await fixture({
      "src/service.ts": "export function createUser(name: string): string { return name; }",
    });
    const scheduler = new ManualScheduler();
    const runtime = new RepoMapRuntime({ projectRoot: root, stateRoot, watch: false, scheduler });
    await runtime.start();
    const cleanRevision = runtime.status().workspaceRevision;

    await writeFile(join(root, "src/service.ts"), "export function createUser(id: number): number { return id; }");
    runtime.notify("change", "src/service.ts");
    expect(runtime.status()).toMatchObject({ freshness: "stale", pendingFiles: ["src/service.ts"] });
    await runtime.flush();

    const query = await runtime.query("createUser");
    expect(query.freshness).toBe("dirty");
    expect(query.workspaceRevision).not.toBe(cleanRevision);
    expect(query.results[0]?.symbols[0]?.signature).toBe("function createUser(id: number): number");
    expect((await loadActiveRepoMapGeneration(stateRoot)).workspaceRevision).toBe(query.workspaceRevision);
    await runtime.close();
  });

  it("computes the same workspace revision regardless of change-event order", async () => {
    const originalA = "export const alpha = 1;";
    const originalB = "export const beta = 1;";
    const { root, stateRoot } = await fixture({ "src/a.ts": originalA, "src/b.ts": originalB });
    const runtime = new RepoMapRuntime({ projectRoot: root, stateRoot, watch: false });
    await runtime.start();
    await writeFile(join(root, "src/a.ts"), "export const alpha = 2;");
    await writeFile(join(root, "src/b.ts"), "export const beta = 2;");
    runtime.notify("change", "src/a.ts");
    runtime.notify("change", "src/b.ts");
    await runtime.flush();
    const firstRevision = runtime.status().workspaceRevision;

    await writeFile(join(root, "src/a.ts"), originalA);
    await writeFile(join(root, "src/b.ts"), originalB);
    runtime.notify("change", "src/a.ts");
    runtime.notify("change", "src/b.ts");
    await runtime.flush();
    await writeFile(join(root, "src/a.ts"), "export const alpha = 2;");
    await writeFile(join(root, "src/b.ts"), "export const beta = 2;");
    runtime.notify("change", "src/b.ts");
    runtime.notify("change", "src/a.ts");
    await runtime.flush();

    expect(runtime.status().workspaceRevision).toBe(firstRevision);
    await runtime.close();
  });

  it("clears a startup dirty overlay after the file is restored to HEAD", async () => {
    const original = "export const restoredValue = 1;";
    const { root, stateRoot } = await fixture({ "src/restored.ts": original });
    await writeFile(join(root, "src/restored.ts"), "export const dirtyValue = 2;");
    const runtime = new RepoMapRuntime({ projectRoot: root, stateRoot, watch: false });
    await runtime.start();
    expect(runtime.status().freshness).toBe("dirty");

    await writeFile(join(root, "src/restored.ts"), original);
    runtime.notify("change", "src/restored.ts");
    const query = await runtime.query("restoredValue");

    expect(query.freshness).toBe("fresh");
    expect(runtime.status().dirtyFiles).toEqual([]);
    expect(query.results[0]?.symbols[0]?.name).toBe("restoredValue");
    await runtime.close();
  });

  it("observes external create, delete, and rename as unlink plus add without sleeps", async () => {
    const { root, stateRoot } = await fixture({ "src/old.ts": "export const oldName = true;" });
    const fakeWatcher = new FakeWatcher();
    const runtime = new RepoMapRuntime({
      projectRoot: root,
      stateRoot,
      watcherFactory: () => fakeWatcher,
      scheduler: new ManualScheduler(),
    });
    await runtime.start();

    await writeFile(join(root, "src/external.ts"), "export const externalEdit = true;");
    fakeWatcher.emit("add", join(root, "src/external.ts"));
    await writeFile(join(root, "src/new.ts"), "export const renamedValue = true;");
    await rm(join(root, "src/old.ts"));
    fakeWatcher.emit("unlink", join(root, "src/old.ts"));
    fakeWatcher.emit("add", join(root, "src/new.ts"));

    expect((await runtime.query("externalEdit")).results[0]?.path).toBe("src/external.ts");
    expect((await runtime.query("renamedValue")).results[0]?.path).toBe("src/new.ts");
    expect((await runtime.query("oldName")).results).toEqual([]);
    await runtime.close();
    expect(fakeWatcher.closed).toBe(true);
  });

  it("does not add watcher events excluded by map configuration", async () => {
    const { root, stateRoot } = await fixture({ "src/visible.ts": "export const visible = true;" });
    const runtime = new RepoMapRuntime({
      projectRoot: root,
      stateRoot,
      watch: false,
      exclude: ["generated/**"],
    });
    await runtime.start();
    await mkdir(join(root, "generated"), { recursive: true });
    await writeFile(join(root, "generated/client.ts"), "export const generatedClient = true;");
    runtime.notify("add", "generated/client.ts");

    expect((await runtime.query("generatedClient")).results).toEqual([]);
    expect(runtime.status().pendingFiles).toEqual([]);
    await runtime.close();
  });

  it("does not revise or activate for ignored and untracked binary additions", async () => {
    const { root, stateRoot } = await fixture({
      ".gitignore": "ignored/**\n",
      "src/visible.ts": "export const visible = true;",
    });
    const runtime = new RepoMapRuntime({ projectRoot: root, stateRoot, watch: false });
    await runtime.start();
    const initial = runtime.status();

    await mkdir(join(root, "ignored"), { recursive: true });
    await writeFile(join(root, "ignored/new.ts"), "export const shouldStayIgnored = true;");
    runtime.notify("add", "ignored/new.ts");
    await mkdir(join(root, "assets"), { recursive: true });
    await writeFile(join(root, "assets/new.bin"), new Uint8Array([0, 1, 2, 3]));
    runtime.notify("add", "assets/new.bin");
    await runtime.flush();

    expect(runtime.status()).toMatchObject({
      generation: initial.generation,
      workspaceRevision: initial.workspaceRevision,
      dirtyFiles: [],
      pendingFiles: [],
      freshness: "fresh",
    });
    expect((await runtime.query("shouldStayIgnored")).results).toEqual([]);
    await runtime.close();
  });

  it("applies root gitignore rules consistently in a non-Git workspace", async () => {
    const { root, stateRoot } = await fixture(
      {
        ".gitignore": "ignored/**\n",
        "configured/initial.ts": "export const initiallyConfiguredOut = true;",
        "ignored/initial.ts": "export const initiallyIgnored = true;",
        "src/visible.ts": "export const visibleWithoutGit = true;",
      },
      false,
    );
    const runtime = new RepoMapRuntime({
      projectRoot: root,
      stateRoot,
      exclude: ["configured/**"],
      watch: false,
    });
    await runtime.start();
    const initial = runtime.status();

    expect((await runtime.query("initiallyIgnored")).results).toEqual([]);
    expect((await runtime.query("initiallyConfiguredOut")).results).toEqual([]);
    await writeFile(join(root, "ignored/added.ts"), "export const addedButIgnored = true;");
    runtime.notify("add", "ignored/added.ts");
    await writeFile(join(root, "configured/added.ts"), "export const addedButConfiguredOut = true;");
    runtime.notify("add", "configured/added.ts");
    await runtime.flush();

    expect((await runtime.query("addedButIgnored")).results).toEqual([]);
    expect((await runtime.query("addedButConfiguredOut")).results).toEqual([]);
    expect(runtime.status()).toMatchObject({
      generation: initial.generation,
      workspaceRevision: initial.workspaceRevision,
      dirtyFiles: [],
      pendingFiles: [],
      freshness: "fresh",
    });

    await writeFile(join(root, ".gitignore"), "other/**\n");
    runtime.notify("change", ".gitignore");
    await runtime.flush();
    expect((await runtime.query("addedButIgnored")).results[0]?.path).toBe("ignored/added.ts");
    await runtime.close();
  });

  it("records tracked text-to-binary as dirty content, not deletion", async () => {
    const { root, stateRoot } = await fixture({ "src/value.ts": "export const textValue = true;" });
    const runtime = new RepoMapRuntime({ projectRoot: root, stateRoot, watch: false });
    await runtime.start();
    const initialGeneration = runtime.status().generation;
    await writeFile(join(root, "src/value.ts"), new Uint8Array([0, 1, 2, 3]));
    runtime.notify("change", "src/value.ts");
    await runtime.flush();

    const status = runtime.status();
    const active = await loadActiveRepoMapGeneration(stateRoot);
    expect(status).toMatchObject({ freshness: "dirty", dirtyFiles: ["src/value.ts"] });
    expect(status.generation).toBeGreaterThan(initialGeneration);
    expect(active.dirtyFiles[0]?.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(active.dirtyFiles[0]?.contentHash).not.toBe("deleted");
    expect((await runtime.query("textValue")).results).toEqual([]);
    await runtime.close();
  });

  it("records a tracked nonregular transition as dirty content, not deletion", async () => {
    const { root, stateRoot } = await fixture({ "src/value.ts": "export const regularValue = true;" });
    const runtime = new RepoMapRuntime({ projectRoot: root, stateRoot, watch: false });
    await runtime.start();
    await rm(join(root, "src/value.ts"));
    await mkdir(join(root, "src/value.ts"));
    runtime.notify("change", "src/value.ts");
    await runtime.flush();

    const active = await loadActiveRepoMapGeneration(stateRoot);
    expect(active.dirtyFiles[0]?.path).toBe("src/value.ts");
    expect(active.dirtyFiles[0]?.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(active.dirtyFiles[0]?.contentHash).not.toBe("deleted");
    expect((await runtime.query("regularValue")).results).toEqual([]);
    await runtime.close();
  });

  it("preserves coherent content and stays stale on transient read errors until recovery", async () => {
    const { root, stateRoot } = await fixture({ "src/value.ts": "export const coherentValue = true;" });
    const runtime = new RepoMapRuntime({ projectRoot: root, stateRoot, watch: false });
    await runtime.start();
    const initialRevision = runtime.status().workspaceRevision;
    await chmod(join(root, "src/value.ts"), 0o000);
    runtime.notify("change", "src/value.ts");
    await runtime.flush();

    const stale = await runtime.query("coherentValue");
    expect(stale).toMatchObject({ freshness: "stale", workspaceRevision: initialRevision });
    expect(stale.results[0]?.path).toBe("src/value.ts");
    expect(stale.pendingFiles).toEqual(["src/value.ts"]);
    expect(stale.fallbackEvidence.length).toBeGreaterThan(0);
    expect(stale.error?.length).toBeLessThanOrEqual(512);

    await chmod(join(root, "src/value.ts"), 0o644);
    await runtime.flush();
    expect(runtime.status()).toMatchObject({ freshness: "fresh", pendingFiles: [] });
    await runtime.close();
  });

  it("preserves coherent evidence for deterministic ENOENT between lstat and readFile", async () => {
    const { root, stateRoot } = await fixture({ "src/value.ts": "export const racedCoherentValue = true;" });
    let failReads = false;
    const runtime = new RepoMapRuntime({
      projectRoot: root,
      stateRoot,
      watch: false,
      indexFileSystem: {
        lstat,
        async readFile(path) {
          if (failReads && path === join(root, "src/value.ts")) {
            throw Object.assign(new Error("simulated ENOENT after successful lstat"), { code: "ENOENT" });
          }
          return readFile(path);
        },
      },
    });
    await runtime.start();
    const coherentRevision = runtime.status().workspaceRevision;

    failReads = true;
    runtime.notify("change", "src/value.ts");
    await runtime.flush();

    const stale = await runtime.query("racedCoherentValue");
    expect(stale).toMatchObject({ freshness: "stale", workspaceRevision: coherentRevision });
    expect(stale.results[0]?.path).toBe("src/value.ts");
    expect(stale.pendingFiles).toEqual(["src/value.ts"]);
    expect(stale.fallbackEvidence).toEqual(expect.arrayContaining([expect.objectContaining({ path: "src/value.ts" })]));
    expect((await loadActiveRepoMapGeneration(stateRoot)).dirtyFiles).toEqual([]);

    failReads = false;
    await runtime.flush();
    expect(runtime.status()).toMatchObject({ freshness: "fresh", pendingFiles: [] });
    await runtime.close();
  });

  it("keeps a prior dirty overlay when Git temporarily omits its read-error path", async () => {
    const { root, stateRoot } = await fixture({ "src/value.ts": "export const originalValue = true;" });
    const runtime = new RepoMapRuntime({ projectRoot: root, stateRoot, watch: false });
    await runtime.start();
    await writeFile(join(root, "src/value.ts"), "export const omittedDirtyValue = true;");
    runtime.notify("change", "src/value.ts");
    await runtime.flush();
    const dirtyRevision = runtime.status().workspaceRevision;
    await execFileAsync("git", ["update-index", "--assume-unchanged", "src/value.ts"], { cwd: root });
    await chmod(join(root, "src/value.ts"), 0o000);
    runtime.notify("change", "src/value.ts");
    await runtime.flush();

    const query = await runtime.query("omittedDirtyValue");
    expect(query).toMatchObject({ freshness: "stale", workspaceRevision: dirtyRevision });
    expect(query.results[0]?.path).toBe("src/value.ts");
    expect(runtime.status().dirtyFiles).toEqual(["src/value.ts"]);
    await chmod(join(root, "src/value.ts"), 0o644);
    await runtime.close();
  });

  it("preserves a coherent dirty overlay when an explicit rebuild hits a read error", async () => {
    const { root, stateRoot } = await fixture({ "src/value.ts": "export const originalValue = true;" });
    const runtime = new RepoMapRuntime({ projectRoot: root, stateRoot, watch: false });
    await runtime.start();
    await writeFile(join(root, "src/value.ts"), "export const coherentDirtyValue = true;");
    runtime.notify("change", "src/value.ts");
    await runtime.flush();
    const dirtyRevision = runtime.status().workspaceRevision;

    await chmod(join(root, "src/value.ts"), 0o000);
    await runtime.rebuild();

    const query = await runtime.query("coherentDirtyValue");
    expect(query).toMatchObject({ freshness: "stale", workspaceRevision: dirtyRevision });
    expect(query.results[0]?.path).toBe("src/value.ts");
    expect(query.pendingFiles).toEqual(["src/value.ts"]);
    expect(query.fallbackEvidence.length).toBeGreaterThan(0);
    expect(query.error?.length).toBeLessThanOrEqual(512);
    await chmod(join(root, "src/value.ts"), 0o644);
    await runtime.close();
  });

  it("preserves coherent evidence when a HEAD-change rebuild hits a read error", async () => {
    const { root, stateRoot } = await fixture({ "src/value.ts": "export const coherentHeadValue = true;" });
    const runtime = new RepoMapRuntime({ projectRoot: root, stateRoot, watch: false });
    await runtime.start();
    const oldHead = runtime.status().gitHead;
    await writeFile(join(root, "README.md"), "new head\n");
    await execFileAsync("git", ["add", "README.md"], { cwd: root });
    await execFileAsync("git", ["commit", "-qm", "new head"], { cwd: root });
    await chmod(join(root, "src/value.ts"), 0o000);

    const query = await runtime.query("coherentHeadValue");
    expect(query.gitHead).not.toBe(oldHead);
    expect(query.freshness).toBe("stale");
    expect(query.results[0]?.path).toBe("src/value.ts");
    expect(query.pendingFiles).toEqual(["src/value.ts"]);
    expect(query.fallbackEvidence.length).toBeGreaterThan(0);
    await chmod(join(root, "src/value.ts"), 0o644);
    await runtime.close();
  });

  it("hydrates coherent persisted evidence on restart, but reports no evidence without a prior generation", async () => {
    const withPrior = await fixture({ "src/value.ts": "export const restartValue = true;" });
    const first = new RepoMapRuntime({ projectRoot: withPrior.root, stateRoot: withPrior.stateRoot, watch: false });
    await first.start();
    await first.close();
    await chmod(join(withPrior.root, "src/value.ts"), 0o000);

    const restarted = new RepoMapRuntime({ projectRoot: withPrior.root, stateRoot: withPrior.stateRoot, watch: false });
    await restarted.start();
    const preserved = await restarted.query("restartValue");
    expect(preserved.freshness).toBe("stale");
    expect(preserved.results[0]?.path).toBe("src/value.ts");

    const withoutPrior = await fixture({ "src/value.ts": "export const unavailableValue = true;" });
    await chmod(join(withoutPrior.root, "src/value.ts"), 0o000);
    const cold = new RepoMapRuntime({
      projectRoot: withoutPrior.root,
      stateRoot: withoutPrior.stateRoot,
      watch: false,
    });
    await cold.start();
    const unavailable = await cold.query("unavailableValue");
    expect(unavailable.freshness).toBe("stale");
    expect(unavailable.results).toEqual([]);
    expect(unavailable.pendingFiles).toEqual(["src/value.ts"]);
    expect(unavailable.fallbackEvidence).toEqual([
      { kind: "source", excerpt: "No indexed source file is available; use direct filesystem search." },
    ]);
    await chmod(join(withPrior.root, "src/value.ts"), 0o644);
    await chmod(join(withoutPrior.root, "src/value.ts"), 0o644);
    await restarted.close();
    await cold.close();
  });

  it("uses the same deleted revision for confirmed missing and unlink outcomes", async () => {
    const { root, stateRoot } = await fixture({ "src/value.ts": "export const deletedValue = true;" });
    const unlinkStateRoot = await mkdtemp(join(tmpdir(), "context-vault-runtime-state-"));
    roots.push(unlinkStateRoot);
    const missingRuntime = new RepoMapRuntime({ projectRoot: root, stateRoot, watch: false });
    const unlinkRuntime = new RepoMapRuntime({ projectRoot: root, stateRoot: unlinkStateRoot, watch: false });
    await missingRuntime.start();
    await unlinkRuntime.start();
    await rm(join(root, "src/value.ts"));
    missingRuntime.notify("change", "src/value.ts");
    unlinkRuntime.notify("unlink", "src/value.ts");
    await missingRuntime.flush();
    await unlinkRuntime.flush();

    const missingActive = await loadActiveRepoMapGeneration(stateRoot);
    const unlinkActive = await loadActiveRepoMapGeneration(unlinkStateRoot);
    expect(missingActive.dirtyFiles).toEqual([{ path: "src/value.ts", contentHash: "deleted" }]);
    expect(unlinkActive.dirtyFiles).toEqual(missingActive.dirtyFiles);
    expect(missingRuntime.status().workspaceRevision).toBe(unlinkRuntime.status().workspaceRevision);
    expect((await missingRuntime.query("deletedValue")).results).toEqual([]);
    await missingRuntime.close();
    await unlinkRuntime.close();
  });

  it("invalidates the base generation when Git HEAD changes at query time", async () => {
    const { root, stateRoot } = await fixture({ "src/version.ts": "export const firstVersion = true;" });
    const firstHead = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    await writeFile(join(root, "src/version.ts"), "export const secondVersion = true;");
    await execFileAsync("git", ["add", "."], { cwd: root });
    await execFileAsync("git", ["commit", "-qm", "second"], { cwd: root });
    const runtime = new RepoMapRuntime({ projectRoot: root, stateRoot, watch: false });
    await runtime.start();
    const secondHead = runtime.status().gitHead;
    await execFileAsync("git", ["checkout", "-q", firstHead], { cwd: root });

    const query = await runtime.query("firstVersion");
    expect(query.gitHead).toBe(firstHead);
    expect(query.gitHead).not.toBe(secondHead);
    expect(query.results[0]?.path).toBe("src/version.ts");
    expect(query.freshness).toBe("fresh");
    await runtime.close();
  });

  it("supports an explicit deep rebuild without relying on watcher delivery", async () => {
    const { root, stateRoot } = await fixture({ "src/value.ts": "export const oldValue = true;" });
    const runtime = new RepoMapRuntime({ projectRoot: root, stateRoot, watch: false });
    await runtime.start();
    const generation = runtime.status().generation;
    await writeFile(join(root, "src/value.ts"), "export const rebuiltValue = true;");

    await runtime.rebuild();

    expect(runtime.status().generation).toBeGreaterThan(generation);
    expect((await runtime.query("rebuiltValue")).results[0]?.path).toBe("src/value.ts");
    expect((await runtime.query("oldValue")).results).toEqual([]);
    await runtime.close();
  });

  it("accounts for orphan bytes after activation failure and reconciles them on later cleanup", async () => {
    const { root, stateRoot } = await fixture({ "src/value.ts": "export const stableValue = 1;" });
    const telemetry = new Telemetry();
    let failActive = false;
    const runtime = new RepoMapRuntime({
      projectRoot: root,
      stateRoot,
      watch: false,
      mapGenerationRetention: 1,
      atomicWriter: async (path, content) => {
        if (failActive && path.endsWith("active.json")) throw new Error("simulated activation crash");
        await atomicWriteFile(path, content);
      },
      telemetry,
    });
    await runtime.start();
    const generationsRoot = join(stateRoot, "generations");
    const before = await readFile(join(stateRoot, "active.json"), "utf8");
    const telemetryBefore = telemetry.snapshot();
    failActive = true;
    await writeFile(join(root, "src/value.ts"), "export const changedValue = 2;");
    runtime.notify("change", "src/value.ts");
    await runtime.flush();

    expect(runtime.status()).toMatchObject({ freshness: "stale", error: "simulated activation crash" });
    expect(await readFile(join(stateRoot, "active.json"), "utf8")).toBe(before);
    expect((await loadActiveRepoMapGeneration(stateRoot)).snapshot.files[0]?.symbols[0]?.name).toBe("stableValue");
    const firstOrphanBytes = (await stat(join(generationsRoot, "2.json"))).size;
    const bytesAfterFirstFailure = (
      await Promise.all(
        (
          await readdir(generationsRoot)
        )
          .filter((path) => path.endsWith(".json"))
          .map(async (path) => (await stat(join(generationsRoot, path))).size),
      )
    ).reduce((total, bytes) => total + bytes, 0);
    expect(telemetry.snapshot()).toMatchObject({
      generationCreatedCount: telemetryBefore.generationCreatedCount,
      generationBytesWritten: telemetryBefore.generationBytesWritten + firstOrphanBytes,
      repoMapTotalBytes: bytesAfterFirstFailure,
    });

    const degraded = await runtime.query("changedValue");
    expect(degraded.freshness).toBe("stale");
    expect(degraded.fallbackEvidence.some((evidence) => evidence.kind === "source")).toBe(true);
    const secondOrphanBytes = (await stat(join(generationsRoot, "3.json"))).size;
    const bytesAfterSecondFailure = (
      await Promise.all(
        (
          await readdir(generationsRoot)
        )
          .filter((path) => path.endsWith(".json"))
          .map(async (path) => (await stat(join(generationsRoot, path))).size),
      )
    ).reduce((total, bytes) => total + bytes, 0);
    expect(telemetry.snapshot()).toMatchObject({
      generationCreatedCount: telemetryBefore.generationCreatedCount,
      generationBytesWritten: telemetryBefore.generationBytesWritten + firstOrphanBytes + secondOrphanBytes,
      repoMapTotalBytes: bytesAfterSecondFailure,
    });

    failActive = false;
    await runtime.flush();
    const active = await loadActiveRepoMapGeneration(stateRoot);
    const remaining = (await readdir(generationsRoot)).filter((path) => path.endsWith(".json"));
    const activeBytes = (await stat(join(generationsRoot, `${active.generation}.json`))).size;
    expect(remaining).toEqual([`${active.generation}.json`]);
    expect(telemetry.snapshot()).toMatchObject({
      generationCreatedCount: telemetryBefore.generationCreatedCount + 1,
      generationBytesWritten:
        telemetryBefore.generationBytesWritten + firstOrphanBytes + secondOrphanBytes + activeBytes,
      repoMapTotalBytes: activeBytes,
    });
    await runtime.close();
  });

  it("suppresses same-content generations and writes compact JSON", async () => {
    const { root, stateRoot } = await fixture({ "src/value.ts": "export const stableValue = 1;" });
    const telemetry = new Telemetry();
    const runtime = new RepoMapRuntime({ projectRoot: root, stateRoot, watch: false, telemetry });
    await runtime.start();
    const generation = runtime.status().generation;
    const before = telemetry.snapshot().generationCreatedCount;
    const generationPath = join(stateRoot, "generations", `${generation}.json`);
    expect(await readFile(generationPath, "utf8")).not.toMatch(/\n\s+"/u);

    await writeFile(join(root, "src/value.ts"), "export const stableValue = 1;");
    runtime.notify("change", "src/value.ts");
    await runtime.flush();

    expect(runtime.status().generation).toBe(generation);
    expect(telemetry.snapshot().generationCreatedCount).toBe(before);
    expect((await readdir(join(stateRoot, "generations"))).filter((path) => path.endsWith(".json"))).toEqual([
      `${generation}.json`,
    ]);
    await runtime.close();
  });

  it("treats snapshot provenance.generatedAt as a nondurable no-op timestamp", async () => {
    const { root, stateRoot } = await fixture({ "src/value.ts": "export const stableValue = 1;" });
    const runtime = new RepoMapRuntime({ projectRoot: root, stateRoot, watch: false });
    await runtime.start();
    const activePath = join(stateRoot, "generations", "1.json");
    const active = JSON.parse(await readFile(activePath, "utf8"));
    active.snapshot.provenance.generatedAt = "2000-01-01T00:00:00.000Z";
    await writeFile(activePath, `${JSON.stringify(active)}\n`);

    await runtime.rebuild();

    expect(runtime.status().generation).toBe(1);
    expect((await readdir(join(stateRoot, "generations"))).filter((path) => path.endsWith(".json"))).toEqual([
      "1.json",
    ]);
    await runtime.close();
  });

  it("rejects nested active-generation corruption before pruning older valid generations", async () => {
    const { root, stateRoot } = await fixture({ "src/value.ts": "export const safeValue = 1;" });
    const runtime = new RepoMapRuntime({ projectRoot: root, stateRoot, watch: false, mapGenerationRetention: 1 });
    await runtime.start();
    const generationsRoot = join(stateRoot, "generations");
    const first = JSON.parse(await readFile(join(generationsRoot, "1.json"), "utf8"));
    const second = { ...structuredClone(first), generation: 2 };
    const third = { ...structuredClone(first), generation: 3 };
    await writeFile(join(generationsRoot, "2.json"), `${JSON.stringify(second)}\n`);
    await writeFile(join(generationsRoot, "3.json"), `${JSON.stringify(third)}\n`);
    await writeFile(join(stateRoot, "active.json"), '{"generation":3,"path":"generations/3.json"}\n');
    const olderGenerations = await Promise.all([
      readFile(join(generationsRoot, "1.json"), "utf8"),
      readFile(join(generationsRoot, "2.json"), "utf8"),
    ]);
    const corruptions: Array<{ name: string; apply: (value: typeof third) => void }> = [
      {
        name: "provenance field",
        apply: (value) => Object.assign(value.snapshot.provenance, { generator: "x".repeat(10_000) }),
      },
      { name: "file integer", apply: (value) => Object.assign(value.snapshot.files[0], { sizeBytes: 1.5 }) },
      { name: "symbol line", apply: (value) => Object.assign(value.snapshot.files[0].symbols[0], { line: 0 }) },
      {
        name: "symbol relationships",
        apply: (value) =>
          Object.assign(value.snapshot.files[0].symbols[0], {
            relationships: { extends: [], implements: [] },
          }),
      },
      {
        name: "import names",
        apply: (value) =>
          Object.assign(value.snapshot.files[0], {
            imports: [{ source: "dependency", names: [1], typeOnly: false }],
          }),
      },
      {
        name: "warning code",
        apply: (value) =>
          Object.assign(value.snapshot, {
            warnings: [{ path: "src/value.ts", code: "unknown", message: "bad" }],
          }),
      },
      { name: "dependency", apply: (value) => Object.assign(value.snapshot.files[0], { dependencies: [null] }) },
    ];

    for (const corruption of corruptions) {
      const corrupt = structuredClone(third);
      corruption.apply(corrupt);
      await writeFile(join(generationsRoot, "3.json"), `${JSON.stringify(corrupt)}\n`);

      await expect(runtime.maintenance(), corruption.name).rejects.toThrow(
        "invalid active repository map generation metadata",
      );
      expect(
        await Promise.all([
          readFile(join(generationsRoot, "1.json"), "utf8"),
          readFile(join(generationsRoot, "2.json"), "utf8"),
        ]),
        corruption.name,
      ).toEqual(olderGenerations);
      expect((await readdir(generationsRoot)).filter((path) => path.endsWith(".json")).sort(), corruption.name).toEqual(
        ["1.json", "2.json", "3.json"],
      );
      expect(runtime.status().maintenance).toEqual({ error: "invalid active repository map generation metadata" });
    }
    await runtime.close();
  });

  it("accepts documented optional snapshot metadata", async () => {
    const { root, stateRoot } = await fixture({ "src/value.ts": "export const safeValue = 1;" });
    const runtime = new RepoMapRuntime({ projectRoot: root, stateRoot, watch: false });
    await runtime.start();
    const activePath = join(stateRoot, "generations", "1.json");
    const active = JSON.parse(await readFile(activePath, "utf8"));
    Object.assign(active.snapshot.provenance, { javaParser: "java-parser@3.0.1" });
    Object.assign(active.snapshot.files[0], {
      packageName: "example",
      degradedReason: "documented optional reason",
      imports: [
        { source: "example.Dependency", names: ["Dependency"], typeOnly: false, static: true, wildcard: false },
      ],
    });
    Object.assign(active.snapshot.files[0].symbols[0], {
      container: "Example",
      annotations: ["Deprecated"],
      modifiers: ["public"],
      typeParameters: ["T"],
      relationships: { extends: ["Base"], implements: ["Contract"], permits: ["Child"] },
    });
    await writeFile(activePath, `${JSON.stringify(active)}\n`);

    await expect(loadActiveRepoMapGeneration(stateRoot)).resolves.toMatchObject({ generation: 1 });
    await expect(runtime.maintenance()).resolves.toMatchObject({ activeGeneration: 1, deletedGenerations: [] });
    await runtime.close();
  });

  it("keeps telemetry recording failures out of maintenance and model-visible state", async () => {
    const { root, stateRoot } = await fixture({ "src/value.ts": "export const stableValue = 1;" });
    let failMaintenance = false;
    const telemetry = new (class extends Telemetry {
      override recordRepoMapTotalBytes(bytes: number): void {
        if (failMaintenance) throw new Error("simulated maintenance failure");
        super.recordRepoMapTotalBytes(bytes);
      }
    })();
    const runtime = new RepoMapRuntime({ projectRoot: root, stateRoot, watch: false, telemetry });
    await runtime.start();
    const failuresBefore = telemetry.snapshot().maintenanceFailureCount;
    failMaintenance = true;

    await runtime.rebuild();

    expect(runtime.status()).toMatchObject({
      freshness: "fresh",
      generation: 1,
      maintenance: { activeGeneration: 1, deletedGenerations: [] },
    });
    expect(runtime.status()).not.toHaveProperty("error");
    expect(telemetry.snapshot().maintenanceFailureCount).toBe(failuresBefore);
    expect((await runtime.query("stableValue")).results[0]?.path).toBe("src/value.ts");
    await runtime.close();
  });

  it("defers cleanup of generations newer than active until a later activation supersedes them", async () => {
    const { root, stateRoot } = await fixture({ "src/value.ts": "export const value = 1;" });
    const runtime = new RepoMapRuntime({
      projectRoot: root,
      stateRoot,
      watch: false,
      mapGenerationRetention: 1,
      mapQuotaBytes: 1,
    });
    await runtime.start();
    const active = await loadActiveRepoMapGeneration(stateRoot);
    await writeFile(join(stateRoot, "generations", "2.json"), `${JSON.stringify({ ...active, generation: 2 })}\n`);

    const maintenance = await runtime.maintenance();
    expect(maintenance.deletedGenerations).toEqual([]);
    expect(maintenance.quotaSatisfied).toBe(false);
    expect((await readdir(join(stateRoot, "generations"))).filter((path) => path.endsWith(".json")).sort()).toEqual([
      "1.json",
      "2.json",
    ]);

    await writeFile(join(root, "src/value.ts"), "export const value = 3;");
    await runtime.rebuild();
    expect((await loadActiveRepoMapGeneration(stateRoot)).generation).toBe(3);
    expect((await readdir(join(stateRoot, "generations"))).filter((path) => path.endsWith(".json"))).toEqual([
      "3.json",
    ]);
    await runtime.close();
  });

  it("prunes old generations by retention while preserving the active generation", async () => {
    const { root, stateRoot } = await fixture({ "src/value.ts": "export const value = 0;" });
    const runtime = new RepoMapRuntime({
      projectRoot: root,
      stateRoot,
      watch: false,
      mapGenerationRetention: 2,
      mapQuotaBytes: 10 * 1024 * 1024,
    });
    await runtime.start();
    for (let value = 1; value <= 3; value += 1) {
      await writeFile(join(root, "src/value.ts"), `export const value = ${value};`);
      runtime.notify("change", "src/value.ts");
      await runtime.flush();
    }

    const active = await loadActiveRepoMapGeneration(stateRoot);
    const files = (await readdir(join(stateRoot, "generations"))).filter((path) => path.endsWith(".json")).sort();
    expect(files).toHaveLength(2);
    expect(files).toContain(`${active.generation}.json`);
    expect(runtime.status().maintenance).toMatchObject({
      activeGeneration: active.generation,
      remainingGenerations: 2,
      quotaSatisfied: true,
    });
    await runtime.close();
  });

  it("prunes non-active generations to satisfy the byte quota", async () => {
    const { root, stateRoot } = await fixture({ "src/value.ts": "export const quotaValue = 0;" });
    const writer = new RepoMapRuntime({
      projectRoot: root,
      stateRoot,
      watch: false,
      mapGenerationRetention: 10,
      mapQuotaBytes: 10 * 1024 * 1024,
    });
    await writer.start();
    for (let value = 1; value <= 2; value += 1) {
      await writeFile(join(root, "src/value.ts"), `export const quotaValue = ${value};`);
      writer.notify("change", "src/value.ts");
      await writer.flush();
    }
    const active = await loadActiveRepoMapGeneration(stateRoot);
    const activeBytes = Buffer.byteLength(
      await readFile(join(stateRoot, "generations", `${active.generation}.json`), "utf8"),
    );
    await writer.close();

    const collector = new RepoMapRuntime({
      projectRoot: root,
      stateRoot,
      watch: false,
      mapGenerationRetention: 10,
      mapQuotaBytes: activeBytes,
    });
    await collector.start();

    expect(collector.status().maintenance).toMatchObject({
      activeGeneration: active.generation,
      deletedGenerations: [1, 2],
      remainingGenerations: 1,
      quotaSatisfied: true,
    });
    expect((await readdir(join(stateRoot, "generations"))).filter((path) => path.endsWith(".json"))).toEqual([
      `${active.generation}.json`,
    ]);
    await collector.close();
  });

  it("keeps an over-quota active generation and reports the unsatisfied quota", async () => {
    const { root, stateRoot } = await fixture({ "src/value.ts": "export const activeValue = 1;" });
    const runtime = new RepoMapRuntime({
      projectRoot: root,
      stateRoot,
      watch: false,
      mapGenerationRetention: 1,
      mapQuotaBytes: 1,
    });
    await runtime.start();

    const active = await loadActiveRepoMapGeneration(stateRoot);
    const maintenance = await runtime.maintenance();
    expect(await readFile(join(stateRoot, "generations", `${active.generation}.json`), "utf8")).toContain(
      "activeValue",
    );
    expect(maintenance).toMatchObject({
      activeGeneration: active.generation,
      remainingGenerations: 1,
      quotaSatisfied: false,
    });
    expect(maintenance.remainingBytes).toBeGreaterThan(1);
    await runtime.close();
  });

  it("serializes concurrent runtimes sharing state and reports one activation with its persisted bytes", async () => {
    const { root, stateRoot } = await fixture({ "src/value.ts": "export const sharedValue = 1;" });
    const telemetry = new Telemetry();
    const first = new RepoMapRuntime({ projectRoot: root, stateRoot, watch: false, telemetry });
    const second = new RepoMapRuntime({ projectRoot: root, stateRoot, watch: false, telemetry });

    await Promise.all([first.start(), second.start()]);

    expect((await loadActiveRepoMapGeneration(stateRoot)).generation).toBe(1);
    const generationsRoot = join(stateRoot, "generations");
    expect((await readdir(generationsRoot)).filter((path) => path.endsWith(".json"))).toEqual(["1.json"]);
    const bytes = (await stat(join(generationsRoot, "1.json"))).size;
    expect(telemetry.snapshot()).toMatchObject({
      generationCreatedCount: 1,
      generationBytesWritten: bytes,
      repoMapTotalBytes: bytes,
    });
    await Promise.all([first.close(), second.close()]);
  });

  it("caches search by effective content version and invalidates only for searchable content changes", async () => {
    const { root, stateRoot } = await fixture({ "src/value.ts": "export const cachedValue = true;" });
    const telemetry = new Telemetry();
    const runtime = new RepoMapRuntime({ projectRoot: root, stateRoot, watch: false, telemetry });
    await runtime.start();

    expect((await runtime.query("cachedValue")).results[0]?.path).toBe("src/value.ts");
    await runtime.query("cachedValue");
    expect(telemetry.snapshot().searchIndexBuildCount).toBe(1);

    // Freshness reconciliation, generation bookkeeping, and a same-content
    // watcher event do not change the effective searchable content.
    await runtime.ensureFresh();
    await runtime.rebuild();
    runtime.notify("change", "src/value.ts");
    await runtime.flush();
    await runtime.queryCurrent("cachedValue");
    expect(telemetry.snapshot().searchIndexBuildCount).toBe(1);

    await writeFile(join(root, "src/value.ts"), "export const changedValue = true;");
    runtime.notify("change", "src/value.ts");
    await runtime.flush();
    expect((await runtime.queryCurrent("changedValue")).results[0]?.path).toBe("src/value.ts");
    expect(telemetry.snapshot().searchIndexBuildCount).toBe(2);

    // Parse degradation is still indexed lexical content and gets a new search index.
    await writeFile(join(root, "src/value.ts"), "export const parseDegraded = ;");
    runtime.notify("change", "src/value.ts");
    await runtime.flush();
    expect((await runtime.queryCurrent("parseDegraded")).freshness).toBe("unsupported");
    expect(telemetry.snapshot().searchIndexBuildCount).toBe(3);

    // Each transition from indexed content to an unavailable file outcome
    // invalidates the search index; status-only transitions above do not.
    await writeFile(join(root, "src/value.ts"), Buffer.from([0, 1, 2, 3]));
    runtime.notify("change", "src/value.ts");
    await runtime.flush();
    expect((await runtime.queryCurrent("parseDegraded")).results).toEqual([]);
    expect(telemetry.snapshot().searchIndexBuildCount).toBe(4);

    await writeFile(join(root, "src/value.ts"), "export const beforeNonregular = true;");
    runtime.notify("change", "src/value.ts");
    await runtime.flush();
    await runtime.queryCurrent("beforeNonregular");
    expect(telemetry.snapshot().searchIndexBuildCount).toBe(5);
    await rm(join(root, "src/value.ts"));
    await mkdir(join(root, "src/value.ts"));
    runtime.notify("change", "src/value.ts");
    await runtime.flush();
    await runtime.queryCurrent("beforeNonregular");
    expect(telemetry.snapshot().searchIndexBuildCount).toBe(6);

    await rm(join(root, "src/value.ts"), { recursive: true });
    await writeFile(join(root, "src/value.ts"), "export const beforeDelete = true;");
    runtime.notify("add", "src/value.ts");
    await runtime.flush();
    await runtime.queryCurrent("beforeDelete");
    expect(telemetry.snapshot().searchIndexBuildCount).toBe(7);
    await rm(join(root, "src/value.ts"));
    runtime.notify("unlink", "src/value.ts");
    await runtime.flush();
    await runtime.queryCurrent("beforeDelete");
    expect(telemetry.snapshot().searchIndexBuildCount).toBe(8);
    await runtime.close();
  });

  it("rechecks root .gitignore admission when its watcher event is missed", async () => {
    const { root, stateRoot } = await fixture({ ".gitignore": "", "src/tracked.ts": "export const tracked = true;" });
    const runtime = new RepoMapRuntime({ projectRoot: root, stateRoot, watch: false });
    await runtime.start();
    await writeFile(join(root, "src/missed.ts"), "export const missedRootIgnore = true;");
    runtime.notify("add", "src/missed.ts");
    await runtime.flush();
    expect((await runtime.queryCurrent("missedRootIgnore")).results[0]?.path).toBe("src/missed.ts");

    // Neither the ignored path nor .gitignore is notified. Git status must
    // cause the prior dirty path's cached outcome to be admission-checked.
    await writeFile(join(root, ".gitignore"), "src/missed.ts\n");
    await runtime.ensureFresh();

    expect((await runtime.queryCurrent("missedRootIgnore")).results).toEqual([]);
    expect(runtime.status().dirtyFiles).not.toContain("src/missed.ts");
    await runtime.close();
  });

  it("rechecks non-Git root patterns when the .gitignore watcher event is missed", async () => {
    const { root, stateRoot } = await fixture(
      { ".gitignore": "", "src/non-git.ts": "export const initialNonGitValue = true;" },
      false,
    );
    const runtime = new RepoMapRuntime({ projectRoot: root, stateRoot, watch: false });
    await runtime.start();
    await writeFile(join(root, "src/non-git.ts"), "export const missedNonGitIgnore = true;");
    runtime.notify("change", "src/non-git.ts");
    await runtime.flush();
    expect((await runtime.queryCurrent("missedNonGitIgnore")).results[0]?.path).toBe("src/non-git.ts");
    expect(runtime.status().dirtyFiles).toContain("src/non-git.ts");

    // The unchanged dirty file has a cached indexing outcome. Refreshing must
    // still apply newly supplied root patterns even without either watcher event.
    await writeFile(join(root, ".gitignore"), "src/non-git.ts\n");
    await runtime.ensureFresh();

    expect((await runtime.queryCurrent("missedNonGitIgnore")).results).toEqual([]);
    expect(runtime.status().dirtyFiles).not.toContain("src/non-git.ts");
    await runtime.close();
  });

  it("rechecks .git/info/exclude admission when its watcher event is missed", async () => {
    const { root, stateRoot } = await fixture({ "src/tracked.ts": "export const tracked = true;" });
    const runtime = new RepoMapRuntime({ projectRoot: root, stateRoot, watch: false });
    await runtime.start();
    await writeFile(join(root, "src/local-only.ts"), "export const missedInfoExclude = true;");
    runtime.notify("add", "src/local-only.ts");
    await runtime.flush();
    expect((await runtime.queryCurrent("missedInfoExclude")).results[0]?.path).toBe("src/local-only.ts");

    await writeFile(join(root, ".git/info/exclude"), "\nsrc/local-only.ts\n", { flag: "a" });
    await runtime.ensureFresh();

    expect((await runtime.queryCurrent("missedInfoExclude")).results).toEqual([]);
    expect(runtime.status().dirtyFiles).not.toContain("src/local-only.ts");
    await runtime.close();
  });

  it("drops an omitted current-dirty path that becomes ignored", async () => {
    const { root, stateRoot } = await fixture({ ".gitignore": "", "src/tracked.ts": "export const tracked = true;" });
    const runtime = new RepoMapRuntime({ projectRoot: root, stateRoot, watch: false });
    await runtime.start();
    await writeFile(join(root, "src/untracked.ts"), "export const removedByAdmissionChange = true;");
    runtime.notify("add", "src/untracked.ts");
    await runtime.flush();
    expect((await runtime.queryCurrent("removedByAdmissionChange")).results[0]?.path).toBe("src/untracked.ts");

    await writeFile(join(root, ".gitignore"), "src/untracked.ts\n");
    runtime.notify("change", ".gitignore");
    await runtime.flush();

    expect((await runtime.queryCurrent("removedByAdmissionChange")).results).toEqual([]);
    expect(runtime.status().dirtyFiles).not.toContain("src/untracked.ts");
    expect(
      (await loadActiveRepoMapGeneration(stateRoot)).snapshot.files.some(({ path }) => path === "src/untracked.ts"),
    ).toBe(false);
    await runtime.close();
  });

  it("skips reparsing unchanged dirty paths but detects missed external changes", async () => {
    const { root, stateRoot } = await fixture({ "src/value.ts": "export const initialValue = true;" });
    const telemetry = new Telemetry();
    const runtime = new RepoMapRuntime({ projectRoot: root, stateRoot, watch: false, telemetry });
    await runtime.start();

    await writeFile(join(root, "src/value.ts"), "export const dirtyValue = true;");
    runtime.notify("change", "src/value.ts");
    await runtime.flush();
    const afterFirstIndex = telemetry.snapshot().filesReindexed;
    expect(afterFirstIndex).toBe(1);

    await runtime.query("dirtyValue");
    await runtime.query("dirtyValue");
    expect(telemetry.snapshot().filesReindexed).toBe(afterFirstIndex);

    // No watcher notification: ensureFresh must still notice a changed file fingerprint.
    await writeFile(join(root, "src/value.ts"), "export const externallyChangedValue = 12345;");
    const changed = await runtime.query("externallyChangedValue");
    expect(changed.results[0]?.path).toBe("src/value.ts");
    expect(telemetry.snapshot().filesReindexed).toBe(afterFirstIndex + 1);
    await runtime.close();
  });

  it("conservatively reindexes coarse fingerprints with unchanged size and timestamps", async () => {
    const original = "export const originalToken = 1;";
    const replacement = "export const replacedToken = 1;";
    expect(Buffer.byteLength(replacement)).toBe(Buffer.byteLength(original));
    const { root, stateRoot } = await fixture({ "src/value.ts": original });
    const runtime = new RepoMapRuntime({
      projectRoot: root,
      stateRoot,
      watch: false,
      indexFileSystem: {
        async lstat(path) {
          const info = await lstat(path);
          return {
            isFile: () => info.isFile(),
            size: info.size,
            mtimeMs: 1_700_000_000_000,
            ctimeMs: 1_700_000_000_000,
            ino: 42,
            dev: 7,
          };
        },
        readFile,
      },
    });
    await runtime.start();
    await writeFile(join(root, "src/value.ts"), original.replace(" = 1", " = 2"));
    runtime.notify("change", "src/value.ts");
    await runtime.flush();
    expect((await runtime.query("originalToken")).results[0]?.path).toBe("src/value.ts");

    // No watcher notification and deliberately identical coarse metadata.
    await writeFile(join(root, "src/value.ts"), replacement);
    const result = await runtime.query("replacedToken");
    expect(result.results[0]?.path).toBe("src/value.ts");
    expect((await runtime.queryCurrent("originalToken")).results).toEqual([]);
    await runtime.close();
  });

  it("keeps the cached coherent search on read errors and rebuilds after changed-content recovery", async () => {
    const { root, stateRoot } = await fixture({ "src/value.ts": "export const coherentCachedValue = true;" });
    const telemetry = new Telemetry();
    let failReads = false;
    const runtime = new RepoMapRuntime({
      projectRoot: root,
      stateRoot,
      watch: false,
      telemetry,
      indexFileSystem: {
        lstat,
        async readFile(path) {
          if (failReads && path === join(root, "src/value.ts")) throw new Error("simulated cached read failure");
          return readFile(path);
        },
      },
    });
    await runtime.start();
    await runtime.query("coherentCachedValue");
    expect(telemetry.snapshot().searchIndexBuildCount).toBe(1);

    await writeFile(join(root, "src/value.ts"), "export const recoveredCachedValue = true;");
    failReads = true;
    runtime.notify("change", "src/value.ts");
    await runtime.flush();
    const stale = await runtime.queryCurrent("coherentCachedValue");
    expect(stale.freshness).toBe("stale");
    expect(stale.results[0]?.path).toBe("src/value.ts");
    expect(telemetry.snapshot().searchIndexBuildCount).toBe(1);

    failReads = false;
    await runtime.ensureFresh();
    const recovered = await runtime.queryCurrent("recoveredCachedValue");
    expect(recovered.results[0]?.path).toBe("src/value.ts");
    expect(telemetry.snapshot().searchIndexBuildCount).toBe(2);
    await runtime.close();
  });

  it("telemetry: ensureFresh records failed invocations and durations", async () => {
    const { root, stateRoot } = await fixture({ "src/service.ts": "export const service = true;" });
    const telemetry = new Telemetry();
    const runtime = new RepoMapRuntime({ projectRoot: root, stateRoot, watch: false, telemetry });
    await runtime.start();
    const before = telemetry.snapshot();
    const flushError = new Error("flush failed");
    const flush = runtime.flush.bind(runtime);
    runtime.flush = async () => {
      throw flushError;
    };

    await expect(runtime.ensureFresh()).rejects.toBe(flushError);
    const after = telemetry.snapshot();
    expect(after.ensureFreshCount).toBe(before.ensureFreshCount + 1);
    expect(after.ensureFreshDurationMsTotal).toBeGreaterThanOrEqual(before.ensureFreshDurationMsTotal);

    runtime.flush = flush;
    await runtime.close();
  });

  it("telemetry: query, ensureFresh, search index, and generation counters", async () => {
    const { root, stateRoot } = await fixture({
      "src/service.ts": "export function createUser(name: string): string { return name; }",
    });
    const telemetry = new Telemetry();
    const runtime = new RepoMapRuntime({ projectRoot: root, stateRoot, watch: false, telemetry });
    await runtime.start();

    // start() rebuilds and activates one generation.
    let snapshot = telemetry.snapshot();
    expect(snapshot.generationCreatedCount).toBe(1);
    expect(snapshot.generationBytesWritten).toBeGreaterThan(0);
    expect(snapshot.repoMapTotalBytes).toBeGreaterThan(0);

    // Query records count/duration and one MiniSearch build.
    const result = await runtime.query("createUser");
    expect(result.results[0]?.path).toBe("src/service.ts");
    snapshot = telemetry.snapshot();
    expect(snapshot.repoMapQueryCount).toBe(1);
    expect(snapshot.repoMapQueryDurationMsTotal).toBeGreaterThanOrEqual(0);
    expect(snapshot.ensureFreshCount).toBeGreaterThanOrEqual(1);
    expect(snapshot.searchIndexBuildCount).toBe(1);

    // A file change re-indexes the file and produces another generation on flush.
    await writeFile(join(root, "src/service.ts"), "export function createUser(id: number): number { return id; }");
    runtime.notify("change", "src/service.ts");
    await runtime.flush();
    snapshot = telemetry.snapshot();
    expect(snapshot.filesReindexed).toBeGreaterThanOrEqual(1);
    snapshot = telemetry.snapshot();
    expect(snapshot.generationCreatedCount).toBeGreaterThanOrEqual(2);
    expect(snapshot.repoMapTotalBytes).toBeGreaterThan(0);
    expect(snapshot.repoMapTotalBytes).toBeGreaterThanOrEqual(snapshot.generationBytesWritten);
    expect(Number.isFinite(snapshot.ensureFreshDurationMsTotal)).toBe(true);
    await runtime.close();
  });

  it("telemetry: hot-path attempts use deterministic count and duration totals", async () => {
    const { root, stateRoot } = await fixture({ "src/service.ts": "export const timedService = true;" });
    const telemetry = new Telemetry();
    const runtime = new RepoMapRuntime({
      projectRoot: root,
      stateRoot,
      watch: false,
      telemetry,
      monotonicNow: tickingClock(),
    });

    await runtime.start();
    await runtime.query("timedService");

    const snapshot = telemetry.snapshot();
    expect(snapshot.gitHeadCount).toBeGreaterThan(0);
    expect(snapshot.gitHeadDurationMsTotal).toBe(snapshot.gitHeadCount);
    expect(snapshot.gitDirtyCount).toBeGreaterThan(0);
    expect(snapshot.gitDirtyDurationMsTotal).toBe(snapshot.gitDirtyCount);
    expect(snapshot.searchIndexBuildCount).toBe(1);
    expect(snapshot.searchIndexBuildDurationMsTotal).toBe(1);
    expect(snapshot.generationWriteCount).toBe(1);
    expect(snapshot.generationWriteDurationMsTotal).toBe(1);
    expect(snapshot.generationPruneCount).toBeGreaterThan(0);
    expect(snapshot.generationPruneDurationMsTotal).toBe(snapshot.generationPruneCount);
    await runtime.close();
  });

  it("telemetry: successful Git diff fallback records one deterministic attempt", async () => {
    const { root, stateRoot } = await fixture({ "src/diff.ts": "export const beforeDiff = true;" });
    const telemetry = new Telemetry();
    let failActivation = false;
    const runtime = new RepoMapRuntime({
      projectRoot: root,
      stateRoot,
      watch: false,
      telemetry,
      monotonicNow: tickingClock(),
      atomicWriter: async (path, content) => {
        if (failActivation && path.endsWith("active.json")) throw new Error("simulated activation failure");
        await atomicWriteFile(path, content);
      },
    });
    await runtime.start();
    failActivation = true;
    await writeFile(join(root, "src/diff.ts"), "export const afterDiff = true;");
    runtime.notify("change", "src/diff.ts");
    await runtime.flush();

    const result = await runtime.query("afterDiff");
    expect(result.fallbackEvidence.some((evidence) => evidence.kind === "git-diff")).toBe(true);
    expect(telemetry.snapshot()).toMatchObject({ gitDiffCount: 1, gitDiffDurationMsTotal: 1 });
    failActivation = false;
    await runtime.close();
  });

  it("telemetry: failed Git, search, generation-write, and prune attempts count once", async () => {
    const gitFailure = await fixture({ "src/service.ts": "export const failedGitService = true;" }, false);
    const gitTelemetry = new Telemetry();
    const gitRuntime = new RepoMapRuntime({
      projectRoot: gitFailure.root,
      stateRoot: gitFailure.stateRoot,
      watch: false,
      telemetry: gitTelemetry,
      monotonicNow: tickingClock(),
      async gitRunner() {
        throw new Error("simulated git failure");
      },
      indexFileSystem: {
        lstat,
        async readFile(path) {
          if (path === join(gitFailure.root, "src/service.ts")) throw new Error("simulated source failure");
          return readFile(path);
        },
      },
    });
    await gitRuntime.start();
    await writeFile(join(gitFailure.root, "src/service.ts"), "export const failedGitService = false;");
    gitRuntime.notify("change", "src/service.ts");
    await gitRuntime.flush();
    await gitRuntime.query("failedGitService");
    const failedGit = gitTelemetry.snapshot();
    expect(failedGit.gitHeadCount).toBeGreaterThan(0);
    expect(failedGit.gitHeadDurationMsTotal).toBe(failedGit.gitHeadCount);
    expect(failedGit.gitDirtyCount).toBeGreaterThan(0);
    expect(failedGit.gitDirtyDurationMsTotal).toBe(failedGit.gitDirtyCount);
    expect(failedGit.gitDiffCount).toBe(1);
    expect(failedGit.gitDiffDurationMsTotal).toBe(1);
    await gitRuntime.close();

    const searchFailure = await fixture({ "src/search.ts": "export const failedSearch = true;" });
    const searchTelemetry = new Telemetry();
    const searchRuntime = new RepoMapRuntime({
      projectRoot: searchFailure.root,
      stateRoot: searchFailure.stateRoot,
      watch: false,
      telemetry: searchTelemetry,
      monotonicNow: tickingClock(),
      searchFactory() {
        throw new Error("simulated search construction failure");
      },
    });
    await searchRuntime.start();
    await expect(searchRuntime.queryCurrent("failedSearch")).rejects.toThrow("simulated search construction failure");
    expect(searchTelemetry.snapshot()).toMatchObject({
      searchIndexBuildCount: 1,
      searchIndexBuildDurationMsTotal: 1,
    });
    await searchRuntime.close();

    const writeFailure = await fixture({ "src/write.ts": "export const beforeWriteFailure = true;" });
    const writeTelemetry = new Telemetry();
    let failGenerationWrite = false;
    const writeRuntime = new RepoMapRuntime({
      projectRoot: writeFailure.root,
      stateRoot: writeFailure.stateRoot,
      watch: false,
      telemetry: writeTelemetry,
      monotonicNow: tickingClock(),
      atomicWriter: async (path, content) => {
        if (failGenerationWrite && path.endsWith("active.json")) throw new Error("simulated pointer failure");
        await atomicWriteFile(path, content);
      },
    });
    await writeRuntime.start();
    const beforeWrite = writeTelemetry.snapshot();
    failGenerationWrite = true;
    await writeFile(join(writeFailure.root, "src/write.ts"), "export const afterWriteFailure = true;");
    writeRuntime.notify("change", "src/write.ts");
    await writeRuntime.flush();
    const afterWrite = writeTelemetry.snapshot();
    expect(afterWrite.generationWriteCount).toBe(beforeWrite.generationWriteCount + 1);
    expect(afterWrite.generationWriteDurationMsTotal).toBe(beforeWrite.generationWriteDurationMsTotal + 1);
    expect(afterWrite.generationCreatedCount).toBe(beforeWrite.generationCreatedCount);
    failGenerationWrite = false;
    await writeRuntime.close();

    const pruneFailure = await fixture({ "src/prune.ts": "export const pruneFailure = true;" });
    const pruneTelemetry = new Telemetry();
    const pruneRuntime = new RepoMapRuntime({
      projectRoot: pruneFailure.root,
      stateRoot: pruneFailure.stateRoot,
      watch: false,
      telemetry: pruneTelemetry,
      monotonicNow: tickingClock(),
    });
    await pruneRuntime.start();
    await symlink("missing-generation.json", join(pruneFailure.stateRoot, "generations", "2.json"));
    const beforePrune = pruneTelemetry.snapshot();
    await expect(pruneRuntime.maintenance()).rejects.toThrow();
    const afterPrune = pruneTelemetry.snapshot();
    expect(afterPrune.generationPruneCount).toBe(beforePrune.generationPruneCount + 1);
    expect(afterPrune.generationPruneDurationMsTotal).toBe(beforePrune.generationPruneDurationMsTotal + 1);
    expect(afterPrune.generationPrunedFiles).toBe(beforePrune.generationPrunedFiles);
    expect(afterPrune.generationPrunedBytes).toBe(beforePrune.generationPrunedBytes);
    await rm(join(pruneFailure.stateRoot, "generations", "2.json"));
    await pruneRuntime.close();
  });

  it("telemetry: startup seeds existing bytes and pruning decrements the reconciled total", async () => {
    const { root, stateRoot } = await fixture({ "src/value.ts": "export const seededValue = 0;" });
    const producer = new RepoMapRuntime({
      projectRoot: root,
      stateRoot,
      watch: false,
      mapGenerationRetention: 10,
    });
    await producer.start();
    for (let value = 1; value <= 2; value += 1) {
      await writeFile(join(root, "src/value.ts"), `export const seededValue = ${value};`);
      producer.notify("change", "src/value.ts");
      await producer.flush();
    }
    await producer.close();

    const generationsRoot = join(stateRoot, "generations");
    const existingNames = (await readdir(generationsRoot)).filter((name) => /^\d+\.json$/u.test(name));
    const existingBytes = (
      await Promise.all(existingNames.map(async (name) => (await stat(join(generationsRoot, name))).size))
    ).reduce((total, bytes) => total + bytes, 0);
    expect(existingNames.length).toBe(3);

    const telemetry = new Telemetry();
    const runtime = new RepoMapRuntime({
      projectRoot: root,
      stateRoot,
      watch: false,
      mapGenerationRetention: 1,
      telemetry,
      monotonicNow: tickingClock(),
    });
    await runtime.start();

    const remainingNames = (await readdir(generationsRoot)).filter((name) => /^\d+\.json$/u.test(name));
    const remainingBytes = (
      await Promise.all(remainingNames.map(async (name) => (await stat(join(generationsRoot, name))).size))
    ).reduce((total, bytes) => total + bytes, 0);
    const snapshot = telemetry.snapshot();
    expect(snapshot.generationCreatedCount).toBe(0);
    expect(snapshot.generationPrunedFiles).toBe(existingNames.length - remainingNames.length);
    expect(snapshot.generationPrunedBytes).toBe(existingBytes - remainingBytes);
    expect(snapshot.repoMapTotalBytes).toBe(remainingBytes);
    await runtime.close();
  });

  it("telemetry: throwing monotonic clocks are non-fatal across Git, query, search, generation, and maintenance", async () => {
    const { root, stateRoot } = await fixture({ "src/clock.ts": "export const clockSafe = true;" });
    const telemetry = new Telemetry();
    const runtime = new RepoMapRuntime({
      projectRoot: root,
      stateRoot,
      watch: false,
      telemetry,
      monotonicNow() {
        throw new Error("simulated clock failure");
      },
    });

    await runtime.start();
    expect((await runtime.query("clockSafe")).results[0]?.path).toBe("src/clock.ts");
    await runtime.maintenance();

    const snapshot = telemetry.snapshot();
    expect(snapshot).toMatchObject({
      repoMapQueryCount: 1,
      repoMapQueryDurationMsTotal: 0,
      ensureFreshCount: 1,
      ensureFreshDurationMsTotal: 0,
      searchIndexBuildCount: 1,
      searchIndexBuildDurationMsTotal: 0,
      generationWriteCount: 1,
      generationWriteDurationMsTotal: 0,
      generationCreatedCount: 1,
      generationPruneDurationMsTotal: 0,
    });
    expect(snapshot.gitHeadCount).toBeGreaterThan(0);
    expect(snapshot.gitHeadDurationMsTotal).toBe(0);
    expect(snapshot.gitDirtyCount).toBeGreaterThan(0);
    expect(snapshot.gitDirtyDurationMsTotal).toBe(0);
    expect(snapshot.generationPruneCount).toBeGreaterThan(1);
    await runtime.close();
  });

  it("telemetry: a throwing monotonic clock is non-fatal for Git diff fallback", async () => {
    const { root, stateRoot } = await fixture({ "src/diff.ts": "export const beforeClockDiff = true;" });
    const telemetry = new Telemetry();
    let failActivation = false;
    const runtime = new RepoMapRuntime({
      projectRoot: root,
      stateRoot,
      watch: false,
      telemetry,
      monotonicNow() {
        throw new Error("simulated clock failure");
      },
      atomicWriter: async (path, content) => {
        if (failActivation && path.endsWith("active.json")) throw new Error("simulated activation failure");
        await atomicWriteFile(path, content);
      },
    });
    await runtime.start();
    failActivation = true;
    await writeFile(join(root, "src/diff.ts"), "export const afterClockDiff = true;");
    runtime.notify("change", "src/diff.ts");
    await runtime.flush();

    const result = await runtime.query("afterClockDiff");
    expect(result.freshness).toBe("stale");
    expect(result.fallbackEvidence.some((evidence) => evidence.kind === "git-diff")).toBe(true);
    expect(telemetry.snapshot()).toMatchObject({ gitDiffCount: 1, gitDiffDurationMsTotal: 0 });
    await runtime.close();
  });

  it("telemetry: disabled and throwing recorders leave model-visible query output identical", async () => {
    const without = await fixture({ "src/model.ts": "export const modelVisibleValue = true;" }, false);
    const withThrowing = await fixture({ "src/model.ts": "export const modelVisibleValue = true;" }, false);
    const alwaysNoGit = async () => {
      throw new Error("not a git workspace");
    };
    const throwingTelemetry = new Proxy(new Telemetry(), {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (property !== "snapshot" && typeof value === "function") {
          return () => {
            throw new Error("simulated telemetry failure");
          };
        }
        return value;
      },
    });
    const plainRuntime = new RepoMapRuntime({
      projectRoot: without.root,
      stateRoot: without.stateRoot,
      watch: false,
      gitRunner: alwaysNoGit,
    });
    const telemetryRuntime = new RepoMapRuntime({
      projectRoot: withThrowing.root,
      stateRoot: withThrowing.stateRoot,
      watch: false,
      gitRunner: alwaysNoGit,
      telemetry: throwingTelemetry,
    });
    await plainRuntime.start();
    await telemetryRuntime.start();

    expect(await telemetryRuntime.query("modelVisibleValue")).toEqual(await plainRuntime.query("modelVisibleValue"));
    await plainRuntime.close();
    await telemetryRuntime.close();
  });
});
