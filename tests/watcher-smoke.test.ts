import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RepoMapRuntime } from "../src/repo-map/runtime.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function eventually<T>(
  operation: () => Promise<T>,
  accept: (value: T) => boolean,
  timeoutMs = 8_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await operation();
    if (accept(last)) return last;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`watcher condition was not observed within ${timeoutMs}ms: ${JSON.stringify(last)}`);
}

describe("real chokidar watcher smoke", () => {
  it("observes an external edit with bounded polling on every supported CI operating system", async () => {
    const project = await mkdtemp(join(tmpdir(), "context-vault-watcher-project-"));
    const stateRoot = await mkdtemp(join(tmpdir(), "context-vault-watcher-state-"));
    roots.push(project, stateRoot);
    await mkdir(join(project, "src"));
    await writeFile(join(project, "src", "value.ts"), "export const initialWatcherValue = true;");
    const runtime = new RepoMapRuntime({ projectRoot: project, stateRoot, mapDebounceMs: 25 });
    try {
      await runtime.start();
      const path = join(project, "src", "value.ts");
      const symbol = "externalWatcherValue";
      await writeFile(path, `export const ${symbol} = true;`);
      const result = await eventually(
        () => runtime.query(symbol),
        (query) => query.results.some((entry) => entry.symbols.some((item) => item.name === symbol)),
      );

      expect(result.freshness).toMatch(/^(dirty|fresh)$/);
      expect(result.pendingFiles).toEqual([]);
    } finally {
      await runtime.close();
    }
  }, 10_000);

  it("never watches git internals and survives lock-file churn (Windows EPERM regression)", async () => {
    const project = await mkdtemp(join(tmpdir(), "context-vault-gitdir-watcher-project-"));
    const stateRoot = await mkdtemp(join(tmpdir(), "context-vault-gitdir-watcher-state-"));
    roots.push(project, stateRoot);
    // A `.git` directory that is not a real repository: git lock files are
    // created and deleted here by git operations (e.g. `.git/t88JaC0` during
    // `git status`). chokidar must never descend into it.
    await mkdir(join(project, ".git"));
    await mkdir(join(project, "src"));
    const path = join(project, "src", "main.ts");
    await writeFile(path, "export const initialGitWatcherValue = true;");
    const runtime = new RepoMapRuntime({ projectRoot: project, stateRoot, mapDebounceMs: 25 });
    try {
      await runtime.start();
      const lockPath = join(project, ".git", "t88JaC0");
      await writeFile(lockPath, Buffer.from([0, 1, 2, 3, 255]));
      const churn = setInterval(() => {
        void writeFile(lockPath, Buffer.from([0, 1, 2, 3, 255])).catch(() => undefined);
      }, 10);
      try {
        const symbol = "gitWatcherValue";
        await writeFile(path, `export const ${symbol} = true;`);
        const result = await eventually(
          () => runtime.query(symbol),
          (query) => query.results.some((entry) => entry.symbols.some((item) => item.name === symbol)),
        );
        expect(result.freshness).toMatch(/^(dirty|fresh)$/);
        expect(result.pendingFiles).toEqual([]);
        expect(result.results.some((entry) => entry.path.includes(".git"))).toBe(false);
      } finally {
        clearInterval(churn);
      }
      await rm(lockPath, { force: true });
      const after = await runtime.query("gitWatcherValue");
      expect(after.freshness).toMatch(/^(dirty|fresh)$/);
      expect(after.pendingFiles).toEqual([]);
    } finally {
      await runtime.close();
    }
  }, 10_000);

  it("observes an external Java signature edit on every supported CI operating system", async () => {
    const project = await mkdtemp(join(tmpdir(), "context-vault-java-watcher-project-"));
    const stateRoot = await mkdtemp(join(tmpdir(), "context-vault-java-watcher-state-"));
    roots.push(project, stateRoot);
    await mkdir(join(project, "src"));
    const path = join(project, "src", "GreetingService.java");
    await writeFile(path, "public class GreetingService { public String greet(String name) { return name; } }");
    const runtime = new RepoMapRuntime({ projectRoot: project, stateRoot, mapDebounceMs: 25 });
    try {
      await runtime.start();
      await writeFile(path, "public class GreetingService { public Message greet(User user) { return null; } }");
      const result = await eventually(
        () => runtime.query("greet"),
        (query) =>
          query.results.some((entry) =>
            entry.symbols.some((item) => item.signature === "public Message greet(User user)"),
          ),
      );
      expect(result.freshness).toMatch(/^(dirty|fresh)$/);
      expect(result.pendingFiles).toEqual([]);
    } finally {
      await runtime.close();
    }
  }, 10_000);
});
