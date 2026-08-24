import { createHash } from "node:crypto";
import { cp, lstat, mkdir, open, opendir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { canonicalHash } from "./canonical.js";
import { scanVaultState } from "./disk.js";
import { type EvaluatorResult, evaluateCommand } from "./evaluator.js";
import { ResumeJournal, type RunStage } from "./journal.js";
import { runProcess } from "./process.js";
import { createPlan } from "./schedule.js";
import {
  ABLATION_ARMS,
  ATTEMPT_SCHEMA_VERSION,
  assertSafeArg,
  type BenchmarkTask,
  type Experiment,
  type ExperimentPlan,
  type PlannedRun,
  parseRawAttempt,
  type RawAttempt,
  validateTreatmentDose,
} from "./schema.js";
import { extractTelemetryFrame } from "./telemetry-frame.js";
import { type aggregateSessionJsonl, parseSessionJsonlLine, recoverSessionJsonl } from "./usage.js";

export interface AgentCommandPlan {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  prompt: string;
  run: PlannedRun;
}
export interface AgentExecution {
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  sessionJsonl: string;
  sessionAmbiguous?: boolean;
  sessionCorrupt?: boolean;
  durationMs: number;
}
export interface AgentExecutor {
  execute(plan: AgentCommandPlan): Promise<AgentExecution>;
}
export class ProcessAgentExecutor implements AgentExecutor {
  async execute(plan: AgentCommandPlan): Promise<AgentExecution> {
    const result = await runProcess(plan.command, plan.args, {
      cwd: plan.cwd,
      env: plan.env,
      timeoutMs: plan.timeoutMs,
      stdin: plan.prompt,
    });
    const session = await readOnlySessionJsonl(plan.env.CV_BENCH_SESSION_DIR as string);
    return {
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      stdout: `${result.stdout}\n${result.stderr}`,
      sessionJsonl: session.text,
      sessionAmbiguous: session.ambiguous,
      sessionCorrupt: session.corrupt,
      durationMs: result.durationMs,
    };
  }
}

interface SessionDiscovery {
  text: string;
  ambiguous: boolean;
  corrupt: boolean;
}

async function readOnlySessionJsonl(root: string): Promise<SessionDiscovery> {
  const candidates: string[] = [];
  let corrupt = false;
  const visit = async (path: string): Promise<void> => {
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") corrupt = true;
      return;
    }
    if (info.isSymbolicLink()) return;
    if (info.isFile()) {
      if (path.endsWith(".jsonl")) candidates.push(path);
      return;
    }
    if (!info.isDirectory()) return;
    try {
      const directory = await opendir(path);
      for await (const entry of directory) await visit(join(path, entry.name));
    } catch {
      corrupt = true;
    }
  };
  await visit(root);
  const chunks: string[] = [];
  for (const path of candidates.sort()) {
    try {
      const text = await readFile(path, "utf8");
      chunks.push(text);
      for (const line of text.split(/\r?\n/u)) if (line.trim() && !parseSessionJsonlLine(line)) corrupt = true;
    } catch {
      corrupt = true;
    }
  }
  return { text: chunks.join("\n"), ambiguous: candidates.length > 1, corrupt };
}

export interface RunHarnessOptions {
  root: string;
  executor?: AgentExecutor;
  evaluate?: (task: BenchmarkTask, workspace: string, env: NodeJS.ProcessEnv) => Promise<EvaluatorResult>;
  afterTransition?: (stage: RunStage, run: PlannedRun) => void | Promise<void>;
  command?: string;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
function cleanEnvironment(
  experiment: Experiment,
  directories: { home: string; pi: string; session: string },
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: directories.home,
    PI_CODING_AGENT_DIR: directories.pi,
    CV_BENCH_SESSION_DIR: directories.session,
  };
  for (const key of experiment.allowedCredentialEnv) if (process.env[key] !== undefined) env[key] = process.env[key];
  return env;
}
export function createAgentCommandPlan(
  experiment: Experiment,
  run: PlannedRun,
  workspace: string,
  directories: { home: string; pi: string; session: string },
  prompt: string,
  command = "pi",
): AgentCommandPlan {
  const arm = ABLATION_ARMS[run.arm];
  assertSafeArg(command, "pi command");
  const args = ["--mode", "json", "--no-extensions"];
  if (arm.extensionEnabled) args.push("-e", resolve(experiment.extensionPath));
  args.push(
    "--session-dir",
    directories.session,
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--offline",
    "--provider",
    experiment.provider,
    "--model",
    experiment.model,
    "--thinking",
    experiment.thinking,
    "--tools",
    experiment.tools.join(","),
    "-",
  );
  for (const [index, value] of args.entries()) assertSafeArg(value, `pi argv[${index}]`);
  return {
    command,
    args,
    cwd: workspace,
    env: cleanEnvironment(experiment, directories),
    timeoutMs: experiment.timeoutMs,
    prompt,
    run,
  };
}

