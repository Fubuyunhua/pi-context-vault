import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { APPROVAL_SCHEMA_VERSION, parseRealExecutionApproval, validateApproval } from "../src/bench/approval.js";
import { canonicalHash, canonicalJson } from "../src/bench/canonical.js";
import { scanDiskTree, scanVaultState } from "../src/bench/disk.js";
import { publicationRecord, verifyPublicationRecord, verifyPublicationValue } from "../src/bench/publication.js";
import { carryoverDiagnostics, createPlan, williamsSequences } from "../src/bench/schedule.js";
import {
  ABLATION_ARMS,
  EXPERIMENT_SCHEMA_VERSION,
  type Experiment,
  parseExperiment,
  parseRawAttempt,
  parseTask,
  type RawAttempt,
  TASK_SCHEMA_VERSION,
} from "../src/bench/schema.js";
import { extractTelemetryFrame, frameTelemetry } from "../src/bench/telemetry-frame.js";
import { aggregateSessionJsonl, recoverSessionJsonl } from "../src/bench/usage.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
function experiment(seed = 7): Experiment {
  return {
    schemaVersion: EXPERIMENT_SCHEMA_VERSION,
    experimentId: "synthetic",
    seed,
    repeats: 3,
    provider: "fake",
    model: "fake-model",
    thinking: "off",
    tools: ["read"],
    piCommit: "pi-commit",
    extensionCommit: "extension-commit",
    packageLockHash: "lock-hash",
    timeoutMs: 1_000,
    maxInfrastructureRetries: 1,
    cacheSupport: "reported",
    extensionPath: "./extensions/index.ts",
    allowedCredentialEnv: [],
    arms: Object.values(ABLATION_ARMS),
    publicationFields: [],
  };
}
function task(id: string, stratum: "lexical" | "semantic" | "mixed" = "lexical") {
  return {
    schemaVersion: TASK_SCHEMA_VERSION,
    taskId: id,
    assetHash: `asset-${id}`,
    repository: ".",
    baseCommit: "deadbeef",
    promptPath: `prompt-${id}`,
    promptHash: `prompt-hash-${id}`,
    language: "Python",
    repoMapStratum: stratum,
    evaluator: { kind: "command" as const, command: "true", args: [], timeoutMs: 100 },
  };
}

