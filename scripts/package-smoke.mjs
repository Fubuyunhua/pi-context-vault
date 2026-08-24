import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const smokeRoot = mkdtempSync(resolve(tmpdir(), "pi-context-vault-smoke-"));
const stateRoot = join(smokeRoot, "pi-state");
const installRoot = join(smokeRoot, "installed");
const assetsRoot = join(smokeRoot, "assets");
const piCli = resolve(projectRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
const npmCli = process.env.npm_execpath;
const run = (command, args, options = {}) =>
  execFileSync(command, args, { cwd: projectRoot, encoding: "utf8", stdio: "pipe", ...options });
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

try {
  if (!npmCli) throw new Error("package smoke must run through npm so npm_execpath is available");
  mkdirSync(stateRoot, { recursive: true });
  const pack = JSON.parse(run(process.execPath, [npmCli, "pack", "--json", "--pack-destination", smokeRoot]));
  const packed = pack[0];
  if (!packed?.filename) throw new Error("npm pack did not create a tarball");
  const tarball = join(smokeRoot, packed.filename);
  const files = new Set(packed.files?.map((entry) => entry.path));
  for (const required of [
    "extensions/index.ts",
    "src/extension.ts",
    "src/bench/cli.ts",
    "src/bench/runner.ts",
    "scripts/bench.mjs",
    "docs/specs/0014-ablation-harness.md",
    "README.md",
    "README.zh-CN.md",
    "deepResearch.md",
    "docs/specs/0001-v0.1.md",
    "docs/releases/v0.1.0.md",
    "docs/releases/v0.2.0.md",
    "LICENSE",
  ]) {
    if (!files.has(required)) throw new Error(`Release package is missing ${required}`);
  }

  mkdirSync(installRoot, { recursive: true });
  writeFileSync(join(installRoot, "package.json"), '{"name":"packed-smoke","private":true}\n');
  run(
    process.execPath,
    [
      npmCli,
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      "--legacy-peer-deps",
      tarball,
    ],
    { cwd: installRoot },
  );
  const packedRoot = join(installRoot, "node_modules", "pi-context-vault");
  const packedBench = join(packedRoot, "scripts", "bench.mjs");
  if (!readFileSync(join(packedRoot, "package.json"), "utf8").includes('"pi-context-vault"'))
    throw new Error("Packed artifact was not extracted into the isolated install");

  mkdirSync(assetsRoot, { recursive: true });
  const repository = join(assetsRoot, "repository");
  mkdirSync(repository);
  run("git", ["init", "--quiet"], { cwd: repository });
  run("git", ["config", "user.email", "fake@example.invalid"], { cwd: repository });
  run("git", ["config", "user.name", "Packed Smoke"], { cwd: repository });
  writeFileSync(join(repository, "base.txt"), "packed synthetic smoke\n");
  run("git", ["add", "base.txt"], { cwd: repository });
  run("git", ["commit", "--quiet", "-m", "base"], { cwd: repository });
  const baseCommit = run("git", ["rev-parse", "HEAD"], { cwd: repository }).trim();
  const prompt = "Packed synthetic mechanics smoke. No benchmark claim.\n";
  const promptPath = join(assetsRoot, "prompt.txt");
  writeFileSync(promptPath, prompt);
  const arms = {
    A: {
      id: "A",
      extensionEnabled: false,
      config: { archivePolicy: "off", repoMapEnabled: false, reductionEnabled: false, mapInjectionMode: "off" },
    },
    B: {
      id: "B",
      extensionEnabled: true,
      config: { archivePolicy: "all", repoMapEnabled: false, reductionEnabled: false, mapInjectionMode: "off" },
    },
    C: {
      id: "C",
      extensionEnabled: true,
      config: { archivePolicy: "all", repoMapEnabled: false, reductionEnabled: true, mapInjectionMode: "off" },
    },
    D: {
      id: "D",
      extensionEnabled: true,
      config: { archivePolicy: "off", repoMapEnabled: true, reductionEnabled: false, mapInjectionMode: "off" },
    },
    E: {
      id: "E",
      extensionEnabled: true,
      config: {
        archivePolicy: "all",
        repoMapEnabled: true,
        reductionEnabled: true,
        mapInjectionMode: "once-per-user-turn",
      },
    },
    F: {
      id: "F",
      extensionEnabled: true,
      config: {
        archivePolicy: "all",
        repoMapEnabled: true,
        reductionEnabled: true,
        mapInjectionMode: "every-llm-call",
      },
    },
  };
  const experiment = {
    schemaVersion: "context-vault-ablation-experiment/v1",
    experimentId: "packed-synthetic-no-provider",
    seed: 31,
    repeats: 6,
    provider: "fake",
    model: "fake-model",
    thinking: "off",
    tools: ["read"],
    piCommit: "synthetic",
    extensionCommit: "synthetic",
    packageLockHash: "synthetic",
    timeoutMs: 1000,
    maxInfrastructureRetries: 0,
    cacheSupport: "reported",
    extensionPath: join(packedRoot, "extensions", "index.ts"),
    allowedCredentialEnv: [],
    arms: Object.values(arms),
    publicationFields: [],
  };
  const task = {
    schemaVersion: "context-vault-ablation-task/v1",
    taskId: "packed-synthetic",
    assetHash: "synthetic-only",
    repository,
    baseCommit,
    promptPath,
    promptHash: sha256(prompt),
    language: "Synthetic",
    repoMapStratum: "mixed",
    evaluator: { kind: "command", command: "true", args: [], timeoutMs: 500 },
  };
  const experimentPath = join(assetsRoot, "experiment.json");
  const tasksPath = join(assetsRoot, "tasks.jsonl");
  const planPath = join(assetsRoot, "plan.json");
  const resultsRoot = join(assetsRoot, "results");
  writeFileSync(experimentPath, JSON.stringify(experiment));
  writeFileSync(tasksPath, `${JSON.stringify(task)}\n`);
  const fakePi = join(assetsRoot, "fake-pi.mjs");
  writeFileSync(
    fakePi,
    `#!/usr/bin/env node\nimport{mkdirSync,readFileSync,writeFileSync}from'node:fs';import{join}from'node:path';import{createHash}from'node:crypto';const a=process.argv.slice(2),s=a[a.indexOf('--session-dir')+1],e=a.includes('-e');mkdirSync(s,{recursive:true});writeFileSync(join(s,'session.jsonl'),JSON.stringify({type:'message',message:{role:'assistant',model:'fake-model',content:[],usage:{input:2,output:1,cacheRead:0,cacheWrite:0,totalTokens:3,cost:{total:0}}}}));if(e){const c=JSON.parse(readFileSync(join(process.cwd(),'.pi','context-vault.json'),'utf8')),m=c.mapInjectionMode==='off'?0:1,r=c.reductionEnabled?1:0,p=JSON.stringify({initialized:true,degraded:false,failures:[],components:{observations:{available:true},repoMap:{available:c.repoMapEnabled}},telemetry:{capsuleBuildCount:m,repoMapAutomaticQueryCount:m,reductionInvocationCount:r,reductionTriggeredCount:0,archiveAttemptCount:0,archiveSuccessCount:0,archiveFailureCount:0}}),h=createHash('sha256').update(p).digest('hex');process.stderr.write('@@CONTEXT_VAULT_TELEMETRY_V1@@ '+Buffer.byteLength(p)+' '+h+'\\n'+p+'\\n@@END_CONTEXT_VAULT_TELEMETRY@@\\n')}\n`,
  );
  chmodSync(fakePi, 0o755);
  const packedCli = (...args) => run(process.execPath, [packedBench, ...args], { cwd: packedRoot });
  packedCli("plan", "--experiment", experimentPath, "--tasks", tasksPath, "--output", planPath);
  packedCli(
    "run",
    "--experiment",
    experimentPath,
    "--tasks",
    tasksPath,
    "--plan",
    planPath,
    "--output",
    resultsRoot,
    "--fake-pi-command",
    fakePi,
  );
  packedCli("verify", "--results", resultsRoot);
  packedCli(
    "analyze",
    "--tasks",
    tasksPath,
    "--plan",
    planPath,
    "--results",
    resultsRoot,
    "--output",
    join(assetsRoot, "analysis.json"),
  );

  run(process.execPath, [piCli, "install", tarball], {
    env: { ...process.env, PI_CODING_AGENT_DIR: stateRoot },
  });
  const packages = run(process.execPath, [piCli, "list"], {
    env: { ...process.env, PI_CODING_AGENT_DIR: stateRoot },
  });
  if (!packages.includes("pi-context-vault"))
    throw new Error(`Pi did not list the packed package. Output:\n${packages}`);
  console.log("packed-artifact-plan-run-verify-analyze-ok");
} finally {
  rmSync(smokeRoot, { recursive: true, force: true });
}
