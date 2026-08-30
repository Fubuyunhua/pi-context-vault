import { describe, expect, it } from "vitest";
import { Telemetry } from "../src/telemetry.js";

const RETIRED_REPO_FIELDS = [
  "capsuleBuildCount",
  "repoMapAutomaticQueryCount",
  "repoMapQueryCount",
  "ensureFreshCount",
  "gitHeadCount",
  "searchIndexBuildCount",
  "generationCreatedCount",
  "repoMapTotalBytes",
  "maintenanceFailureCount",
] as const;

describe("Vault-only telemetry", () => {
  it("records archive, metadata, and reduction metrics in detached finite snapshots", () => {
    const telemetry = new Telemetry();
    telemetry.recordArchiveStarted();
    telemetry.recordArchiveSucceeded(2, true);
    telemetry.recordMetadataRead(3);
    telemetry.recordMetadataWrite(4);
    telemetry.recordMetadataTailSync(5);
    telemetry.recordMetadataAppend(6, 1);
    telemetry.recordArtifactGcFailure();
    telemetry.recordObservationSearch({
      durationMs: 8,
      candidates: 3,
      artifactReads: 2,
      unavailable: 1,
      hydrationReads: 4,
      fallbacks: 5,
    });
    telemetry.recordReduction({
      durationMs: 7,
      triggered: true,
      reducedCount: 2,
      estimatedTokensBefore: 100,
      estimatedTokensAfter: 60,
      targetReached: true,
    });
    const first = telemetry.snapshot();
    expect(first).toMatchObject({
      archiveAttemptCount: 1,
      archiveSuccessCount: 1,
      archiveDeduplicatedCount: 1,
      archiveDurationMsTotal: 2,
      metadataReadDurationMsTotal: 3,
      metadataWriteDurationMsTotal: 4,
      metadataTailSyncCount: 1,
      metadataTailBytesRead: 5,
      metadataAppendCount: 1,
      metadataBytesAppended: 6,
      metadataTombstoneCount: 1,
      artifactGcFailureCount: 1,
      observationSearchCount: 1,
      observationSearchCandidateCount: 3,
      observationSearchArtifactReadCount: 2,
      observationSearchUnavailableCount: 1,
      observationSearchHydrationReadCount: 4,
      observationSearchFallbackCount: 5,
      observationSearchIndexLoadFailureCount: 0,
      observationSearchIndexWriteFailureCount: 0,
      observationSearchDurationMsTotal: 8,
      reductionInvocationCount: 1,
      reductionTriggeredCount: 1,
      reducedObservationCount: 2,
      estimatedTokensBeforeTotal: 100,
      estimatedTokensAfterTotal: 60,
      targetReachedCount: 1,
      reductionDurationMsTotal: 7,
    });
    first.archiveAttemptCount = 999;
    expect(telemetry.snapshot().archiveAttemptCount).toBe(1);
    expect(Object.values(telemetry.snapshot()).every(Number.isFinite)).toBe(true);
    for (const field of RETIRED_REPO_FIELDS) expect(telemetry.snapshot()).not.toHaveProperty(field);
  });

  it("normalizes invalid numeric inputs and retains no arrays or records", () => {
    const telemetry = new Telemetry();
    telemetry.recordArchiveSucceeded(Number.POSITIVE_INFINITY, false);
    telemetry.recordMetadataWrite(Number.NaN);
    telemetry.recordMetadataAppend(-1, Number.POSITIVE_INFINITY);
    telemetry.recordReduction({
      durationMs: Number.NaN,
      triggered: false,
      reducedCount: -1,
      estimatedTokensBefore: Number.POSITIVE_INFINITY,
      estimatedTokensAfter: -1,
      targetReached: false,
    });
    expect(Object.values(telemetry.snapshot()).every(Number.isFinite)).toBe(true);
    expect(Object.values(telemetry.snapshot()).some(Array.isArray)).toBe(false);
  });
});