async function transition(
  journal: ResumeJournal,
  run: PlannedRun,
  attempt: number,
  stage: RunStage,
  hook?: RunHarnessOptions["afterTransition"],
  detail: { code?: string; retryable?: boolean } = {},
): Promise<void> {
  await journal.append(run.runId, attempt, stage, detail);
  await hook?.(stage, run);
}
async function provision(task: BenchmarkTask, workspace: string): Promise<number> {
  const started = performance.now();
  const clone = await runProcess("git", ["clone", "--no-hardlinks", "--quiet", task.repository, workspace], {
    cwd: resolve(workspace, ".."),
    timeoutMs: 120_000,
  });
  if (clone.exitCode !== 0) throw new Error("repository-clone-failed");
  const checkout = await runProcess("git", ["checkout", "--quiet", "--detach", task.baseCommit], {
    cwd: workspace,
    timeoutMs: 60_000,
  });
  if (checkout.exitCode !== 0) throw new Error("base-commit-checkout-failed");
  const head = await runProcess("git", ["rev-parse", "HEAD"], { cwd: workspace, timeoutMs: 10_000 });
  if (head.exitCode !== 0 || head.stdout.trim() !== task.baseCommit) throw new Error("base-commit-verification-failed");
  return performance.now() - started;
}
async function writeImmutable(path: string, value: RawAttempt): Promise<void> {
  const data = `${JSON.stringify(parseRawAttempt(value), null, 2)}\n`;
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await writeFile(`${path}.sha256`, `${sha256(data)}\n`, { flag: "wx", mode: 0o600 });
}

function recoverSessionUsage(
  text: string,
  cacheSupport: Experiment["cacheSupport"],
): { usage: ReturnType<typeof aggregateSessionJsonl>; malformed: boolean } {
  return recoverSessionJsonl(text, cacheSupport);
}

function rawDiskSnapshot(value: Awaited<ReturnType<typeof scanVaultState>>): RawAttempt["disk"] {
  const tree = (item: typeof value.total) => ({
    files: item.files,
    directories: item.directories,
    symlinksSkipped: item.symlinksSkipped,
    logicalBytes: item.logicalBytes,
    allocatedBytes: item.allocatedBytes,
  });
  return {
    total: tree(value.total),
    repoMap: {
      ...tree(value.repoMap),
      generationCount: value.repoMap.generationCount,
      generationLogicalBytes: value.repoMap.generationLogicalBytes,
      generationAllocatedBytes: value.repoMap.generationAllocatedBytes,
    },
    observations: {
      ...tree(value.observations),
      uniqueArtifacts: value.observations.uniqueArtifacts,
      uniqueLiveArtifacts: value.observations.uniqueLiveArtifacts,
      liveRecords: value.observations.liveRecords,
      logRecords: value.observations.logRecords,
      tombstones: value.observations.tombstones,
      metadataBytes: value.observations.metadataBytes,
    },
  };
}

