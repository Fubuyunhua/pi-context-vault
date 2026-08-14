import { mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { atomicWriteFile, withFileLock } from "../src/state/atomic.js";
import { loadConfig } from "../src/state/config.js";
import { resolveProjectState } from "../src/state/project-state.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "context-vault-state-"));
  roots.push(root);
  return root;
}

describe("project state", () => {
  it("isolates canonical projects under PI_CODING_AGENT_DIR", async () => {
    const root = await tempRoot();
    const project = join(root, "project");
    await mkdir(project);
    const alias = join(project, "..");
    const state = await resolveProjectState(project, { PI_CODING_AGENT_DIR: join(root, "pi") });

    expect(state.projectRoot).toBe(await realpath(project));
    expect(state.stateRoot).toContain(join(root, "pi", "context-vault", "projects"));
    expect(state.projectId).toMatch(/^[a-f0-9]{32}$/);

    const other = await resolveProjectState(alias, { PI_CODING_AGENT_DIR: join(root, "pi") });
    expect(other.projectId).not.toBe(state.projectId);
  });

  it("loads defaults and validates a project override", async () => {
    const root = await tempRoot();
    await writeFile(
      join(root, ".pi-context-vault.json"),
      JSON.stringify({ archiveThresholdBytes: 2048, hotObservationCount: 2 }),
    );

    const config = await loadConfig(root);
    expect(config.archiveThresholdBytes).toBe(2048);
    expect(config.hotObservationCount).toBe(2);
    expect(config.receiptMaxBytes).toBeGreaterThan(0);
  });

  it("rejects invalid configuration values", async () => {
    const root = await tempRoot();
    await writeFile(join(root, ".pi-context-vault.json"), JSON.stringify({ archiveThresholdBytes: -1 }));
    await expect(loadConfig(root)).rejects.toThrow("archiveThresholdBytes");
  });
});

describe("atomic state operations", () => {
  it("atomically replaces a file", async () => {
    const root = await tempRoot();
    const target = join(root, "state.json");
    await atomicWriteFile(target, "first");
    await atomicWriteFile(target, "second");
    expect(await readFile(target, "utf8")).toBe("second");
  });

  it("serializes lock holders and recovers stale locks", async () => {
    const root = await tempRoot();
    const lockPath = join(root, "writer.lock");
    const order: string[] = [];

    await Promise.all([
      withFileLock(lockPath, async () => {
        order.push("a:start");
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push("a:end");
      }),
      withFileLock(lockPath, async () => {
        order.push("b");
      }),
    ]);
    expect(order).toEqual(["a:start", "a:end", "b"]);

    await writeFile(lockPath, "stale");
    const old = new Date(Date.now() - 120_000);
    await utimes(lockPath, old, old);
    await expect(withFileLock(lockPath, async () => "recovered", { staleMs: 1000 })).resolves.toBe("recovered");
  });
});
