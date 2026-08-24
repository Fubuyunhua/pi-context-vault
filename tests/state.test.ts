import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
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

async function waitForFile(path: string, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await stat(path);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for file: ${path}`);
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

  it("maps aliases of the same canonical project to the same state directory", async () => {
    const root = await tempRoot();
    const project = join(root, "project");
    const alias = join(root, "project-alias");
    const piRoot = join(root, "pi");
    await mkdir(project);
    await symlink(project, alias, "junction");

    const directState = await resolveProjectState(project, { PI_CODING_AGENT_DIR: piRoot });
    const aliasState = await resolveProjectState(alias, { PI_CODING_AGENT_DIR: piRoot });

    expect(aliasState.projectRoot).toBe(directState.projectRoot);
    expect(aliasState.projectId).toBe(directState.projectId);
    expect(aliasState.stateRoot).toBe(directState.stateRoot);
  });

  it("loads defaults and validates a project override", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".pi"));
    await writeFile(
      join(root, ".pi", "context-vault.json"),
      JSON.stringify({ archiveThresholdBytes: 2048, hotObservationCount: 2, mapExcludePatterns: ["generated/**"] }),
    );

    const config = await loadConfig(root);
    expect(config.archiveThresholdBytes).toBe(2048);
    expect(config.replacementThresholdBytes).toBe(2048);
    expect(config.archivePolicy).toBe("all");
    expect(config.archiveMinBytes).toBe(16 * 1024);
    expect(config.archiveErrorsAlways).toBe(true);
    expect(config.hotObservationCount).toBe(2);
    expect(config.mapExcludePatterns).toEqual(["generated/**"]);
    expect(config.mapGenerationRetention).toBe(3);
    expect(config.mapQuotaBytes).toBe(128 * 1024 * 1024);
    expect(config.receiptMaxBytes).toBeGreaterThan(0);
  });

  it("migrates the legacy threshold and rejects an ambiguous legacy/new threshold conflict", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".pi"));
    const path = join(root, ".pi", "context-vault.json");

    await writeFile(path, JSON.stringify({ archiveThresholdBytes: 2048 }));
    await expect(loadConfig(root)).resolves.toMatchObject({
      archiveThresholdBytes: 2048,
      replacementThresholdBytes: 2048,
    });

    await writeFile(path, JSON.stringify({ replacementThresholdBytes: 4096 }));
    await expect(loadConfig(root)).resolves.toMatchObject({
      archiveThresholdBytes: 4096,
      replacementThresholdBytes: 4096,
    });

    await writeFile(path, JSON.stringify({ archiveThresholdBytes: 2048, replacementThresholdBytes: 4096 }));
    await expect(loadConfig(root)).rejects.toThrow("cannot both be configured");
  });

  it("accepts the archive policy matrix and validates its options", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".pi"));
    const path = join(root, ".pi", "context-vault.json");

    for (const archivePolicy of ["all", "errors-and-large", "off"]) {
      await writeFile(
        path,
        JSON.stringify({ archivePolicy, archiveMinBytes: 0, replacementThresholdBytes: 1, archiveErrorsAlways: false }),
      );
      await expect(loadConfig(root)).resolves.toMatchObject({
        archivePolicy,
        archiveMinBytes: 0,
        replacementThresholdBytes: 1,
        archiveErrorsAlways: false,
      });
    }
    await writeFile(path, JSON.stringify({ archivePolicy: "sometimes" }));
    await expect(loadConfig(root)).rejects.toThrow("archivePolicy must be one of");
    await writeFile(path, JSON.stringify({ archiveMinBytes: -1 }));
    await expect(loadConfig(root)).rejects.toThrow("archiveMinBytes must be a non-negative safe integer");
  });

  it("rejects invalid configuration values", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".pi"));
    await writeFile(join(root, ".pi", "context-vault.json"), JSON.stringify({ archiveThresholdBytes: -1 }));
    await expect(loadConfig(root)).rejects.toThrow("archiveThresholdBytes");

    await writeFile(join(root, ".pi", "context-vault.json"), JSON.stringify({ receiptMaxBytes: 511 }));
    await expect(loadConfig(root)).rejects.toThrow("at least 512");

    await writeFile(join(root, ".pi", "context-vault.json"), JSON.stringify({ mapContextMaxBytes: 511 }));
    await expect(loadConfig(root)).rejects.toThrow("mapContextMaxBytes must be at least 512");

    await writeFile(join(root, ".pi", "context-vault.json"), JSON.stringify({ debugRequestFingerprints: "yes" }));
    await expect(loadConfig(root)).rejects.toThrow("debugRequestFingerprints must be a boolean");

    for (const [key, value] of [
      ["mapGenerationRetention", 0],
      ["mapGenerationRetention", 1.5],
      ["mapQuotaBytes", 0],
      ["mapQuotaBytes", Number.MAX_SAFE_INTEGER + 1],
    ] as const) {
      await writeFile(join(root, ".pi", "context-vault.json"), JSON.stringify({ [key]: value }));
      await expect(loadConfig(root)).rejects.toThrow(`${key} must be a positive safe integer`);
    }
  });

  it("rejects unknown, non-numeric, and inconsistent configuration", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".pi"));
    const path = join(root, ".pi", "context-vault.json");

    await writeFile(path, JSON.stringify({ unknownOption: 1 }));
    await expect(loadConfig(root)).rejects.toThrow("Unknown");
    await writeFile(path, JSON.stringify({ archiveThresholdBytes: "many" }));
    await expect(loadConfig(root)).rejects.toThrow("finite number");
    await writeFile(path, JSON.stringify({ softContextRatio: 2 }));
    await expect(loadConfig(root)).rejects.toThrow("between 0 and 1");
    await writeFile(path, JSON.stringify({ softContextRatio: 0.5, targetContextRatio: 0.6 }));
    await expect(loadConfig(root)).rejects.toThrow("lower than");
  });

  it("accepts and validates mapInjectionMode", async () => {
    const root = await tempRoot();
    const defaults = await loadConfig(root);
    expect(defaults.mapInjectionMode).toBe("once-per-user-turn");

    await mkdir(join(root, ".pi"));
    const path = join(root, ".pi", "context-vault.json");
    for (const mode of ["off", "once-per-user-turn", "every-llm-call"]) {
      await writeFile(path, JSON.stringify({ mapInjectionMode: mode }));
      await expect(loadConfig(root)).resolves.toMatchObject({ mapInjectionMode: mode });
    }
    await writeFile(path, JSON.stringify({ mapInjectionMode: "sometimes" }));
    await expect(loadConfig(root)).rejects.toThrow("mapInjectionMode must be one of");
  });

  it("rejects invalid repository map exclusions", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".pi"));
    await writeFile(join(root, ".pi", "context-vault.json"), JSON.stringify({ mapExcludePatterns: [""] }));

    await expect(loadConfig(root)).rejects.toThrow("mapExcludePatterns");
  });

  it("rejects a non-object configuration", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".pi"));
    await writeFile(join(root, ".pi", "context-vault.json"), "null");

    await expect(loadConfig(root)).rejects.toThrow("configuration must be a JSON object");
  });
});

describe("atomic state operations", () => {
  it("atomically replaces a file", async () => {
    const root = await tempRoot();
    const target = join(root, "state.json");
    await atomicWriteFile(target, "first");
    await atomicWriteFile(target, "second");
    expect(await readFile(target, "utf8")).toBe("second");
    expect(await readdir(root)).toEqual(["state.json"]);
  });

  it("serializes lock holders", async () => {
    const root = await tempRoot();
    const lockPath = join(root, "writer.lock");
    const order: string[] = [];

    const firstHolder = withFileLock(lockPath, async () => {
      order.push("a:start");
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push("a:end");
    });
    await waitForFile(lockPath);
    const secondHolder = withFileLock(lockPath, async () => {
      order.push("b");
    });
    await Promise.all([firstHolder, secondHolder]);
    expect(order).toEqual(["a:start", "a:end", "b"]);
  });

  it("times out without stealing an active lock", async () => {
    const root = await tempRoot();
    const lockPath = join(root, "writer.lock");
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = withFileLock(lockPath, async () => held, { staleMs: 1000 });
    await waitForFile(lockPath);

    await expect(
      withFileLock(lockPath, async () => undefined, { retryMs: 5, staleMs: 1000, timeoutMs: 20 }),
    ).rejects.toThrow("Timed out waiting for state lock");

    release?.();
    await holder;
  });

  it("releases a lock when its operation fails", async () => {
    const root = await tempRoot();
    const lockPath = join(root, "writer.lock");

    await expect(
      withFileLock(lockPath, async () => {
        throw new Error("operation failed");
      }),
    ).rejects.toThrow("operation failed");
    await expect(withFileLock(lockPath, async () => "next holder")).resolves.toBe("next holder");
  });
});
