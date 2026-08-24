import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalHash } from "../src/bench/canonical.js";
import { createPlan } from "../src/bench/schedule.js";
import {
  ABLATION_ARMS,
  ATTEMPT_SCHEMA_VERSION,
  type BenchmarkTask,
  EXPERIMENT_SCHEMA_VERSION,
  type Experiment,
  type RawAttempt,
  TASK_SCHEMA_VERSION,
} from "../src/bench/schema.js";
import { aggregateSessionJsonl } from "../src/bench/usage.js";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));
const hash = async (text: string) => (await import("node:crypto")).createHash("sha256").update(text).digest("hex");
const emptyTree = () => ({ files: 0, directories: 0, symlinksSkipped: 0, logicalBytes: 0, allocatedBytes: 0 });
const emptyDisk = () => ({
  total: emptyTree(),
  repoMap: {
    ...emptyTree(),
    generationCount: 0,
    generationLogicalBytes: 0,
    generationAllocatedBytes: 0,
  },
  observations: {
    ...emptyTree(),
    uniqueArtifacts: 0,
    uniqueLiveArtifacts: 0,
    liveRecords: 0,
    logRecords: 0,
    tombstones: 0,
    metadataBytes: 0,
  },
});

async function assets(repeats = 6) {
  const root = await mkdtemp(join(tmpdir(), "bench-cli-e2e-"));
  roots.push(root);
  const repository = join(root, "repo");
  await mkdir(repository);
  await exec("git", ["init", "--quiet"], { cwd: repository });
  await exec("git", ["config", "user.email", "fake@example.invalid"], { cwd: repository });
  await exec("git", ["config", "user.name", "Fake"], { cwd: repository });
  await writeFile(join(repository, "base.txt"), "synthetic mechanics only\n");
  await exec("git", ["add", "."], { cwd: repository });
  await exec("git", ["commit", "--quiet", "-m", "base"], { cwd: repository });
  const baseCommit = (await exec("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout.trim();
  const prompt = "Synthetic mechanics fixture. No benchmark claim.\n";
  const promptPath = join(root, "prompt.txt");
  await writeFile(promptPath, prompt);
  const task: BenchmarkTask = {
    schemaVersion: TASK_SCHEMA_VERSION,
    taskId: "synthetic-mechanics",
    assetHash: "synthetic-mechanics-only",
    repository,
    baseCommit,
    promptPath,
    promptHash: await hash(prompt),
    language: "Synthetic",
    repoMapStratum: "mixed",
    evaluator: { kind: "command", command: "true", args: [], timeoutMs: 500 },
  };
  const experiment: Experiment = {
    schemaVersion: EXPERIMENT_SCHEMA_VERSION,
    experimentId: "synthetic-no-claim",
    seed: 31,
    repeats,
    provider: "fake",
    model: "fake-model",
    thinking: "off",
    tools: ["read"],
    piCommit: "synthetic",
    extensionCommit: "synthetic",
    packageLockHash: "synthetic",
    timeoutMs: 1_000,
    maxInfrastructureRetries: 0,
    cacheSupport: "reported",
    extensionPath: "./extensions/index.ts",
    allowedCredentialEnv: [],
    arms: Object.values(ABLATION_ARMS),
    publicationFields: [],
  };
  const experimentPath = join(root, "experiment.json"),
    tasksPath = join(root, "tasks.jsonl"),
    planPath = join(root, "plan.json");
  await writeFile(experimentPath, JSON.stringify(experiment));
  await writeFile(tasksPath, `${JSON.stringify(task)}\n`);
  return { root, task, experiment, experimentPath, tasksPath, planPath };
}
async function bench(args: string[]) {
  return exec(process.execPath, [join(process.cwd(), "scripts", "bench.mjs"), ...args], {
    cwd: process.cwd(),
    timeout: 120_000,
  });
}

describe("subprocess fake-Pi benchmark CLI", () => {
  it("transpiles and runs the production process adapter with stderr telemetry and nested session discovery", async () => {
    const value = await assets();
    await bench(["plan", "--experiment", value.experimentPath, "--tasks", value.tasksPath, "--output", value.planPath]);
    const fake = join(value.root, "fake-pi.mjs");
    await writeFile(
      fake,
      `#!/usr/bin/env node\nimport{mkdirSync,readFileSync,writeFileSync}from'node:fs';import{join}from'node:path';import{createHash}from'node:crypto';const a=process.argv.slice(2),s=a[a.indexOf('--session-dir')+1],e=a.indexOf('-e')>=0;mkdirSync(join(s,'nested'),{recursive:true});writeFileSync(join(s,'nested','session.jsonl'),JSON.stringify({type:'message',message:{role:'assistant',model:'fake-model',content:[],usage:{input:5,output:1,cacheRead:1,cacheWrite:0,totalTokens:7,cost:{total:0}}}}));process.stdout.write('fake stdout protocol\\n');if(e){const c=JSON.parse(readFileSync(join(process.cwd(),'.pi','context-vault.json'),'utf8')),m=c.mapInjectionMode!=='off'?1:0,r=c.reductionEnabled?1:0,p=JSON.stringify({initialized:true,degraded:false,failures:[],components:{observations:{available:true},repoMap:{available:c.repoMapEnabled}},telemetry:{capsuleBuildCount:m,repoMapAutomaticQueryCount:m,reductionInvocationCount:r,reductionTriggeredCount:0,archiveAttemptCount:0,archiveSuccessCount:0,archiveFailureCount:0}}),h=createHash('sha256').update(p).digest('hex');process.stderr.write('@@CONTEXT_VAULT_TELEMETRY_V1@@ '+Buffer.byteLength(p)+' '+h+'\\n'+p+'\\n@@END_CONTEXT_VAULT_TELEMETRY@@\\n')}\n`,
    );
    await chmod(fake, 0o755);
    const results = join(value.root, "results");
    await bench([
      "run",
      "--experiment",
      value.experimentPath,
      "--tasks",
      value.tasksPath,
      "--plan",
      value.planPath,
      "--output",
      results,
      "--fake-pi-command",
      fake,
    ]);
    const plan = JSON.parse(await readFile(value.planPath, "utf8"));
    for (const run of plan.runs) {
      const attempt = JSON.parse(await readFile(join(results, "runs", run.runId, "attempt-0", "attempt.json"), "utf8"));
      expect(attempt.usage.totals.totalTokens).toBe(7);
    }
    await bench(["verify", "--results", results]);
  }, 120_000);

  it("rejects approval/provider execution paths before launching any command", { timeout: 30_000 }, async () => {
    const value = await assets();
    await bench(["plan", "--experiment", value.experimentPath, "--tasks", value.tasksPath, "--output", value.planPath]);
    await expect(
      bench([
        "run",
        "--experiment",
        value.experimentPath,
        "--tasks",
        value.tasksPath,
        "--plan",
        value.planPath,
        "--output",
        join(value.root, "forbidden"),
        "--approval",
        join(value.root, "approval.json"),
        "--pi-command",
        join(value.root, "pi"),
      ]),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("no-token only") });
    const nonFakeExperiment = join(value.root, "non-fake-experiment.json");
    const nonFakePlan = join(value.root, "non-fake-plan.json");
    await writeFile(nonFakeExperiment, JSON.stringify({ ...value.experiment, provider: "openai" }));
    await bench(["plan", "--experiment", nonFakeExperiment, "--tasks", value.tasksPath, "--output", nonFakePlan]);
    await expect(
      bench([
        "run",
        "--experiment",
        nonFakeExperiment,
        "--tasks",
        value.tasksPath,
        "--plan",
        nonFakePlan,
        "--output",
        join(value.root, "non-fake-results"),
        "--fake-pi-command",
        join(value.root, "must-not-launch"),
      ]),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("fake-provider manifest") });
  });

  it("validates analyzer assignment, plan hash, statuses and sidecars with explicit attrition", async () => {
    const value = await assets(6);
    const plan = createPlan(value.experiment, [value.task]);
    await writeFile(value.planPath, JSON.stringify(plan));
    const results = join(value.root, "analysis-results");
    const ef = plan.runs.filter((run) => run.arm === "E" || run.arm === "F");
    for (const [index, run] of ef.entries()) {
      const evaluator = { status: "passed", passed: true, exitCode: 0, f2p: null, p2p: null, durationMs: 1 };
      const raw: RawAttempt = {
        schemaVersion: ATTEMPT_SCHEMA_VERSION,
        experimentHash: plan.experimentHash,
        planHash: canonicalHash(plan),
        runId: run.runId,
        attempt: 0,
        taskId: run.taskId,
        arm: run.arm,
        repeat: run.repeat,
        scheduleIndex: run.scheduleIndex,
        status: "complete",
        requestedProvider: "fake",
        requestedModel: "fake-model",
        responseModels: ["fake-model"],
        integrity: { modelDrift: false, lifecycleDegraded: false },
        timingMs: { provisioning: 1, agent: 1, evaluation: 1, total: 3 },
        usage: aggregateSessionJsonl(
          JSON.stringify({
            type: "message",
            message: {
              role: "assistant",
              model: "fake-model",
              usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: 0 },
            },
          }),
          "reported",
        ),
        telemetry: null,
        disk: emptyDisk(),
        evaluator,
        treatmentDose: {
          toolCalls: 0,
          explicitMapQueries: 0,
          capsuleBuilds: 1,
          automaticMapQueries: 1,
          reductionInvocations: 1,
          reductionTriggered: 0,
          archiveAttempts: 0,
          archiveSuccesses: 0,
          archiveFailures: 0,
        },
        finalDiffHash: null,
        evaluatorOutputHash: null,
      };
      if (index === 1) {
        raw.status = "infrastructure-failed";
        raw.failure = { stage: "evaluator", code: "evaluator-timed-out" };
        raw.evaluator = { ...evaluator, status: "timed-out", passed: false };
      }
      if (index === 2) raw.integrity.lifecycleDegraded = true;
      if (index === 3) raw.planHash = "wrong-plan";
      if (index === 4) {
        raw.status = "timed-out";
        raw.failure = { stage: "agent", code: "agent-timeout" };
        raw.evaluator = { status: "not-run", passed: false };
      }
      if (index === 6) raw.integrity.sessionUsageAmbiguous = true;
      if (index === 7) raw.integrity.sessionUsageCorrupt = true;
      const path = join(results, "runs", run.runId, "attempt-0", "attempt.json");
      await mkdir(dirname(path), { recursive: true });
      const data = `${JSON.stringify(raw)}\n`;
      await writeFile(path, data);
      await writeFile(`${path}.sha256`, `${await hash(data)}\n`);
      if (index === 5) await writeFile(`${path}.sha256`, `${"0".repeat(64)}\n`);
    }
    const output = join(value.root, "analysis.json");
    await bench([
      "analyze",
      "--tasks",
      value.tasksPath,
      "--plan",
      value.planPath,
      "--results",
      results,
      "--output",
      output,
    ]);
    const report = JSON.parse(await readFile(output, "utf8"));
    expect(report.attrition).toMatchObject({
      evaluatorInfrastructure: 1,
      integrity: 1,
      planHashMismatch: 1,
      sidecarOrParse: 1,
      sessionUsageAmbiguous: 1,
      sessionUsageCorrupt: 1,
    });
    expect(report.usageAccounting).toMatchObject({
      analyzedOutcomes: { attempts: 6, totalTokens: 12, cost: 0 },
      sessionUsageAmbiguous: { attempts: 1, totalTokens: 2, cost: 0 },
      sessionUsageCorrupt: { attempts: 1, totalTokens: 2, cost: 0 },
    });
    expect(report.analysisSeed).toBeTypeOf("number");
    expect(report.carryover.claim).toBe("exactly-balanced");
    expect(report.totalTokens).toHaveProperty("ratioBootstrap95");
  });
});
