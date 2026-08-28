import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

const VAULT_VERSION = "0.3.0";
const PI_VERSION = "0.84.1";
const TYPEBOX_VERSION = "1.3.7";
const REBUILD_MESSAGE =
  "Repository rebuild has moved to pi-repo-context.\nInstall pi-repo-context and use /repo-context rebuild.";
const root = resolve(import.meta.dirname, "..");
const scratch = mkdtempSync(join(tmpdir(), "pi-context-vault-rpc-"));
const home = join(scratch, "home");
const agentDir = join(scratch, "agent");
const temporaryDir = join(scratch, "tmp");
const packDir = join(scratch, "pack");
const installDir = join(scratch, "install");
const project = join(scratch, "project");
const npmCli = process.env.npm_execpath;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isolatedEnvironment(extra = {}) {
  const env = {
    HOME: home,
    LANG: process.env.LANG ?? "C.UTF-8",
    NO_COLOR: "1",
    PATH: process.env.PATH ?? "",
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1",
    TEMP: temporaryDir,
    TMP: temporaryDir,
    TMPDIR: temporaryDir,
    ...extra,
  };
  for (const key of ["ComSpec", "PATHEXT", "SystemRoot", "WINDIR"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function runNode(script, args, cwd = root, env = isolatedEnvironment()) {
  return execFileSync(process.execPath, [script, ...args], {
    cwd,
    encoding: "utf8",
    env,
    stdio: "pipe",
  });
}

function assertDependencyAbsent(tree, forbidden) {
  const visit = (node, ancestry) => {
    for (const [name, dependency] of Object.entries(node?.dependencies ?? {})) {
      assert(name !== forbidden, `dependency tree contains ${forbidden} at ${ancestry}>${name}`);
      visit(dependency, `${ancestry}>${name}`);
    }
  };
  visit(tree, "root");
}

async function snapshot(rootPath) {
  const rows = [];
  async function visit(path) {
    if (!existsSync(path)) return;
    for (const name of (await readdir(path)).sort()) {
      const child = join(path, name);
      const info = await stat(child);
      if (info.isDirectory()) {
        rows.push(`${relative(rootPath, child)}/`);
        await visit(child);
      } else {
        rows.push(
          `${relative(rootPath, child)}\0${createHash("sha256")
            .update(await readFile(child))
            .digest("hex")}`,
        );
      }
    }
  }
  await visit(rootPath);
  return rows;
}

async function runRpc(piCli, extension) {
  const child = spawn(
    process.execPath,
    [
      piCli,
      "--mode",
      "rpc",
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--offline",
      "--no-builtin-tools",
      "--extension",
      extension,
    ],
    {
      cwd: project,
      env: isolatedEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  let stdout = "";
  let stderr = "";
  let protocolError;
  const records = [];
  const pending = new Map();

  const failPending = (error) => {
    protocolError ??= error;
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    pending.clear();
  };

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
    for (;;) {
      const end = stdout.indexOf("\n");
      if (end < 0) break;
      const line = stdout.slice(0, end);
      stdout = stdout.slice(end + 1);
      if (!line) continue;
      try {
        const value = JSON.parse(line);
        records.push(value);
        const request = value.type === "response" && value.id ? pending.get(value.id) : undefined;
        if (request) {
          clearTimeout(request.timer);
          pending.delete(value.id);
          request.resolve(value);
        }
      } catch (error) {
        failPending(new Error(`non-JSON Pi RPC stdout: ${line}`, { cause: error }));
        child.kill("SIGKILL");
        break;
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  child.on("error", failPending);

  const send = (value) =>
    new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        pending.delete(value.id);
        reject(new Error(`Pi RPC timeout: ${value.id}`));
      }, 20_000);
      pending.set(value.id, { reject, resolve: resolvePromise, timer });
      child.stdin.write(`${JSON.stringify(value)}\n`);
    });

  const successful = async (value) => {
    const response = await send(value);
    assert(response.success, `Pi RPC failure: ${JSON.stringify(response)}`);
    return response;
  };

  const stateResponse = await successful({ id: "state", type: "get_state" });
  assert(stateResponse.data?.model?.id === "unknown", "Pi RPC unexpectedly selected a model");
  const commandsResponse = await successful({ id: "commands", type: "get_commands" });
  await successful({ id: "status", type: "prompt", message: "/context-vault status" });
  await successful({ id: "doctor", type: "prompt", message: "/context-vault doctor" });

  const vaultRoot = join(agentDir, "context-vault");
  const vaultState = (await readdir(vaultRoot)).sort();
  assert(
    JSON.stringify(vaultState) === JSON.stringify(["projects"]),
    `unexpected Vault state root: ${JSON.stringify(vaultState)}`,
  );
  const projectsRoot = join(vaultRoot, "projects");
  const projectIds = (await readdir(projectsRoot)).sort();
  assert(projectIds.length === 1, `expected one Vault project state, found ${JSON.stringify(projectIds)}`);
  const ownedState = (await readdir(join(projectsRoot, projectIds[0]))).sort();
  assert(
    JSON.stringify(ownedState) === JSON.stringify(["artifacts", "metadata"]),
    `unexpected Vault-owned state: ${JSON.stringify(ownedState)}`,
  );
  const repoStateRoot = join(agentDir, "pi-repo-context");
  assert(!existsSync(repoStateRoot), "Repo Context state was created before rebuild");
  assert(!existsSync(join(projectsRoot, projectIds[0], "repo-map")), "legacy Repo Map state was created");

  const beforeRebuild = await snapshot(vaultRoot);
  await successful({ id: "rebuild", type: "prompt", message: "/context-vault rebuild" });
  const afterRebuild = await snapshot(vaultRoot);
  assert(JSON.stringify(afterRebuild) === JSON.stringify(beforeRebuild), "inert rebuild mutated Vault state");
  assert(!existsSync(repoStateRoot), "Repo Context state was created by rebuild");

  child.stdin.end();
  const exit = await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Pi RPC shutdown timeout"));
    }, 20_000);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal });
    });
  });

  if (protocolError) throw protocolError;
  assert(pending.size === 0, `unresolved Pi RPC requests: ${JSON.stringify([...pending.keys()])}`);
  assert(stdout === "", `partial Pi RPC stdout: ${stdout}`);
  assert(stderr.trim() === "", `Pi RPC stderr was not empty: ${stderr}`);
  assert(exit.code === 0 && exit.signal === null, `unclean Pi RPC exit: ${JSON.stringify(exit)}`);

  const commands = commandsResponse.data?.commands ?? [];
  const ownedCommands = commands.filter((command) => command.sourceInfo?.path === extension);
  assert(
    JSON.stringify(ownedCommands.map((command) => command.name).sort()) === JSON.stringify(["context-vault"]),
    `unexpected Vault command ownership: ${JSON.stringify(ownedCommands)}`,
  );
  assert(
    commands.filter((command) => command.name === "context-vault").length === 1,
    "context-vault command does not have exactly one owner",
  );
  assert(!commands.some((command) => command.name === "repo-context"), "Repo Context command was registered");

  const notifications = records.filter(
    (record) => record.type === "extension_ui_request" && record.method === "notify",
  );
  assert(notifications.length === 3, `unexpected command notifications: ${JSON.stringify(notifications)}`);
  const status = JSON.parse(notifications[0].message);
  assert(
    status.extension?.id === "context-vault" && status.extension?.version === VAULT_VERSION,
    `unexpected status identity: ${notifications[0].message}`,
  );
  assert(
    status.initialized === true && status.degraded === false,
    `unhealthy Vault status: ${notifications[0].message}`,
  );
  assert(
    JSON.stringify(Object.keys(status.components ?? {}).sort()) === JSON.stringify(["observations"]),
    `status is not observation-only: ${notifications[0].message}`,
  );
  assert(
    status.project?.stateRoot === join(projectsRoot, projectIds[0]),
    `status reported an unexpected state root: ${notifications[0].message}`,
  );
  const doctor = JSON.parse(notifications[1].message);
  assert(
    doctor.status === "healthy" && doctor.stateOutsideProjectTree === true,
    `unhealthy Vault doctor: ${notifications[1].message}`,
  );
  assert(
    notifications[2].message === REBUILD_MESSAGE && notifications[2].notifyType === "warning",
    `unexpected rebuild response: ${JSON.stringify(notifications[2])}`,
  );

  const errors = records.filter(
    (record) => record.type === "extension_error" || JSON.stringify(record).includes('"extension_error"'),
  );
  assert(errors.length === 0, `extension_error records: ${JSON.stringify(errors)}`);
  const statuses = records.filter((record) => record.type === "extension_ui_request" && record.method === "setStatus");
  assert(
    statuses.some((record) => record.statusKey === "context-vault" && record.statusText === `vault v${VAULT_VERSION}`),
    "Vault startup status was not owned or versioned correctly",
  );
  assert(
    statuses.some((record) => record.statusKey === "context-vault" && record.statusText === undefined),
    "Vault did not clear its status during shutdown",
  );
}

