import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { canonicalHash } from "./canonical.js";
import type { Experiment, ExperimentPlan } from "./schema.js";

export const APPROVAL_SCHEMA_VERSION = "context-vault-issue-36-approval/v1" as const;
export interface RealExecutionApproval {
  schemaVersion: typeof APPROVAL_SCHEMA_VERSION;
  issue: 36;
  planHash: string;
  provider: string;
  model: string;
  piCommit: string;
  piBinaryHash: string;
  piVersion: string;
  extensionCommit: string;
  extensionTreeHash: string;
  packageLockHash: string;
  budgets: { maxRequests: number; maxTokens: number; maxUsd: number };
  localEvaluatorAllowed: boolean;
  confirmationHash: string;
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`${label} has unknown field ${key}`);
  for (const key of keys) if (!(key in value)) throw new Error(`${label} is missing ${key}`);
}
function positive(value: unknown, label: string, integer = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || (integer && !Number.isSafeInteger(value)))
    throw new Error(`${label} must be a positive${integer ? " integer" : ""}`);
  return value;
}
export function parseRealExecutionApproval(value: unknown): RealExecutionApproval {
  const input = object(value, "approval");
  const keys = [
    "schemaVersion",
    "issue",
    "planHash",
    "provider",
    "model",
    "piCommit",
    "piBinaryHash",
    "piVersion",
    "extensionCommit",
    "extensionTreeHash",
    "packageLockHash",
    "budgets",
    "localEvaluatorAllowed",
    "confirmationHash",
  ] as const;
  exact(input, keys, "approval");
  if (input.schemaVersion !== APPROVAL_SCHEMA_VERSION || input.issue !== 36)
    throw new Error("Approval must be for issue #36");
  const budgets = object(input.budgets, "approval.budgets");
  exact(budgets, ["maxRequests", "maxTokens", "maxUsd"], "approval.budgets");
  const approval = {
    ...input,
    budgets: {
      maxRequests: positive(budgets.maxRequests, "maxRequests", true),
      maxTokens: positive(budgets.maxTokens, "maxTokens", true),
      maxUsd: positive(budgets.maxUsd, "maxUsd"),
    },
  } as unknown as RealExecutionApproval;
  for (const key of ["planHash", "piBinaryHash", "packageLockHash", "confirmationHash"] as const)
    if (!/^[a-f0-9]{64}$/u.test(approval[key])) throw new Error(`approval.${key} must be a SHA-256 hash`);
  for (const key of ["piCommit", "extensionCommit", "extensionTreeHash"] as const)
    if (!/^[a-f0-9]{40}$/u.test(approval[key])) throw new Error(`approval.${key} must be a full Git object ID`);
  if (
    typeof approval.provider !== "string" ||
    typeof approval.model !== "string" ||
    typeof approval.piVersion !== "string"
  )
    throw new Error("Approval provider/model/Pi version pins must be strings");
  if (typeof approval.localEvaluatorAllowed !== "boolean") throw new Error("localEvaluatorAllowed must be boolean");
  const { confirmationHash, ...confirmed } = approval;
  if (canonicalHash(confirmed) !== confirmationHash)
    throw new Error(
      "Approval confirmation hash mismatch; confirmation must be reproducible without an interactive prompt",
    );
  return approval;
}
export function validateApproval(approval: RealExecutionApproval, experiment: Experiment, plan: ExperimentPlan): void {
  const expected = {
    planHash: canonicalHash(plan),
    provider: experiment.provider,
    model: experiment.model,
    piCommit: experiment.piCommit,
    extensionCommit: experiment.extensionCommit,
    packageLockHash: experiment.packageLockHash,
  };
  for (const [key, value] of Object.entries(expected))
    if (approval[key as keyof RealExecutionApproval] !== value) throw new Error(`Approval ${key} pin mismatch`);
}
export async function sha256File(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}
