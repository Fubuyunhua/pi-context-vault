import { seededRandom } from "./schedule.js";
import type { RepoMapStratum } from "./schema.js";

export interface AnalysisObservation {
  taskId: string;
  arm: "E" | "F";
  repeat: number;
  stratum: RepoMapStratum;
  passed: boolean;
  metrics: Record<string, number | null>;
}
export interface ConfidenceInterval {
  low: number;
  high: number;
}
export interface ExpectedPair {
  taskId: string;
  repeat: number;
  stratum: RepoMapStratum;
}
export interface BinaryPairedResult {
  pairs: number;
  missingPairs: number;
  missingE: number;
  missingF: number;
  missingBoth: number;
  eOnlyPass: number;
  fOnlyPass: number;
  bothPass: number;
  bothFail: number;
  passDifference: number;
  mcnemarExactP: number;
  bootstrap95: ConfidenceInterval | null;
}

function quantile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)))] as number;
}
function choose(n: number, k: number): number {
  let result = 1;
  for (let index = 1; index <= k; index += 1) result = (result * (n - index + 1)) / index;
  return result;
}
export function exactMcNemar(eOnly: number, fOnly: number): number {
  const discordant = eOnly + fOnly;
  if (discordant === 0) return 1;
  const tail = Math.min(eOnly, fOnly);
  let probability = 0;
  for (let index = 0; index <= tail; index += 1) probability += choose(discordant, index) * 0.5 ** discordant;
  return Math.min(1, probability * 2);
}

function paired(
  observations: AnalysisObservation[],
  expected: ExpectedPair[] = [],
): {
  pairs: Array<[AnalysisObservation, AnalysisObservation]>;
  missing: number;
  missingE: number;
  missingF: number;
  missingBoth: number;
} {
  const groups = new Map<string, Partial<Record<"E" | "F", AnalysisObservation>>>();
  for (const item of expected) groups.set(`${item.taskId}\0${item.repeat}`, {});
  for (const observation of observations) {
    const key = `${observation.taskId}\0${observation.repeat}`;
    const group = groups.get(key) ?? {};
    group[observation.arm] = observation;
    groups.set(key, group);
  }
  const pairs: Array<[AnalysisObservation, AnalysisObservation]> = [];
  let missing = 0;
  let missingE = 0;
  let missingF = 0;
  let missingBoth = 0;
  for (const group of groups.values()) {
    if (group.E && group.F) pairs.push([group.E, group.F]);
    else {
      missing += 1;
      if (!group.E) missingE += 1;
      if (!group.F) missingF += 1;
      if (!group.E && !group.F) missingBoth += 1;
    }
  }
  return { pairs, missing, missingE, missingF, missingBoth };
}

function taskBootstrap(
  values: Array<{ taskId: string; value: number }>,
  seed: number,
  iterations: number,
): ConfidenceInterval | null {
  const byTask = new Map<string, number[]>();
  for (const value of values) byTask.set(value.taskId, [...(byTask.get(value.taskId) ?? []), value.value]);
  const tasks = [...byTask.keys()];
  if (tasks.length === 0) return null;
  const random = seededRandom(seed);
  const samples: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const selected = Array.from({ length: tasks.length }, () => tasks[Math.floor(random() * tasks.length)] as string);
    const valuesForSample = selected.flatMap((task) => byTask.get(task) ?? []);
    samples.push(valuesForSample.reduce((sum, value) => sum + value, 0) / valuesForSample.length);
  }
  return { low: quantile(samples, 0.025), high: quantile(samples, 0.975) };
}

export function analyzeBinary(
  observations: AnalysisObservation[],
  seed: number,
  bootstrapIterations = 2_000,
  expected: ExpectedPair[] = [],
): BinaryPairedResult {
  const { pairs, missing, missingE, missingF, missingBoth } = paired(observations, expected);
  let eOnlyPass = 0;
  let fOnlyPass = 0;
  let bothPass = 0;
  let bothFail = 0;
  const differences = pairs.map(([e, f]) => {
    if (e.passed && f.passed) bothPass += 1;
    else if (e.passed) eOnlyPass += 1;
    else if (f.passed) fOnlyPass += 1;
    else bothFail += 1;
    return { taskId: e.taskId, value: Number(f.passed) - Number(e.passed) };
  });
  return {
    pairs: pairs.length,
    missingPairs: missing,
    missingE,
    missingF,
    missingBoth,
    eOnlyPass,
    fOnlyPass,
    bothPass,
    bothFail,
    passDifference: pairs.length ? (fOnlyPass - eOnlyPass) / pairs.length : 0,
    mcnemarExactP: exactMcNemar(eOnlyPass, fOnlyPass),
    bootstrap95: taskBootstrap(differences, seed, bootstrapIterations),
  };
}

export interface ContinuousPairedResult {
  pairs: number;
  missingPairs: number;
  meanDifference: number | null;
  medianDifference: number | null;
  meanRatio: number | null;
  medianRatio: number | null;
  differenceBootstrap95: ConfidenceInterval | null;
  ratioBootstrap95: ConfidenceInterval | null;
}
export function analyzeContinuous(
  observations: AnalysisObservation[],
  metric: string,
  seed: number,
  bootstrapIterations = 2_000,
  expected: ExpectedPair[] = [],
): ContinuousPairedResult {
  const all = paired(observations, expected);
  let missing = all.missing;
  const values: Array<{ taskId: string; difference: number; ratio: number | null }> = [];
  for (const [e, f] of all.pairs) {
    const eValue = e.metrics[metric];
    const fValue = f.metrics[metric];
    if (eValue === null || eValue === undefined || fValue === null || fValue === undefined) {
      missing += 1;
      continue;
    }
    values.push({ taskId: e.taskId, difference: fValue - eValue, ratio: eValue === 0 ? null : fValue / eValue });
  }
  const differences = values.map((value) => value.difference);
  const ratios = values.flatMap((value) => (value.ratio === null ? [] : [value.ratio]));
  const mean = (items: number[]): number | null =>
    items.length ? items.reduce((sum, value) => sum + value, 0) / items.length : null;
  return {
    pairs: values.length,
    missingPairs: missing,
    meanDifference: mean(differences),
    medianDifference: differences.length ? quantile(differences, 0.5) : null,
    meanRatio: mean(ratios),
    medianRatio: ratios.length ? quantile(ratios, 0.5) : null,
    differenceBootstrap95: taskBootstrap(
      values.map((value) => ({ taskId: value.taskId, value: value.difference })),
      seed,
      bootstrapIterations,
    ),
    ratioBootstrap95: taskBootstrap(
      values.flatMap((value) => (value.ratio === null ? [] : [{ taskId: value.taskId, value: value.ratio }])),
      seed ^ 0x9e3779b9,
      bootstrapIterations,
    ),
  };
}

export function analyzeStrata(
  observations: AnalysisObservation[],
  seed: number,
  expected: ExpectedPair[] = [],
): Record<RepoMapStratum, BinaryPairedResult> {
  return {
    lexical: analyzeBinary(
      observations.filter((item) => item.stratum === "lexical"),
      seed,
      2_000,
      expected.filter((item) => item.stratum === "lexical"),
    ),
    semantic: analyzeBinary(
      observations.filter((item) => item.stratum === "semantic"),
      seed + 1,
      2_000,
      expected.filter((item) => item.stratum === "semantic"),
    ),
    mixed: analyzeBinary(
      observations.filter((item) => item.stratum === "mixed"),
      seed + 2,
      2_000,
      expected.filter((item) => item.stratum === "mixed"),
    ),
  };
}
