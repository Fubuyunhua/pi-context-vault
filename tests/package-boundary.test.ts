import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { EXTENSION_VERSION, REBUILD_MIGRATION_MESSAGE } from "../src/extension.js";
import { LEGACY_REPO_CONFIG_KEYS } from "../src/state/config.js";

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

it("keeps the concise English and Chinese README product contracts aligned", () => {
  const english = readFileSync("README.md", "utf8");
  const chinese = readFileSync("README.zh-CN.md", "utf8");
  for (const text of [english, chinese]) {
    for (const token of [
      "pi-context-vault",
      "pi-repo-context",
      "pi install git:github.com/Fubuyunhua/pi-context-vault@<tag-or-commit>",
      "context_vault_obs_get",
      "context_vault_obs_search",
      "context_vault_status",
      "/context-vault status",
      "/context-vault status-json",
      "/context-vault gc",
      "/context-vault doctor",
      "PLUGIN-DIAG-12-POSTFIX-03-RESULTS.md",
      "PLUGIN-DIAG-11-DETERMINISTIC-COMPARISON.md",
      "npm run test:pi",
      ...ACTIVE_CONFIG_KEYS,
    ]) {
      expect(text, `README missing ${token}`).toContain(token);
    }
    expect(text).not.toContain("context_vault_repo_map");
    expect(text).not.toContain("pi install git:github.com/Fubuyunhua/pi-repo-context");
  }
  expect(english).toContain("24 evaluable runs");
  expect(english).toContain("Across `VAULT+BOTH`, 4/4 pressure runs passed");
  expect(chinese).toContain("24 个有效运行");
  expect(chinese).toContain("`VAULT+BOTH` 的压力任务通过 4/4");
});

it("publishes only Vault-owned source and has no repository runtime dependency", () => {
  const manifest = JSON.parse(readFileSync("package.json", "utf8")) as {
    name?: string;
    version?: string;
    files?: string[];
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  };
  expect({ name: manifest.name, manifestVersion: manifest.version, runtimeVersion: EXTENSION_VERSION }).toEqual({
    name: "pi-context-vault",
    manifestVersion: "0.3.0",
    runtimeVersion: "0.3.0",
  });
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
    "@earendil-works/pi-coding-agent": "*",
    typebox: "*",
  });
  expect(manifest.devDependencies).toMatchObject({
    "@earendil-works/pi-coding-agent": "0.84.1",
    typebox: "1.3.7",
  });
  expect(manifest.scripts?.["test:pi"]).toBe("node scripts/pi-rpc-smoke.mjs");
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

it("keeps the final release record stable and the pre-split candidate frozen", () => {
  expect(() => readFileSync("docs/releases/v0.2.0.md", "utf8")).toThrow();
  const legacy = readFileSync("docs/legacy/releases/v0.2.0-rc.md", "utf8");
  expect(legacy).toContain("RELEASE CANDIDATE / UNTAGGED");
  expect(readFileSync("docs/legacy/README.md", "utf8")).toContain("releases/v0.2.0-rc.md");

  const release = readFileSync("docs/releases/v0.3.0.md", "utf8");
  expect(release).toMatch(/^# pi-context-vault v0\.3\.0$/mu);
  expect(release).toMatch(/^Release date: 2026-08-28$/mu);
  expect(release).toContain("records the approved v0.3.0 payload");
  expect(release).toContain("presence of the immutable `v0.3.0` tag in the upstream repository");
  expect(release).toContain("source of truth for release availability");
  expect(release).toContain("this document does not create or publish a tag, package, or release");
  expect(release).toContain("Verify that the reviewed immutable `v0.3.0` tag exists");
  expect(release).toContain("If that tag is not present, use a reviewed local checkout");
  expect(release).not.toContain("RELEASE CANDIDATE / UNPUBLISHED");
  expect(release).not.toContain("- [ ]");
  for (const token of [
    "0.3.0",
    "7062879b9a3bf3ccc491ea73824fd6abeb41a6a6",
    "6243694de90d1a557e3f5f3b18e7aa08dc0bd1f6",
    "0d6af86614d7550d67785d17a378e6f1865d8eca",
    "@earendil-works/pi-coding-agent` `0.84.1",
    "typebox` `1.3.7",
    "pi install git:github.com/Fubuyunhua/pi-context-vault@v0.3.0",
    "pi install git:github.com/Fubuyunhua/pi-repo-context@v0.1.0",
    "context_vault_repo_map",
    "repo_context_search",
    "repo_context_status",
    ".pi/context-vault.json",
    "extension ID/UI key",
    "Validation evidence and publication procedure",
    ...REBUILD_MIGRATION_MESSAGE.split("\n"),
    ...LEGACY_REPO_CONFIG_KEYS,
  ]) {
    expect(release, `release record missing ${token}`).toContain(token);
  }
});
