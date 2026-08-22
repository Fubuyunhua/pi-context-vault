import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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

  it("keeps the previously activated generation intact when activation crashes", async () => {
    const { root, stateRoot } = await fixture({ "src/value.ts": "export const stableValue = 1;" });
    const telemetry = new Telemetry();
    let failActive = false;
    const runtime = new RepoMapRuntime({
      projectRoot: root,
      stateRoot,
      watch: false,
      atomicWriter: async (path, content) => {
        if (failActive && path.endsWith("active.json")) throw new Error("simulated activation crash");
        await atomicWriteFile(path, content);
      },
      telemetry,
    });
    await runtime.start();
    const before = await readFile(join(stateRoot, "active.json"), "utf8");
    const telemetryBefore = telemetry.snapshot();
    failActive = true;
    await writeFile(join(root, "src/value.ts"), "export const changedValue = 2;");
    runtime.notify("change", "src/value.ts");
    await runtime.flush();

    expect(runtime.status()).toMatchObject({ freshness: "stale", error: "simulated activation crash" });
    expect(await readFile(join(stateRoot, "active.json"), "utf8")).toBe(before);
    expect((await loadActiveRepoMapGeneration(stateRoot)).snapshot.files[0]?.symbols[0]?.name).toBe("stableValue");
    expect(telemetry.snapshot()).toMatchObject({
      generationCreatedCount: telemetryBefore.generationCreatedCount,
      generationBytesWritten: telemetryBefore.generationBytesWritten,
      repoMapTotalBytes: telemetryBefore.repoMapTotalBytes,
    });
    const degraded = await runtime.query("changedValue");
    expect(degraded.freshness).toBe("stale");
    expect(degraded.fallbackEvidence.some((evidence) => evidence.kind === "source")).toBe(true);

    failActive = false;
    const maintenance = await runtime.maintenance();
    expect(maintenance.deletedGenerations).toEqual([]);
    expect((await readdir(join(stateRoot, "generations"))).filter((path) => path.endsWith(".json")).sort()).toEqual([
      "1.json",
      "2.json",
      "3.json",
    ]);
    expect((await loadActiveRepoMapGeneration(stateRoot)).generation).toBe(1);
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

  it("reports no-op maintenance failures without degrading the active map", async () => {
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
      maintenance: { error: "simulated maintenance failure" },
    });
    expect(runtime.status()).not.toHaveProperty("error");
    expect(telemetry.snapshot().maintenanceFailureCount).toBe(failuresBefore + 1);
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

  it("serializes concurrent runtimes sharing a state root and suppresses the equivalent activation", async () => {
    const { root, stateRoot } = await fixture({ "src/value.ts": "export const sharedValue = 1;" });
    const first = new RepoMapRuntime({ projectRoot: root, stateRoot, watch: false });
    const second = new RepoMapRuntime({ projectRoot: root, stateRoot, watch: false });

    await Promise.all([first.start(), second.start()]);

    expect((await loadActiveRepoMapGeneration(stateRoot)).generation).toBe(1);
    expect((await readdir(join(stateRoot, "generations"))).filter((path) => path.endsWith(".json"))).toEqual([
      "1.json",
    ]);
    await Promise.all([first.close(), second.close()]);
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
});
