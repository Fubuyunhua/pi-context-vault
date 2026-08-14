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
});
