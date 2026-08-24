import { canonicalHash } from "./canonical.js";
import { type ArmId, type BenchmarkTask, type Experiment, type ExperimentPlan, PLAN_SCHEMA_VERSION } from "./schema.js";

export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function shuffle<T>(values: readonly T[], random: () => number): T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const selected = Math.floor(random() * (index + 1));
    [result[index], result[selected]] = [result[selected] as T, result[index] as T];
  }
  return result;
}

export function williamsSequences(): ArmId[][] {
  const arms: ArmId[] = ["A", "B", "C", "D", "E", "F"];
  const first = [0, 1, 5, 2, 4, 3];
  const rows = arms.map((_, row) => first.map((column) => arms[(column + row) % arms.length] as ArmId));
  const diagnostic = carryoverDiagnostics(rows);
  if (!diagnostic.complete || diagnostic.min !== 1 || diagnostic.max !== 1)
    throw new Error("Internal Williams rows do not balance ordered carryover exactly");
  return rows;
}

export interface CarryoverDiagnostics {
  scope: "within-task-repeat-block";
  rows: number;
  transitions: number;
  expectedOrderedPairs: number;
  counts: Record<string, number>;
  min: number;
  max: number;
  complete: boolean;
  claim: "exactly-balanced" | "incomplete-no-balance-claim";
}

export function carryoverDiagnostics(rows: readonly (readonly ArmId[])[]): CarryoverDiagnostics {
  const arms: ArmId[] = ["A", "B", "C", "D", "E", "F"];
  const counts: Record<string, number> = {};
  for (const from of arms) for (const to of arms) if (from !== to) counts[`${from}->${to}`] = 0;
  let transitions = 0;
  for (const row of rows) {
    if (row.length !== arms.length || new Set(row).size !== arms.length || row.some((arm) => !arms.includes(arm)))
      throw new Error("Invalid Williams row");
    for (let index = 1; index < row.length; index += 1) {
      const key = `${row[index - 1]}->${row[index]}`;
      counts[key] = (counts[key] ?? 0) + 1;
      transitions += 1;
    }
  }
  const values = Object.values(counts);
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 0;
  const complete = rows.length > 0 && min === max && min > 0;
  return {
    scope: "within-task-repeat-block",
    rows: rows.length,
    transitions,
    expectedOrderedPairs: arms.length * (arms.length - 1),
    counts,
    min,
    max,
    complete,
    claim: complete ? "exactly-balanced" : "incomplete-no-balance-claim",
  };
}

export function createPlan(experiment: Experiment, tasks: BenchmarkTask[]): ExperimentPlan {
  if (tasks.length === 0) throw new Error("At least one task is required");
  if (new Set(tasks.map((task) => task.taskId)).size !== tasks.length) throw new Error("Duplicate taskId");
  if ((tasks.length * experiment.repeats) % 6 !== 0)
    throw new Error("Task/repeat block count must be a multiple of six for balanced ordered carryover");
  const experimentHash = canonicalHash(experiment);
  const tasksHash = canonicalHash(tasks);
  const random = seededRandom(experiment.seed);
  const blocks = shuffle(
    tasks.flatMap((task) => Array.from({ length: experiment.repeats }, (_, repeat) => ({ task, repeat }))),
    random,
  );
  const rows = shuffle(williamsSequences(), random);
  let scheduleIndex = 0;
  const runs = blocks.flatMap((block, blockIndex) => {
    const sequence = rows[blockIndex % rows.length] as ArmId[];
    return sequence.map((arm) => {
      const identity = {
        experimentHash,
        tasksHash,
        taskId: block.task.taskId,
        arm,
        repeat: block.repeat,
        blockIndex,
        scheduleIndex,
      };
      const run = { ...identity, runId: canonicalHash(identity).slice(0, 32) };
      scheduleIndex += 1;
      return {
        runId: run.runId,
        taskId: run.taskId,
        arm: run.arm,
        repeat: run.repeat,
        blockIndex: run.blockIndex,
        scheduleIndex: run.scheduleIndex,
      };
    });
  });
  return { schemaVersion: PLAN_SCHEMA_VERSION, experimentHash, tasksHash, seed: experiment.seed, runs };
}
