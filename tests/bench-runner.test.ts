import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalHash } from "../src/bench/canonical.js";
import type { EvaluatorResult } from "../src/bench/evaluator.js";
import { ResumeJournal } from "../src/bench/journal.js";
import {
  type AgentCommandPlan,
  type AgentExecution,
  type AgentExecutor,
  ProcessAgentExecutor,
  runHarness,
} from "../src/bench/runner.js";
import { createPlan } from "../src/bench/schedule.js";
import {
  ABLATION_ARMS,
  type BenchmarkTask,
  EXPERIMENT_SCHEMA_VERSION,
  type Experiment,
  TASK_SCHEMA_VERSION,
} from "../src/bench/schema.js";
import { frameTelemetry } from "../src/bench/telemetry-frame.js";
import { aggregateSessionJsonl } from "../src/bench/usage.js";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class FakePi implements AgentExecutor {
  plans: AgentCommandPlan[] = [];
  async execute(plan: AgentCommandPlan): Promise<AgentExecution> {
    this.plans.push(plan);
    expect(plan.env.HOME).toContain(plan.run.runId);
    expect(plan.env.PI_CODING_AGENT_DIR).toContain(plan.run.runId);
    const extensionIndex = plan.args.indexOf("-e");
    if (plan.run.arm === "A") expect(extensionIndex).toBe(-1);
    else {
      expect(extensionIndex).toBeGreaterThan(0);
      const config = JSON.parse(await readFile(join(plan.cwd, ".pi", "context-vault.json"), "utf8"));
      expect(config).toEqual(ABLATION_ARMS[plan.run.arm].config);
    }
    const sessionJsonl = JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        model: "fake-model",
        content: [{ type: "text", text: "done" }],
        usage: { input: 10, output: 2, cacheRead: 1, cacheWrite: 0, totalTokens: 13, cost: { total: 0 } },
      },
    });
    const archiveEnabled = ["B", "C", "E", "F"].includes(plan.run.arm);
    const telemetry = {
      initialized: true,
      degraded: false,
      failures: [],
      components: {
        observations: { available: true },
        repoMap: { available: ["D", "E", "F"].includes(plan.run.arm) },
      },
      telemetry: {
        capsuleBuildCount: plan.run.arm === "E" || plan.run.arm === "F" ? 1 : 0,
        repoMapAutomaticQueryCount: plan.run.arm === "E" || plan.run.arm === "F" ? 1 : 0,
        reductionInvocationCount: ["C", "E", "F"].includes(plan.run.arm) ? 1 : 0,
        reductionTriggeredCount: 0,
        archiveAttemptCount: archiveEnabled ? 1 : 0,
        archiveSuccessCount: archiveEnabled ? 1 : 0,
        archiveFailureCount: 0,
      },
    };
    return {
      exitCode: 0,
      timedOut: false,
      stdout: plan.run.arm === "A" ? "" : frameTelemetry(telemetry),
      sessionJsonl,
      durationMs: 1,
    };
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "bench-runner-"));
  roots.push(root);
  const repository = join(root, "repository");
  await mkdir(repository);
  await exec("git", ["init", "--quiet"], { cwd: repository });
  await exec("git", ["config", "user.email", "fake@example.invalid"], { cwd: repository });
  await exec("git", ["config", "user.name", "Fake"], { cwd: repository });
  await writeFile(join(repository, "file.txt"), "base\n");
  await exec("git", ["add", "file.txt"], { cwd: repository });
  await exec("git", ["commit", "--quiet", "-m", "base"], { cwd: repository });
  const { stdout } = await exec("git", ["rev-parse", "HEAD"], { cwd: repository });
  const promptPath = join(root, "prompt.txt");
  const prompt = "Synthetic task. NOT BENCHMARK EVIDENCE.\n";
  await writeFile(promptPath, prompt);
  const { createHash } = await import("node:crypto");
  const task: BenchmarkTask = {
    schemaVersion: TASK_SCHEMA_VERSION,
    taskId: "synthetic-task",
    assetHash: "synthetic-asset",
    repository,
    baseCommit: stdout.trim(),
    promptPath,
    promptHash: createHash("sha256").update(prompt).digest("hex"),
    language: "Synthetic",
    repoMapStratum: "mixed",
    evaluator: { kind: "command", command: "true", args: [], timeoutMs: 100 },
  };
  const experiment: Experiment = {
    schemaVersion: EXPERIMENT_SCHEMA_VERSION,
    experimentId: "synthetic-no-token",
    seed: 31,
    repeats: 6,
    provider: "fake",
    model: "fake-model",
    thinking: "off",
    tools: ["read", "bash"],
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
  return { root, task, experiment };
}

