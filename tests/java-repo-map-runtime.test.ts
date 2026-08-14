import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { RepoMapRuntime } from "../src/repo-map/runtime.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(files: Record<string, string>): Promise<{ root: string; stateRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), "context-vault-java-runtime-"));
  const stateRoot = await mkdtemp(join(tmpdir(), "context-vault-java-runtime-state-"));
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

describe("incremental Java repository map", () => {
  it("reparses only the changed Java file and updates its signature before query", async () => {
    const { root, stateRoot } = await fixture({
      "src/UserService.java": "public class UserService { public String find(long id) { return null; } }",
      "src/Stable.java": "public class Stable { public void untouched() {} }",
    });
    const runtime = new RepoMapRuntime({ projectRoot: root, stateRoot, watch: false });
    await runtime.start();
    const before = runtime.status().workspaceRevision;
    await writeFile(
      join(root, "src/UserService.java"),
      "public class UserService { public User find(UserId id) throws MissingUser { return null; } }",
    );
    runtime.notify("change", "src/UserService.java");

    const result = await runtime.query("find");
    expect(result.freshness).toBe("dirty");
    expect(result.workspaceRevision).not.toBe(before);
    expect(result.results[0]?.symbols).toContainEqual(
      expect.objectContaining({ name: "find", signature: "public User find(UserId id) throws MissingUser" }),
    );
    expect((await runtime.query("untouched")).results[0]?.symbols).toContainEqual(
      expect.objectContaining({ name: "untouched" }),
    );
    await runtime.close();
  });

  it("handles external Java create, unlink, and rename", async () => {
    const { root, stateRoot } = await fixture({ "src/Old.java": "public class Old {}" });
    const runtime = new RepoMapRuntime({ projectRoot: root, stateRoot, watch: false });
    await runtime.start();
    await writeFile(join(root, "src/Added.java"), "public class Added { void newMethod() {} }");
    runtime.notify("add", "src/Added.java");
    expect((await runtime.query("newMethod")).results[0]?.path).toBe("src/Added.java");

    await rename(join(root, "src/Old.java"), join(root, "src/Renamed.java"));
    await writeFile(join(root, "src/Renamed.java"), "public class Renamed {}");
    runtime.notify("unlink", "src/Old.java");
    runtime.notify("add", "src/Renamed.java");
    expect((await runtime.query("Old")).results).toEqual([]);
    expect((await runtime.query("Renamed")).results[0]?.path).toBe("src/Renamed.java");

    await rm(join(root, "src/Added.java"));
    runtime.notify("unlink", "src/Added.java");
    expect((await runtime.query("newMethod")).results).toEqual([]);
    await runtime.close();
  });

  it("invalidates Java symbols across Git HEAD changes", async () => {
    const { root, stateRoot } = await fixture({ "src/Version.java": "public class FirstVersion {}" });
    const firstHead = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    await writeFile(join(root, "src/Version.java"), "public class SecondVersion {}");
    await execFileAsync("git", ["add", "."], { cwd: root });
    await execFileAsync("git", ["commit", "-qm", "second"], { cwd: root });
    const runtime = new RepoMapRuntime({ projectRoot: root, stateRoot, watch: false });
    await runtime.start();
    await execFileAsync("git", ["checkout", "-q", firstHead], { cwd: root });

    const result = await runtime.query("FirstVersion");
    expect(result.gitHead).toBe(firstHead);
    expect(result.freshness).toBe("fresh");
    expect(result.results[0]?.symbols).toContainEqual(expect.objectContaining({ name: "FirstVersion" }));
    expect((await runtime.query("SecondVersion")).results).toEqual([]);
    await runtime.close();
  });

  it("reports unsupported after Java parse fallback and never claims fresh semantics", async () => {
    const { root, stateRoot } = await fixture({
      "src/Broken.java": "public class Broken { public void incomplete( ",
    });
    const runtime = new RepoMapRuntime({ projectRoot: root, stateRoot, watch: false });
    await runtime.start();

    expect(runtime.status().freshness).toBe("unsupported");
    const initial = await runtime.query("Broken incomplete");
    expect(initial.freshness).toBe("unsupported");
    expect(initial.results[0]).toMatchObject({ path: "src/Broken.java", kind: "lexical", symbols: [] });

    await writeFile(join(root, "src/Broken.java"), "public class Repaired { public void working() {} }");
    runtime.notify("change", "src/Broken.java");
    expect((await runtime.query("working")).freshness).toBe("dirty");
    await writeFile(join(root, "src/Broken.java"), "public class Repaired { public void broken( ");
    runtime.notify("change", "src/Broken.java");
    expect((await runtime.query("broken")).freshness).toBe("unsupported");
    await runtime.close();
  });
});
