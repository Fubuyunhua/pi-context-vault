import { runProcess } from "./process.js";
import type { BenchmarkTask } from "./schema.js";

export type EvaluatorStatus = "passed" | "test-failed" | "timed-out" | "malformed-assets" | "infrastructure-failed";
export interface EvaluatorResult {
  status: EvaluatorStatus;
  isolation?: "local-unisolated";
  passed: boolean;
  exitCode: number | null;
  f2p: { passed: number; total: number } | null;
  p2p: { passed: number; total: number } | null;
  durationMs: number;
  output: string;
}

export async function evaluateCommand(
  task: BenchmarkTask,
  workspace: string,
  env: NodeJS.ProcessEnv = {},
): Promise<EvaluatorResult> {
  if (task.evaluator.command.length === 0)
    return {
      status: "malformed-assets",
      isolation: "local-unisolated",
      passed: false,
      exitCode: null,
      f2p: null,
      p2p: null,
      durationMs: 0,
      output: "",
    };
  try {
    const result = await runProcess(task.evaluator.command, task.evaluator.args, {
      cwd: workspace,
      env,
      timeoutMs: task.evaluator.timeoutMs,
    });
    const status: EvaluatorStatus = result.timedOut ? "timed-out" : result.exitCode === 0 ? "passed" : "test-failed";
    return {
      status,
      isolation: "local-unisolated",
      passed: status === "passed",
      exitCode: result.exitCode,
      f2p: null,
      p2p: null,
      durationMs: result.durationMs,
      output: `${result.stdout}${result.stderr}`,
    };
  } catch (error) {
    return {
      status: "infrastructure-failed",
      isolation: "local-unisolated",
      passed: false,
      exitCode: null,
      f2p: null,
      p2p: null,
      durationMs: 0,
      output: error instanceof Error ? error.message : String(error),
    };
  }
}