describe("ablation schemas, hashing, and schedule", () => {
  it("canonicalizes objects independent of key order and rejects non-finite values", () => {
    expect(canonicalJson({ z: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"z":1}');
    expect(canonicalHash({ a: 1, b: 2 })).toBe(canonicalHash({ b: 2, a: 1 }));
    expect(() => canonicalJson({ value: Number.NaN })).toThrow("non-finite");
  });
  it("strictly validates versions and the exact A-F treatment contract", async () => {
    const snapshot = JSON.parse(await readFile(join(process.cwd(), "tests/fixtures/bench/arm-snapshots.json"), "utf8"));
    expect(snapshot.label).toContain("NOT BENCHMARK EVIDENCE");
    expect(snapshot.arms).toEqual(ABLATION_ARMS);
    expect(parseExperiment(experiment()).arms).toEqual(Object.values(ABLATION_ARMS));
    expect(() => parseExperiment({ ...experiment(), schemaVersion: "v2" })).toThrow("Unsupported experiment schema");
    const widened = structuredClone(experiment());
    widened.arms[1].config.repoMapEnabled = true;
    expect(() => parseExperiment(widened)).toThrow("isolation contract");
    expect(parseTask(task("corpus/one"))).toMatchObject({ taskId: "corpus/one", repoMapStratum: "lexical" });
    expect(() => parseTask({ ...task("one"), transcript: "not allowed" })).toThrow("unknown field");
    for (const taskId of [
      "/home/alice/corpus-task",
      "C:\\Users\\alice\\corpus-task",
      "file:///etc/passwd",
      "ghp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ",
      "token-private-key",
      "corpus/task\nnext",
    ])
      expect(() => parseTask({ ...task("one"), taskId })).toThrow("taskId");
  });
  it("builds deterministic balanced Williams blocks and immutable run IDs", () => {
    const rows = williamsSequences();
    expect(rows).toHaveLength(6);
    expect(rows[0]).toEqual(["A", "B", "F", "C", "E", "D"]);
    const plan = createPlan(experiment(), [task("one"), task("two", "semantic")]);
    expect(plan).toEqual(createPlan(experiment(), [task("one"), task("two", "semantic")]));
    expect(plan.runs).toHaveLength(36);
    for (const block of [0, 1, 2, 3, 4, 5])
      expect(
        plan.runs
          .filter((run) => run.blockIndex === block)
          .map((run) => run.arm)
          .sort(),
      ).toEqual(["A", "B", "C", "D", "E", "F"]);
    expect(createPlan(experiment(8), [task("one"), task("two")]).runs.map((run) => run.runId)).not.toEqual(
      plan.runs.map((run) => run.runId),
    );
    expect(carryoverDiagnostics(rows)).toMatchObject({ min: 1, max: 1, complete: true, claim: "exactly-balanced" });
    expect(carryoverDiagnostics(rows.slice(0, 2))).toMatchObject({
      complete: false,
      claim: "incomplete-no-balance-claim",
    });
    expect(() => createPlan({ ...experiment(), repeats: 1 }, [task("one")])).toThrow("multiple of six");
    expect(() => createPlan(experiment(), [task("duplicate"), task("duplicate")])).toThrow("Duplicate taskId");
  });
  it("validates immutable noninteractive issue-36 approval and hard budgets", () => {
    const approvedExperiment = { ...experiment(), repeats: 6 };
    const plan = createPlan(approvedExperiment, [task("one")]);
    const unsigned = {
      schemaVersion: APPROVAL_SCHEMA_VERSION,
      issue: 36 as const,
      planHash: canonicalHash(plan),
      provider: "fake",
      model: "fake-model",
      piCommit: "a".repeat(40),
      piBinaryHash: "b".repeat(64),
      piVersion: "1.0.0",
      extensionCommit: "c".repeat(40),
      extensionTreeHash: "d".repeat(40),
      packageLockHash: "e".repeat(64),
      budgets: { maxRequests: 1, maxTokens: 1, maxUsd: 0.01 },
      localEvaluatorAllowed: true,
    };
    const approval = parseRealExecutionApproval({ ...unsigned, confirmationHash: canonicalHash(unsigned) });
    expect(() => validateApproval(approval, approvedExperiment, plan)).toThrow("piCommit pin mismatch");
    expect(() => parseRealExecutionApproval({ ...unsigned, confirmationHash: "0".repeat(64) })).toThrow(
      "confirmation hash",
    );
    expect(() =>
      parseRealExecutionApproval({
        ...unsigned,
        budgets: { ...unsigned.budgets, maxRequests: 0 },
        confirmationHash: "0".repeat(64),
      }),
    ).toThrow("positive");
  });
  it("rejects credential-bearing argv sources and reserved execution environment names", () => {
    expect(() => parseTask({ ...task("one"), repository: "https://user:pass@example.invalid/repo" })).toThrow(
      "userinfo",
    );
    for (const args of [
      ["token=bad"],
      ["--api-key", "value"],
      ["--token", "value"],
      ["--authorization", "value"],
      ["ghp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ"],
      ["sk-proj-abcdefghijklmnopqrstuvwxyz0123456789"],
      ["AKIAIOSFODNN7EXAMPLE"],
      ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123"],
    ])
      expect(() =>
        parseTask({ ...task("one"), evaluator: { kind: "command", command: "true", args, timeoutMs: 1 } }),
      ).toThrow("credential");
    for (const name of ["NODE_OPTIONS", "GIT_CONFIG_GLOBAL", "PYTHONWARNINGS", "AWS_CONFIG_FILE"])
      expect(() => parseExperiment({ ...experiment(), allowedCredentialEnv: [name] })).toThrow("reserved");
    expect(() => parseExperiment({ ...experiment(), provider: "api_key=bad" })).toThrow("credential");
  });
});

describe("Pi parser, telemetry frame, disk, and publication", () => {
  it("aggregates Pi assistant and auxiliary usage with null cache semantics", async () => {
    const fixture = await readFile(join(process.cwd(), "tests/fixtures/bench/pi-session.golden.jsonl"), "utf8");
    const result = aggregateSessionJsonl(fixture, "reported");
    expect(result).toMatchObject({
      mainAssistantCalls: 2,
      auxiliaryUsageRecords: 2,
      toolCalls: 1,
      toolResults: 1,
      totals: { input: 17, output: 5, cacheRead: 12, cacheWrite: 3, totalTokens: 37, cost: 0.16 },
      cache: { promptTokens: 32, uncachedPrompt: 20, hitRatio: 0.375 },
    });
    expect(aggregateSessionJsonl(fixture, "unknown").cache.hitRatio).toBeNull();
    expect(aggregateSessionJsonl("", "reported").cache.hitRatio).toBeNull();
    const noCacheFields = JSON.stringify({
      type: "message",
      message: { role: "assistant", model: "fake", usage: { input: 2, output: 1, totalTokens: 3 } },
    });
    expect(aggregateSessionJsonl(noCacheFields, "reported").cache).toMatchObject({ observed: false, hitRatio: null });
    const validUsage = JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        model: "fake-model",
        content: [],
        usage: { input: 4, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 5 },
      },
    });
    for (const corrupt of ["{", "null", "42", '"scalar"', "[]", "{}", '{"type":"message","message":null}'])
      expect(() => aggregateSessionJsonl(`${corrupt}\n${validUsage}`, "reported")).not.toThrow();
    expect(aggregateSessionJsonl(`null\n[]\n{}\n${validUsage}\n42`, "reported").totals.totalTokens).toBe(5);
    expect(recoverSessionJsonl(`null\n[]\n{}\n${validUsage}\n42`, "reported")).toMatchObject({
      malformed: true,
      usage: { totals: { totalTokens: 5 } },
    });
    const secretLabels = aggregateSessionJsonl(
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          model: "ghp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ",
          content: [{ type: "toolCall", name: "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789" }],
          usage: { input: 1, output: 1, totalTokens: 2 },
        },
      }),
      "reported",
    );
    expect(secretLabels.responseModels).toEqual([]);
    expect(secretLabels.toolNameCounts).toEqual({ redacted: 1 });
    expect(JSON.stringify(secretLabels)).not.toContain("ghp_");
    expect(JSON.stringify(secretLabels)).not.toContain("sk-proj-");
  });
  it("extracts one hash/length framed telemetry snapshot and rejects tampering", () => {
    const frame = frameTelemetry({ telemetry: { reductionInvocationCount: 2 } });
    expect(extractTelemetryFrame(`noise\n${frame}\nnoise`)).toEqual({ telemetry: { reductionInvocationCount: 2 } });
    expect(() => extractTelemetryFrame(frame.replace("2", "3"))).toThrow();
    expect(() => extractTelemetryFrame(`${frame}\n${frame}`)).toThrow("exactly one");
  });
  it("does not follow symlinks while scanning", async () => {
    const root = await mkdtemp(join(tmpdir(), "bench-disk-"));
    roots.push(root);
    const tree = join(root, "tree");
    const outside = join(root, "outside");
    await mkdir(tree);
    await mkdir(outside);
    await writeFile(join(tree, "inside"), "123");
    await writeFile(join(outside, "secret"), "planted secret source text");
    await symlink(outside, join(tree, "escape"), "dir");
    const snapshot = await scanDiskTree(tree);
    expect(snapshot.files).toBe(1);
    expect(snapshot.logicalBytes).toBe(3);
    expect(snapshot.symlinksSkipped).toBe(1);
  });
  it("counts deduplicated artifacts, append records, live records, and tombstones", async () => {
    const root = await mkdtemp(join(tmpdir(), "bench-vault-disk-"));
    roots.push(root);
    await mkdir(join(root, "artifacts"));
    await mkdir(join(root, "metadata"));
    await writeFile(join(root, "artifacts", "shared-blob"), "same bytes");
    const metadata = [
      { schemaVersion: 2, recordType: "upsert", metadata: { observationId: "one", artifactId: "shared" } },
      { schemaVersion: 2, recordType: "upsert", metadata: { observationId: "two", artifactId: "shared" } },
      { schemaVersion: 2, recordType: "tombstone", observationId: "one", artifactId: "shared" },
    ];
    await writeFile(
      join(root, "metadata", "observations.jsonl"),
      `${metadata.map((item) => JSON.stringify(item)).join("\n")}\n`,
    );
    expect((await scanVaultState(root)).observations).toMatchObject({
      uniqueArtifacts: 1,
      uniqueLiveArtifacts: 1,
      liveRecords: 1,
      logRecords: 3,
      tombstones: 1,
    });
  });
  it("projects a strict publication allowlist and rejects secrets, paths, source, and unknown fields", () => {
    const raw = {
      schemaVersion: "context-vault-ablation-attempt/v1",
      experimentHash: "x",
      planHash: "p",
      runId: "r",
      attempt: 0,
      taskId: "t",
      arm: "E",
      repeat: 0,
      scheduleIndex: 0,
      status: "complete",
      requestedProvider: "fake",
      requestedModel: "fake",
      responseModels: ["fake"],
      integrity: { modelDrift: false },
      timingMs: { provisioning: 0, agent: 0, evaluation: 0, total: 0 },
      usage: aggregateSessionJsonl("", "reported"),
      telemetry: null,
      disk: {
        total: { files: 0, directories: 0, symlinksSkipped: 0, logicalBytes: 0, allocatedBytes: 0 },
        repoMap: {
          files: 0,
          directories: 0,
          symlinksSkipped: 0,
          logicalBytes: 0,
          allocatedBytes: 0,
          generationCount: 0,
          generationLogicalBytes: 0,
          generationAllocatedBytes: 0,
        },
        observations: {
          files: 0,
          directories: 0,
          symlinksSkipped: 0,
          logicalBytes: 0,
          allocatedBytes: 0,
          uniqueArtifacts: 0,
          uniqueLiveArtifacts: 0,
          liveRecords: 0,
          logRecords: 0,
          tombstones: 0,
          metadataBytes: 0,
        },
      },
      evaluator: { status: "not-run", passed: false, durationMs: 0 },
      treatmentDose: {
        toolCalls: 0,
        explicitMapQueries: 0,
        capsuleBuilds: 0,
        automaticMapQueries: 0,
        reductionInvocations: 0,
        reductionTriggered: 0,
        archiveAttempts: 0,
        archiveSuccesses: 0,
        archiveFailures: 0,
      },
      finalDiffHash: null,
      evaluatorOutputHash: null,
      failure: { stage: "agent", code: "raw output" },
    } as unknown as RawAttempt;
    expect(publicationRecord(raw)).not.toHaveProperty("failure");
    expect(() => verifyPublicationRecord({ transcript: "hello" })).toThrow("not allowlisted");
    for (const planted of [
      "api_key=PLANTED_SECRET",
      "/home/alice/private",
      "PLANTED_SOURCE function code() {}",
      "PLANTED_PATH",
      "C:\\Users\\alice\\private.txt",
      "/root/private.txt",
      "/usr/local/private",
      "/workspace/source",
      "/run/secrets/x",
      "/proc/self/environ",
      "\\\\server\\share\\private",
      "/",
      "///server/share/private",
      "//server/share/private",
      "failure:/home/alice/private",
      "file:///etc/passwd",
      "file://server/share/private",
      "\\\\?\\C:\\private.txt",
      "\\\\.\\PhysicalDrive0",
      "text embeds /home/alice/private here",
      "ghp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ",
      "github_pat_abcdefghijklmnopqrstuvwxyz_0123456789",
      "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789",
      "AKIAIOSFODNN7EXAMPLE",
      "ASIAIOSFODNN7EXAMPLE",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123",
      "-----BEGIN OPENSSH PRIVATE KEY-----",
    ])
      expect(() => verifyPublicationValue(planted)).toThrow();
    expect(() => verifyPublicationValue({ "api_key=PLANTED_SECRET": 1 })).toThrow();
    expect(() => verifyPublicationValue({ token: "opaque" })).toThrow();
    expect(() => verifyPublicationRecord({ ...publicationRecord(raw), usage: { unexpected: 1 } })).toThrow(
      "unknown field",
    );
    expect(publicationRecord(raw).treatmentDose).toMatchObject({
      reductionTriggered: 0,
      archiveSuccesses: 0,
      archiveFailures: 0,
    });
    const finiteRaw = { ...raw, arm: "A", failure: undefined } as unknown as Record<string, unknown>;
    expect(parseRawAttempt(finiteRaw)).toMatchObject({ arm: "A", status: "complete" });
    for (const mutation of [
      {
        ...finiteRaw,
        usage: { ...(finiteRaw.usage as Record<string, unknown>), transcript: "must not survive" },
      },
      {
        ...finiteRaw,
        usage: { ...(finiteRaw.usage as Record<string, unknown>), totals: { totalTokens: Number.NaN, cost: 0 } },
      },
      {
        ...finiteRaw,
        usage: {
          ...(finiteRaw.usage as Record<string, unknown>),
          records: [{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, secret: "x" }],
        },
      },
      { ...finiteRaw, evaluator: { status: "passed", passed: true, durationMs: 1, output: "secret" } },
      { ...finiteRaw, evaluator: { status: "passed", passed: true, durationMs: Number.POSITIVE_INFINITY } },
      {
        ...finiteRaw,
        disk: {
          ...(finiteRaw.disk as Record<string, unknown>),
          total: {
            ...((finiteRaw.disk as Record<string, Record<string, unknown>>).total ?? {}),
            hostPath: "/tmp/x",
          },
        },
      },
      { ...finiteRaw, disk: { ...(finiteRaw.disk as Record<string, unknown>), total: { files: Number.NaN } } },
      {
        ...finiteRaw,
        treatmentDose: {
          ...(finiteRaw.treatmentDose as Record<string, unknown>),
          archiveAttempts: Number.NaN,
        },
      },
      {
        ...finiteRaw,
        telemetry: {
          telemetry: {
            capsuleBuildCount: 1,
            repoMapAutomaticQueryCount: 1,
            reductionInvocationCount: 1,
            reductionTriggeredCount: 0,
            archiveAttemptCount: 0,
            archiveSuccessCount: 0,
            archiveFailureCount: 0,
            secret: "must not survive",
          },
          lifecycle: {
            initialized: true,
            degraded: false,
            failureCount: 0,
            observationsAvailable: true,
            repoMapAvailable: true,
          },
        },
      },
    ])
      expect(() => parseRawAttempt(mutation)).toThrow();
    expect(() =>
      parseRawAttempt({
        ...finiteRaw,
        arm: "D",
        treatmentDose: {
          ...(finiteRaw.treatmentDose as Record<string, unknown>),
          archiveAttempts: 1,
        },
      }),
    ).toThrow("forbids archive");
    for (const [arm, dose] of [
      ["C", { reductionInvocations: 0 }],
      ["E", { reductionInvocations: 1, capsuleBuilds: 0, automaticMapQueries: 1 }],
      ["F", { reductionInvocations: 1, capsuleBuilds: 1, automaticMapQueries: 0 }],
    ] as const)
      expect(() =>
        parseRawAttempt({
          ...finiteRaw,
          arm,
          treatmentDose: { ...(finiteRaw.treatmentDose as Record<string, unknown>), ...dose },
        }),
      ).toThrow("requires");
    expect(() =>
      parseRawAttempt({
        ...finiteRaw,
        arm: "D",
        treatmentDose: { ...(finiteRaw.treatmentDose as Record<string, unknown>), explicitMapQueries: 0 },
      }),
    ).not.toThrow();
    expect(() => parseRawAttempt({ ...finiteRaw, taskId: "corpus/relative-task" })).not.toThrow();
    for (const taskId of [
      "/workspace/private-task",
      "\\\\server\\share\\private-task",
      "file://server/share/task",
      "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789",
      "private_key_material",
      "task\u0000suffix",
    ])
      expect(() => parseRawAttempt({ ...finiteRaw, taskId })).toThrow("taskId");
    for (const mutation of [
      {
        ...finiteRaw,
        arm: "C",
        status: "task-failed",
        evaluator: { status: "test-failed", passed: false },
        treatmentDose: { ...(finiteRaw.treatmentDose as Record<string, unknown>), reductionInvocations: 0 },
      },
      {
        ...finiteRaw,
        arm: "E",
        status: "infrastructure-failed",
        failure: { stage: "evaluator", code: "evaluator-timed-out" },
        evaluator: { status: "timed-out", passed: false },
        treatmentDose: {
          ...(finiteRaw.treatmentDose as Record<string, unknown>),
          reductionInvocations: 1,
          capsuleBuilds: 0,
          automaticMapQueries: 0,
        },
      },
    ])
      expect(() => parseRawAttempt(mutation)).toThrow("requires active");
  });
});