async function safeScanVaultState(root: string): Promise<Awaited<ReturnType<typeof scanVaultState>>> {
  try {
    return await scanVaultState(root);
  } catch {
    const tree = { files: 0, directories: 0, symlinksSkipped: 0, logicalBytes: 0, allocatedBytes: null };
    return {
      total: { ...tree },
      repoMap: {
        ...tree,
        generationCount: 0,
        generationLogicalBytes: 0,
        generationAllocatedBytes: null,
        activePointer: null,
      },
      observations: {
        ...tree,
        uniqueArtifacts: 0,
        uniqueLiveArtifacts: 0,
        liveRecords: 0,
        logRecords: 0,
        tombstones: 0,
        metadataBytes: 0,
      },
    };
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function quarantineInterruptedAttempt(attemptRoot: string, quarantine: string): Promise<void> {
  if (await pathExists(attemptRoot)) {
    await mkdir(resolve(quarantine, ".."), { recursive: true, mode: 0o700 });
    if (!(await pathExists(quarantine))) await rename(attemptRoot, quarantine);
    else {
      let sequence = 1;
      while (await pathExists(join(quarantine, `recovery-corrupt-${sequence}`))) sequence += 1;
      await rename(attemptRoot, join(quarantine, `recovery-corrupt-${sequence}`));
    }
  }
  if (await pathExists(quarantine)) await markQuarantinedAttemptEvidence(quarantine);
}

async function markQuarantinedAttemptEvidence(root: string): Promise<void> {
  for (const name of ["attempt.json", "attempt.json.sha256"]) {
    const source = join(root, name);
    if (!(await pathExists(source))) continue;
    let target = `${source}.corrupt`;
    let sequence = 1;
    while (await pathExists(target)) {
      target = `${source}.corrupt-${sequence}`;
      sequence += 1;
    }
    await rename(source, target);
  }
  const directory = await opendir(root);
  for await (const entry of directory) {
    if (entry.isDirectory() && /^recovery-corrupt-\d+$/u.test(entry.name))
      await markQuarantinedAttemptEvidence(join(root, entry.name));
  }
}

async function quarantineWorkspace(source: string, quarantine: string): Promise<void> {
  if (!(await pathExists(source))) return;
  await mkdir(quarantine, { recursive: true, mode: 0o700 });
  let target = join(quarantine, "workspace");
  let sequence = 1;
  while (await pathExists(target)) {
    target = join(quarantine, `workspace-${sequence}`);
    sequence += 1;
  }
  await rename(source, target);
}

export async function runHarness(
  experiment: Experiment,
  tasks: BenchmarkTask[],
  plan: ExperimentPlan,
  options: RunHarnessOptions,
): Promise<RawAttempt[]> {
  if (experiment.provider !== "fake" || experiment.allowedCredentialEnv.length !== 0)
    throw new Error("The no-token harness requires a fake provider and no credential environment variables");
  if (plan.experimentHash !== canonicalHash(experiment) || plan.tasksHash !== canonicalHash(tasks))
    throw new Error("Plan input hash mismatch");
  if (canonicalHash(plan) !== canonicalHash(createPlan(experiment, tasks)))
    throw new Error("Plan schedule or immutable run ID mismatch");
  const planHash = canonicalHash(plan);
  await mkdir(options.root, { recursive: true, mode: 0o700 });
  const journal = await ResumeJournal.open(join(options.root, "journal.jsonl"), planHash);
  for (const partial of journal.nonterminalAttempts()) {
    const run = plan.runs.find((candidate) => candidate.runId === partial.runId);
    if (!run) throw new Error(`Journal contains unknown run: ${partial.runId}`);
    const attemptRoot = join(options.root, "runs", partial.runId, `attempt-${partial.attempt}`);
    const attemptPath = join(attemptRoot, "attempt.json");
    const quarantine = join(options.root, "quarantine", `${partial.runId}-attempt-${partial.attempt}`);
    if (
      !(await validCompletedAttempt(options.root, partial.runId, partial.attempt, {
        experimentHash: plan.experimentHash,
        planHash,
        run,
      }))
    ) {
      // The first rename atomically preserves the entire interrupted attempt, including malformed
      // JSON/checksum evidence. If recovery itself was interrupted, keep each subsequent partial
      // write under the original quarantine rather than replacing either copy.
      const recoveryRoot = (await pathExists(quarantine)) ? quarantine : attemptRoot;
      const sessionRoot = (await pathExists(join(attemptRoot, "session"))) ? attemptRoot : recoveryRoot;
      const diskRoot = (await pathExists(join(attemptRoot, "pi-agent"))) ? attemptRoot : recoveryRoot;
      const session = await readOnlySessionJsonl(join(sessionRoot, "session"));
      const recovered = recoverSessionUsage(session.text, experiment.cacheSupport);
      const usage = recovered.usage;
      const disk = rawDiskSnapshot(
        await safeScanVaultState(
          join(
            diskRoot,
            "pi-agent",
            "context-vault",
            "projects",
            sha256(resolve(join(attemptRoot, "workspace"))).slice(0, 32),
          ),
        ),
      );
      const raw: RawAttempt = {
        schemaVersion: ATTEMPT_SCHEMA_VERSION,
        experimentHash: plan.experimentHash,
        planHash,
        runId: run.runId,
        attempt: partial.attempt,
        taskId: run.taskId,
        arm: run.arm,
        repeat: run.repeat,
        scheduleIndex: run.scheduleIndex,
        status: "partial",
        failure: { stage: "harness", code: "nonterminal-crash" },
        requestedProvider: experiment.provider,
        requestedModel: experiment.model,
        responseModels: usage.responseModels,
        integrity: {
          modelDrift: false,
          lifecycleDegraded: false,
          sessionUsageAmbiguous: session.ambiguous,
          sessionUsageCorrupt: session.corrupt || recovered.malformed,
        },
        timingMs: { provisioning: 0, agent: 0, evaluation: 0, total: 0 },
        usage,
        telemetry: null,
        disk,
        evaluator: { status: "not-run", passed: false },
        treatmentDose: extractDose(null, usage.toolCalls, usage.toolNameCounts.context_vault_repo_map ?? 0),
        finalDiffHash: null,
        evaluatorOutputHash: null,
      };
      await quarantineInterruptedAttempt(attemptRoot, quarantine);
      await mkdir(attemptRoot, { recursive: true, mode: 0o700 });
      await writeImmutable(attemptPath, raw);
    }
    await quarantineWorkspace(join(attemptRoot, "workspace"), quarantine);
    await journal.append(partial.runId, partial.attempt, "failed", {
      code: "nonterminal-crash",
      retryable: true,
    });
  }
  const executor = options.executor ?? new ProcessAgentExecutor();
  const evaluate = options.evaluate ?? evaluateCommand;
  const byTask = new Map(tasks.map((task) => [task.taskId, task]));
  const attempts: RawAttempt[] = [];
  for (const run of plan.runs) {
    if (journal.completedRunIds().has(run.runId)) {
      const complete = [...journal.events()]
        .reverse()
        .find((event) => event.runId === run.runId && event.stage === "complete");
      if (
        !complete ||
        !(await validCompletedAttempt(options.root, run.runId, complete.attempt, {
          experimentHash: plan.experimentHash,
          planHash,
          run,
        }))
      ) {
        throw new Error(`Completed attempt checksum or schema mismatch: ${run.runId}`);
      }
      continue;
    }
    const previousAttempts = journal.events().filter((event) => event.runId === run.runId && event.stage === "failed");
    if (previousAttempts.length > 0 && !journal.canRetry(run.runId, experiment.maxInfrastructureRetries)) continue;
    const attempt = journal.nextAttempt(run.runId);
    const task = byTask.get(run.taskId);
    if (!task) throw new Error(`Unknown planned task: ${run.taskId}`);
    const attemptRoot = join(options.root, "runs", run.runId, `attempt-${attempt}`);
    const workspace = join(attemptRoot, "workspace");
    const directories = {
      home: join(attemptRoot, "home"),
      pi: join(attemptRoot, "pi-agent"),
      session: join(attemptRoot, "session"),
    };
    await mkdir(attemptRoot, { recursive: true, mode: 0o700 });
    await Promise.all(Object.values(directories).map((path) => mkdir(path, { recursive: true, mode: 0o700 })));
    const totalStarted = performance.now();
    let provisioningMs = 0;
    let agentMs = 0;
    let authoritativeUsage: ReturnType<typeof aggregateSessionJsonl> | undefined;
    let sessionUsageAmbiguous = false;
    let sessionUsageCorrupt = false;
    let lastTelemetry: unknown | null = null;
    const storeFailedAttempt = async (
      status: RawAttempt["status"],
      stage: string,
      code: string,
      agentMs: number,
      usage: ReturnType<typeof aggregateSessionJsonl>,
      telemetry: unknown | null,
    ): Promise<void> => {
      const disk = rawDiskSnapshot(
        await safeScanVaultState(
          join(directories.pi, "context-vault", "projects", sha256(resolve(workspace)).slice(0, 32)),
        ),
      );
      let rawTelemetry = telemetry;
      let treatmentDose = extractDose(telemetry, usage.toolCalls, usage.toolNameCounts.context_vault_repo_map ?? 0);
      try {
        validateTreatmentDose(treatmentDose, run.arm, status);
      } catch {
        rawTelemetry = null;
        treatmentDose = extractDose(
          null,
          usage.toolCalls,
          ABLATION_ARMS[run.arm].config.repoMapEnabled ? (usage.toolNameCounts.context_vault_repo_map ?? 0) : 0,
        );
      }
      const raw: RawAttempt = {
        schemaVersion: ATTEMPT_SCHEMA_VERSION,
        experimentHash: plan.experimentHash,
        planHash,
        runId: run.runId,
        attempt,
        taskId: run.taskId,
        arm: run.arm,
        repeat: run.repeat,
        scheduleIndex: run.scheduleIndex,
        status,
        failure: { stage, code },
        requestedProvider: experiment.provider,
        requestedModel: experiment.model,
        responseModels: usage.responseModels,
        integrity: {
          modelDrift: code === "model-drift",
          lifecycleDegraded: code === "lifecycle-degraded",
          sessionUsageAmbiguous,
          sessionUsageCorrupt,
        },
        timingMs: {
          provisioning: provisioningMs,
          agent: agentMs,
          evaluation: 0,
          total: performance.now() - totalStarted,
        },
        usage,
        telemetry: rawTelemetry,
        disk,
        evaluator: { status: "not-run", passed: false },
        treatmentDose,
        finalDiffHash: null,
        evaluatorOutputHash: null,
      };
      await writeImmutable(join(attemptRoot, "attempt.json"), raw);
      attempts.push(raw);
    };
    try {
      await transition(journal, run, attempt, "planned", options.afterTransition);
      provisioningMs = await provision(task, workspace);
      const prompt = await readFile(task.promptPath, "utf8");
      if (sha256(prompt) !== task.promptHash) throw new Error("prompt-hash-mismatch");
      const arm = ABLATION_ARMS[run.arm];
      if (arm.extensionEnabled) {
        await mkdir(join(workspace, ".pi"), { recursive: true });
        await writeFile(join(workspace, ".pi", "context-vault.json"), `${JSON.stringify(arm.config, null, 2)}\n`);
      }
      await transition(journal, run, attempt, "provisioned", options.afterTransition);
      const commandPlan = createAgentCommandPlan(experiment, run, workspace, directories, prompt, options.command);
      await transition(journal, run, attempt, "running", options.afterTransition);
      const agent = await executor.execute(commandPlan);
      agentMs = agent.durationMs;
      const recoveredUsage = recoverSessionUsage(agent.sessionJsonl, experiment.cacheSupport);
      authoritativeUsage = recoveredUsage.usage;
      sessionUsageAmbiguous = agent.sessionAmbiguous === true;
      sessionUsageCorrupt = agent.sessionCorrupt === true || recoveredUsage.malformed;
      if (sessionUsageAmbiguous || sessionUsageCorrupt) {
        await storeFailedAttempt(
          "infrastructure-failed",
          "agent",
          sessionUsageCorrupt ? "session-jsonl-malformed" : "session-jsonl-ambiguous",
          agent.durationMs,
          authoritativeUsage,
          null,
        );
        await transition(journal, run, attempt, "failed", options.afterTransition, {
          code: sessionUsageCorrupt ? "session-jsonl-malformed" : "session-jsonl-ambiguous",
          retryable: true,
        });
        continue;
      }
      if (agent.timedOut) {
        const failedUsage = authoritativeUsage;
        await storeFailedAttempt("timed-out", "agent", "agent-timeout", agent.durationMs, failedUsage, null);
        await transition(journal, run, attempt, "failed", options.afterTransition, {
          code: "agent-timeout",
          retryable: false,
        });
        continue;
      }
      if (agent.exitCode !== 0) {
        const failedUsage = authoritativeUsage;
        await storeFailedAttempt(
          "infrastructure-failed",
          "agent",
          "agent-process",
          agent.durationMs,
          failedUsage,
          null,
        );
        await transition(journal, run, attempt, "failed", options.afterTransition, {
          code: "agent-process",
          retryable: true,
        });
        continue;
      }
      await transition(journal, run, attempt, "agent-finished", options.afterTransition);
      const usage = authoritativeUsage;
      const modelDrift = usage.responseModels.some((model) => model !== experiment.model);
      const framedStatus = arm.extensionEnabled ? extractTelemetryFrame(agent.stdout) : null;
      const telemetry = lifecycleTelemetry(framedStatus);
      lastTelemetry = telemetry;
      const lifecycleError = arm.extensionEnabled
        ? lifecycleIntegrityError(
            framedStatus,
            run.arm,
            usage.toolCalls,
            usage.toolNameCounts.context_vault_repo_map ?? 0,
          )
        : null;
      const lifecycleDegraded = lifecycleError !== null;
      if (modelDrift || lifecycleDegraded) {
        await storeFailedAttempt(
          "infrastructure-failed",
          "integrity",
          modelDrift ? "model-drift" : (lifecycleError as string),
          agent.durationMs,
          usage,
          telemetry,
        );
        await transition(journal, run, attempt, "failed", options.afterTransition, {
          code: modelDrift ? "model-drift" : (lifecycleError as string),
          retryable: false,
        });
        continue;
      }
      await transition(journal, run, attempt, "evaluating", options.afterTransition);
      const evaluationWorkspace = join(attemptRoot, "evaluation-workspace");
      await cp(workspace, evaluationWorkspace, { recursive: true, dereference: false });
      const evaluator = await evaluate(task, evaluationWorkspace, {
        PATH: process.env.PATH,
        HOME: directories.home,
        NO_PROXY: "*",
      });
      const diff = await runProcess("git", ["diff", "--binary", "--no-ext-diff"], {
        cwd: workspace,
        timeoutMs: 30_000,
      });
      const disk = rawDiskSnapshot(
        await scanVaultState(
          join(directories.pi, "context-vault", "projects", sha256(resolve(workspace)).slice(0, 32)),
        ),
      );
      await transition(journal, run, attempt, "collected", options.afterTransition);
      let status: RawAttempt["status"] =
        evaluator.status === "passed"
          ? "complete"
          : evaluator.status === "test-failed"
            ? "task-failed"
            : "infrastructure-failed";
      const treatmentDose = extractDose(telemetry, usage.toolCalls, usage.toolNameCounts.context_vault_repo_map ?? 0);
      let treatmentFailure = false;
      try {
        validateTreatmentDose(treatmentDose, run.arm, status, true);
      } catch {
        treatmentFailure = true;
        status = "infrastructure-failed";
      }
      const publicEvaluator = {
        status: evaluator.status,
        isolation: evaluator.isolation ?? "local-unisolated",
        passed: evaluator.passed,
        exitCode: evaluator.exitCode,
        f2p: evaluator.f2p,
        p2p: evaluator.p2p,
        durationMs: evaluator.durationMs,
      };
      const raw: RawAttempt = {
        schemaVersion: ATTEMPT_SCHEMA_VERSION,
        experimentHash: plan.experimentHash,
        planHash,
        runId: run.runId,
        attempt,
        taskId: run.taskId,
        arm: run.arm,
        repeat: run.repeat,
        scheduleIndex: run.scheduleIndex,
        status,
        requestedProvider: experiment.provider,
        requestedModel: experiment.model,
        responseModels: usage.responseModels,
        integrity: { modelDrift, lifecycleDegraded, sessionUsageAmbiguous, sessionUsageCorrupt },
        timingMs: {
          provisioning: provisioningMs,
          agent: agent.durationMs,
          evaluation: evaluator.durationMs,
          total: performance.now() - totalStarted,
        },
        usage,
        telemetry,
        disk,
        evaluator: publicEvaluator,
        treatmentDose,
        finalDiffHash: sha256(diff.stdout),
        evaluatorOutputHash: sha256(evaluator.output),
        ...(treatmentFailure
          ? { failure: { stage: "integrity", code: "treatment-dose-incompatible" } }
          : status === "infrastructure-failed"
            ? { failure: { stage: "evaluator", code: `evaluator-${evaluator.status}` } }
            : {}),
      };
      await writeImmutable(join(attemptRoot, "attempt.json"), raw);
      attempts.push(raw);
      if (treatmentFailure || ["timed-out", "malformed-assets", "infrastructure-failed"].includes(evaluator.status)) {
        await transition(journal, run, attempt, "failed", options.afterTransition, {
          code: treatmentFailure ? "treatment-dose-incompatible" : `evaluator-${evaluator.status}`,
          retryable: !treatmentFailure,
        });
      } else {
        await transition(journal, run, attempt, "complete", options.afterTransition);
      }
    } catch (error) {
      const code =
        error instanceof Error ? error.message.replace(/[^a-z0-9-]/giu, "-").slice(0, 80) : "unknown-infrastructure";
      if (!attempts.some((item) => item.runId === run.runId && item.attempt === attempt)) {
        if (!authoritativeUsage) {
          const persisted = await readOnlySessionJsonl(directories.session);
          const recovered = recoverSessionUsage(persisted.text, experiment.cacheSupport);
          authoritativeUsage = recovered.usage;
          sessionUsageAmbiguous = persisted.ambiguous;
          sessionUsageCorrupt = persisted.corrupt || recovered.malformed;
        }
        await storeFailedAttempt("infrastructure-failed", "harness", code, agentMs, authoritativeUsage, lastTelemetry);
      }
      const last = [...journal.events()]
        .reverse()
        .find((event) => event.runId === run.runId && event.attempt === attempt);
      if (last && last.stage !== "failed" && last.stage !== "complete")
        await transition(journal, run, attempt, "failed", options.afterTransition, {
          code,
          retryable: true,
        });
    }
  }
  return attempts;
}

function lifecycleIntegrityError(
  value: unknown,
  armId: RawAttempt["arm"],
  toolCalls: number,
  explicitMapQueries: number,
): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "lifecycle-malformed";
  const status = value as Record<string, unknown>;
  if (
    typeof status.initialized !== "boolean" ||
    typeof status.degraded !== "boolean" ||
    !Array.isArray(status.failures)
  )
    return "lifecycle-malformed";
  const components = status.components;
  if (!components || typeof components !== "object" || Array.isArray(components)) return "lifecycle-malformed";
  const componentRecord = components as Record<string, unknown>;
  const observations = componentRecord.observations;
  const repoMap = componentRecord.repoMap;
  if (
    !observations ||
    typeof observations !== "object" ||
    Array.isArray(observations) ||
    typeof (observations as Record<string, unknown>).available !== "boolean" ||
    !repoMap ||
    typeof repoMap !== "object" ||
    Array.isArray(repoMap) ||
    typeof (repoMap as Record<string, unknown>).available !== "boolean"
  )
    return "lifecycle-malformed";
  const snapshot = status.telemetry;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return "treatment-dose-malformed";
  for (const field of [
    "capsuleBuildCount",
    "repoMapAutomaticQueryCount",
    "reductionInvocationCount",
    "reductionTriggeredCount",
    "archiveAttemptCount",
    "archiveSuccessCount",
    "archiveFailureCount",
  ]) {
    const count = (snapshot as Record<string, unknown>)[field];
    if (!Number.isSafeInteger(count) || (count as number) < 0) return "treatment-dose-malformed";
  }
  const arm = ABLATION_ARMS[armId];
  if (
    status.initialized !== true ||
    status.degraded !== false ||
    status.failures.length !== 0 ||
    (observations as Record<string, unknown>).available !== true ||
    (repoMap as Record<string, unknown>).available !== arm.config.repoMapEnabled
  )
    return "lifecycle-degraded";
  try {
    validateTreatmentDose(extractDose(value, toolCalls, explicitMapQueries), armId, undefined, true);
  } catch {
    return "treatment-dose-incompatible";
  }
  return null;
}

function lifecycleTelemetry(value: unknown): unknown | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const status = value as Record<string, unknown>;
  const components =
    status.components && typeof status.components === "object" && !Array.isArray(status.components)
      ? (status.components as Record<string, Record<string, unknown>>)
      : undefined;
  const snapshot =
    status.telemetry && typeof status.telemetry === "object" && !Array.isArray(status.telemetry)
      ? (status.telemetry as Record<string, unknown>)
      : undefined;
  const telemetryFields = [
    "capsuleBuildCount",
    "repoMapAutomaticQueryCount",
    "reductionInvocationCount",
    "reductionTriggeredCount",
    "archiveAttemptCount",
    "archiveSuccessCount",
    "archiveFailureCount",
  ] as const;
  const initialized = status.initialized;
  const degraded = status.degraded;
  const observationsAvailable = components?.observations?.available;
  const repoMapAvailable = components?.repoMap?.available;
  if (
    !snapshot ||
    typeof initialized !== "boolean" ||
    typeof degraded !== "boolean" ||
    !Array.isArray(status.failures) ||
    typeof observationsAvailable !== "boolean" ||
    typeof repoMapAvailable !== "boolean" ||
    telemetryFields.some((field) => !Number.isSafeInteger(snapshot[field]) || (snapshot[field] as number) < 0)
  )
    return null;
  return {
    telemetry: Object.fromEntries(telemetryFields.map((field) => [field, snapshot[field]])),
    lifecycle: {
      initialized,
      degraded,
      failureCount: status.failures.length,
      observationsAvailable,
      repoMapAvailable,
    },
  };
}

