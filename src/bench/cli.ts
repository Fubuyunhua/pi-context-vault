#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, opendir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { canonicalHash } from "./canonical.js";
import { publicationRecord, verifyPublicationRecord } from "./publication.js";
import { runHarness } from "./runner.js";
import { carryoverDiagnostics, createPlan, williamsSequences } from "./schedule.js";
import { parseExperiment, parsePlan, parseRawAttempt, parseTask, type RawAttempt } from "./schema.js";
import { type AnalysisObservation, analyzeBinary, analyzeContinuous, analyzeStrata } from "./stats.js";

function flags(args: string[]): Map<string, string> {
  const parsed = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`Expected --name value, got ${key ?? "end"}`);
    const name = key.slice(2);
    if (parsed.has(name)) throw new Error(`Duplicate --${name}`);
    parsed.set(name, value);
  }
  return parsed;
}
function required(values: Map<string, string>, key: string): string {
  const value = values.get(key);
  if (!value) throw new Error(`Missing --${key}`);
  return resolve(value);
}
async function loadJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}
async function loadTasks(path: string) {
  const text = await readFile(path, "utf8");
  const tasks = text
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => parseTask(JSON.parse(line) as unknown));
  if (new Set(tasks.map((task) => task.taskId)).size !== tasks.length) throw new Error("Duplicate taskId");
  return tasks;
}
async function jsonFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  const visit = async (path: string): Promise<void> => {
    const directory = await opendir(path);
    for await (const entry of directory) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile() && entry.name === "attempt.json") result.push(child);
    }
  };
  await visit(root);
  return result.sort();
}
interface LocatedAttempt {
  path: string;
  raw?: RawAttempt;
  error?: string;
  pathRunId?: string;
  pathAttempt?: number;
}
function identityFromPath(path: string): Pick<LocatedAttempt, "pathRunId" | "pathAttempt"> {
  const parts = path.split(/[\\/]/u);
  const runsIndex = parts.lastIndexOf("runs");
  const attempt = parts[runsIndex + 2]?.match(/^attempt-(\d+)$/u);
  return {
    pathRunId: runsIndex >= 0 ? parts[runsIndex + 1] : undefined,
    pathAttempt: attempt ? Number(attempt[1]) : undefined,
  };
}
async function locatedAttempts(root: string): Promise<LocatedAttempt[]> {
  return Promise.all(
    (await jsonFiles(root)).map(async (path) => {
      const identity = identityFromPath(path);
      try {
        const [data, sidecar] = await Promise.all([readFile(path, "utf8"), readFile(`${path}.sha256`, "utf8")]);
        const actual = createHash("sha256").update(data).digest("hex");
        if (actual !== sidecar.trim()) return { path, ...identity, error: "sidecar-mismatch" };
        const raw = parseRawAttempt(JSON.parse(data) as unknown);
        if (identity.pathRunId !== raw.runId || identity.pathAttempt !== raw.attempt)
          return { path, ...identity, error: "path-identity-mismatch" };
        return { path, ...identity, raw };
      } catch (error) {
        return { path, ...identity, error: error instanceof Error ? error.message : String(error) };
      }
    }),
  );
}
function seedFromPlan(plan: unknown): number {
  return Number.parseInt(canonicalHash(plan).slice(0, 8), 16) >>> 0;
}
function primaryAttempts(values: LocatedAttempt[]): LocatedAttempt[] {
  const primary = new Map<string, LocatedAttempt>();
  const unassigned: LocatedAttempt[] = [];
  for (const value of values) {
    const runId = value.raw?.runId ?? value.pathRunId;
    const attempt = value.raw?.attempt ?? value.pathAttempt;
    if (!runId || attempt === undefined) {
      unassigned.push(value);
      continue;
    }
    const current = primary.get(runId);
    const currentAttempt = current?.raw?.attempt ?? current?.pathAttempt ?? -1;
    if (!current || attempt > currentAttempt) primary.set(runId, value);
  }
  return [...primary.values(), ...unassigned];
}
function scheduleRows(plan: ReturnType<typeof parsePlan>) {
  const blocks = new Map<number, Array<{ index: number; arm: RawAttempt["arm"] }>>();
  for (const run of plan.runs)
    blocks.set(run.blockIndex, [...(blocks.get(run.blockIndex) ?? []), { index: run.scheduleIndex, arm: run.arm }]);
  return [...blocks.values()].map((runs) => runs.sort((a, b) => a.index - b.index).map((run) => run.arm));
}

