import { describe, expect, it } from "vitest";
import { Telemetry } from "../src/telemetry.js";

describe("Telemetry", () => {
  it("returns bounded snapshot copies for hot-path metrics", () => {
    const telemetry = new Telemetry();
    telemetry.recordGitHead(2);
    telemetry.recordGitDirty(3);
    telemetry.recordGitDiff(4);
    telemetry.recordSearchIndexBuild(5);
    telemetry.recordGenerationWrite(6);
    telemetry.recordRepoMapTotalBytes(100);
    telemetry.recordGenerationPrune(7, 2, 40);

    const first = telemetry.snapshot();
    expect(first).toMatchObject({
      gitHeadCount: 1,
      gitHeadDurationMsTotal: 2,
      gitDirtyCount: 1,
      gitDirtyDurationMsTotal: 3,
      gitDiffCount: 1,
      gitDiffDurationMsTotal: 4,
      searchIndexBuildCount: 1,
      searchIndexBuildDurationMsTotal: 5,
      generationWriteCount: 1,
      generationWriteDurationMsTotal: 6,
      generationPruneCount: 1,
      generationPruneDurationMsTotal: 7,
      generationPrunedFiles: 2,
      generationPrunedBytes: 40,
      repoMapTotalBytes: 60,
    });

    first.gitHeadCount = 999;
    expect(telemetry.snapshot().gitHeadCount).toBe(1);
    for (const [name, value] of Object.entries(telemetry.snapshot())) {
      expect(typeof value, name).toBe("number");
      expect(Number.isFinite(value), name).toBe(true);
    }
    expect(Object.values(telemetry.snapshot()).some(Array.isArray)).toBe(false);
  });

  it("separates persisted generation bytes from successful activation", () => {
    const telemetry = new Telemetry();
    telemetry.recordRepoMapTotalBytes(10);
    telemetry.recordGenerationFileWritten(20);

    expect(telemetry.snapshot()).toMatchObject({
      generationCreatedCount: 0,
      generationBytesWritten: 20,
      repoMapTotalBytes: 30,
    });

    telemetry.recordGenerationActivated();
    expect(telemetry.snapshot()).toMatchObject({
      generationCreatedCount: 1,
      generationBytesWritten: 20,
      repoMapTotalBytes: 30,
    });

    telemetry.recordGenerationCreated(5);
    expect(telemetry.snapshot()).toMatchObject({
      generationCreatedCount: 2,
      generationBytesWritten: 25,
      repoMapTotalBytes: 35,
    });
  });

  it("normalizes invalid hot-path numeric inputs without retaining records", () => {
    const telemetry = new Telemetry();
    telemetry.recordGitHead(Number.POSITIVE_INFINITY);
    telemetry.recordGitDirty(Number.NaN);
    telemetry.recordGitDiff(-1);
    telemetry.recordSearchIndexBuild(Number.NaN);
    telemetry.recordGenerationWrite(Number.POSITIVE_INFINITY);
    telemetry.recordRepoMapTotalBytes(Number.NaN);
    telemetry.recordGenerationPrune(Number.NaN, Number.POSITIVE_INFINITY, -10);

    expect(Object.values(telemetry.snapshot()).every(Number.isFinite)).toBe(true);
  });
});
