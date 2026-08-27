import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../src/artifacts/store.js";
import { Telemetry } from "../src/telemetry.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const workerPath = join(process.cwd(), "tests", "fixtures", "file-lock-stress-worker.mjs");

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "context-vault-lock-stress-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("file lock subprocess stress", () => {
  it("serializes ArtifactStore metadata updates across processes", async () => {
    const root = await tempRoot();
    const artifactsRoot = join(root, "artifacts");
    const metadataRoot = join(root, "metadata");
    const workers = 4;
    const observationsPerWorker = 12;

    await Promise.all(
      Array.from({ length: workers }, (_, index) =>
        execFileAsync(
          process.execPath,
          [
            "--experimental-strip-types",
            workerPath,
            "artifact",
            artifactsRoot,
            metadataRoot,
            String(index),
            String(observationsPerWorker),
          ],
          { timeout: 20_000 },
        ),
      ),
    );

    const records = (await readFile(join(metadataRoot, "observations.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { metadata: { observationId: string } });
    expect(records).toHaveLength(workers * observationsPerWorker);
    expect(new Set(records.map((record) => record.metadata.observationId))).toHaveLength(
      workers * observationsPerWorker,
    );
    await expect(readdir(metadataRoot)).resolves.not.toContain("artifacts.lock");
  }, 20_000);

  it("detects subprocess tail appends and compaction pathname replacement", async () => {
    const root = await tempRoot();
    const artifactsRoot = join(root, "artifacts");
    const metadataRoot = join(root, "metadata");
    const telemetry = new Telemetry();
    const reader = new ArtifactStore({ artifactsRoot, metadataRoot, telemetry });
    await reader.archive({
      observationId: "shared-observation",
      toolName: "parent",
      sessionId: "parent",
      content: "parent content",
    });
    await reader.listMetadata();
    const rebuildsBefore = telemetry.snapshot().metadataFullRebuildCount;

    await execFileAsync(
      process.execPath,
      ["--experimental-strip-types", workerPath, "artifact-compact", artifactsRoot, metadataRoot, "child content"],
      { timeout: 20_000 },
    );

    expect((await reader.getMetadata("shared-observation"))?.toolName).toBe("subprocess-compaction");
    expect(telemetry.snapshot().metadataFullRebuildCount).toBeGreaterThan(rebuildsBefore);
    const lines = (await readFile(join(metadataRoot, "observations.jsonl"), "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);
  }, 20_000);
});
