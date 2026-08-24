import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateCommand } from "../src/bench/evaluator.js";
import { runProcess } from "../src/bench/process.js";
import { type BenchmarkTask, TASK_SCHEMA_VERSION } from "../src/bench/schema.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function root() {
  const path = await mkdtemp(join(tmpdir(), "bench-process-"));
  roots.push(path);
  return path;
}
function task(command: string, args: string[], timeoutMs = 500): BenchmarkTask {
  return {
    schemaVersion: TASK_SCHEMA_VERSION,
    taskId: "synthetic",
    assetHash: "synthetic",
    repository: ".",
    baseCommit: "synthetic",
    promptPath: "synthetic",
    promptHash: "synthetic",
    language: "Synthetic",
    repoMapStratum: "mixed",
    evaluator: { kind: "command", command, args, timeoutMs },
  };
}

describe("evaluator classification and timeout cleanup", () => {
  it("classifies pass, ordinary test failure, timeout, malformed assets, and infrastructure failure", async () => {
    const cwd = await root();
    await expect(evaluateCommand(task(process.execPath, ["-e", "process.exit(0)"]), cwd)).resolves.toMatchObject({
      status: "passed",
      passed: true,
    });
    await expect(evaluateCommand(task(process.execPath, ["-e", "process.exit(2)"]), cwd)).resolves.toMatchObject({
      status: "test-failed",
      passed: false,
      exitCode: 2,
    });
    await expect(
      evaluateCommand(task(process.execPath, ["-e", "setTimeout(() => {}, 1000)"], 20), cwd),
    ).resolves.toMatchObject({ status: "timed-out", passed: false });
    await expect(evaluateCommand(task("", []), cwd)).resolves.toMatchObject({ status: "malformed-assets" });
    await expect(evaluateCommand(task(join(cwd, "missing-command"), []), cwd)).resolves.toMatchObject({
      status: "infrastructure-failed",
    });
  });
  it.runIf(process.platform !== "win32")("kills the detached process tree on timeout", async () => {
    const cwd = await root();
    const marker = join(cwd, "survived");
    const childCode = `const {writeFileSync}=require('node:fs');setTimeout(()=>writeFileSync(${JSON.stringify(marker)},'bad'),500)`;
    const parentCode = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'ignore'});setTimeout(()=>{},5000)`;
    const result = await runProcess(process.execPath, ["-e", parentCode], { cwd, timeoutMs: 30 });
    expect(result.timedOut).toBe(true);
    // runProcess does not return until the whole group has been terminated.
    await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    await new Promise((resolve) => setTimeout(resolve, 650));
    await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
