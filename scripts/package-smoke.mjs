import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const stateRoot = mkdtempSync(resolve(tmpdir(), "pi-context-vault-smoke-"));
const piCli = resolve(projectRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
const npmCli = process.env.npm_execpath;
const installSpec = process.env.CONTEXT_VAULT_INSTALL_SPEC ?? projectRoot;

try {
  if (!npmCli) throw new Error("package smoke must run through npm so npm_execpath is available");
  const pack = JSON.parse(
    execFileSync(process.execPath, [npmCli, "pack", "--dry-run", "--json"], {
      cwd: projectRoot,
      encoding: "utf8",
    }),
  );
  const files = new Set(pack[0]?.files?.map((entry) => entry.path));
  for (const required of [
    "extensions/index.ts",
    "src/extension.ts",
    "README.md",
    "README.zh-CN.md",
    "deepResearch.md",
    "docs/specs/0001-v0.1.md",
    "docs/releases/v0.1.0.md",
    "LICENSE",
  ]) {
    if (!files.has(required)) throw new Error(`Release package is missing ${required}`);
  }

  execFileSync(process.execPath, [piCli, "install", installSpec], {
    env: { ...process.env, PI_CODING_AGENT_DIR: stateRoot },
    stdio: "pipe",
  });
  const packages = execFileSync(process.execPath, [piCli, "list"], {
    encoding: "utf8",
    env: { ...process.env, PI_CODING_AGENT_DIR: stateRoot },
  });
  if (!packages.includes(installSpec) && !packages.includes("pi-context-vault")) {
    throw new Error(`Pi did not list the installed package ${installSpec}. Output:\n${packages}`);
  }
} finally {
  rmSync(stateRoot, { recursive: true, force: true });
}