async function validCompletedAttempt(
  root: string,
  runId: string,
  attempt: number,
  expectedIdentity?: { experimentHash: string; planHash: string; run: PlannedRun },
): Promise<boolean> {
  const path = join(root, "runs", runId, `attempt-${attempt}`, "attempt.json");
  try {
    const [data, expected] = await Promise.all([readFile(path, "utf8"), readFile(`${path}.sha256`, "utf8")]);
    if (sha256(data) !== expected.trim()) return false;
    const raw = parseRawAttempt(JSON.parse(data));
    if (raw.runId !== runId || raw.attempt !== attempt) return false;
    if (!expectedIdentity) return true;
    const run = expectedIdentity.run;
    return (
      raw.experimentHash === expectedIdentity.experimentHash &&
      raw.planHash === expectedIdentity.planHash &&
      raw.taskId === run.taskId &&
      raw.arm === run.arm &&
      raw.repeat === run.repeat &&
      raw.scheduleIndex === run.scheduleIndex
    );
  } catch {
    return false;
  }
}

function extractDose(telemetry: unknown, toolCalls: number, explicitMapQueries: number): Record<string, number> {
  const status = telemetry && typeof telemetry === "object" ? (telemetry as Record<string, unknown>) : {};
  const snapshot =
    status.telemetry && typeof status.telemetry === "object" ? (status.telemetry as Record<string, unknown>) : status;
  const numeric = (name: string): number => {
    const value = snapshot[name];
    return typeof value === "number" ? value : 0;
  };
  return {
    toolCalls,
    explicitMapQueries,
    capsuleBuilds: numeric("capsuleBuildCount"),
    automaticMapQueries: numeric("repoMapAutomaticQueryCount"),
    reductionInvocations: numeric("reductionInvocationCount"),
    reductionTriggered: numeric("reductionTriggeredCount"),
    archiveAttempts: numeric("archiveAttemptCount"),
    archiveSuccesses: numeric("archiveSuccessCount"),
    archiveFailures: numeric("archiveFailureCount"),
  };
}

export async function quarantinePartialRuns(root: string, plan: ExperimentPlan): Promise<void> {
  const journal = await ResumeJournal.open(join(root, "journal.jsonl"), canonicalHash(plan));
  for (const partial of journal.nonterminalAttempts()) {
    const source = join(root, "runs", partial.runId, `attempt-${partial.attempt}`, "workspace");
    const target = join(root, "quarantine", `${partial.runId}-attempt-${partial.attempt}`);
    await mkdir(join(root, "quarantine"), { recursive: true, mode: 0o700 });
    try {
      await rename(source, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await journal.append(partial.runId, partial.attempt, "failed", { code: "nonterminal-crash", retryable: true });
  }
}