export async function analyzeResults(
  taskList: Awaited<ReturnType<typeof loadTasks>>,
  plan: ReturnType<typeof parsePlan>,
  root: string,
) {
  if (canonicalHash(taskList) !== plan.tasksHash) throw new Error("Plan task hash mismatch");
  const taskMap = new Map(taskList.map((task) => [task.taskId, task]));
  const planHash = canonicalHash(plan);
  const assignment = new Map(plan.runs.map((run) => [run.runId, run]));
  const expected = plan.runs
    .filter((run) => run.arm === "E")
    .map((run) => {
      const task = taskMap.get(run.taskId);
      if (!task) throw new Error(`Missing task ${run.taskId}`);
      return { taskId: run.taskId, repeat: run.repeat, stratum: task.repoMapStratum };
    });
  const attrition: Record<string, number> = {
    missing: 0,
    sidecarOrParse: 0,
    unknownRun: 0,
    assignmentMismatch: 0,
    planHashMismatch: 0,
    integrity: 0,
    infrastructure: 0,
    evaluatorInfrastructure: 0,
    invalidStatus: 0,
    sessionUsageAmbiguous: 0,
    sessionUsageCorrupt: 0,
  };
  const usageAccounting = {
    analyzedOutcomes: { attempts: 0, totalTokens: 0, cost: 0 },
    sessionUsageAmbiguous: { attempts: 0, totalTokens: 0, cost: 0 },
    sessionUsageCorrupt: { attempts: 0, totalTokens: 0, cost: 0 },
  };
  const accountUsage = (bucket: keyof typeof usageAccounting, item: RawAttempt): void => {
    const usage = item.usage as { totals?: { totalTokens?: number; cost?: number } };
    usageAccounting[bucket].attempts += 1;
    usageAccounting[bucket].totalTokens += usage.totals?.totalTokens ?? 0;
    usageAccounting[bucket].cost += usage.totals?.cost ?? 0;
  };
  const latest = primaryAttempts(await locatedAttempts(root));
  const seen = new Set<string>();
  const observations: AnalysisObservation[] = [];
  for (const located of latest) {
    if (!located.raw) {
      if (located.pathRunId && assignment.has(located.pathRunId)) seen.add(located.pathRunId);
      attrition.sidecarOrParse += 1;
      continue;
    }
    const item = located.raw;
    if (item.arm !== "E" && item.arm !== "F") continue;
    const planned = assignment.get(item.runId);
    if (!planned) {
      attrition.unknownRun += 1;
      continue;
    }
    seen.add(item.runId);
    if (item.planHash !== planHash || item.experimentHash !== plan.experimentHash) {
      attrition.planHashMismatch += 1;
      continue;
    }
    if (
      item.taskId !== planned.taskId ||
      item.arm !== planned.arm ||
      item.repeat !== planned.repeat ||
      item.scheduleIndex !== planned.scheduleIndex
    ) {
      attrition.assignmentMismatch += 1;
      continue;
    }
    if (item.integrity.sessionUsageCorrupt) {
      attrition.sessionUsageCorrupt += 1;
      accountUsage("sessionUsageCorrupt", item);
      continue;
    }
    if (item.integrity.sessionUsageAmbiguous) {
      attrition.sessionUsageAmbiguous += 1;
      accountUsage("sessionUsageAmbiguous", item);
      continue;
    }
    if (item.integrity.modelDrift || item.integrity.lifecycleDegraded) {
      attrition.integrity += 1;
      continue;
    }
    if (item.status === "infrastructure-failed" || item.status === "partial") {
      const evaluator = item.evaluator as { status?: string };
      if (
        item.failure?.stage === "evaluator" ||
        evaluator.status === "timed-out" ||
        evaluator.status === "infrastructure-failed"
      )
        attrition.evaluatorInfrastructure += 1;
      else attrition.infrastructure += 1;
      continue;
    }
    const evaluator = item.evaluator as { status?: string; passed?: boolean };
    const valid =
      (item.status === "complete" && evaluator.status === "passed" && evaluator.passed === true) ||
      (item.status === "task-failed" && evaluator.status === "test-failed" && evaluator.passed === false) ||
      (item.status === "timed-out" && item.failure?.stage === "agent" && item.failure.code === "agent-timeout");
    if (!valid) {
      attrition.invalidStatus += 1;
      continue;
    }
    const task = taskMap.get(item.taskId);
    if (!task) throw new Error(`Missing task ${item.taskId}`);
    const usage = item.usage as {
      totals?: { totalTokens?: number; cost?: number };
      cache?: { hitRatio?: number | null };
    };
    accountUsage("analyzedOutcomes", item);
    observations.push({
      taskId: item.taskId,
      arm: item.arm,
      repeat: item.repeat,
      stratum: task.repoMapStratum,
      passed: item.status === "complete",
      metrics: {
        totalTokens: usage.totals?.totalTokens ?? null,
        cost: usage.totals?.cost ?? null,
        cacheHitRatio: usage.cache?.hitRatio ?? null,
      },
    });
  }
  for (const run of plan.runs) if ((run.arm === "E" || run.arm === "F") && !seen.has(run.runId)) attrition.missing += 1;
  const seed = seedFromPlan(plan);
  const rows = scheduleRows(plan);
  const validRows = new Set(williamsSequences().map((row) => row.join("")));
  if (rows.some((row) => !validRows.has(row.join("")))) throw new Error("Plan contains a non-Williams treatment row");
  const design = carryoverDiagnostics(rows);
  return {
    evidenceLabel: "ANALYSIS OF PROVIDED RESULTS; SYNTHETIC INPUTS ARE NOT EVIDENCE",
    analysisSeed: seed,
    attrition: { ...attrition, totalExcluded: Object.values(attrition).reduce((sum, value) => sum + value, 0) },
    usageAccounting,
    carryover: design,
    binary: analyzeBinary(observations, seed, 2_000, expected),
    totalTokens: analyzeContinuous(observations, "totalTokens", seed, 2_000, expected),
    cost: analyzeContinuous(observations, "cost", seed, 2_000, expected),
    cacheHitRatio: analyzeContinuous(observations, "cacheHitRatio", seed, 2_000, expected),
    strata: analyzeStrata(observations, seed, expected),
  };
}

