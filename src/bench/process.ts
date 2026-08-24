import { spawn } from "node:child_process";

export interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function processGroupExists(pid: number): Promise<boolean> {
  if (process.platform === "win32") return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function terminateTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      killer.once("error", () => resolve());
      killer.once("close", () => resolve());
    });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {}
  const deadline = performance.now() + 250;
  while ((await processGroupExists(pid)) && performance.now() < deadline) await delay(10);
  if (await processGroupExists(pid)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
  }
  const killDeadline = performance.now() + 2_000;
  while ((await processGroupExists(pid)) && performance.now() < killDeadline) await delay(10);
  if (await processGroupExists(pid)) throw new Error("process-group-termination-failed");
}

export async function runProcess(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs: number; stdin?: string },
): Promise<ProcessResult> {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let cleanup: Promise<void> | null = null;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) cleanup = terminateTree(child.pid);
    }, options.timeoutMs);
    child.once("close", async (exitCode, signal) => {
      clearTimeout(timer);
      try {
        if (cleanup) await cleanup;
        resolve({ exitCode, signal, stdout, stderr, timedOut, durationMs: performance.now() - started });
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(options.stdin);
  });
}
