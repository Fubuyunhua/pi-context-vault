import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    let failActive = false;
    const runtime = new RepoMapRuntime({
      projectRoot: root,
      stateRoot,
      watch: false,
      atomicWriter: async (path, content) => {
        if (failActive && path.endsWith("active.json")) throw new Error("simulated activation crash");
        await atomicWriteFile(path, content);
      },
    });
    await runtime.start();
    const before = await readFile(join(stateRoot, "active.json"), "utf8");
    failActive = true;
    await writeFile(join(root, "src/value.ts"), "export const changedValue = 2;");
    runtime.notify("change", "src/value.ts");
    await runtime.flush();

    expect(runtime.status()).toMatchObject({ freshness: "stale", error: "simulated activation crash" });
    expect(await readFile(join(stateRoot, "active.json"), "utf8")).toBe(before);
    expect((await loadActiveRepoMapGeneration(stateRoot)).snapshot.files[0]?.symbols[0]?.name).toBe("stableValue");
    const degraded = await runtime.query("changedValue");
    expect(degraded.freshness).toBe("stale");
    expect(degraded.fallbackEvidence.some((evidence) => evidence.kind === "source")).toBe(true);
    await runtime.close();
  });
});
