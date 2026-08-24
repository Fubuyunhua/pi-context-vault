import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseJournal, ResumeJournal, type RunStage } from "../src/bench/journal.js";
import {
  type AnalysisObservation,
  analyzeBinary,
  analyzeContinuous,
  analyzeStrata,
  exactMcNemar,
} from "../src/bench/stats.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("append-only resume journal", () => {
  it("validates every transition, plan hash, and event hash", async () => {
    const root = await mkdtemp(join(tmpdir(), "bench-journal-"));
    roots.push(root);
    const path = join(root, "journal.jsonl");
    const planHash = "plan-hash";
    const journal = await ResumeJournal.open(path, planHash);
    const stages: RunStage[] = [
      "planned",
      "provisioned",
      "running",
      "agent-finished",
      "evaluating",
      "collected",
      "complete",
    ];
    for (const stage of stages) await journal.append("run", 0, stage);
    expect((await ResumeJournal.open(path, planHash)).completedRunIds()).toEqual(new Set(["run"]));
    await expect(ResumeJournal.open(path, "drifted-plan")).rejects.toThrow("plan hash mismatch");
    const lines = (await readFile(path, "utf8")).trim().split("\n");
    const changed = JSON.parse(lines[2] as string);
    changed.stage = "evaluating";
    lines[2] = JSON.stringify(changed);
    await writeFile(path, `${lines.join("\n")}\n`);
    expect(() => parseJournal(lines.join("\n"), planHash)).toThrow();
  });
  it("resumes with a fresh attempt after a crash at every transition", async () => {
    const stages: RunStage[] = ["planned", "provisioned", "running", "agent-finished", "evaluating", "collected"];
    for (const [crashIndex, crashStage] of stages.entries()) {
      const root = await mkdtemp(join(tmpdir(), "bench-crash-resume-"));
      roots.push(root);
      const path = join(root, "journal.jsonl");
      let journal = await ResumeJournal.open(path, "plan");
      for (const stage of stages.slice(0, crashIndex + 1)) await journal.append("run", 0, stage);
      await journal.append("run", 0, "failed", { code: `crash-after-${crashStage}`, retryable: true });
      journal = await ResumeJournal.open(path, "plan");
      expect(journal.nextAttempt("run")).toBe(1);
      for (const stage of [...stages, "complete"] as RunStage[]) await journal.append("run", 1, stage);
      expect((await ResumeJournal.open(path, "plan")).completedRunIds()).toContain("run");
    }
  });
  it("starts numbered attempts and retries only declared infrastructure failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "bench-journal-"));
    roots.push(root);
    const journal = await ResumeJournal.open(join(root, "journal.jsonl"), "plan");
    await journal.append("infra", 0, "planned");
    await journal.append("infra", 0, "failed", { code: "spawn", retryable: true });
    expect(journal.nextAttempt("infra")).toBe(1);
    expect(journal.canRetry("infra", 1)).toBe(true);
    await journal.append("test", 0, "planned");
    await journal.append("test", 0, "failed", { code: "task-failed", retryable: false });
    expect(journal.canRetry("test", 10)).toBe(false);
  });
});

function observation(
  taskId: string,
  arm: "E" | "F",
  passed: boolean,
  tokens: number | null,
  stratum: "lexical" | "semantic" | "mixed" = "lexical",
  repeat = 0,
): AnalysisObservation {
  return { taskId, arm, passed, repeat, stratum, metrics: { tokens } };
}
describe("paired known-answer statistics", () => {
  it("computes discordance and exact McNemar", () => {
    const data = [
      observation("both-pass", "E", true, 10),
      observation("both-pass", "F", true, 12),
      observation("e-only", "E", true, 20),
      observation("e-only", "F", false, 10),
      observation("f-only", "E", false, 10),
      observation("f-only", "F", true, 15),
      observation("both-fail", "E", false, 0),
      observation("both-fail", "F", false, 0),
      observation("missing", "E", true, 1),
    ];
    expect(analyzeBinary(data, 1, 100)).toMatchObject({
      pairs: 4,
      missingPairs: 1,
      eOnlyPass: 1,
      fOnlyPass: 1,
      bothPass: 1,
      bothFail: 1,
      passDifference: 0,
      mcnemarExactP: 1,
    });
    expect(exactMcNemar(0, 5)).toBe(0.0625);
  });
  it("reports paired differences, ratios, missing values, seeded bootstrap, and strata", () => {
    const data = [
      observation("one", "E", true, 10),
      observation("one", "F", true, 15),
      observation("two", "E", false, 20, "semantic"),
      observation("two", "F", true, 10, "semantic"),
      observation("zero", "E", true, 0, "mixed"),
      observation("zero", "F", true, 5, "mixed"),
      observation("missing-value", "E", true, null),
      observation("missing-value", "F", true, 2),
      observation("missing-arm", "E", true, 3),
    ];
    const result = analyzeContinuous(data, "tokens", 17, 200);
    expect(result).toMatchObject({
      pairs: 3,
      missingPairs: 2,
      meanDifference: 0,
      medianDifference: 5,
      meanRatio: 1,
      medianRatio: 1.5,
    });
    expect(result.differenceBootstrap95).toEqual(analyzeContinuous(data, "tokens", 17, 200).differenceBootstrap95);
    expect(result.ratioBootstrap95).not.toBeNull();
    expect(result.ratioBootstrap95).toEqual(analyzeContinuous(data, "tokens", 17, 200).ratioBootstrap95);
    const strata = analyzeStrata(data, 2);
    expect(strata.lexical.missingPairs).toBe(1);
    expect(strata.semantic.pairs).toBe(1);
    expect(strata.mixed.pairs).toBe(1);
  });
});