try {
  assert(process.platform === "linux", "real Pi RPC smoke is supported only on Linux");
  assert(process.versions.node.split(".")[0] === "24", "real Pi RPC smoke requires Node.js 24");
  assert(npmCli, "real Pi RPC smoke must run through npm");
  for (const path of [home, agentDir, temporaryDir, packDir, installDir, join(project, ".pi")]) {
    mkdirSync(path, { recursive: true });
  }
  writeFileSync(join(project, ".pi", "context-vault.json"), "{}\n");

  const packed = JSON.parse(
    runNode(npmCli, ["pack", "--json", "--pack-destination", packDir], root, isolatedEnvironment()),
  )[0];
  assert(packed.name === "pi-context-vault" && packed.version === VAULT_VERSION, "packed Vault identity mismatch");
  const archive = join(packDir, packed.filename);
  writeFileSync(
    join(installDir, "package.json"),
    `${JSON.stringify(
      {
        name: "pi-context-vault-rpc-smoke",
        private: true,
        dependencies: {
          "@earendil-works/pi-coding-agent": PI_VERSION,
          "pi-context-vault": `file:${archive}`,
          typebox: TYPEBOX_VERSION,
        },
      },
      null,
      2,
    )}\n`,
  );
  runNode(
    npmCli,
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock"],
    installDir,
    isolatedEnvironment(),
  );

  const directDependencies = Object.keys(
    JSON.parse(readFileSync(join(installDir, "package.json"), "utf8")).dependencies,
  ).sort();
  assert(
    JSON.stringify(directDependencies) ===
      JSON.stringify(["@earendil-works/pi-coding-agent", "pi-context-vault", "typebox"]),
    `unexpected direct dependencies: ${JSON.stringify(directDependencies)}`,
  );
  const dependencyTree = JSON.parse(runNode(npmCli, ["ls", "--all", "--json"], installDir, isolatedEnvironment()));
  assertDependencyAbsent(dependencyTree, "pi-repo-context");
  assert(!existsSync(join(installDir, "node_modules", "pi-repo-context")), "Repo Context sibling was installed");

  const installed = (name) =>
    JSON.parse(readFileSync(join(installDir, "node_modules", ...name.split("/"), "package.json"), "utf8"));
  assert(installed("pi-context-vault").version === VAULT_VERSION, "installed Vault version mismatch");
  assert(installed("@earendil-works/pi-coding-agent").version === PI_VERSION, "installed Pi version mismatch");
  assert(installed("typebox").version === TYPEBOX_VERSION, "installed typebox version mismatch");

  const piCli = join(installDir, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
  const piVersion = runNode(piCli, ["--version"], project, isolatedEnvironment()).trim();
  assert(piVersion === PI_VERSION, `unexpected real Pi version: ${piVersion}`);
  const extension = join(installDir, "node_modules", "pi-context-vault", "extensions", "index.ts");
  await runRpc(piCli, extension);
  console.log("real-pi-rpc-vault-only-ok");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