async function main(): Promise<void> {
  const [subcommand, ...args] = process.argv.slice(2);
  const values = flags(args);
  if (subcommand === "plan") {
    const experiment = parseExperiment(await loadJson(required(values, "experiment")));
    const tasks = await loadTasks(required(values, "tasks"));
    const output = required(values, "output");
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(createPlan(experiment, tasks), null, 2)}\n`, { flag: "wx" });
    return;
  }
  if (subcommand === "run") {
    const experiment = parseExperiment(await loadJson(required(values, "experiment")));
    const tasks = await loadTasks(required(values, "tasks"));
    const plan = parsePlan(await loadJson(required(values, "plan")));
    if (values.has("approval") || values.has("pi-command"))
      throw new Error("bench run is no-token only; provider execution and approvals belong to issue #36");
    const fake = values.get("fake-pi-command");
    if (!fake) throw new Error("bench run requires --fake-pi-command");
    if (experiment.provider !== "fake" || experiment.allowedCredentialEnv.length !== 0)
      throw new Error("bench run requires a fake-provider manifest with no credential environment variables");
    await runHarness(experiment, tasks, plan, { root: required(values, "output"), command: resolve(fake) });
    return;
  }
  if (subcommand === "analyze") {
    if (values.has("seed")) throw new Error("Analysis seed is derived from the immutable plan");
    const report = await analyzeResults(
      await loadTasks(required(values, "tasks")),
      parsePlan(await loadJson(required(values, "plan"))),
      required(values, "results"),
    );
    const output = values.get("output");
    if (output) await writeFile(resolve(output), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
    else console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (subcommand === "verify") {
    const located = await locatedAttempts(required(values, "results"));
    for (const item of located) {
      if (!item.raw) throw new Error(`Attempt sidecar/schema verification failed: ${item.path}: ${item.error}`);
      verifyPublicationRecord(publicationRecord(item.raw));
    }
    return;
  }
  throw new Error("Usage: bench plan|run|analyze|verify [--name value ...]");
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
