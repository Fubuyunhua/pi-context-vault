import { open, readFile } from "node:fs/promises";
import { canonicalHash } from "./canonical.js";

export type RunStage =
  | "planned"
  | "provisioned"
  | "running"
  | "agent-finished"
  | "evaluating"
  | "collected"
  | "complete"
  | "failed";
export interface JournalEvent {
  version: 1;
  sequence: number;
  runId: string;
  attempt: number;
  stage: RunStage;
  previousHash: string | null;
  planHash: string;
  detail: { code?: string; retryable?: boolean };
  eventHash: string;
}
const nextStages: Record<RunStage, RunStage[]> = {
  planned: ["provisioned", "failed"],
  provisioned: ["running", "failed"],
  running: ["agent-finished", "failed"],
  "agent-finished": ["evaluating", "failed"],
  evaluating: ["collected", "failed"],
  collected: ["complete", "failed"],
  complete: [],
  failed: [],
};

function withoutHash(event: JournalEvent): Omit<JournalEvent, "eventHash"> {
  const { eventHash: _, ...unsigned } = event;
  return unsigned;
}

export function parseJournal(text: string, expectedPlanHash?: string): JournalEvent[] {
  const events: JournalEvent[] = [];
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    let event: JournalEvent;
    try {
      event = JSON.parse(line) as JournalEvent;
    } catch {
      throw new Error(`Invalid journal JSON at line ${index + 1}`);
    }
    if (event.version !== 1 || event.sequence !== events.length)
      throw new Error(`Invalid journal sequence at line ${index + 1}`);
    if (expectedPlanHash && event.planHash !== expectedPlanHash) throw new Error("Journal plan hash mismatch");
    const previous = events.at(-1)?.eventHash ?? null;
    if (event.previousHash !== previous) throw new Error(`Broken journal hash chain at line ${index + 1}`);
    if (canonicalHash(withoutHash(event)) !== event.eventHash)
      throw new Error(`Invalid journal event hash at line ${index + 1}`);
    const priorForRun = [...events]
      .reverse()
      .find((candidate) => candidate.runId === event.runId && candidate.attempt === event.attempt);
    if (priorForRun && !nextStages[priorForRun.stage].includes(event.stage))
      throw new Error(`Invalid transition ${priorForRun.stage} -> ${event.stage}`);
    if (!priorForRun && event.stage !== "planned") throw new Error("An attempt must begin at planned");
    events.push(event);
  }
  return events;
}

export class ResumeJournal {
  readonly path: string;
  readonly planHash: string;
  #events: JournalEvent[] = [];
  private constructor(path: string, planHash: string) {
    this.path = path;
    this.planHash = planHash;
  }
  static async open(path: string, planHash: string): Promise<ResumeJournal> {
    const journal = new ResumeJournal(path, planHash);
    try {
      journal.#events = parseJournal(await readFile(path, "utf8"), planHash);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return journal;
  }
  events(): readonly JournalEvent[] {
    return this.#events;
  }
  completedRunIds(): Set<string> {
    return new Set(this.#events.filter((event) => event.stage === "complete").map((event) => event.runId));
  }
  nextAttempt(runId: string): number {
    return Math.max(0, ...this.#events.filter((event) => event.runId === runId).map((event) => event.attempt + 1));
  }
  nonterminalAttempts(): JournalEvent[] {
    const latest = new Map<string, JournalEvent>();
    for (const event of this.#events) latest.set(`${event.runId}\0${event.attempt}`, event);
    return [...latest.values()].filter((event) => event.stage !== "complete" && event.stage !== "failed");
  }
  canRetry(runId: string, maxRetries: number): boolean {
    const failures = this.#events.filter((event) => event.runId === runId && event.stage === "failed");
    // maxRetries is retries after the initial attempt; every terminalized crash/failure consumes one.
    return failures.length <= maxRetries && failures.at(-1)?.detail.retryable === true;
  }
  async append(
    runId: string,
    attempt: number,
    stage: RunStage,
    detail: JournalEvent["detail"] = {},
  ): Promise<JournalEvent> {
    const previous = this.#events.at(-1)?.eventHash ?? null;
    const event = {
      version: 1 as const,
      sequence: this.#events.length,
      runId,
      attempt,
      stage,
      previousHash: previous,
      planHash: this.planHash,
      detail,
    };
    const complete: JournalEvent = { ...event, eventHash: canonicalHash(event) };
    parseJournal(
      `${this.#events.map((item) => JSON.stringify(item)).join("\n")}\n${JSON.stringify(complete)}\n`,
      this.planHash,
    );
    const handle = await open(this.path, "a", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(complete)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    this.#events.push(complete);
    return complete;
  }
}
