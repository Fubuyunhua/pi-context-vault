import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { atomicWriteFile, withFileLock } from "../src/state/atomic.js";
import {
  DEFAULT_CONFIG,
  LEGACY_REPO_CONFIG_KEYS,
  LEGACY_REPO_CONFIG_WARNING,
  loadConfig,
  loadConfigWithDiagnostics,
} from "../src/state/config.js";
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

async function createDirectorySymlink(target: string, path: string): Promise<boolean> {
  try {
    await symlink(target, path, "junction");
    return true;
  } catch (error) {
    if (["EACCES", "ENOSYS", "ENOTSUP", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      return false;
    }
    throw error;
  }
}

describe("Vault project state and configuration", () => {
  it("isolates canonical aliases and creates only artifacts and metadata", async () => {
    const root = await tempRoot();
    const project = join(root, "project");
    const alias = join(root, "alias");
    await mkdir(project);
    await symlink(project, alias, "junction");
    const direct = await resolveProjectState(project, { PI_CODING_AGENT_DIR: join(root, "pi") });
    const linked = await resolveProjectState(alias, { PI_CODING_AGENT_DIR: join(root, "pi") });
    expect(direct.projectRoot).toBe(await realpath(project));
    expect(linked.projectId).toBe(direct.projectId);
    expect(direct.projectId).toMatch(/^[a-f0-9]{32}$/u);
    expect((await readdir(direct.stateRoot)).sort()).toEqual(["artifacts", "metadata"]);
    expect(direct).not.toHaveProperty("mapRoot");
    await expect(stat(join(direct.stateRoot, "repo-map"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects artifacts and metadata symlinks into both repository state roots", async () => {
    const root = await tempRoot();
    const project = join(root, "project");
    const piRoot = join(root, "pi");
    await mkdir(project);
    const state = await resolveProjectState(project, { PI_CODING_AGENT_DIR: piRoot });
    const targets = [
      join(state.stateRoot, "repo-map"),
      join(piRoot, "pi-repo-context", "projects", state.projectId, "repo-map"),
    ];
    for (const target of targets) {
      await mkdir(target, { recursive: true });
      await writeFile(join(target, "sentinel"), `unchanged:${target}`);
    }

    for (const [ownedName, target] of [
      ["artifacts", targets[0]],
      ["artifacts", targets[1]],
      ["metadata", targets[0]],
      ["metadata", targets[1]],
    ] as const) {
      const owned = join(state.stateRoot, ownedName);
      await rm(owned, { recursive: true, force: true });
      if (!(await createDirectorySymlink(target, owned))) return;
      await expect(resolveProjectState(project, { PI_CODING_AGENT_DIR: piRoot })).rejects.toThrow(
        /symbolic-link|Unsafe/u,
      );
      expect(await readFile(join(target, "sentinel"), "utf8")).toBe(`unchanged:${target}`);
      await rm(owned, { force: true });
      await mkdir(owned);
    }
  });

  it("rejects symlinked Context Vault namespace components without changing Repo Context targets", async () => {
    for (const component of ["context-vault", "projects"] as const) {
      const root = await tempRoot();
      const project = join(root, "project");
      const piRoot = join(root, "pi");
      const target = join(piRoot, "pi-repo-context", "projects", `redirect-${component}`, "repo-map");
      await mkdir(project);
      await mkdir(join(target, "nested"), { recursive: true });
      await writeFile(join(target, "sentinel"), `${component}-safe`);
      await writeFile(join(target, "nested", "evidence"), `${component}-nested-safe`);
      const before = [
        (await readdir(target)).sort(),
        await readFile(join(target, "sentinel"), "utf8"),
        (await readdir(join(target, "nested"))).sort(),
        await readFile(join(target, "nested", "evidence"), "utf8"),
      ];
      const owned =
        component === "context-vault" ? join(piRoot, "context-vault") : join(piRoot, "context-vault", "projects");
      if (component === "projects") await mkdir(join(piRoot, "context-vault"));
      if (!(await createDirectorySymlink(target, owned))) return;

      await expect(resolveProjectState(project, { PI_CODING_AGENT_DIR: piRoot })).rejects.toThrow(/symbolic-link/u);
      expect([
        (await readdir(target)).sort(),
        await readFile(join(target, "sentinel"), "utf8"),
        (await readdir(join(target, "nested"))).sort(),
        await readFile(join(target, "nested", "evidence"), "utf8"),
      ]).toEqual(before);
    }
  });

  it("allows a symlinked PI root ancestor while keeping owned directories real", async () => {
    const root = await tempRoot();
    const project = join(root, "project");
    const actualPiRoot = join(root, "actual-pi");
    const linkedPiRoot = join(root, "linked-pi");
    await mkdir(project);
    await mkdir(actualPiRoot);
    if (!(await createDirectorySymlink(actualPiRoot, linkedPiRoot))) return;
    const state = await resolveProjectState(project, { PI_CODING_AGENT_DIR: linkedPiRoot });
    expect((await lstat(state.artifactsRoot)).isSymbolicLink()).toBe(false);
    expect((await lstat(state.metadataRoot)).isSymbolicLink()).toBe(false);
  });

  it("loads Vault-only defaults and threshold aliases", async () => {
    const root = await tempRoot();
    expect(await loadConfig(root)).toEqual(DEFAULT_CONFIG);
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
    await writeFile(path, JSON.stringify({ searchPreviewMaxBytes: 12 * 1024 }));
    await expect(loadConfig(root)).resolves.toMatchObject({ searchPreviewMaxBytes: 12 * 1024 });
    await writeFile(path, JSON.stringify({ archiveThresholdBytes: 1, replacementThresholdBytes: 2 }));
    await expect(loadConfig(root)).rejects.toThrow("cannot both be configured");
  });

  it("accepts and ignores every legacy repository key regardless of value type", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".pi"));
    const values: unknown[] = [null, "bad", -1, [], {}, false, 1.5, [""]];
    const legacy = Object.fromEntries(LEGACY_REPO_CONFIG_KEYS.map((key, index) => [key, values[index]]));
    await writeFile(join(root, ".pi", "context-vault.json"), JSON.stringify(legacy));
    const loaded = await loadConfigWithDiagnostics(root);
    expect(loaded.config).toEqual(DEFAULT_CONFIG);
    expect(loaded.warnings).toEqual([LEGACY_REPO_CONFIG_WARNING]);
  });

  it("rejects unknown, malformed, and invalid active Vault values", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".pi"));
    const path = join(root, ".pi", "context-vault.json");
    for (const [value, expected] of [
      [{ unknown: 1 }, "Unknown"],
      [{ reductionEnabled: "yes" }, "boolean"],
      [{ archivePolicy: "sometimes" }, "archivePolicy"],
      [{ archiveMinBytes: -1 }, "non-negative"],
      [{ receiptMaxBytes: 511 }, "at least 512"],
      [{ searchPreviewMaxBytes: 4095 }, "at least 4096"],
      [{ softContextRatio: 2 }, "between 0 and 1"],
      [{ softContextRatio: 0.5, targetContextRatio: 0.6 }, "lower than"],
    ] as const) {
      await writeFile(path, JSON.stringify(value));
      await expect(loadConfig(root)).rejects.toThrow(expected);
    }
    await writeFile(path, "null");
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

  it("serializes and releases lock holders", async () => {
    const root = await tempRoot();
    const lockPath = join(root, "writer.lock");
    const order: string[] = [];
    const first = withFileLock(lockPath, async () => {
      order.push("a:start");
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push("a:end");
    });
    while (true) {
      try {
        await stat(lockPath);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
    }
    const second = withFileLock(lockPath, async () => order.push("b"));
    await Promise.all([first, second]);
    expect(order).toEqual(["a:start", "a:end", "b"]);
    await expect(withFileLock(lockPath, async () => "next")).resolves.toBe("next");
  });
});