describe("fake-Pi A-F end-to-end", { timeout: 60_000 }, () => {
  it("runs all isolated arms and writes immutable attempts without provider calls", async () => {
    const { root, task, experiment } = await fixture();
    const fake = new FakePi();
    const plan = createPlan(experiment, [task]);
    const evaluate = async (): Promise<EvaluatorResult> => ({
      status: "passed",
      passed: true,
      exitCode: 0,
      f2p: { passed: 1, total: 1 },
      p2p: { passed: 1, total: 1 },
      durationMs: 1,
      output: "synthetic evaluator output",
    });
    const attempts = await runHarness(experiment, [task], plan, {
      root: join(root, "results"),
      executor: fake,
      evaluate,
    });
    expect(new Set(attempts.map((attempt) => attempt.arm))).toEqual(new Set(["A", "B", "C", "D", "E", "F"]));
    expect(fake.plans).toHaveLength(36);
    expect(new Set(fake.plans.map((item) => item.env.HOME)).size).toBe(36);
    expect(attempts.find((item) => item.arm === "A")?.telemetry).toBeNull();
    expect(attempts.find((item) => item.arm === "B")?.treatmentDose).toMatchObject({
      capsuleBuilds: 0,
      reductionInvocations: 0,
      archiveAttempts: 1,
    });
    expect(attempts.find((item) => item.arm === "F")?.treatmentDose).toMatchObject({
      capsuleBuilds: 1,
      automaticMapQueries: 1,
      reductionInvocations: 1,
    });
  });
  it("quarantines a nonterminal crash and consumes the retry budget", async () => {
    const { root, task, experiment } = await fixture();
    const plan = createPlan(experiment, [task]);
    const run = plan.runs[0] as (typeof plan.runs)[number];
    const results = join(root, "crash-results");
    await mkdir(join(results, "runs", run.runId, "attempt-0", "workspace"), { recursive: true });
    await mkdir(join(results, "runs", run.runId, "attempt-0", "session"), { recursive: true });
    await writeFile(join(results, "runs", run.runId, "attempt-0", "workspace", "partial"), "partial");
    await writeFile(
      join(results, "runs", run.runId, "attempt-0", "session", "z-session.jsonl"),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          model: "fake-model",
          usage: { input: 9, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { total: 0 } },
        },
      }),
    );
    await writeFile(
      join(results, "runs", run.runId, "attempt-0", "session", "a-session.jsonl"),
      `${JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          model: "fake-model",
          usage: { input: 3, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 4, cost: { total: 0 } },
        },
      })}\nnull\n42\n[]\n{}\n{"type":"message","message":null}\n{malformed`,
    );
    const journal = await ResumeJournal.open(join(results, "journal.jsonl"), canonicalHash(plan));
    await journal.append(run.runId, 0, "planned");
    const resumed = await runHarness(experiment, [task], plan, { root: results, executor: new FakePi() });
    expect(resumed.some((attempt) => attempt.runId === run.runId)).toBe(false);
    await expect(
      stat(join(results, "quarantine", `${run.runId}-attempt-0`, "workspace", "partial")),
    ).resolves.toBeDefined();
    const journalText = await readFile(join(results, "journal.jsonl"), "utf8");
    expect(journalText).toContain("nonterminal-crash");
    expect(journalText).toContain('"stage":"failed"');
    const recovered = JSON.parse(await readFile(join(results, "runs", run.runId, "attempt-0", "attempt.json"), "utf8"));
    expect(recovered).toMatchObject({
      status: "partial",
      failure: { stage: "harness", code: "nonterminal-crash" },
      integrity: { sessionUsageAmbiguous: true, sessionUsageCorrupt: true },
      usage: { totals: { totalTokens: 14 } },
    });
  });
  it.each([
    { name: "JSON without a sidecar", sidecar: undefined },
    { name: "JSON with a bad sidecar", sidecar: "not-the-json-hash\n" },
  ])("preserves corrupt $name on resume and remains idempotent", async ({ sidecar }) => {
    const { root, task, experiment } = await fixture();
    experiment.maxInfrastructureRetries = 1;
    const plan = createPlan(experiment, [task]);
    const run = plan.runs[0] as (typeof plan.runs)[number];
    const results = join(root, `corrupt-${sidecar === undefined ? "missing" : "bad"}-sidecar`);
    const attemptRoot = join(results, "runs", run.runId, "attempt-0");
    const corruptJson = `${JSON.stringify({ preserved: "corrupt evidence" })}\n`;
    await mkdir(join(attemptRoot, "workspace"), { recursive: true });
    await mkdir(join(attemptRoot, "session"), { recursive: true });
    await writeFile(join(attemptRoot, "workspace", "partial"), "partial");
    await writeFile(join(attemptRoot, "attempt.json"), corruptJson);
    if (sidecar !== undefined) await writeFile(join(attemptRoot, "attempt.json.sha256"), sidecar);
    await writeFile(
      join(attemptRoot, "session", "session.jsonl"),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          model: "fake-model",
          usage: { input: 5, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 7, cost: { total: 0 } },
        },
      }),
    );
    const journal = await ResumeJournal.open(join(results, "journal.jsonl"), canonicalHash(plan));
    await journal.append(run.runId, 0, "planned");

    const firstResumeExecutor = new FakePi();
    await runHarness(experiment, [task], plan, { root: results, executor: firstResumeExecutor });

    expect(firstResumeExecutor.plans.find((item) => item.run.runId === run.runId)?.cwd).toContain("attempt-1");
    const quarantine = join(results, "quarantine", `${run.runId}-attempt-0`);
    expect(await readFile(join(quarantine, "attempt.json.corrupt"), "utf8")).toBe(corruptJson);
    if (sidecar !== undefined)
      expect(await readFile(join(quarantine, "attempt.json.sha256.corrupt"), "utf8")).toBe(sidecar);
    await expect(stat(join(quarantine, "workspace", "partial"))).resolves.toBeDefined();
    const recoveredPath = join(attemptRoot, "attempt.json");
    const recoveredData = await readFile(recoveredPath, "utf8");
    const recovered = JSON.parse(recoveredData);
    expect(recovered).toMatchObject({
      runId: run.runId,
      attempt: 0,
      status: "partial",
      failure: { stage: "harness", code: "nonterminal-crash" },
      usage: { totals: { totalTokens: 7 } },
    });
    const { createHash } = await import("node:crypto");
    expect((await readFile(`${recoveredPath}.sha256`, "utf8")).trim()).toBe(
      createHash("sha256").update(recoveredData).digest("hex"),
    );
    const terminal = await ResumeJournal.open(join(results, "journal.jsonl"), canonicalHash(plan));
    expect(terminal.nextAttempt(run.runId)).toBe(2);
    expect(terminal.events().filter((event) => event.runId === run.runId && event.stage === "failed")).toHaveLength(1);
    expect(
      terminal.events().some((event) => event.runId === run.runId && event.attempt === 1 && event.stage === "complete"),
    ).toBe(true);
    const journalBeforeSecondResume = await readFile(join(results, "journal.jsonl"), "utf8");

    const secondResumeExecutor = new FakePi();
    await runHarness(experiment, [task], plan, { root: results, executor: secondResumeExecutor });

    expect(secondResumeExecutor.plans).toHaveLength(0);
    expect(await readFile(join(results, "journal.jsonl"), "utf8")).toBe(journalBeforeSecondResume);
    expect(await readFile(join(quarantine, "attempt.json.corrupt"), "utf8")).toBe(corruptJson);
    expect(await readFile(recoveredPath, "utf8")).toBe(recoveredData);
  });
  it("parses persisted session usage after nonzero exit and timeout", async () => {
    const { root } = await fixture();
    for (const mode of ["nonzero", "timeout"] as const) {
      const session = join(root, `session-${mode}`);
      await mkdir(session);
      const script = join(root, `${mode}.mjs`);
      const line = JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          model: "fake-model",
          usage: { input: 7, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 8, cost: { total: 0.1 } },
        },
      });
      await writeFile(
        script,
        `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(join(session, "one.jsonl"))},${JSON.stringify(line)});${mode === "timeout" ? "setTimeout(()=>{},5000)" : "process.exit(2)"}`,
      );
      const result = await new ProcessAgentExecutor().execute({
        command: process.execPath,
        args: [script],
        cwd: root,
        env: { CV_BENCH_SESSION_DIR: session },
        timeoutMs: mode === "timeout" ? 150 : 1000,
        prompt: "",
        run: { runId: mode, taskId: "t", arm: "A", repeat: 0, scheduleIndex: 0, blockIndex: 0 },
      });
      expect(result.sessionJsonl).toContain('"input":7');
      expect(result.sessionAmbiguous).toBe(false);
      expect(result.sessionCorrupt).toBe(false);
      expect(result.timedOut).toBe(mode === "timeout");
    }
  });
  it("discovers multiple session files deterministically and flags malformed content without losing valid usage", async () => {
    const { root } = await fixture();
    const session = join(root, "multi-session");
    await mkdir(session);
    await writeFile(
      join(session, "z.jsonl"),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          model: "fake-model",
          usage: { input: 7, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 8 },
        },
      }),
    );
    await writeFile(
      join(session, "a.jsonl"),
      `${JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          model: "fake-model",
          usage: { input: 3, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 4 },
        },
      })}\n{bad`,
    );
    const result = await new ProcessAgentExecutor().execute({
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: root,
      env: { CV_BENCH_SESSION_DIR: session },
      timeoutMs: 1_000,
      prompt: "",
      run: { runId: "multi", taskId: "t", arm: "A", repeat: 0, scheduleIndex: 0, blockIndex: 0 },
    });
    expect(result).toMatchObject({ sessionAmbiguous: true, sessionCorrupt: true });
    const valid = result.sessionJsonl
      .split(/\r?\n/u)
      .filter((line) => {
        try {
          JSON.parse(line);
          return true;
        } catch {
          return false;
        }
      })
      .join("\n");
    expect(aggregateSessionJsonl(valid, "reported").totals.totalTokens).toBe(12);
    expect(result.sessionJsonl.indexOf('"input":3')).toBeLessThan(result.sessionJsonl.indexOf('"input":7'));
  });
  it("persists authoritative usage when a post-agent harness transition fails", async () => {
    const { root, task, experiment } = await fixture();
    const plan = createPlan(experiment, [task]);
    const first = plan.runs[0] as (typeof plan.runs)[number];
    const attempts = await runHarness(experiment, [task], plan, {
      root: join(root, "post-agent-failure"),
      executor: new FakePi(),
      afterTransition: (stage, run) => {
        if (stage === "evaluating" && run.runId === first.runId) throw new Error("planted-post-agent-failure");
      },
    });
    expect(attempts.find((attempt) => attempt.runId === first.runId)).toMatchObject({
      status: "infrastructure-failed",
      usage: { totals: { totalTokens: 13 } },
    });
  });
  it("retains valid authoritative usage records when later session JSONL is malformed", async () => {
    const { root, task, experiment } = await fixture();
    const plan = createPlan(experiment, [task]);
    const first = plan.runs[0] as (typeof plan.runs)[number];
    const base = new FakePi();
    const executor: AgentExecutor = {
      execute: async (commandPlan) => {
        const result = await base.execute(commandPlan);
        return commandPlan.run.runId === first.runId
          ? { ...result, sessionJsonl: `${result.sessionJsonl}\nnull\n42\n[]\n{}\n{"type":"message","message":null}` }
          : result;
      },
    };
    const attempts = await runHarness(experiment, [task], plan, {
      root: join(root, "malformed-session"),
      executor,
    });
    expect(attempts.find((attempt) => attempt.runId === first.runId)).toMatchObject({
      status: "infrastructure-failed",
      failure: { code: "session-jsonl-malformed" },
      usage: { totals: { totalTokens: 13 } },
    });
  });
  it("rejects missing active C/E/F treatment before every evaluator outcome", async () => {
    const { root, task, experiment } = await fixture();
    const base = new FakePi();
    const executor: AgentExecutor = {
      execute: async (plan) => {
        const result = await base.execute(plan);
        if (!["C", "E", "F"].includes(plan.run.arm)) return result;
        return {
          ...result,
          stdout: frameTelemetry({
            initialized: true,
            degraded: false,
            failures: [],
            components: {
              observations: { available: true },
              repoMap: { available: plan.run.arm === "E" || plan.run.arm === "F" },
            },
            telemetry: {
              capsuleBuildCount: 0,
              repoMapAutomaticQueryCount: 0,
              reductionInvocationCount: 0,
              reductionTriggeredCount: 0,
              archiveAttemptCount: 0,
              archiveSuccessCount: 0,
              archiveFailureCount: 0,
            },
          }),
        };
      },
    };
    const evaluate = vi.fn(
      async (_task: BenchmarkTask, workspace: string): Promise<EvaluatorResult> => ({
        status: workspace.includes("attempt-0") ? "test-failed" : "timed-out",
        passed: false,
        exitCode: 1,
        f2p: null,
        p2p: null,
        durationMs: 1,
        output: "",
      }),
    );
    const attempts = await runHarness(experiment, [task], createPlan(experiment, [task]), {
      root: join(root, "active-dose-gate"),
      executor,
      evaluate,
    });
    expect(evaluate).toHaveBeenCalledTimes(18);
    expect(
      attempts
        .filter((attempt) => ["C", "E", "F"].includes(attempt.arm))
        .every(
          (attempt) =>
            attempt.status === "infrastructure-failed" &&
            attempt.failure?.stage === "integrity" &&
            attempt.failure.code === "treatment-dose-incompatible",
        ),
    ).toBe(true);
  });
  it("rejects malformed lifecycle and forbidden arm treatment activity", async () => {
    const { root, task, experiment } = await fixture();
    const base = new FakePi();
    const executor: AgentExecutor = {
      execute: async (plan) => {
        const result = await base.execute(plan);
        if (plan.run.arm === "B") {
          const bad = {
            initialized: true,
            degraded: false,
            failures: [],
            components: { observations: { available: true }, repoMap: { available: false } },
            telemetry: {
              capsuleBuildCount: 1,
              repoMapAutomaticQueryCount: 1,
              reductionInvocationCount: 0,
              reductionTriggeredCount: 0,
              archiveAttemptCount: 1,
              archiveSuccessCount: 1,
              archiveFailureCount: 0,
            },
          };
          return { ...result, stdout: frameTelemetry(bad) };
        }
        if (plan.run.arm === "C") return { ...result, stdout: frameTelemetry({ initialized: true }) };
        return result;
      },
    };
    const attempts = await runHarness(experiment, [task], createPlan(experiment, [task]), {
      root: join(root, "integrity-contract"),
      executor,
    });
    expect(
      attempts
        .filter((attempt) => attempt.arm === "B")
        .every((attempt) => attempt.failure?.code === "treatment-dose-incompatible"),
    ).toBe(true);
    expect(
      attempts
        .filter((attempt) => attempt.arm === "C")
        .every((attempt) => attempt.failure?.code === "lifecycle-malformed"),
    ).toBe(true);
  });
  it("classifies evaluator timeout separately from agent timeout and lifecycle degradation as integrity", async () => {
    const { root, task, experiment } = await fixture();
    const executor: AgentExecutor = {
      execute: async (commandPlan) => ({
        exitCode: 0,
        timedOut: false,
        durationMs: 1,
        stdout:
          commandPlan.run.arm === "A"
            ? ""
            : frameTelemetry({
                initialized: true,
                degraded: true,
                failures: [{ component: "repo-map" }],
                components: { observations: { available: true }, repoMap: { available: false } },
                telemetry: {
                  capsuleBuildCount: 0,
                  repoMapAutomaticQueryCount: 0,
                  reductionInvocationCount: 0,
                  reductionTriggeredCount: 0,
                  archiveAttemptCount: 0,
                  archiveSuccessCount: 0,
                  archiveFailureCount: 0,
                },
              }),
        sessionJsonl: JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            model: "fake-model",
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
          },
        }),
      }),
    };
    const evaluate = vi.fn(
      async (): Promise<EvaluatorResult> => ({
        status: "timed-out",
        isolation: "local-unisolated",
        passed: false,
        exitCode: null,
        f2p: null,
        p2p: null,
        durationMs: 2,
        output: "",
      }),
    );
    const attempts = await runHarness(experiment, [task], createPlan(experiment, [task]), {
      root: join(root, "classification"),
      executor,
      evaluate,
    });
    const a = attempts.find((attempt) => attempt.arm === "A");
    expect(a).toMatchObject({
      status: "infrastructure-failed",
      failure: { stage: "evaluator", code: "evaluator-timed-out" },
    });
    expect(
      attempts.filter((attempt) => attempt.arm !== "A").every((attempt) => attempt.integrity.lifecycleDegraded),
    ).toBe(true);
    expect(
      attempts
        .filter((attempt) => attempt.arm !== "A")
        .every((attempt) => attempt.failure?.code === "lifecycle-degraded"),
    ).toBe(true);
  });
  it("classifies observed response-model drift as an integrity failure before evaluation", async () => {
    const { root, task, experiment } = await fixture();
    const plan = createPlan(experiment, [task]);
    const executor: AgentExecutor = {
      execute: async (commandPlan) => ({
        exitCode: 0,
        timedOut: false,
        stdout: commandPlan.run.arm === "A" ? "" : frameTelemetry({ telemetry: {} }),
        sessionJsonl: JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            model: "drifted-model",
            content: [],
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
          },
        }),
        durationMs: 1,
      }),
    };
    const evaluate = vi.fn();
    const attempts = await runHarness(experiment, [task], plan, {
      root: join(root, "drift-results"),
      executor,
      evaluate,
    });
    expect(attempts).toHaveLength(36);
    expect(attempts.every((attempt) => attempt.status === "infrastructure-failed")).toBe(true);
    expect(attempts.every((attempt) => attempt.integrity.modelDrift)).toBe(true);
    expect(evaluate).not.toHaveBeenCalled();
    expect(await readFile(join(root, "drift-results", "journal.jsonl"), "utf8")).toContain("model-drift");
  });
});
