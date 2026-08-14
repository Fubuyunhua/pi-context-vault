import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const stateRoot = mkdtempSync(resolve(tmpdir(), "pi-context-vault-smoke-"));

try {
  execFileSync("pi", ["install", projectRoot], {
    env: { ...process.env, PI_CODING_AGENT_DIR: stateRoot },
    stdio: "pipe",
  });
  const packages = execFileSync("pi", ["list"], {
    encoding: "utf8",
    env: { ...process.env, PI_CODING_AGENT_DIR: stateRoot },
  });
  if (!packages.includes(projectRoot)) {
    throw new Error(`Pi did not list the installed local package. Output:\n${packages}`);
  }
} finally {
  rmSync(stateRoot, { recursive: true, force: true });
}
