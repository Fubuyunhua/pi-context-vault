import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { REBUILD_MIGRATION_MESSAGE } from "../src/extension.js";
import { LEGACY_REPO_CONFIG_KEYS, LEGACY_REPO_CONFIG_WARNING } from "../src/state/config.js";

const ACTIVE_CONFIG_KEYS = [
  "reductionEnabled",
  "archivePolicy",
  "archiveMinBytes",
  "replacementThresholdBytes",
  "archiveErrorsAlways",
  "archiveThresholdBytes",
  "receiptMaxBytes",
  "hotObservationCount",
  "softContextRatio",
  "targetContextRatio",
  "projectQuotaBytes",
  "retentionDays",
] as const;

it("keeps English and Chinese README migration and Vault surfaces aligned", () => {
  const english = readFileSync("README.md", "utf8");
  const chinese = readFileSync("README.zh-CN.md", "utf8");
  for (const text of [english, chinese]) {
    for (const token of [
      "pi-repo-context",
      "repo_context_search",
      "context_vault_repo_map",
      "0.1.x",
      "0.2.0",
      "S03",
      "bench",
      ".pi/repo-context.json",
      "context_vault_obs_get",
      "context_vault_obs_search",
      "context_vault_status",
      "/context-vault status",
      "/context-vault status-json",
      "/context-vault gc",
      "/context-vault doctor",
      LEGACY_REPO_CONFIG_WARNING,
      ...REBUILD_MIGRATION_MESSAGE.split("\n"),
      ...ACTIVE_CONFIG_KEYS,
      ...LEGACY_REPO_CONFIG_KEYS,
    ]) {
      expect(text, `README missing ${token}`).toContain(token);
    }
  }
});

it("publishes only Vault-owned source and has no repository runtime dependency", () => {
  const manifest = JSON.parse(readFileSync("package.json", "utf8")) as {
    files?: string[];
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  };
  expect(manifest.dependencies ?? {}).toEqual({});
  expect(manifest.files).toEqual([
    "extensions/index.ts",
    "src/artifacts/redaction.ts",
    "src/artifacts/store.ts",
    "src/context/reduction.ts",
    "src/observations/virtualization.ts",
    "src/state/atomic.ts",
    "src/state/config.ts",
    "src/state/project-state.ts",
    "src/extension.ts",
    "src/telemetry.ts",
    "src/telemetry-frame.ts",
    "README.md",
    "README.zh-CN.md",
    "LICENSE",
  ]);
  expect(manifest.peerDependencies).toEqual({
    "@earendil-works/pi-coding-agent": "0.84.1",
    typebox: "1.3.7",
  });
  expect(manifest.devDependencies).toMatchObject(manifest.peerDependencies as Record<string, string>);
  expect(manifest.scripts).not.toHaveProperty("test:watcher");
  expect(manifest.scripts).not.toHaveProperty("bench");

  const extension = readFileSync("src/extension.ts", "utf8");
  expect(extension).toContain('description: "Context Vault status|status-json|rebuild|gc|doctor"');
  for (const forbidden of [
    "RepoMapRuntime",
    "RepositoryGraph",
    "FrozenMapCapsule",
    "context_vault_repo_map",
    "before_agent_start",
  ]) {
    expect(extension).not.toContain(forbidden);
  }
});

it("keeps the pre-split mixed release candidate frozen outside active release docs", () => {
  expect(() => readFileSync("docs/releases/v0.2.0.md", "utf8")).toThrow();
  const legacy = readFileSync("docs/legacy/releases/v0.2.0-rc.md", "utf8");
  expect(legacy).toContain("RELEASE CANDIDATE / UNTAGGED");
  expect(readFileSync("docs/legacy/README.md", "utf8")).toContain("releases/v0.2.0-rc.md");
});
